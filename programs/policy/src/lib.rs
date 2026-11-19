#![cfg_attr(target_os = "solana", no_std)]
// The hash-locked shared policy source (policy/policy_api.rs) names the other rail's build feature,
// which this rail never sets.
#![allow(unexpected_cfgs)]
use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};
#[path = "../../../policy/policy.rs"]
pub mod policy;
#[path = "../../../policy/policy_api.rs"]
pub mod policy_api;
#[path = "../../../policy/source_hash.rs"]
mod source_hash;
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::program_entrypoint!(process_instruction, 1);
pinocchio::no_allocator!();
pinocchio::nostd_panic_handler!();
fn word(data: &[u8], start: usize) -> u64 {
    u64::from_le_bytes(data[start..start + 8].try_into().unwrap())
}
fn process_instruction(_: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if !accounts.is_empty() {
        return Err(ProgramError::InvalidArgument);
    }
    let (binding, result) = match data.first() {
        Some(0) if data.len() == 74 && data[1] <= 1 => {
            let context = policy_api::Context {
                approved: data[1] == 1,
                amount: word(data, 2),
                daily_limit: word(data, 10),
                spent: word(data, 18),
                spent_day: word(data, 26),
                now: word(data, 34),
            };
            (&data[42..74], policy::execute(&context))
        }
        Some(1) if data.len() == 41 => (
            &data[9..41],
            policy_api::validate_daily_limit(word(data, 1)).map(|_| 0),
        ),
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    let (error, next) = match result {
        Ok(next) => (0u32, next),
        Err(error) => (error as u32, 0),
    };
    let mut response = [0u8; 77];
    response[0] = 2;
    response[1..5].copy_from_slice(&error.to_le_bytes());
    response[5..37].copy_from_slice(binding);
    response[37..69].copy_from_slice(&source_hash::SOURCE_HASH);
    response[69..77].copy_from_slice(&next.to_le_bytes());
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_set_return_data(response.as_ptr(), response.len() as u64);
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../../policy/tests.rs"]
mod tests;
