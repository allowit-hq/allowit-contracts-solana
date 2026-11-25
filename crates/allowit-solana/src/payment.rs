//! A payment from a Native wallet that the server pays the fee of: the agent and the server
//! authorize the same exact bytes, the bytes are retained before they leave, and the receipt is
//! what the ledger moved, not what was asked.
//!
//! - Every transaction carries its request id in its memo, so two requests are never one
//!   transaction.
//! - [`authorize`]: the server builds the payment, signs it as fee payer and as one of the
//!   delegate's two signers, and retains it under the request id. The transaction's id is the
//!   server's signature, so it is known before the agent signs.
//! - [`countersign`]: the agent builds the same payment from its own request and signs only
//!   bytes that are equal to it and that the wallet's server signed.
//! - [`submit`]: the server takes the agent's signature for the retained bytes and sends them.
//! - [`status`]: one read of the ledger; identical bytes go again while they are valid. A lapse
//!   ends the payment: a request id is never authorized twice, so a new payment is a new request.
//! - [`receipt`]: the finalized transaction is the retained one, and the wallet's account lost
//!   and the destination gained exactly the amount.
use crate::native::{Address, Budget, Wallet};
use crate::owner::{Journal, Ledger, Resolution, Retained, resolve};
use allowit_core::vendor::{
    error::{Error, Result},
    runtime::Signer,
};
use ed25519_dalek::{Signature as Ed25519Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use solana_hash::Hash;
use solana_signature::Signature;

/// The compute units of a `TransferChecked` whose authority is a two-signer multisig, with room.
pub const TRANSFER_UNITS: u32 = 6_000;

/// The compute units that the deployed Memo program takes for a memo of `len` bytes, with room.
/// Simulated on Solana Devnet (2026-11-24): 8 bytes took 4,273 units, 32 took 12,775, 72 took
/// 27,043, 78 took 29,269 and 100 took 36,890: about 355 a byte. The Memo program that LiteSVM
/// bundles takes far less, so a ledger test does not show this cost.
pub fn memo_units(len: usize) -> u32 {
    1_500u32.saturating_add(370u32.saturating_mul(u32::try_from(len).unwrap_or(u32::MAX)))
}

/// The least compute-unit limit of a payment with a memo of `memo_len` bytes. A lower limit
/// fails on the ledger after the fee is paid.
pub fn min_units(memo_len: usize) -> u32 {
    TRANSFER_UNITS.saturating_add(memo_units(memo_len))
}

/// What the agent asks the wallet to pay.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payment<'a> {
    /// The recipient's token account of the wallet's mint.
    pub destination: Address,
    /// The amount in base units of the mint.
    pub amount: u64,
    pub decimals: u8,
    pub memo: Option<&'a str>,
    pub budget: Budget,
}

/// Where a payment stands. Each names the transaction by the server's signature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Finalized without an error: read the [`receipt`].
    Settled { signature: [u8; 64] },
    /// Finalized with an error: nothing moved, and the fee was paid.
    Failed { signature: [u8; 64] },
    /// Sent and not finalized, or sent again.
    Pending { signature: [u8; 64] },
    /// Authorized by the server; the agent has not signed yet.
    Unsigned { signature: [u8; 64] },
    /// The bytes never ran and can no longer run. What was reserved for them is free.
    Lapsed { signature: [u8; 64] },
}

/// A token balance of one account of a finalized transaction, before and after it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenBalance {
    /// The account's place among the message's account keys.
    pub index: usize,
    pub mint: Address,
    pub before: u64,
    pub after: u64,
}

/// A finalized transaction as the ledger reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finalized {
    /// The signed bytes that the ledger holds.
    pub wire: Vec<u8>,
    pub failed: bool,
    /// The network fee that the fee payer paid, in lamports.
    pub fee: u64,
    pub slot: u64,
    /// The time of the block, in seconds: the time that a daily limit counts the payment at.
    pub block_time: Option<u64>,
    pub balances: Vec<TokenBalance>,
}

/// The ledger's record of finalized transactions.
pub trait Receipts {
    /// The finalized transaction of `signature`; `None` while there is none.
    fn transaction(&self, signature: &[u8; 64]) -> Result<Option<Finalized>>;
}

/// What a finalized payment did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub signature: [u8; 64],
    pub failed: bool,
    pub slot: u64,
    pub block_time: Option<u64>,
    /// The network fee in lamports. The server paid it; it is no debit of the wallet's asset.
    pub fee: u64,
    /// What the wallet's account lost, in base units of the mint: the amount, or zero for a
    /// failed transaction.
    pub debit: u64,
    /// What the destination gained.
    pub credit: u64,
}

fn identity(wallet: &Wallet, payment: &Payment<'_>) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"allowit-solana-payment-v1\0");
    for key in [
        &wallet.owner,
        &wallet.mint,
        &wallet.agent,
        &wallet.server,
        &payment.destination,
    ] {
        hash.update(key.as_ref());
    }
    hash.update(payment.amount.to_le_bytes());
    hash.update([payment.decimals]);
    hash.update(payment.budget.units.to_le_bytes());
    hash.update(payment.budget.micro_lamports_per_unit.to_le_bytes());
    match payment.memo {
        None => hash.update([0]),
        Some(memo) => {
            hash.update([1]);
            hash.update((memo.len() as u64).to_le_bytes());
            hash.update(memo.as_bytes());
        }
    }
    hash.finalize().into()
}

fn check_id(request_id: &str) -> Result<()> {
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(Error::usage(
            "A request id has 1 to 128 visible ASCII characters",
        ));
    }
    Ok(())
}

/// The memo of the transaction: the request id, then the payment's own memo. Two requests for
/// the same payment in the life of one blockhash would otherwise be one transaction with one
/// signature, and one transfer would settle both.
fn memo(request_id: &str, payment: &Payment<'_>) -> String {
    match payment.memo {
        None => format!("allowit:{request_id}"),
        Some(memo) => format!(
            "allowit:{request_id}
{memo}"
        ),
    }
}

/// The two signatures and the message of a payment's wire bytes: the fee payer's place first.
pub(crate) fn parts(wire: &[u8]) -> Result<(&[u8], &[u8], &[u8])> {
    if wire.len() < 129 + 36 || wire[0] != 2 {
        return Err(Error::usage(
            "A Native payment that the server pays has two signatures",
        ));
    }
    Ok((&wire[1..65], &wire[65..129], &wire[129..]))
}

/// The account keys of a legacy message that the rail built: at most 127, so one length byte.
pub(crate) fn account_keys(message: &[u8]) -> Result<Vec<Address>> {
    let bad = || Error::usage("The transaction is not a message of this rail");
    let count = usize::from(*message.get(3).ok_or_else(bad)?);
    if count >= 128 || message.len() < 4 + 32 * count + 32 {
        return Err(bad());
    }
    Ok(message[4..4 + 32 * count]
        .as_chunks::<32>()
        .0
        .iter()
        .map(|key| Address::new_from_array(*key))
        .collect())
}

pub(crate) fn blockhash(message: &[u8]) -> Result<Hash> {
    let keys = account_keys(message)?.len();
    let at = 4 + 32 * keys;
    Ok(Hash::new_from_array(
        message[at..at + 32].try_into().expect("32 bytes"),
    ))
}

pub(crate) fn verify(key: &Address, message: &[u8], signature: &[u8]) -> Result<()> {
    let invalid = || Error::usage("A signature of the payment is invalid");
    VerifyingKey::from_bytes(&key.to_bytes())
        .map_err(|_| invalid())?
        .verify_strict(
            message,
            &Ed25519Signature::from_slice(signature).map_err(|_| invalid())?,
        )
        .map_err(|_| invalid())
}

fn signed(wire: &[u8]) -> Result<[u8; 64]> {
    Ok(parts(wire)?.0.try_into().expect("64 bytes"))
}

/// The server authorizes `payment` under `request_id`: it builds the transaction with itself as
/// the fee payer, signs it and retains it. The bytes go to the agent, whose place is empty. A
/// repeat of the id returns the retained bytes and signs nothing: one id, one authorization.
pub fn authorize(
    ledger: &dyn Ledger,
    journal: &dyn Journal,
    server: &dyn Signer,
    wallet: &Wallet,
    request_id: &str,
    payment: &Payment<'_>,
) -> Result<Vec<u8>> {
    wallet.check()?;
    check_id(request_id)?;
    if server.identity() != wallet.server.to_string() {
        return Err(Error::usage(
            "Only the wallet's server authorizes a payment",
        ));
    }
    let identity = identity(wallet, payment);
    if let Some(retained) = journal.load(request_id)? {
        if retained.request != identity {
            return Err(Error::usage(
                "This request id names another payment; use a new id for a new payment",
            ));
        }
        return Ok(retained.wire);
    }
    let memo = memo(request_id, payment);
    if payment.budget.units < min_units(memo.len()) {
        return Err(Error::usage(format!(
            "The payment's compute-unit limit is below the {} units that its transfer and its {}-byte memo take",
            min_units(memo.len()),
            memo.len()
        )));
    }
    let recent = ledger.recent()?;
    let prepared = wallet.payment(
        &payment.destination,
        payment.amount,
        payment.decimals,
        payment.budget,
        Some(&memo),
        &wallet.server,
        recent.blockhash,
    )?;
    let (address, signature) = prepared.sign(server)?;
    let wire = prepared.wire(&[(address, signature)])?;
    journal.save(
        request_id,
        &Retained {
            request: identity,
            wire: wire.clone(),
            signature: signature.into(),
            last_valid_height: recent.last_valid_height,
        },
    )?;
    Ok(wire)
}

/// The agent signs the server's `wire` only if it is exactly `payment` of `request_id` from `wallet`, paid by the
/// wallet's server and signed by it. The blockhash is the server's; everything else is the
/// agent's own request, rebuilt and compared byte for byte.
pub fn countersign(
    wire: &[u8],
    agent: &dyn Signer,
    wallet: &Wallet,
    request_id: &str,
    payment: &Payment<'_>,
) -> Result<Vec<u8>> {
    wallet.check()?;
    check_id(request_id)?;
    if agent.identity() != wallet.agent.to_string() {
        return Err(Error::usage(
            "Only the wallet's agent countersigns a payment",
        ));
    }
    let (server_signature, agent_place, message) = parts(wire)?;
    let prepared = wallet.payment(
        &payment.destination,
        payment.amount,
        payment.decimals,
        payment.budget,
        Some(&memo(request_id, payment)),
        &wallet.server,
        blockhash(message)?,
    )?;
    if prepared.message_bytes() != message {
        return Err(Error::usage(
            "The server's transaction is not the payment that the agent asked for",
        ));
    }
    if agent_place != [0u8; 64] {
        return Err(Error::usage("The payment already holds an agent signature"));
    }
    verify(&wallet.server, message, server_signature)?;
    let server_signature: [u8; 64] = server_signature.try_into().expect("64 bytes");
    prepared.wire(&[
        (wallet.server, Signature::from(server_signature)),
        prepared.sign(agent)?,
    ])
}

/// The server takes the agent's signature: `wire` must be the retained bytes of `request_id`
/// with a valid agent signature in its place. The complete bytes are retained, then sent.
pub fn submit(
    ledger: &dyn Ledger,
    journal: &dyn Journal,
    wallet: &Wallet,
    request_id: &str,
    wire: &[u8],
) -> Result<Outcome> {
    check_id(request_id)?;
    let mut retained = journal
        .load(request_id)?
        .ok_or_else(|| Error::usage("No payment is authorized under this request id"))?;
    let (server_signature, agent_signature, message) = parts(wire)?;
    let (_, _, authorized) = parts(&retained.wire)?;
    if message != authorized || server_signature != retained.signature {
        return Err(Error::usage(
            "The signed transaction is not the one authorized under this request id",
        ));
    }
    verify(&wallet.agent, message, agent_signature)?;
    if retained.wire != wire {
        retained.wire = wire.to_vec();
        journal.save(request_id, &retained)?;
    }
    status(ledger, journal, request_id)
}

/// Where the payment of `request_id` stands. A complete payment without a status goes again as
/// the identical bytes while its blockhash is valid.
pub fn status(ledger: &dyn Ledger, journal: &dyn Journal, request_id: &str) -> Result<Outcome> {
    check_id(request_id)?;
    let retained = journal
        .load(request_id)?
        .ok_or_else(|| Error::usage("No payment is authorized under this request id"))?;
    let signature = retained.signature;
    Ok(match resolve(ledger, &retained)? {
        Resolution::Settled => Outcome::Settled { signature },
        Resolution::Failed => Outcome::Failed { signature },
        Resolution::Pending => Outcome::Pending { signature },
        Resolution::Lapsed => Outcome::Lapsed { signature },
        Resolution::Unsent if parts(&retained.wire)?.1 == [0u8; 64] => {
            Outcome::Unsigned { signature }
        }
        Resolution::Unsent => {
            // A refusal proves nothing: the next read of the ledger decides.
            let _ = ledger.submit(&retained.wire);
            Outcome::Pending { signature }
        }
    })
}

/// The receipt of the payment of `request_id`, once it is finalized: `None` before. The ledger's
/// transaction must be the retained bytes, and a successful one must have moved exactly the
/// amount from the wallet's account to the destination, in the wallet's mint.
pub fn receipt(
    ledger: &dyn Receipts,
    journal: &dyn Journal,
    wallet: &Wallet,
    payment: &Payment<'_>,
    request_id: &str,
) -> Result<Option<Receipt>> {
    check_id(request_id)?;
    let retained = journal
        .load(request_id)?
        .ok_or_else(|| Error::usage("No payment is authorized under this request id"))?;
    if retained.request != identity(wallet, payment) {
        return Err(Error::usage("This request id names another payment"));
    }
    let Some(finalized) = ledger.transaction(&retained.signature)? else {
        return Ok(None);
    };
    let differs = |what: &str| {
        Error::config(format!(
            "The ledger's transaction differs from the authorized payment: {what}"
        ))
    };
    let (_, _, message) = parts(&finalized.wire).map_err(|_| differs("its form"))?;
    if message != parts(&retained.wire)?.2 || signed(&finalized.wire)? != retained.signature {
        return Err(differs("its bytes"));
    }
    let mut receipt = Receipt {
        signature: retained.signature,
        failed: finalized.failed,
        slot: finalized.slot,
        block_time: finalized.block_time,
        fee: finalized.fee,
        debit: 0,
        credit: 0,
    };
    if finalized.failed {
        return Ok(Some(receipt));
    }
    let keys = account_keys(message)?;
    let change = |account: &Address, what: &str| -> Result<(u64, u64)> {
        let index = keys
            .iter()
            .position(|key| key == account)
            .ok_or_else(|| differs(what))?;
        let balance = finalized
            .balances
            .iter()
            .find(|balance| balance.index == index && balance.mint == wallet.mint)
            .ok_or_else(|| differs(what))?;
        Ok((balance.before, balance.after))
    };
    let (before, after) = change(&wallet.token_account(), "the wallet's balance")?;
    receipt.debit = before
        .checked_sub(after)
        .ok_or_else(|| differs("the wallet's balance"))?;
    let (before, after) = change(&payment.destination, "the destination's balance")?;
    receipt.credit = after
        .checked_sub(before)
        .ok_or_else(|| differs("the destination's balance"))?;
    if receipt.debit != payment.amount || receipt.credit != payment.amount {
        return Err(differs("the amount that moved"));
    }
    Ok(Some(receipt))
}
