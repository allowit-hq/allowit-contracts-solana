use borsh::BorshDeserialize;
use solana_account_info::AccountInfo;
use solana_program_error::{ProgramError, ProgramResult};
use solana_pubkey::Pubkey;

const VAULT_PROGRAM: Pubkey = Pubkey::new_from_array([10; 32]);
const VAULT_SEED: &[u8] = b"allowit-vault-v3";
const ABI: u8 = 3;
const LIMIT: u64 = 3_000_000;
const LIMIT_EXCEEDED: u32 = 3001;

#[derive(BorshDeserialize)]
struct CheckInput {
    abi: u8,
    amount: u64,
    _recipient: [u8; 32],
    mint: [u8; 32],
    now: i64,
    day: u64,
    _calls: u64,
    _spent: i128,
    _day_spent: i128,
    _day_total: i128,
}

solana_program_entrypoint::entrypoint!(process_instruction);

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (vault, check_state) = match accounts {
        [vault] => (vault, None),
        [vault, check_state] => (vault, Some(check_state)),
        _ => return Err(ProgramError::NotEnoughAccountKeys),
    };
    if !vault.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if vault.is_writable || vault.owner != &VAULT_PROGRAM {
        return Err(ProgramError::InvalidAccountOwner);
    }

    let state = vault.try_borrow_data()?;
    // Borsh header through instance_id: offsets 8..40 (owner), 104..136 (mint), 136..168 (instance).
    let header = state.get(..168).ok_or(ProgramError::InvalidAccountData)?;
    let (expected, bump) = Pubkey::find_program_address(
        &[VAULT_SEED, &header[8..40], &header[136..168]],
        &VAULT_PROGRAM,
    );
    if header[0] != ABI || header[1] != bump || expected != *vault.key {
        return Err(ProgramError::InvalidSeeds);
    }
    if let Some(check_state) = check_state {
        let expected = Pubkey::find_program_address(&[vault.key.as_ref()], program_id).0;
        if !check_state.is_writable || *check_state.key != expected {
            return Err(ProgramError::InvalidSeeds);
        }
    }

    let input =
        CheckInput::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    let now = u64::try_from(input.now).map_err(|_| ProgramError::InvalidInstructionData)?;
    if input.abi != ABI || input.mint != header[104..136] || input.day != now / 86_400 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if input.amount > LIMIT {
        return Err(ProgramError::Custom(LIMIT_EXCEEDED));
    }
    Ok(())
}
