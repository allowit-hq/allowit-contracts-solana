//! Test-only priced vault of the Solana rail. Never use this program as a product vault: its
//! admin decides what a share is worth.
//!
//! A vault holds one asset, a classic SPL Token mint with six decimals (USDC on Devnet), and
//! issues shares as an SPL Token mint of its own with six decimals. It behaves as a tokenized
//! vault should: a deposit takes exactly the assets that it is asked to take and mints the
//! shares that `PreviewDeposit` names; a redeem burns exactly the shares that it is asked to
//! burn and pays the assets that `PreviewRedeem` names. Unlike a product vault it earns nothing:
//! its admin sets the price of one share (`SetSharePrice`), and every conversion uses that price.
//! Tests and Devnet evals use it to give a wallet an honest vault and to move a share price on
//! purpose.
//!
//! The price is the asset amount, in base units, for [`SHARE`] share units (one share). `SHARE`
//! itself is a price of one asset per share. Both conversions round down, toward the vault. The
//! admin keeps the vault solvent: a redeem fails when the vault holds fewer assets than it pays,
//! so the admin moves the difference to the vault's token account with a plain token transfer
//! before raising the price. Lowering the price leaves the difference in the vault.
//!
//! `README.md` beside this crate has the accounts of each instruction, the state layout and the
//! deployment steps.
use solana_account_info::AccountInfo;
use solana_cpi::{invoke, invoke_signed, set_return_data};
use solana_instruction::Instruction;
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

/// One share in share units, and the price of one asset per share.
pub const SHARE: u64 = 1_000_000;
/// Decimals of the asset and of the shares.
pub const DECIMALS: u8 = 6;
/// The first bytes of a vault's state: the layout's name and its version.
pub const TAG: [u8; 8] = *b"alwtvlt\x01";
/// The size of a vault's state.
pub const STATE_LEN: usize = 148;
/// Seeds of a vault's state: this, the admin, the name.
pub const VAULT_SEED: &[u8] = b"allowit-test-vault";
/// Seeds of a vault's share mint: this, the state.
pub const SHARES_SEED: &[u8] = b"shares";
/// The most signers of a multisig authority.
pub const MAX_SIGNERS: usize = 11;

/// What the program refuses with, as `ProgramError::Custom`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    /// An amount or a price is zero.
    NotPositive = 1,
    /// The conversion gives no share or no asset.
    ZeroResult = 2,
    /// The source holds fewer shares than the redeem burns.
    InsufficientShares = 3,
    /// The vault holds fewer assets than the redeem pays.
    InsufficientAssets = 4,
    /// An amount does not fit 64 bits.
    Overflow = 5,
    /// The state, a mint or a token account is not this vault's.
    InvalidVault = 6,
    /// The signer is not the vault's admin.
    InvalidAdmin = 7,
    /// The asset is not a classic SPL Token mint with six decimals.
    UnsupportedAsset = 8,
    /// The accounts do not fit the instruction.
    InvalidInvocation = 9,
}

impl From<VaultError> for ProgramError {
    fn from(error: VaultError) -> Self {
        Self::Custom(error as u32)
    }
}

/// A vault's state: [`STATE_LEN`] bytes. [`TAG`] comes first, then the fields in this order,
/// the price little-endian.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultState {
    pub bump: u8,
    pub shares_bump: u8,
    pub asset_decimals: u8,
    pub share_decimals: u8,
    pub admin: [u8; 32],
    pub asset_mint: [u8; 32],
    pub share_mint: [u8; 32],
    /// UTF-8, zero-padded. It is a seed of the state's address.
    pub name: [u8; 32],
    /// Asset base units for [`SHARE`] share units.
    pub share_price: u64,
}

impl VaultState {
    pub fn to_bytes(&self) -> [u8; STATE_LEN] {
        let mut out = [0; STATE_LEN];
        out[..8].copy_from_slice(&TAG);
        out[8] = self.bump;
        out[9] = self.shares_bump;
        out[10] = self.asset_decimals;
        out[11] = self.share_decimals;
        out[12..44].copy_from_slice(&self.admin);
        out[44..76].copy_from_slice(&self.asset_mint);
        out[76..108].copy_from_slice(&self.share_mint);
        out[108..140].copy_from_slice(&self.name);
        out[140..148].copy_from_slice(&self.share_price.to_le_bytes());
        out
    }

    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() != STATE_LEN || data[..8] != TAG {
            return None;
        }
        let key = |at: usize| -> [u8; 32] { data[at..at + 32].try_into().unwrap() };
        Some(Self {
            bump: data[8],
            shares_bump: data[9],
            asset_decimals: data[10],
            share_decimals: data[11],
            admin: key(12),
            asset_mint: key(44),
            share_mint: key(76),
            name: key(108),
            share_price: u64::from_le_bytes(data[140..148].try_into().unwrap()),
        })
    }
}

/// The instructions. The data is one tag byte and the fields in order, integers little-endian.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VaultInstruction {
    /// 0. The admin creates a vault of `name` for the asset mint.
    Initialize { name: [u8; 32], share_price: u64 },
    /// 1. The admin sets the price of one share.
    SetSharePrice { share_price: u64 },
    /// 2. Take exactly `assets` and mint the shares of [`shares_for`]. Returns the shares.
    Deposit { assets: u64 },
    /// 3. Burn exactly `shares` and pay the assets of [`assets_for`]. Returns the assets.
    Redeem { shares: u64 },
    /// 4. Read-only: returns the price of one share.
    SharePrice,
    /// 5. Read-only: returns the shares that a deposit of `assets` mints now.
    PreviewDeposit { assets: u64 },
    /// 6. Read-only: returns the assets that a redeem of `shares` pays now.
    PreviewRedeem { shares: u64 },
}

impl VaultInstruction {
    pub fn pack(&self) -> Vec<u8> {
        let (tag, name, amount) = match *self {
            Self::Initialize { name, share_price } => (0, Some(name), Some(share_price)),
            Self::SetSharePrice { share_price } => (1, None, Some(share_price)),
            Self::Deposit { assets } => (2, None, Some(assets)),
            Self::Redeem { shares } => (3, None, Some(shares)),
            Self::SharePrice => (4, None, None),
            Self::PreviewDeposit { assets } => (5, None, Some(assets)),
            Self::PreviewRedeem { shares } => (6, None, Some(shares)),
        };
        let mut out = vec![tag];
        out.extend(name.iter().flatten());
        out.extend(amount.iter().flat_map(|amount| amount.to_le_bytes()));
        out
    }

    pub fn unpack(data: &[u8]) -> Option<Self> {
        let (tag, rest) = data.split_first()?;
        let amount = |rest: &[u8]| Some(u64::from_le_bytes(rest.try_into().ok()?));
        Some(match tag {
            0 => Self::Initialize {
                name: rest.get(..32)?.try_into().ok()?,
                share_price: amount(&rest[32..])?,
            },
            1 => Self::SetSharePrice {
                share_price: amount(rest)?,
            },
            2 => Self::Deposit {
                assets: amount(rest)?,
            },
            3 => Self::Redeem {
                shares: amount(rest)?,
            },
            4 if rest.is_empty() => Self::SharePrice,
            5 => Self::PreviewDeposit {
                assets: amount(rest)?,
            },
            6 => Self::PreviewRedeem {
                shares: amount(rest)?,
            },
            _ => return None,
        })
    }
}

/// `amount * numerator / denominator`, rounded down, when it is positive and fits 64 bits.
fn convert(amount: u64, numerator: u64, denominator: u64) -> Result<u64, VaultError> {
    if amount == 0 || numerator == 0 || denominator == 0 {
        return Err(VaultError::NotPositive);
    }
    let result = u128::from(amount) * u128::from(numerator) / u128::from(denominator);
    match u64::try_from(result) {
        Ok(0) => Err(VaultError::ZeroResult),
        Ok(result) => Ok(result),
        Err(_) => Err(VaultError::Overflow),
    }
}

/// The shares that a deposit of `assets` mints at `share_price`, rounded down.
pub fn shares_for(assets: u64, share_price: u64) -> Result<u64, VaultError> {
    convert(assets, SHARE, share_price)
}

/// The assets that a redeem of `shares` pays at `share_price`, rounded down.
pub fn assets_for(shares: u64, share_price: u64) -> Result<u64, VaultError> {
    convert(shares, share_price, SHARE)
}

/// The address and bump of the state of the vault of `admin` and `name`.
pub fn vault_address(program_id: &Pubkey, admin: &Pubkey, name: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, admin.as_ref(), name], program_id)
}

/// The address and bump of the share mint of the vault at `state`.
pub fn share_mint_address(program_id: &Pubkey, state: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SHARES_SEED, state.as_ref()], program_id)
}

/// The vault's token account of its asset: the associated token account of the state.
pub fn asset_account_address(state: &Pubkey, asset_mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(state, asset_mint, &spl_token_interface::ID)
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program_entrypoint::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let instruction = VaultInstruction::unpack(data).ok_or(ProgramError::InvalidInstructionData)?;
    match instruction {
        VaultInstruction::Initialize { name, share_price } => {
            initialize(program_id, accounts, name, share_price)
        }
        VaultInstruction::SetSharePrice { share_price } => {
            set_share_price(program_id, accounts, share_price)
        }
        VaultInstruction::Deposit { assets } => deposit(program_id, accounts, assets),
        VaultInstruction::Redeem { shares } => redeem(program_id, accounts, shares),
        VaultInstruction::SharePrice => answer(program_id, accounts, |state| Ok(state.share_price)),
        VaultInstruction::PreviewDeposit { assets } => answer(program_id, accounts, |state| {
            shares_for(assets, state.share_price)
        }),
        VaultInstruction::PreviewRedeem { shares } => answer(program_id, accounts, |state| {
            assets_for(shares, state.share_price)
        }),
    }
}

/// A read-only instruction: the state is its only account and the answer is the return data,
/// eight bytes little-endian.
fn answer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    read: impl Fn(&VaultState) -> Result<u64, VaultError>,
) -> ProgramResult {
    let [state_account] = accounts else {
        return Err(VaultError::InvalidInvocation.into());
    };
    let value = read(&load(program_id, state_account)?)?;
    set_return_data(&value.to_le_bytes());
    Ok(())
}

fn load(program_id: &Pubkey, account: &AccountInfo) -> Result<VaultState, ProgramError> {
    if account.owner != program_id {
        return Err(VaultError::InvalidVault.into());
    }
    Ok(VaultState::from_bytes(&account.try_borrow_data()?).ok_or(VaultError::InvalidVault)?)
}

/// Accounts: state (w), admin (s).
fn set_share_price(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    share_price: u64,
) -> ProgramResult {
    let [state_account, admin] = accounts else {
        return Err(VaultError::InvalidInvocation.into());
    };
    let mut state = load(program_id, state_account)?;
    if !admin.is_signer || admin.key.to_bytes() != state.admin {
        return Err(VaultError::InvalidAdmin.into());
    }
    if share_price == 0 {
        return Err(VaultError::NotPositive.into());
    }
    state.share_price = share_price;
    state_account
        .try_borrow_mut_data()?
        .copy_from_slice(&state.to_bytes());
    Ok(())
}

/// Create the program-derived account `account` with `space` bytes for `owner`, paid by `payer`.
/// An address that already holds lamports is allocated and assigned in place.
fn create<'a>(
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    system_account: &AccountInfo<'a>,
    space: usize,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> ProgramResult {
    if !account.is_writable || !account.data_is_empty() || !system_program::check_id(account.owner)
    {
        return Err(VaultError::InvalidVault.into());
    }
    let deposit = Rent::get()?.minimum_balance(space);
    let infos = [payer.clone(), account.clone(), system_account.clone()];
    if account.lamports() == 0 {
        return invoke_signed(
            &system::create_account(payer.key, account.key, deposit, space as u64, owner),
            &infos,
            &[seeds],
        );
    }
    let top_up = deposit.saturating_sub(account.lamports());
    if top_up != 0 {
        invoke(&system::transfer(payer.key, account.key, top_up), &infos)?;
    }
    invoke_signed(
        &system::allocate(account.key, space as u64),
        &infos[1..],
        &[seeds],
    )?;
    invoke_signed(&system::assign(account.key, owner), &infos[1..], &[seeds])
}

/// Accounts: state (w), admin (w, s), asset mint, share mint (w), the vault's asset account
/// (w), System, SPL Token, Associated Token.
fn initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    name: [u8; 32],
    share_price: u64,
) -> ProgramResult {
    let [state_account, admin, asset_mint, share_mint, asset_account, system_account, token_program, ata] =
        accounts
    else {
        return Err(VaultError::InvalidInvocation.into());
    };
    if !admin.is_signer {
        return Err(VaultError::InvalidAdmin.into());
    }
    if share_price == 0 {
        return Err(VaultError::NotPositive.into());
    }
    if !system_program::check_id(system_account.key)
        || !spl_token_interface::check_id(token_program.key)
        || !ata_program::check_id(ata.key)
    {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !spl_token_interface::check_id(asset_mint.owner)
        || Mint::unpack(&asset_mint.try_borrow_data()?).map(|mint| mint.decimals) != Ok(DECIMALS)
    {
        return Err(VaultError::UnsupportedAsset.into());
    }
    let (state_address, bump) = vault_address(program_id, admin.key, &name);
    let (share_address, shares_bump) = share_mint_address(program_id, state_account.key);
    if state_address != *state_account.key
        || share_address != *share_mint.key
        || asset_account_address(state_account.key, asset_mint.key) != *asset_account.key
    {
        return Err(VaultError::InvalidVault.into());
    }
    let state = VaultState {
        bump,
        shares_bump,
        asset_decimals: DECIMALS,
        share_decimals: DECIMALS,
        admin: admin.key.to_bytes(),
        asset_mint: asset_mint.key.to_bytes(),
        share_mint: share_mint.key.to_bytes(),
        name,
        share_price,
    };
    create(
        admin,
        state_account,
        system_account,
        STATE_LEN,
        program_id,
        &[VAULT_SEED, admin.key.as_ref(), &name, &[bump]],
    )?;
    state_account
        .try_borrow_mut_data()?
        .copy_from_slice(&state.to_bytes());
    create(
        admin,
        share_mint,
        system_account,
        Mint::LEN,
        token_program.key,
        &[SHARES_SEED, state_account.key.as_ref(), &[shares_bump]],
    )?;
    invoke(
        &token::initialize_mint2(
            token_program.key,
            share_mint.key,
            state_account.key,
            None,
            DECIMALS,
        )?,
        std::slice::from_ref(share_mint),
    )?;
    invoke(
        &create_associated_token_account_idempotent(
            admin.key,
            state_account.key,
            asset_mint.key,
            token_program.key,
        ),
        &[
            admin.clone(),
            asset_account.clone(),
            state_account.clone(),
            asset_mint.clone(),
            system_account.clone(),
            token_program.clone(),
            ata.clone(),
        ],
    )
}

/// The accounts that a deposit and a redeem share, checked against the state.
struct Movement<'a, 'b> {
    state: VaultState,
    state_account: &'a AccountInfo<'b>,
    asset_mint: &'a AccountInfo<'b>,
    share_mint: &'a AccountInfo<'b>,
    asset_account: &'a AccountInfo<'b>,
    source: &'a AccountInfo<'b>,
    authority: &'a AccountInfo<'b>,
    receiver: &'a AccountInfo<'b>,
    token_program: &'a AccountInfo<'b>,
    signers: &'a [AccountInfo<'b>],
}

impl<'a, 'b> Movement<'a, 'b> {
    fn read(program_id: &Pubkey, accounts: &'a [AccountInfo<'b>]) -> Result<Self, ProgramError> {
        let [state_account, asset_mint, share_mint, asset_account, source, authority, receiver, token_program, signers @ ..] =
            accounts
        else {
            return Err(VaultError::InvalidInvocation.into());
        };
        if signers.len() > MAX_SIGNERS {
            return Err(VaultError::InvalidInvocation.into());
        }
        if !spl_token_interface::check_id(token_program.key) {
            return Err(ProgramError::IncorrectProgramId);
        }
        let state = load(program_id, state_account)?;
        if asset_mint.key.to_bytes() != state.asset_mint
            || share_mint.key.to_bytes() != state.share_mint
            || *asset_account.key != asset_account_address(state_account.key, asset_mint.key)
        {
            return Err(VaultError::InvalidVault.into());
        }
        Ok(Self {
            state,
            state_account,
            asset_mint,
            share_mint,
            asset_account,
            source,
            authority,
            receiver,
            token_program,
            signers,
        })
    }

    /// The keys of the signers of a multisig authority.
    fn signer_keys(&self) -> Vec<&Pubkey> {
        self.signers.iter().map(|signer| signer.key).collect()
    }

    /// A token instruction of the caller's authority: `accounts`, the authority, its signers.
    fn by_caller(&self, instruction: &Instruction, accounts: &[&AccountInfo<'b>]) -> ProgramResult {
        let mut infos: Vec<AccountInfo<'b>> = accounts.iter().map(|&info| info.clone()).collect();
        infos.push(self.authority.clone());
        infos.extend(self.signers.iter().cloned());
        invoke(instruction, &infos)
    }

    /// A token instruction that the vault's state signs.
    fn by_vault(&self, instruction: &Instruction, accounts: &[&AccountInfo<'b>]) -> ProgramResult {
        let mut infos: Vec<AccountInfo<'b>> = accounts.iter().map(|&info| info.clone()).collect();
        infos.push(self.state_account.clone());
        invoke_signed(
            instruction,
            &infos,
            &[&[
                VAULT_SEED,
                &self.state.admin,
                &self.state.name,
                &[self.state.bump],
            ]],
        )
    }
}

/// The balance of an SPL Token account.
fn balance(account: &AccountInfo) -> Result<u64, ProgramError> {
    if !spl_token_interface::check_id(account.owner) {
        return Err(VaultError::InvalidVault.into());
    }
    Ok(TokenAccount::unpack(&account.try_borrow_data()?)
        .map_err(|_| VaultError::InvalidVault)?
        .amount)
}

/// Accounts: state, asset mint, share mint (w), the vault's asset account (w), the source asset
/// account (w), its authority, the receiving share account (w), SPL Token, then the signers of
/// a multisig authority. The authority is the owner or the delegate of the source: a signer of
/// the transaction, a program-derived address that its program signs for, or an SPL Token
/// multisig whose signers follow.
fn deposit(program_id: &Pubkey, accounts: &[AccountInfo], assets: u64) -> ProgramResult {
    let m = Movement::read(program_id, accounts)?;
    let shares = shares_for(assets, m.state.share_price)?;
    if m.source.key == m.asset_account.key {
        return Err(VaultError::InvalidInvocation.into());
    }
    m.by_caller(
        &token::transfer_checked(
            m.token_program.key,
            m.source.key,
            m.asset_mint.key,
            m.asset_account.key,
            m.authority.key,
            &m.signer_keys(),
            assets,
            m.state.asset_decimals,
        )?,
        &[m.source, m.asset_mint, m.asset_account],
    )?;
    m.by_vault(
        &token::mint_to_checked(
            m.token_program.key,
            m.share_mint.key,
            m.receiver.key,
            m.state_account.key,
            &[],
            shares,
            m.state.share_decimals,
        )?,
        &[m.share_mint, m.receiver],
    )?;
    set_return_data(&shares.to_le_bytes());
    Ok(())
}

/// Accounts: state, asset mint, share mint (w), the vault's asset account (w), the source share
/// account (w), its authority, the receiving asset account (w), SPL Token, then the signers of
/// a multisig authority. The authority is as for a deposit.
fn redeem(program_id: &Pubkey, accounts: &[AccountInfo], shares: u64) -> ProgramResult {
    let m = Movement::read(program_id, accounts)?;
    let assets = assets_for(shares, m.state.share_price)?;
    if m.receiver.key == m.asset_account.key {
        return Err(VaultError::InvalidInvocation.into());
    }
    if balance(m.source)? < shares {
        return Err(VaultError::InsufficientShares.into());
    }
    if balance(m.asset_account)? < assets {
        return Err(VaultError::InsufficientAssets.into());
    }
    m.by_caller(
        &token::burn_checked(
            m.token_program.key,
            m.source.key,
            m.share_mint.key,
            m.authority.key,
            &m.signer_keys(),
            shares,
            m.state.share_decimals,
        )?,
        &[m.source, m.share_mint],
    )?;
    m.by_vault(
        &token::transfer_checked(
            m.token_program.key,
            m.asset_account.key,
            m.asset_mint.key,
            m.receiver.key,
            m.state_account.key,
            &[],
            assets,
            m.state.asset_decimals,
        )?,
        &[m.asset_account, m.asset_mint, m.receiver],
    )?;
    set_return_data(&assets.to_le_bytes());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversions_round_down_and_refuse_zero_and_overflow() {
        // One asset per share.
        assert_eq!(shares_for(5_000_000, SHARE), Ok(5_000_000));
        assert_eq!(assets_for(5_000_000, SHARE), Ok(5_000_000));
        // 0.94 assets per share: a deposit and a redeem both round toward the vault.
        assert_eq!(shares_for(1_000_000, 940_000), Ok(1_063_829));
        assert_eq!(assets_for(1_063_829, 940_000), Ok(999_999));
        assert_eq!(assets_for(1, 1_999_999), Ok(1));
        assert_eq!(shares_for(0, SHARE), Err(VaultError::NotPositive));
        assert_eq!(assets_for(0, SHARE), Err(VaultError::NotPositive));
        assert_eq!(shares_for(1, 0), Err(VaultError::NotPositive));
        assert_eq!(shares_for(1, 2 * SHARE), Err(VaultError::ZeroResult));
        assert_eq!(assets_for(1, SHARE - 1), Err(VaultError::ZeroResult));
        assert_eq!(shares_for(u64::MAX, 1), Err(VaultError::Overflow));
        assert_eq!(assets_for(u64::MAX, SHARE + 1), Err(VaultError::Overflow));
        assert_eq!(assets_for(u64::MAX, SHARE), Ok(u64::MAX));
    }

    #[test]
    fn the_state_and_the_instructions_keep_their_bytes() {
        let state = VaultState {
            bump: 254,
            shares_bump: 253,
            asset_decimals: 6,
            share_decimals: 6,
            admin: [1; 32],
            asset_mint: [2; 32],
            share_mint: [3; 32],
            name: [4; 32],
            share_price: 940_000,
        };
        let bytes = state.to_bytes();
        assert_eq!(VaultState::from_bytes(&bytes), Some(state));
        assert_eq!(bytes[..12], *b"alwtvlt\x01\xfe\xfd\x06\x06");
        assert_eq!(bytes[140..], 940_000u64.to_le_bytes());
        assert_eq!(VaultState::from_bytes(&bytes[1..]), None);
        let mut other = bytes;
        other[7] = 2;
        assert_eq!(VaultState::from_bytes(&other), None);

        for instruction in [
            VaultInstruction::Initialize {
                name: [7; 32],
                share_price: SHARE,
            },
            VaultInstruction::SetSharePrice { share_price: 1 },
            VaultInstruction::Deposit { assets: 2 },
            VaultInstruction::Redeem { shares: 3 },
            VaultInstruction::SharePrice,
            VaultInstruction::PreviewDeposit { assets: 4 },
            VaultInstruction::PreviewRedeem { shares: 5 },
        ] {
            let data = instruction.pack();
            assert_eq!(VaultInstruction::unpack(&data), Some(instruction));
            // No instruction reads data that is shorter or longer than its own.
            assert_eq!(VaultInstruction::unpack(&data[..data.len() - 1]), None);
            let longer = [data.as_slice(), &[0]].concat();
            assert_eq!(VaultInstruction::unpack(&longer), None);
        }
        assert_eq!(VaultInstruction::Deposit { assets: 2 }.pack()[0], 2);
        assert_eq!(VaultInstruction::unpack(&[]), None);
        assert_eq!(VaultInstruction::unpack(&[7]), None);
    }
}
