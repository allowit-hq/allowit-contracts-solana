use allowit_core::{
    preflight, Address, AllowitArgs, AllowitContext, AllowitEnv, AllowitMap, AllowitOperation,
    AllowitParams, AllowitRequest, AllowitRule, AllowitStandardState, AllowitValue,
};
use borsh::BorshDeserialize;
use solana_account_info::AccountInfo;
use solana_program_error::{ProgramError, ProgramResult};
use solana_pubkey::Pubkey;

#[cfg(not(any(
    feature = "paper-transfer",
    feature = "destination-list",
    feature = "daily-limits"
)))]
compile_error!("select one policy fixture");
#[cfg(any(
    all(feature = "paper-transfer", feature = "destination-list"),
    all(feature = "paper-transfer", feature = "daily-limits"),
    all(feature = "destination-list", feature = "daily-limits")
))]
compile_error!("select only one policy fixture");

const ABI: u8 = 3;
#[cfg(any(feature = "paper-transfer", feature = "daily-limits"))]
const USDC: i128 = 1_000_000;
const VAULT_SEED: &[u8] = b"allowit-vault-v3";
const TEST_VAULT: Pubkey = Pubkey::new_from_array([10; 32]);
const DEVNET_VAULT: Pubkey = Pubkey::from_str_const("4DndpzM9r5svGVEUzBWEgVVu6mvn9hb7L4woy48Q98qc");
#[cfg(any(feature = "paper-transfer", feature = "destination-list"))]
const DESTINATION: Pubkey = Pubkey::new_from_array([16; 32]);
#[cfg(feature = "paper-transfer")]
const MINT: Pubkey = Pubkey::new_from_array([14; 32]);
const POLICY_DENIED: u32 = 3001;

#[derive(BorshDeserialize)]
struct CheckInput {
    abi: u8,
    amount: u64,
    recipient: [u8; 32],
    mint: [u8; 32],
    now: i64,
    day: u64,
    calls: u64,
    spent: i128,
    day_spent: i128,
    day_total: i128,
}

solana_program_entrypoint::entrypoint!(process_instruction);

fn process_instruction(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [vault] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !vault.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if vault.is_writable || ![TEST_VAULT, DEVNET_VAULT].contains(vault.owner) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let state = vault.try_borrow_data()?;
    // ABI 3 header: owner, mint, instance and pinned check program.
    let header = state.get(..240).ok_or(ProgramError::InvalidAccountData)?;
    let expected = Pubkey::create_program_address(
        &[VAULT_SEED, &header[8..40], &header[136..168], &[header[1]]],
        vault.owner,
    )
    .map_err(|_| ProgramError::InvalidSeeds)?;
    if header[0] != ABI
        || header[2] != 3
        || expected != *vault.key
        || &header[208..240] != program.as_ref()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let input =
        CheckInput::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    let now = u64::try_from(input.now).map_err(|_| ProgramError::InvalidInstructionData)?;
    if input.abi != ABI || input.mint != header[104..136] || input.day != now / 86_400 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut policy_state = AllowitMap::new();
    AllowitStandardState {
        calls: input.calls,
        spent: input.spent,
        day: input.day,
        day_spent: input.day_spent,
        day_total: input.day_total,
        unpriced: false,
        day_unpriced: false,
    }
    .write(&mut policy_state)
    .map_err(|_| ProgramError::InvalidAccountData)?;

    let mint = address(Pubkey::new_from_array(input.mint));
    let amount = i128::from(input.amount);
    let ctx = AllowitContext {
        env: AllowitEnv::new(),
        params: AllowitParams::from(fixture_params()),
        state: policy_state,
        request: AllowitRequest {
            operation: AllowitOperation::transfer,
            asset: mint.clone(),
            recipient: address(Pubkey::new_from_array(input.recipient)),
            amount,
            token_in: mint,
            amount_in: amount,
            token_out: None,
            min_out: 0,
            now,
            // ABI 3 already enforces the transaction's deadline before making this call.
            expires_at: now + 1,
            spent_units: amount,
            gas_units: 0,
            unpriced: false,
            args: AllowitArgs::from(AllowitMap::new()),
        },
    };
    execute(&ctx).map_err(|_| ProgramError::Custom(POLICY_DENIED))
}

fn address(key: Pubkey) -> Address {
    Address::new(key.to_string())
}

fn fixture_params() -> AllowitMap {
    let mut params = AllowitMap::new();
    #[cfg(any(feature = "paper-transfer", feature = "destination-list"))]
    params.insert(
        "destinations".into(),
        AllowitValue::List(vec![AllowitValue::Addr(address(DESTINATION))].into()),
    );
    #[cfg(feature = "paper-transfer")]
    {
        params.insert(
            "operations".into(),
            AllowitValue::List(vec![AllowitValue::Str("transfer".into())].into()),
        );
        params.insert(
            "tokens".into(),
            AllowitValue::List(vec![AllowitValue::Addr(address(MINT))].into()),
        );
        params.insert("expires_at".into(), AllowitValue::Int(4_102_444_800));
        params.insert(
            "lifetime_spending_limit".into(),
            AllowitValue::Int(10 * USDC),
        );
        params.insert("payment_limit".into(), AllowitValue::Int(3 * USDC));
    }
    #[cfg(any(feature = "paper-transfer", feature = "daily-limits"))]
    {
        params.insert("daily_spending_limit".into(), AllowitValue::Int(5 * USDC));
        params.insert("daily_volume_limit".into(), AllowitValue::Int(6 * USDC));
    }
    params
}

fn execute(ctx: &AllowitContext) -> allowit_core::Result {
    use AllowitRule::*;
    // The derived expression uses the Core host's thread-local failure latch
    // via .ok(). SBF cannot link it, so measure the same transfer rules using
    // the typed Core entry point already used by vault ABI 3.
    #[cfg(feature = "paper-transfer")]
    const RULES: &[AllowitRule] = &[
        operations,
        tokens,
        expires_at,
        lifetime_spending_limit,
        daily_spending_limit,
        daily_volume_limit,
        destinations,
        payment_limit,
    ];
    #[cfg(feature = "destination-list")]
    const RULES: &[AllowitRule] = &[destinations];
    #[cfg(feature = "daily-limits")]
    const RULES: &[AllowitRule] = &[daily_spending_limit, daily_volume_limit];
    for &rule in RULES {
        preflight(ctx, rule)?;
    }
    Ok(())
}
