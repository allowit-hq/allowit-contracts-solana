//! Exact SPL approval/revocation instruction templates. The caller admits and signs the bound operation.
use allowit_native::{
    client::{ATA_PROGRAM, TOKEN_PROGRAM},
    crypto::Key,
};
use allowit_sdk::service::{Error, Result, bad, fault};

const COMPUTE: &str = "ComputeBudget111111111111111111111111111111";
const MEMO: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

pub struct Account {
    pub key: [u8; 32],
    pub writable: bool,
    pub signer: bool,
}
pub struct Instruction {
    pub program: [u8; 32],
    pub accounts: Vec<Account>,
    pub data: Vec<u8>,
}
/// Public, owner-bound terms only. No private key enters this request.
pub struct Terms<'a> {
    pub owner: &'a str,
    pub source_token_account: &'a str,
    pub mint: &'a str,
    pub delegate: &'a str,
    pub budget_units: u64,
    pub commitment_hash: &'a str,
}
fn key(address: &str) -> Result<[u8; 32]> {
    Key::parse(address)
        .map(|key| key.0)
        .map_err(|_| bad("Invalid Solana public key."))
}
fn storage_error() -> Error {
    fault(500, "Saved state could not be read.")
}

pub fn associated_account(owner: &str, mint: &str) -> Result<[u8; 32]> {
    let owner = Key(key(owner)?);
    let mint = Key(key(mint)?);
    let token = Key(key(TOKEN_PROGRAM)?);
    Key::find_program_address(&[&owner.0, &token.0, &mint.0], Key(key(ATA_PROGRAM)?))
        .map(|value| value.0.0)
        .map_err(|_| bad("Cannot derive the USDC account."))
}

pub fn compute_budget(limit: u32, price: u64) -> Result<Vec<Instruction>> {
    let mut units = vec![2];
    units.extend(limit.to_le_bytes());
    let mut fee = vec![3];
    fee.extend(price.to_le_bytes());
    Ok(vec![
        Instruction {
            program: key(COMPUTE)?,
            accounts: vec![],
            data: units,
        },
        Instruction {
            program: key(COMPUTE)?,
            accounts: vec![],
            data: fee,
        },
    ])
}

pub fn approval_instructions(terms: &Terms<'_>, action: &str) -> Result<Vec<Instruction>> {
    let source = key(terms.source_token_account)?;
    let owner = key(terms.owner)?;
    let account = |key, writable, signer| Account {
        key,
        writable,
        signer,
    };
    let (data, accounts) = match action {
        "approve" => {
            let mut data = vec![13];
            data.extend(terms.budget_units.to_le_bytes());
            data.push(6);
            (
                data,
                vec![
                    account(source, true, false),
                    account(key(terms.mint)?, false, false),
                    account(key(terms.delegate)?, false, false),
                    account(owner, false, true),
                ],
            )
        }
        "revoke" => (
            vec![5],
            vec![account(source, true, false), account(owner, false, true)],
        ),
        _ => return Err(bad("Unsupported setup operation.")),
    };
    Ok(vec![
        Instruction {
            program: key(TOKEN_PROGRAM)?,
            accounts,
            data,
        },
        Instruction {
            program: key(MEMO)?,
            accounts: vec![],
            data: format!("allowit-grant-v1:{}", terms.commitment_hash).into_bytes(),
        },
    ])
}

/// Add the already admitted one-use signer to the protective memo, preserving the instruction bytes.
pub fn with_memo_signer(
    mut instructions: Vec<Instruction>,
    signer: &str,
) -> Result<Vec<Instruction>> {
    instructions.last_mut().ok_or_else(storage_error)?.accounts = vec![Account {
        key: key(signer)?,
        writable: false,
        signer: true,
    }];
    Ok(instructions)
}
