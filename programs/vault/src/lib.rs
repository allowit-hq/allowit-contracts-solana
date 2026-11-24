mod abi;
mod policy;

pub use abi::*;
use allowit_core::DAY;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_account_info::AccountInfo;
use solana_clock::Clock;
use solana_cpi::{invoke, invoke_signed};
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::{ProgramError, ProgramResult};
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use solana_rent::Rent;
use solana_sdk_ids::system_program;
use solana_system_interface::instruction as system;
use solana_sysvar::Sysvar;
use spl_associated_token_account_interface::{
    address::get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent, program as ata_program,
};
use spl_token_interface::{
    instruction as token,
    state::{Account as TokenAccount, Mint},
};

const MAX_LIFETIME: u64 = 600;

#[cfg(not(feature = "no-entrypoint"))]
solana_program_entrypoint::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let instruction =
        VaultInstruction::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    match instruction {
        VaultInstruction::Initialize {
            instance_id,
            kind,
            agent,
            server,
            source_hash,
            check_program,
            rules,
            params,
        } => {
            let mut state = VaultState {
                abi: ABI,
                bump: 0,
                kind,
                paused: false,
                version: 0,
                owner: [0; 32],
                agent,
                server,
                mint: [0; 32],
                instance_id,
                created_slot: 0,
                source_hash,
                check_program,
                nonce: 0,
                figures: Figures::default(),
                rules,
                params,
            };
            initialize(program_id, accounts, &mut state)
        }
        VaultInstruction::Execute {
            amount,
            nonce,
            version,
            created_slot,
            expires_at,
        } => execute(
            program_id,
            accounts,
            amount,
            nonce,
            version,
            created_slot,
            expires_at,
        ),
        VaultInstruction::SetPause { paused, version } => {
            let [state_account, owner] = accounts else {
                return Err(VaultError::InvalidInvocation.into());
            };
            let mut state = load(program_id, state_account)?;
            require_signer(owner, &state.owner)?;
            next_version(&state, version)?;
            state.paused = paused;
            state.version = version;
            store(state_account, &state)
        }
        VaultInstruction::Close { version } => close(program_id, accounts, version),
        VaultInstruction::Stop { version } => {
            owner_transfer(program_id, accounts, OwnerTransfer::Stop(version))
        }
        VaultInstruction::Recover { amount } => {
            owner_transfer(program_id, accounts, OwnerTransfer::Recover(amount))
        }
        VaultInstruction::UpdatePolicy {
            version,
            agent,
            server,
            source_hash,
            check_program,
            rules,
            params,
        } => {
            let [state_account, owner, system_account] = accounts else {
                return Err(VaultError::InvalidInvocation.into());
            };
            let mut state = load(program_id, state_account)?;
            require_signer(owner, &state.owner)?;
            next_version(&state, version)?;
            state.version = version;
            state.agent = agent;
            state.server = server;
            state.source_hash = source_hash;
            state.check_program = check_program;
            state.rules = rules;
            state.params = params;
            validate_policy(&state)?;
            resize_state(state_account, owner, system_account, &state)
        }
    }
}

fn initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    state: &mut VaultState,
) -> ProgramResult {
    let [state_account, owner, mint, vault_ata, system_account, token_program, ata] = accounts
    else {
        return Err(VaultError::InvalidInvocation.into());
    };
    require_signer(owner, &owner.key.to_bytes())?;
    state.owner = owner.key.to_bytes();
    validate_policy(state)?;
    validate_mint(mint, token_program)?;
    if !system_program::check_id(system_account.key) || !ata_program::check_id(ata.key) {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (address, bump) = Pubkey::find_program_address(
        &[VAULT_SEED, owner.key.as_ref(), &state.instance_id],
        program_id,
    );
    if address != *state_account.key
        || !state_account.is_writable
        || !state_account.data_is_empty()
        || !system_program::check_id(state_account.owner)
    {
        return Err(VaultError::InvalidState.into());
    }
    if *vault_ata.key != vault_token_address(state_account.key, mint.key) {
        return Err(VaultError::InvalidState.into());
    }
    let clock = Clock::get()?;
    state.mint = mint.key.to_bytes();
    state.bump = bump;
    state.created_slot = clock.slot;
    state.figures.day = timestamp(&clock)? / DAY;
    let bytes = borsh::to_vec(state).map_err(|_| VaultError::InvalidState)?;
    let space = bytes.len() as u64;
    let deposit = Rent::get()?.minimum_balance(bytes.len());
    let bump_seed = [bump];
    let seeds = state_seeds(state, &bump_seed);

    if state_account.lamports() == 0 {
        invoke_signed(
            &system::create_account(owner.key, state_account.key, deposit, space, program_id),
            &[owner.clone(), state_account.clone(), system_account.clone()],
            &[&seeds],
        )?;
    } else {
        let top_up = deposit.saturating_sub(state_account.lamports());
        if top_up != 0 {
            invoke(
                &system::transfer(owner.key, state_account.key, top_up),
                &[owner.clone(), state_account.clone(), system_account.clone()],
            )?;
        }
        invoke_signed(
            &system::allocate(state_account.key, space),
            &[state_account.clone(), system_account.clone()],
            &[&seeds],
        )?;
        invoke_signed(
            &system::assign(state_account.key, program_id),
            &[state_account.clone(), system_account.clone()],
            &[&seeds],
        )?;
    }
    state_account.try_borrow_mut_data()?.copy_from_slice(&bytes);
    invoke(
        &create_associated_token_account_idempotent(
            owner.key,
            state_account.key,
            mint.key,
            token_program.key,
        ),
        &[
            owner.clone(),
            vault_ata.clone(),
            state_account.clone(),
            mint.clone(),
            system_account.clone(),
            token_program.clone(),
            ata.clone(),
        ],
    )
}

fn validate_policy(state: &VaultState) -> ProgramResult {
    if [state.owner, state.agent, state.server].contains(&[0; 32])
        || state.owner == state.agent
        || state.owner == state.server
        || state.agent == state.server
    {
        return Err(VaultError::InvalidActor.into());
    }
    if !matches!(state.kind, SIMPLE | STANDARD | CUSTOM)
        || (state.kind == CUSTOM) != (state.check_program != [0; 32])
        || (state.kind != STANDARD && (!state.rules.is_empty() || !state.params.is_empty()))
    {
        return Err(VaultError::InvalidParam.into());
    }
    policy::params(&state.rules, &state.params)?;
    Ok(())
}

fn resize_state<'a>(
    account: &AccountInfo<'a>,
    owner: &AccountInfo<'a>,
    system_account: &AccountInfo<'a>,
    state: &VaultState,
) -> ProgramResult {
    if !system_program::check_id(system_account.key) {
        return Err(ProgramError::IncorrectProgramId);
    }
    let bytes = borsh::to_vec(state).map_err(|_| VaultError::InvalidState)?;
    let old_len = account.data_len();
    let new_len = bytes.len();
    if new_len != old_len {
        let deposit = Rent::get()?.minimum_balance(new_len);
        let current = account.lamports();
        if new_len > old_len {
            let top_up = deposit.saturating_sub(current);
            if top_up != 0 {
                invoke(
                    &system::transfer(owner.key, account.key, top_up),
                    &[owner.clone(), account.clone(), system_account.clone()],
                )?;
            }
        } else if current > deposit {
            let refund = current - deposit;
            let owner_balance = owner
                .lamports()
                .checked_add(refund)
                .ok_or(VaultError::Overflow)?;
            **owner.try_borrow_mut_lamports()? = owner_balance;
            **account.try_borrow_mut_lamports()? = deposit;
        }
        account.resize(new_len)?;
    }
    account.try_borrow_mut_data()?.copy_from_slice(&bytes);
    Ok(())
}

fn execute(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount: u64,
    nonce: u64,
    version: u32,
    created_slot: u64,
    expires_at: i64,
) -> ProgramResult {
    let [state_account, agent, server, mint, vault_ata, destination, token_program, check_accounts @ ..] =
        accounts
    else {
        return Err(VaultError::InvalidInvocation.into());
    };
    let mut state = load(program_id, state_account)?;
    require_signer(agent, &state.agent)?;
    require_signer(server, &state.server)?;
    if state.kind != CUSTOM && !check_accounts.is_empty() {
        return Err(VaultError::InvalidInvocation.into());
    }
    if state.paused {
        return Err(VaultError::Paused.into());
    }
    if (nonce, version, created_slot) != (state.nonce, state.version, state.created_slot) {
        return Err(VaultError::StaleRequest.into());
    }
    if amount == 0 {
        return Err(VaultError::InvalidAmount.into());
    }
    let now = timestamp(&Clock::get()?)?;
    let expires_at = u64::try_from(expires_at).map_err(|_| VaultError::Expired)?;
    if expires_at <= now || expires_at - now > MAX_LIFETIME {
        return Err(VaultError::Expired.into());
    }
    let (balance, recipient) = transfer_accounts(
        state_account,
        &state,
        mint,
        vault_ata,
        destination,
        token_program,
    )?;
    state.figures = match state.kind {
        SIMPLE => transfer_figures(&state.figures, amount, now)?,
        STANDARD => policy::evaluate(&state, &recipient, amount, now, expires_at)?,
        CUSTOM => {
            check_custom(
                state_account,
                &state,
                check_accounts,
                &recipient,
                amount,
                now,
            )?;
            transfer_figures(&state.figures, amount, now)?
        }
        _ => return Err(VaultError::UnsupportedOperation.into()),
    };
    if amount > balance {
        return Err(VaultError::InsufficientFunds.into());
    }
    state.nonce = state.nonce.checked_add(1).ok_or(VaultError::Overflow)?;
    store(state_account, &state)?;
    transfer(
        state_account,
        &state,
        mint,
        vault_ata,
        destination,
        token_program,
        amount,
    )
}

fn check_custom<'a>(
    state_account: &AccountInfo<'a>,
    state: &VaultState,
    accounts: &[AccountInfo<'a>],
    recipient: &Pubkey,
    amount: u64,
    now: u64,
) -> ProgramResult {
    let (program, check_state) = match accounts {
        [program] => (program, None),
        [program, check_state] => (program, Some(check_state)),
        _ => return Err(VaultError::InvalidInvocation.into()),
    };
    if program.key.to_bytes() != state.check_program || !program.executable {
        return Err(ProgramError::IncorrectProgramId);
    }

    let mut metas = vec![AccountMeta::new_readonly(*state_account.key, true)];
    let mut infos = vec![state_account.clone()];
    if let Some(check_state) = check_state {
        // A check program's optional wallet state is keyed by the vault state PDA.
        let expected = Pubkey::find_program_address(&[state_account.key.as_ref()], program.key).0;
        if *check_state.key != expected || !check_state.is_writable {
            return Err(VaultError::InvalidInvocation.into());
        }
        metas.push(AccountMeta::new(*check_state.key, false));
        infos.push(check_state.clone());
    }
    infos.push(program.clone());

    let day = now / DAY;
    let (day_spent, day_total) = daily_figures(&state.figures, day);
    let data = borsh::to_vec(&CustomCheckInput {
        abi: ABI,
        amount,
        recipient: recipient.to_bytes(),
        mint: state.mint,
        now: i64::try_from(now).map_err(|_| VaultError::InvalidState)?,
        day,
        calls: state.figures.calls,
        spent: state.figures.spent,
        day_spent,
        day_total,
    })
    .map_err(|_| VaultError::InvalidState)?;
    let instruction = Instruction {
        program_id: *program.key,
        accounts: metas,
        data,
    };
    let bump = [state.bump];
    invoke_signed(&instruction, &infos, &[&state_seeds(state, &bump)])
}

enum OwnerTransfer {
    Stop(u32),
    Recover(u64),
}

fn owner_transfer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    action: OwnerTransfer,
) -> ProgramResult {
    let [state_account, owner, mint, vault_ata, destination, token_program] = accounts else {
        return Err(VaultError::InvalidInvocation.into());
    };
    let mut state = load(program_id, state_account)?;
    require_signer(owner, &state.owner)?;
    if let OwnerTransfer::Stop(version) = action {
        next_version(&state, version)?;
    }
    let (balance, recipient) = transfer_accounts(
        state_account,
        &state,
        mint,
        vault_ata,
        destination,
        token_program,
    )?;
    if recipient != *owner.key {
        return Err(VaultError::InvalidRecipient.into());
    }
    let amount = match action {
        OwnerTransfer::Stop(version) => {
            state.paused = true;
            state.version = version;
            store(state_account, &state)?;
            balance
        }
        OwnerTransfer::Recover(amount) => amount,
    };
    if amount > balance {
        return Err(VaultError::InsufficientFunds.into());
    }
    if amount == 0 {
        return Ok(());
    }
    transfer(
        state_account,
        &state,
        mint,
        vault_ata,
        destination,
        token_program,
        amount,
    )
}

fn close(program_id: &Pubkey, accounts: &[AccountInfo], version: u32) -> ProgramResult {
    let [state_account, owner, mint, vault_ata, destination, token_program] = accounts else {
        return Err(VaultError::InvalidInvocation.into());
    };
    let state = load(program_id, state_account)?;
    require_signer(owner, &state.owner)?;
    next_version(&state, version)?;
    let (balance, recipient) = transfer_accounts(
        state_account,
        &state,
        mint,
        vault_ata,
        destination,
        token_program,
    )?;
    if recipient != *owner.key {
        return Err(VaultError::InvalidRecipient.into());
    }
    if balance != 0 {
        transfer(
            state_account,
            &state,
            mint,
            vault_ata,
            destination,
            token_program,
            balance,
        )?;
    }
    let bump = [state.bump];
    invoke_signed(
        &token::close_account(
            token_program.key,
            vault_ata.key,
            owner.key,
            state_account.key,
            &[],
        )?,
        &[
            vault_ata.clone(),
            owner.clone(),
            state_account.clone(),
            token_program.clone(),
        ],
        &[&state_seeds(&state, &bump)],
    )?;
    let balance = owner
        .lamports()
        .checked_add(state_account.lamports())
        .ok_or(VaultError::Overflow)?;
    **owner.try_borrow_mut_lamports()? = balance;
    **state_account.try_borrow_mut_lamports()? = 0;
    state_account.resize(0)?;
    state_account.assign(&system_program::ID);
    Ok(())
}

fn transfer_accounts(
    state_account: &AccountInfo,
    state: &VaultState,
    mint: &AccountInfo,
    vault_ata: &AccountInfo,
    destination: &AccountInfo,
    token_program: &AccountInfo,
) -> Result<(u64, Pubkey), ProgramError> {
    validate_mint(mint, token_program)?;
    if mint.key.to_bytes() != state.mint
        || *vault_ata.key != vault_token_address(state_account.key, mint.key)
    {
        return Err(VaultError::InvalidState.into());
    }
    if vault_ata.owner != token_program.key {
        return Err(VaultError::InvalidState.into());
    }
    let source = TokenAccount::unpack(&vault_ata.try_borrow_data()?)?;
    if source.owner != *state_account.key || source.mint != *mint.key {
        return Err(VaultError::InvalidState.into());
    }
    if vault_ata.key == destination.key || destination.owner != token_program.key {
        return Err(VaultError::InvalidRecipient.into());
    }
    let target = TokenAccount::unpack(&destination.try_borrow_data()?)
        .map_err(|_| VaultError::InvalidRecipient)?;
    if target.mint != *mint.key {
        return Err(VaultError::InvalidRecipient.into());
    }
    Ok((source.amount, target.owner))
}

fn transfer<'a>(
    state_account: &AccountInfo<'a>,
    state: &VaultState,
    mint: &AccountInfo<'a>,
    vault_ata: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    amount: u64,
) -> ProgramResult {
    let bump = [state.bump];
    invoke_signed(
        &token::transfer_checked(
            token_program.key,
            vault_ata.key,
            mint.key,
            destination.key,
            state_account.key,
            &[],
            amount,
            DECIMALS,
        )?,
        &[
            vault_ata.clone(),
            mint.clone(),
            destination.clone(),
            state_account.clone(),
            token_program.clone(),
        ],
        &[&state_seeds(state, &bump)],
    )
}

fn load(program_id: &Pubkey, account: &AccountInfo) -> Result<VaultState, ProgramError> {
    if account.owner != program_id || !account.is_writable {
        return Err(VaultError::InvalidState.into());
    }
    let state = VaultState::try_from_slice(&account.try_borrow_data()?)
        .map_err(|_| VaultError::InvalidState)?;
    let bump = [state.bump];
    let derived = Pubkey::create_program_address(&state_seeds(&state, &bump), program_id)
        .map_err(|_| VaultError::InvalidState)?;
    if state.abi != ABI || derived != *account.key {
        return Err(VaultError::InvalidState.into());
    }
    Ok(state)
}

fn store(account: &AccountInfo, state: &VaultState) -> ProgramResult {
    state
        .serialize(&mut &mut account.try_borrow_mut_data()?[..])
        .map_err(|_| VaultError::InvalidState.into())
}

fn state_seeds<'a>(state: &'a VaultState, bump: &'a [u8; 1]) -> [&'a [u8]; 4] {
    [VAULT_SEED, &state.owner, &state.instance_id, bump]
}

fn vault_token_address(state: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(state, mint, &spl_token_interface::ID)
}

fn validate_mint(mint: &AccountInfo, token_program: &AccountInfo) -> ProgramResult {
    if !spl_token_interface::check_id(token_program.key) || mint.owner != token_program.key {
        return Err(VaultError::UnsupportedAsset.into());
    }
    let mint = Mint::unpack(&mint.try_borrow_data()?).map_err(|_| VaultError::UnsupportedAsset)?;
    if mint.decimals != DECIMALS {
        return Err(VaultError::UnsupportedAsset.into());
    }
    Ok(())
}

fn require_signer(account: &AccountInfo, expected: &[u8; 32]) -> ProgramResult {
    if account.key.to_bytes() != *expected {
        return Err(VaultError::InvalidActor.into());
    }
    if !account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

fn next_version(state: &VaultState, version: u32) -> ProgramResult {
    if state.version.checked_add(1).ok_or(VaultError::Overflow)? != version {
        return Err(VaultError::StaleRequest.into());
    }
    Ok(())
}

fn timestamp(clock: &Clock) -> Result<u64, ProgramError> {
    u64::try_from(clock.unix_timestamp).map_err(|_| VaultError::InvalidState.into())
}

fn daily_figures(figures: &Figures, day: u64) -> (i128, i128) {
    if figures.day == day {
        (figures.day_spent, figures.day_total)
    } else {
        (0, 0)
    }
}

fn transfer_figures(figures: &Figures, amount: u64, now: u64) -> Result<Figures, ProgramError> {
    let amount = i128::from(amount);
    let day = now / DAY;
    let (day_spent, day_total) = daily_figures(figures, day);
    Ok(Figures {
        calls: figures.calls.checked_add(1).ok_or(VaultError::Overflow)?,
        spent: figures
            .spent
            .checked_add(amount)
            .ok_or(VaultError::Overflow)?,
        day,
        day_spent: day_spent.checked_add(amount).ok_or(VaultError::Overflow)?,
        day_total: day_total.checked_add(amount).ok_or(VaultError::Overflow)?,
    })
}
