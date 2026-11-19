// The hash-locked shared policy source (policy/policy_api.rs) names the other rail's build feature,
// which this rail never sets.
#![allow(unexpected_cfgs)]
use borsh::{BorshDeserialize, BorshSerialize};
#[path = "../../../policy/policy.rs"]
pub mod policy;
#[path = "../../../policy/policy_api.rs"]
pub mod policy_api;

pub const ABI_VERSION: u8 = 2;
pub const VAULT_SEED: &[u8] = b"allowit-vault-v2";
/// 347 serialized bytes plus zero padding. ABI 1's 320-byte state is incompatible.
pub const STATE_BYTES: usize = 352;
pub const MAX_APPROVAL_SECONDS: u64 = 300;
#[derive(Clone, Debug, BorshDeserialize, BorshSerialize)]
pub struct VaultState {
    pub abi: u8,
    pub bump: u8,
    pub owner: [u8; 32],
    pub executor: [u8; 32],
    pub mint: [u8; 32],
    pub token_account: [u8; 32],
    pub policy: [u8; 32],
    pub policy_source: [u8; 32],
    pub policy_artifact: [u8; 32],
    pub vault_id: [u8; 32],
    pub daily_limit: u64,
    pub spent: u64,
    pub spent_day: u64,
    pub nonce: u64,
    pub revision: u64,
    pub approved: bool,
    pub authority: [u8; 32],
    pub action_limit: u64,
    /// The chain slot of initialization. Closure requires a later slot, so a
    /// recreated PDA cannot accept a prior instance's signed execution.
    pub instance_slot: u64,
}
#[derive(Clone, Debug, BorshDeserialize, BorshSerialize)]
pub enum VaultInstruction {
    Initialize {
        vault_id: [u8; 32],
        policy_source: [u8; 32],
        policy_artifact: [u8; 32],
        daily_limit: u64,
        action_limit: u64,
    },
    Deposit {
        amount: u64,
    },
    Approve {
        approved: bool,
        expected_revision: u64,
    },
    SetDailyLimit {
        value: u64,
        expected_revision: u64,
    },
    Transfer {
        amount: u64,
        nonce: u64,
        expected_revision: u64,
        expires_at: u64,
        /// Canonical server assessment/request commitment, signed in the exact
        /// transaction message. This is trusted authorization, not a ZK proof.
        commitment: [u8; 32],
        expected_instance_slot: u64,
    },
    Withdraw {
        amount: u64,
    },
    SetPolicy {
        policy_source: [u8; 32],
        policy_artifact: [u8; 32],
        expected_revision: u64,
    },
    Unsupported {
        method: u32,
    },
    SetActionLimit {
        value: u64,
        expected_revision: u64,
    },
    Close {
        expected_revision: u64,
        expected_instance_slot: u64,
    },
}
#[derive(Clone, Debug, BorshDeserialize, BorshSerialize)]
pub struct Evaluation {
    pub approved: bool,
    pub amount: u64,
    pub daily_limit: u64,
    pub spent: u64,
    pub spent_day: u64,
    pub now: u64,
    pub binding: [u8; 32],
}
impl Evaluation {
    pub fn context(&self) -> policy_api::Context {
        policy_api::Context {
            approved: self.approved,
            amount: self.amount,
            daily_limit: self.daily_limit,
            spent: self.spent,
            spent_day: self.spent_day,
            now: self.now,
        }
    }
}
#[derive(Clone, Debug, BorshDeserialize, BorshSerialize)]
pub enum PolicyInstruction {
    Evaluate(Evaluation),
    ValidateDailyLimit { value: u64, binding: [u8; 32] },
}
#[derive(Clone, Debug, BorshDeserialize, BorshSerialize)]
pub struct PolicyDecision {
    pub abi: u8,
    pub error: u32,
    pub binding: [u8; 32],
    pub source: [u8; 32],
    pub next_spent: u64,
}
