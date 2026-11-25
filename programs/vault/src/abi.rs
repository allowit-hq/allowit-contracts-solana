use borsh::{BorshDeserialize, BorshSerialize};

pub const ABI: u8 = 3;
pub const VAULT_SEED: &[u8] = b"allowit-vault-v3";
pub const SIMPLE: u8 = 1;
pub const STANDARD: u8 = 2;
pub const CUSTOM: u8 = 3;
pub const DECIMALS: u8 = 6;

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub enum Operations {
    Any,
    Names(Vec<String>),
}

/// One typed value per rule, in the same order as the rule indices.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub enum Param {
    Amount(i128),
    Count(u64),
    Expiry(i64),
    Addresses(Vec<[u8; 32]>),
    Operations(Operations),
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Default, Eq, PartialEq)]
pub struct Figures {
    pub calls: u64,
    pub spent: i128,
    pub day: u64,
    pub day_spent: i128,
    pub day_total: i128,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub struct VaultState {
    pub abi: u8,
    pub bump: u8,
    pub kind: u8,
    pub paused: bool,
    pub version: u32,
    pub owner: [u8; 32],
    pub agent: [u8; 32],
    pub server: [u8; 32],
    pub mint: [u8; 32],
    pub instance_id: [u8; 32],
    pub created_slot: u64,
    pub source_hash: [u8; 32],
    pub check_program: [u8; 32],
    pub nonce: u64,
    pub figures: Figures,
    pub rules: Vec<u8>,
    pub params: Vec<Param>,
}

/// Little-endian input to a Custom check CPI, with figures before this transfer.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct CustomCheckInput {
    pub abi: u8,
    pub amount: u64,
    pub recipient: [u8; 32],
    pub mint: [u8; 32],
    pub now: i64,
    pub day: u64,
    pub calls: u64,
    pub spent: i128,
    pub day_spent: i128,
    pub day_total: i128,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Eq, PartialEq)]
pub enum VaultInstruction {
    /// State, owner, mint, vault ATA, System, Token, Associated Token.
    Initialize {
        instance_id: [u8; 32],
        kind: u8,
        agent: [u8; 32],
        server: [u8; 32],
        source_hash: [u8; 32],
        check_program: [u8; 32],
        rules: Vec<u8>,
        params: Vec<Param>,
    },
    /// State, agent, server, mint, vault ATA, destination, Token.
    /// Custom adds the check program and its optional writable wallet state.
    Execute {
        amount: u64,
        nonce: u64,
        version: u32,
        created_slot: u64,
        expires_at: i64,
    },
    /// State, owner.
    SetPause { paused: bool, version: u32 },
    /// State, owner, mint, vault ATA, owner's destination, Token.
    Stop { version: u32 },
    /// State, owner, mint, vault ATA, owner's destination, Token.
    Recover { amount: u64 },
    /// State, writable owner and System.
    UpdatePolicy {
        version: u32,
        agent: [u8; 32],
        server: [u8; 32],
        source_hash: [u8; 32],
        check_program: [u8; 32],
        rules: Vec<u8>,
        params: Vec<Param>,
    },
    /// State, owner, mint, vault ATA, owner's destination, Token.
    Close { version: u32 },
}

/// Vault error codes, all below 100: Allowit's wallet error codes, the same on every rail. A
/// denial by a standard rule collapses to `PolicyDenied`; a Core error about owner params, state,
/// overflow or an unsupported operation keeps its own code.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    InvalidState = 1,
    /// Invalid owner params or rules, or a param that a rule cannot decode.
    InvalidParam = 2,
    UnsupportedAsset = 3,
    InvalidActor = 4,
    StaleRequest = 5,
    Paused = 6,
    Expired = 7,
    InvalidAmount = 8,
    InvalidRecipient = 9,
    Overflow = 11,
    InsufficientFunds = 14,
    UnsupportedOperation = 16,
    InvalidInvocation = 17,
    /// A standard rule denied the request.
    PolicyDenied = 18,
}

impl From<VaultError> for solana_program_error::ProgramError {
    fn from(error: VaultError) -> Self {
        Self::Custom(error as u32)
    }
}
