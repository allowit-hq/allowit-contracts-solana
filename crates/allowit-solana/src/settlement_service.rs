//! The Allowit facilitator's settlement service for x402 `exact` payments on Solana Devnet: the
//! rail's [`SettlementProvider`].
//!
//! A seller that names the Allowit facilitator forwards the client's partly signed payment and
//! its payment requirements. The host serves the routes and keeps the facilitator's fee-payer key
//! (from its configuration, never from a repository); this module checks the request, signs the
//! client's own transaction as fee payer and reads its settlement from the ledger.
//!
//! Before it signs, the service applies the minimal safety baseline of the x402 `exact` SVM
//! specification (section 2.1) through [`facilitator::check`]: the fee payer is in no
//! instruction and pays only the network fee, the transaction has no address lookup table, every
//! signature but the fee payer's is present and valid, and the transaction makes exactly the
//! required `TransferChecked` to the payee's associated token account. Then its own bounds: at
//! most three required signatures (a Native payment has the agent's, the server's and the
//! facilitator's), the compute budget of [`Policy::allowit`], the host's fee ceiling
//! ([`Limits::max_fee`]) and an hourly fee budget. The ledger must still accept the blockhash
//! and simulate the transaction.
//!
//! One payment settles once. The service keeps each payment that it signed, by the SHA-256 of
//! its message, with the signed bytes and their signature, before it sends them. A second
//! request for the same payment is refused as a duplicate. There is no one-at-a-time rule: a
//! Solana message carries a blockhash, not an account sequence, so settlements of different
//! payments run side by side.
//!
//! A submission whose answer is lost is not a failure. The service reads the outcome by the
//! signature and sends only the identical bytes again while their blockhash is valid; it never
//! builds a new transaction for the payment. The fee payer's signature is deterministic for its
//! message, so identical bytes are the only form the payment can take. The payment lapses when
//! a finalized block height is above the last valid block height of its blockhash and the
//! signature has no status: the reply then carries that lapse proof and the budget gets the
//! reserved fee back.
use crate::{
    facilitator::{self, Policy},
    native::{Address, MAX_TRANSACTION_BYTES},
    networks::DEVNET,
    owner::{self, Observation, Status},
    payment::{self, Finalized, Receipts},
    plugin::PLUGIN,
    rpc::Rpc,
    x402::{self, PaymentCheck},
};
use allowit_core::vendor::{
    error::{Error, Result},
    plugin::RailPlugin as _,
    runtime::Signer,
    settlement_service::{
        Authorization, Limits, Outcome, Settled, SettlementProvider, Supported, Verified,
    },
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use solana_hash::Hash;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// The x402 protocol version that this service reads.
pub const VERSION: u64 = 2;
/// The network fee that all settlements of one hour pay at most, in lamports: the default of
/// the host facilitator's hourly budget, 5,000,000, about 330 Native payments.
pub const HOURLY_FEE_LAMPORTS: u128 = 5_000_000;
/// How long the service keeps a payment that it signed. A blockhash lapses after 150 blocks,
/// about 90 seconds, so a duplicate after this time can no longer land either.
pub const KEEP_SECONDS: u64 = 3_600;
/// How often a settlement reads the ledger while it waits.
const POLL: Duration = Duration::from_secs(2);

/// The reason of a request that is not a well-formed `exact` request for Solana Devnet.
pub const INVALID_REQUEST: &str = "invalid_exact_svm_payload_request";
/// The reason of a transaction that fails the checks before signing.
pub const INVALID_TRANSACTION: &str = "invalid_exact_svm_payload_transaction";
/// The reason of an offer whose `expiresAt` has passed.
pub const OFFER_EXPIRED: &str = "invalid_exact_svm_payload_offer_expired";
/// The reason of a transaction whose blockhash the ledger no longer accepts.
pub const BLOCKHASH_EXPIRED: &str = "invalid_exact_svm_payload_blockhash_expired";
/// The reason of a transaction whose simulation fails.
pub const SIMULATION_FAILED: &str = "transaction_simulation_failed";
/// The reason of a payment that this service already signed (x402 duplicate settlement
/// mitigation).
pub const DUPLICATE: &str = "duplicate_settlement";
/// The reason of a settlement that the hourly fee budget cannot hold; the host's name for it.
pub const BUDGET_EXHAUSTED: &str = "facilitator_fee_budget_exhausted";
/// The reason of a transaction that the ledger finalized as failed.
pub const FAILED: &str = "settle_exact_svm_transaction_failed";
/// The reason of a transaction that landed without the required transfer.
pub const NOT_PAID: &str = "settle_exact_svm_transfer_not_found";
/// The reason of a transaction that lapsed without landing.
pub const LAPSED: &str = "settle_exact_svm_transaction_lapsed";
/// The reason of a settlement whose outcome the ledger has not shown yet.
pub const PENDING: &str = "settlement_pending";

/// The ledger that the service reads and writes, beside the rail's owner ledger: `submit` there
/// answers an error for an unknown outcome, and `observe` reads a signature's status with a
/// finalized block height.
pub trait SettlementLedger: owner::Ledger + Receipts {
    /// The genesis hash of the ledger's network, base58.
    fn genesis_hash(&self) -> Result<String>;
    /// `None` when the ledger no longer accepts `blockhash`. Otherwise an upper bound of the last
    /// block height at which a transaction with it is valid: the last valid block height of the
    /// ledger's latest blockhash, read after it accepted `blockhash`.
    fn blockhash_bound(&self, blockhash: &Hash) -> Result<Option<u64>>;
    /// Simulate `wire` without signature checks (the fee payer's place is empty). `Some` holds
    /// the reason when the simulation fails.
    fn simulate(&self, wire: &[u8]) -> Result<Option<String>>;
}

impl SettlementLedger for Rpc {
    fn genesis_hash(&self) -> Result<String> {
        self.0
            .call("getGenesisHash", json!([]))?
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| malformed("getGenesisHash"))
    }

    fn blockhash_bound(&self, blockhash: &Hash) -> Result<Option<u64>> {
        let valid = self.0.call(
            "isBlockhashValid",
            json!([blockhash.to_string(), {"commitment":"processed"}]),
        )?;
        let bad = || malformed("isBlockhashValid");
        let slot = valid["context"]["slot"].as_u64().ok_or_else(bad)?;
        if !valid["value"].as_bool().ok_or_else(bad)? {
            return Ok(None);
        }
        // A bank at or after the one that accepted the blockhash: its latest blockhash is valid
        // at least as long.
        let latest = self.0.call(
            "getLatestBlockhash",
            json!([{"commitment":"processed","minContextSlot":slot}]),
        )?;
        latest["value"]["lastValidBlockHeight"]
            .as_u64()
            .map(Some)
            .ok_or_else(|| malformed("getLatestBlockhash"))
    }

    fn simulate(&self, wire: &[u8]) -> Result<Option<String>> {
        let reply = self.0.call(
            "simulateTransaction",
            json!([STANDARD.encode(wire), {"encoding":"base64","sigVerify":false,
                "replaceRecentBlockhash":false,"commitment":"processed"}]),
        )?;
        let err = reply["value"]
            .get("err")
            .ok_or_else(|| malformed("simulateTransaction"))?;
        // The ledger's own error body stays out of the reply: it names the cause in its terms.
        Ok((!err.is_null()).then(|| {
            "The Solana ledger's simulation of the payment failed: as signed it would not \
             settle. Check the payer's balance and its delegate's allowance, then pay again."
                .to_owned()
        }))
    }
}

fn malformed(method: &str) -> Error {
    Error::config(format!(
        "The Solana RPC answered {method} in a form that the rail does not read"
    ))
}

/// A payment that the service signed.
#[derive(Clone, Debug)]
struct Kept {
    wire: Vec<u8>,
    signature: [u8; 64],
    /// The upper bound of the last valid block height of its blockhash.
    bound: u64,
    fee: u64,
    /// The hour whose budget holds its fee.
    hour: u64,
    signed_at: u64,
    authorization: Authorization,
    destination: Address,
    mint: Address,
}

#[derive(Default)]
struct Book {
    kept: HashMap<[u8; 32], Kept>,
    hour: u64,
    spent: u128,
}

/// The settlement service. [`SERVICE`] is the plugin's.
pub struct Service {
    hourly_fee: u128,
    book: Mutex<Option<Book>>,
}

/// The rail's settlement service, with the default hourly budget.
pub static SERVICE: Service = Service::new(HOURLY_FEE_LAMPORTS);

/// A refusal: its reason, a message that names the cause and the next step, and the payer when
/// the request names one.
struct Refusal(&'static str, String, Option<String>);

/// A request that passed every check before signing.
struct Admitted {
    wire: Vec<u8>,
    check: PaymentCheck,
    bound: u64,
    authorization: Authorization,
    mint: Address,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The payment of `request`: its requirements and its decoded transaction.
fn read(network: &str, request: &Value) -> std::result::Result<(Value, Vec<u8>), Refusal> {
    let refuse = |what: &str| {
        Err(Refusal(
            INVALID_REQUEST,
            format!(
                "The settlement request is invalid: {what}. Send the x402 V2 payment payload and the requirements that it accepted."
            ),
            None,
        ))
    };
    if network != DEVNET {
        return refuse("this service settles Solana Devnet only");
    }
    let payload = &request["paymentPayload"];
    if !matches!(&request["x402Version"], Value::Null)
        && request["x402Version"].as_u64() != Some(VERSION)
        || payload["x402Version"].as_u64() != Some(VERSION)
    {
        return refuse("the x402 version is not 2");
    }
    let requirements = &request["paymentRequirements"];
    if !requirements.is_object() || payload["accepted"] != *requirements {
        return refuse("the payload accepted other requirements than the request names");
    }
    if requirements["network"] != DEVNET {
        return refuse("the requirements name another network");
    }
    let Some(encoded) = payload["payload"]["transaction"]
        .as_str()
        .filter(|text| text.len() <= MAX_TRANSACTION_BYTES.div_ceil(3) * 4)
    else {
        return refuse("the payload holds no transaction of at most 1,232 bytes");
    };
    let Ok(wire) = STANDARD.decode(encoded) else {
        return refuse("the transaction is not base64");
    };
    Ok((requirements.clone(), wire))
}

/// Check `request` for the fee payer `signer` at the Unix time `now`, against the ledger.
fn admit(
    ledger: &dyn SettlementLedger,
    network: &str,
    signer: &str,
    request: &Value,
    limits: &Limits,
    now: u64,
) -> Result<std::result::Result<Admitted, Refusal>> {
    let fee_payer: Address = signer
        .parse()
        .map_err(|_| Error::config("The facilitator's key is not a Solana address"))?;
    let (requirements, wire) = match read(network, request) {
        Ok(read) => read,
        Err(refusal) => return Ok(Err(refusal)),
    };
    let max_fee = u64::try_from(limits.max_fee).unwrap_or(u64::MAX);
    let check = match facilitator::check(&wire, &requirements, &Policy::allowit(fee_payer), max_fee)
    {
        Ok(check) => check,
        Err(error) => return Ok(Err(Refusal(INVALID_TRANSACTION, error.message, None))),
    };
    let payer = check.source.to_string();
    let refused = |reason, message: &str| {
        Ok(Err(Refusal(
            reason,
            message.to_owned(),
            Some(payer.clone()),
        )))
    };
    match &requirements["extra"]["expiresAt"] {
        Value::Null => {}
        at => match at.as_u64() {
            Some(at) if at > now => {}
            Some(_) => {
                return refused(
                    OFFER_EXPIRED,
                    "The seller's payment offer has expired; ask the seller for a new one.",
                );
            }
            None => return refused(INVALID_REQUEST, "The seller's offer has an invalid expiry."),
        },
    }
    if !ledger
        .genesis_hash()?
        .starts_with(&DEVNET["solana:".len()..])
    {
        return Err(Error::config(
            "The facilitator's Solana RPC endpoint serves another network than Solana Devnet",
        ));
    }
    let Some(bound) = ledger.blockhash_bound(&check.blockhash)? else {
        return refused(
            BLOCKHASH_EXPIRED,
            "The Solana ledger no longer accepts the payment's blockhash; sign the payment again with a recent one.",
        );
    };
    if let Some(reason) = ledger.simulate(&wire)? {
        return refused(SIMULATION_FAILED, &reason);
    }
    let mint = requirements["asset"]
        .as_str()
        .and_then(|asset| asset.parse().ok())
        .ok_or_else(|| Error::config("A checked requirement has no mint"))?;
    let authorization = Authorization {
        id: check.id,
        payer,
        pay_to: requirements["payTo"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        asset: requirements["asset"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        units: i128::from(check.units),
        expires_height: bound,
    };
    Ok(Ok(Admitted {
        wire,
        check,
        bound,
        authorization,
        mint,
    }))
}

fn verify_reply(refusal: Option<&Refusal>, payer: Option<&str>) -> Value {
    let mut reply = json!({"isValid": refusal.is_none()});
    if let Some(Refusal(reason, message, _)) = refusal {
        reply["invalidReason"] = json!(reason);
        reply["invalidMessage"] = json!(message);
    }
    if let Some(payer) = payer {
        reply["payer"] = json!(payer);
    }
    reply
}

fn settle_reply(
    success: bool,
    reason: Option<(&str, &str)>,
    payer: Option<&str>,
    signature: Option<&[u8; 64]>,
) -> Value {
    let mut reply = json!({
        "success": success,
        "transaction": signature.map(|s| bs58::encode(s).into_string()).unwrap_or_default(),
        "network": DEVNET,
    });
    if let Some((reason, message)) = reason {
        reply["errorReason"] = json!(reason);
        reply["errorMessage"] = json!(message);
    }
    if let Some(payer) = payer {
        reply["payer"] = json!(payer);
    }
    reply
}

fn refused(refusal: Refusal) -> Settled {
    let Refusal(reason, message, payer) = refusal;
    Settled {
        reply: settle_reply(false, Some((reason, &message)), payer.as_deref(), None),
        outcome: Outcome::Refused,
        authorization: None,
        transaction: None,
        fee_paid: None,
    }
}

impl Service {
    /// A service whose settlements of one hour pay at most `hourly_fee` lamports.
    pub const fn new(hourly_fee: u128) -> Self {
        Self {
            hourly_fee,
            book: Mutex::new(None),
        }
    }

    fn book<T>(&self, f: impl FnOnce(&mut Book) -> T) -> Result<T> {
        let mut guard = self
            .book
            .lock()
            .map_err(|_| Error::config("The settlement book is unavailable"))?;
        Ok(f(guard.get_or_insert_with(Book::default)))
    }

    /// Keep `admitted` and reserve its fee in the budget of the hour of `now`, before anything is
    /// signed. A refusal when the payment is already kept or the budget cannot hold the fee.
    fn reserve(&self, admitted: &Admitted, now: u64) -> Result<std::result::Result<(), Refusal>> {
        let hourly_fee = self.hourly_fee;
        self.book(|book| {
            book.kept
                .retain(|_, kept| now.saturating_sub(kept.signed_at) < KEEP_SECONDS);
            let payer = Some(admitted.authorization.payer.clone());
            if let Some(kept) = book.kept.get(&admitted.check.id) {
                return Err(duplicate(kept));
            }
            let hour = now / 3_600;
            if book.hour != hour {
                (book.hour, book.spent) = (hour, 0);
            }
            let fee = u128::from(admitted.check.fee);
            if book.spent.saturating_add(fee) > hourly_fee {
                return Err(Refusal(
                    BUDGET_EXHAUSTED,
                    "The Allowit facilitator's network-fee budget of this hour is spent; settle again in the next hour.".into(),
                    payer,
                ));
            }
            book.spent += fee;
            book.kept.insert(
                admitted.check.id,
                Kept {
                    wire: Vec::new(),
                    signature: [0; 64],
                    bound: admitted.bound,
                    fee: admitted.check.fee,
                    hour,
                    signed_at: now,
                    authorization: admitted.authorization.clone(),
                    destination: admitted.check.destination,
                    mint: admitted.mint,
                },
            );
            Ok(())
        })
    }

    /// Give back the fee of `id` and forget it: nothing of it was sent, or it lapsed.
    fn release(&self, id: &[u8; 32]) -> Result<()> {
        self.book(|book| {
            if let Some(kept) = book.kept.remove(id)
                && kept.hour == book.hour
            {
                book.spent = book.spent.saturating_sub(u128::from(kept.fee));
            }
        })
    }

    /// [`SettlementProvider::verify`] on `ledger` at the Unix time `now`.
    pub fn verify_on(
        &self,
        ledger: &dyn SettlementLedger,
        network: &str,
        signer: &str,
        request: &Value,
        limits: &Limits,
        now: u64,
    ) -> Result<Verified> {
        Ok(
            match admit(ledger, network, signer, request, limits, now)? {
                Ok(admitted) => Verified {
                    reply: verify_reply(None, Some(&admitted.authorization.payer)),
                    fee: u128::from(admitted.check.fee),
                    authorization: Some(admitted.authorization),
                },
                Err(refusal) => Verified {
                    reply: verify_reply(Some(&refusal), refusal.2.as_deref()),
                    authorization: None,
                    fee: 0,
                },
            },
        )
    }

    /// [`SettlementProvider::settle`] on `ledger` at the Unix time `now`, reading the ledger every
    /// `poll` until `limits.wait` has passed.
    #[allow(clippy::too_many_arguments)]
    pub fn settle_on(
        &self,
        ledger: &dyn SettlementLedger,
        network: &str,
        signer: &dyn Signer,
        request: &Value,
        limits: &Limits,
        now: u64,
        poll: Duration,
    ) -> Result<Settled> {
        // A payment that this service already signed is refused before the ledger is asked.
        if let Ok((_, wire)) = read(network, request)
            && let Ok(message) = message_of(&wire)
            && let Some(refusal) = self.book(|book| {
                book.kept
                    .get(&crate::packets::message_hash(message))
                    .map(duplicate)
            })?
        {
            return Ok(refused(refusal));
        }
        let admitted = match admit(ledger, network, signer.identity(), request, limits, now)? {
            Ok(admitted) => admitted,
            Err(refusal) => return Ok(refused(refusal)),
        };
        if let Err(refusal) = self.reserve(&admitted, now)? {
            return Ok(refused(refusal));
        }
        let id = admitted.check.id;
        let signed = match sign(&admitted, signer) {
            Ok(signed) => signed,
            Err(error) => {
                // Nothing was signed, so nothing can land: the payment may settle again.
                self.release(&id)?;
                return Err(error);
            }
        };
        // Retained before it is sent: the signed bytes and their signature.
        let kept = self.book(|book| {
            book.kept.get_mut(&id).map(|kept| {
                kept.signature = signed.1;
                kept.wire = signed.0.clone();
                kept.clone()
            })
        })?;
        let Some(kept) = kept else {
            return Err(Error::config("The settlement book lost a kept payment"));
        };
        // An error answer leaves the outcome unknown: the ledger is read by the signature.
        let _ = ledger.submit(&kept.wire);
        let deadline = Instant::now() + limits.wait;
        loop {
            if let Some(settled) = self.reconcile(ledger, &id, &kept)? {
                return Ok(settled);
            }
            if Instant::now() >= deadline {
                return Ok(pending(&kept));
            }
            std::thread::sleep(poll);
        }
    }

    /// [`SettlementProvider::observe`] on `ledger`.
    pub fn observe_on(
        &self,
        ledger: &dyn SettlementLedger,
        network: &str,
        request: &Value,
        transaction: &[u8; 32],
    ) -> Result<Settled> {
        let (_, wire) =
            read(network, request).map_err(|Refusal(_, message, _)| Error::usage(message))?;
        if message_of(&wire).map(crate::packets::message_hash).ok() != Some(*transaction) {
            return Err(Error::usage(
                "The transaction is not the settlement of this request",
            ));
        }
        let kept = self.book(|book| book.kept.get(transaction).cloned())?;
        let Some(kept) = kept else {
            // Without the signature the ledger cannot be read for this payment.
            return Ok(Settled {
                reply: settle_reply(
                    false,
                    Some((
                        PENDING,
                        "This facilitator holds no signature for this payment any more; read the outcome by the transaction signature of the earlier reply.",
                    )),
                    None,
                    None,
                ),
                outcome: Outcome::Pending,
                authorization: None,
                transaction: Some(*transaction),
                fee_paid: None,
            });
        };
        Ok(match self.reconcile(ledger, transaction, &kept)? {
            Some(settled) => settled,
            None => pending(&kept),
        })
    }

    /// The outcome of `kept` as the ledger shows it now; `None` while it can still land.
    fn reconcile(
        &self,
        ledger: &dyn SettlementLedger,
        id: &[u8; 32],
        kept: &Kept,
    ) -> Result<Option<Settled>> {
        // A failed read leaves the outcome unknown.
        let Ok(Observation {
            status,
            finalized_height,
        }) = ledger.observe(&kept.signature)
        else {
            return Ok(None);
        };
        let payer = Some(kept.authorization.payer.as_str());
        let settled = |outcome, reply, fee_paid: Option<u64>| Settled {
            reply,
            outcome,
            authorization: Some(kept.authorization.clone()),
            transaction: Some(*id),
            fee_paid: fee_paid.map(u128::from),
        };
        Ok(match status {
            Status::Pending => None,
            Status::Unknown if finalized_height <= kept.bound => {
                // The identical bytes again while their blockhash is valid; never a new
                // transaction. An error answer leaves the outcome unknown.
                let _ = ledger.submit(&kept.wire);
                None
            }
            Status::Unknown => {
                // The lapse proof: a finalized height past the bound and no status.
                self.release(id)?;
                let mut reply = settle_reply(
                    false,
                    Some((
                        LAPSED,
                        "The payment's blockhash expired before the Solana ledger took it; nothing was paid. Sign the payment again with a recent blockhash.",
                    )),
                    payer,
                    Some(&kept.signature),
                );
                reply["lapse"] = json!({
                    "signature": bs58::encode(kept.signature).into_string(),
                    "lastValidBlockHeight": kept.bound,
                    "finalizedBlockHeight": finalized_height,
                });
                Some(Settled {
                    reply,
                    outcome: Outcome::Refused,
                    authorization: Some(kept.authorization.clone()),
                    transaction: None,
                    fee_paid: None,
                })
            }
            Status::Finalized { failed } => {
                let Some(receipt) = ledger.transaction(&kept.signature)? else {
                    return Ok(None);
                };
                // Settlement success reflects the ledger's effects, not the simulation.
                let reason = if failed || receipt.failed {
                    Some((
                        FAILED,
                        "The Solana ledger finalized the payment as failed; nothing was paid, the network fee was.",
                    ))
                } else if !paid(&receipt, kept) {
                    Some((
                        NOT_PAID,
                        "The finalized transaction did not pay the payee the required amount.",
                    ))
                } else {
                    None
                };
                Some(settled(
                    if reason.is_none() {
                        Outcome::Settled
                    } else {
                        Outcome::Refused
                    },
                    settle_reply(reason.is_none(), reason, payer, Some(&kept.signature)),
                    Some(receipt.fee),
                ))
            }
        })
    }
}

/// Whether `receipt` credited the payee's token account with exactly the payment.
fn paid(receipt: &Finalized, kept: &Kept) -> bool {
    let keys = message_of(&receipt.wire)
        .and_then(payment::account_keys)
        .unwrap_or_default();
    let units = u64::try_from(kept.authorization.units).unwrap_or(0);
    receipt.balances.iter().any(|balance| {
        keys.get(balance.index) == Some(&kept.destination)
            && balance.mint == kept.mint
            && balance.after.checked_sub(balance.before) == Some(units)
    })
}

/// The refusal of a payment that this service keeps.
fn duplicate(kept: &Kept) -> Refusal {
    let message = if kept.wire.is_empty() {
        "This facilitator is settling this payment in another request; read its outcome instead of settling it again.".to_owned()
    } else {
        format!(
            "This facilitator already signed this payment as transaction {}; read its outcome instead of settling it again.",
            bs58::encode(kept.signature).into_string()
        )
    };
    Refusal(DUPLICATE, message, Some(kept.authorization.payer.clone()))
}

/// The message of a signed transaction: a one-byte signature count, then the signatures.
fn message_of(wire: &[u8]) -> Result<&[u8]> {
    let count = usize::from(*wire.first().unwrap_or(&128));
    wire.get(1 + 64 * count..)
        .filter(|_| count < 128)
        .ok_or_else(|| Error::usage("The transaction is not a signed Solana transaction"))
}

fn pending(kept: &Kept) -> Settled {
    Settled {
        reply: settle_reply(
            false,
            Some((
                PENDING,
                "The Solana ledger has not shown the payment's outcome yet; read it again by its transaction.",
            )),
            Some(&kept.authorization.payer),
            Some(&kept.signature),
        ),
        outcome: Outcome::Pending,
        authorization: Some(kept.authorization.clone()),
        transaction: Some(kept.authorization.id),
        fee_paid: None,
    }
}

/// The client's transaction with the facilitator's signature in the fee payer's place.
fn sign(admitted: &Admitted, signer: &dyn Signer) -> Result<(Vec<u8>, [u8; 64])> {
    let wire = &admitted.wire;
    // A checked payment has one to three signatures: a one-byte count, then the fee payer's place.
    let message = &wire[1 + 64 * admitted.check.signatures..];
    let signature: [u8; 64] = signer
        .sign_bytes(message)?
        .try_into()
        .map_err(|_| Error::config("The facilitator's signature is not 64 bytes"))?;
    payment::verify(&admitted.check.fee_payer, message, &signature)
        .map_err(|_| Error::config("The facilitator's key did not sign as its fee payer"))?;
    let mut signed = wire.clone();
    signed[1..65].copy_from_slice(&signature);
    Ok((signed, signature))
}

fn connect(network: &str, endpoint: &str) -> Result<Rpc> {
    Ok(Rpc(PLUGIN.connect(network, endpoint)?))
}

impl SettlementProvider for Service {
    fn supported(&self, network: &str) -> Result<Supported> {
        if network != DEVNET {
            return Err(Error::unsupported(
                "The Solana settlement service settles Solana Devnet only",
            ));
        }
        Ok(Supported {
            kinds: vec![json!({
                "x402Version": VERSION,
                "scheme": x402::SCHEME,
                "network": DEVNET,
            })],
            signers_key: "solana:*".into(),
        })
    }

    fn verify(
        &self,
        network: &str,
        endpoint: &str,
        signer: &str,
        request: &Value,
        limits: &Limits,
    ) -> Result<Verified> {
        self.verify_on(
            &connect(network, endpoint)?,
            network,
            signer,
            request,
            limits,
            now(),
        )
    }

    fn settle(
        &self,
        network: &str,
        endpoint: &str,
        signer: &dyn Signer,
        request: &Value,
        limits: &Limits,
    ) -> Result<Settled> {
        let ledger = connect(network, endpoint)?;
        self.settle_on(&ledger, network, signer, request, limits, now(), POLL)
    }

    fn observe(
        &self,
        network: &str,
        endpoint: &str,
        request: &Value,
        transaction: &[u8; 32],
    ) -> Result<Settled> {
        self.observe_on(&connect(network, endpoint)?, network, request, transaction)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use allowit_core::vendor::runtime::Transport;
    use std::sync::Arc;

    /// A transport that answers each method with a fixed reply and records the calls.
    struct Node(Vec<(&'static str, Value)>, Mutex<Vec<(String, Value)>>);
    impl Transport for Node {
        fn call(&self, method: &str, params: Value) -> Result<Value> {
            self.1.lock().unwrap().push((method.into(), params));
            self.0
                .iter()
                .find(|(m, _)| *m == method)
                .map(|(_, reply)| reply.clone())
                .ok_or_else(|| Error::uncertain("no answer"))
        }
    }
    fn rpc(answers: Vec<(&'static str, Value)>) -> (Rpc, Arc<Node>) {
        let node = Arc::new(Node(answers, Mutex::new(Vec::new())));
        (Rpc(node.clone()), node)
    }

    #[test]
    fn the_rpc_bounds_a_blockhash_by_a_bank_that_accepted_it() {
        let (ledger, node) = rpc(vec![
            (
                "isBlockhashValid",
                json!({"context": {"slot": 77}, "value": true}),
            ),
            (
                "getLatestBlockhash",
                json!({"value": {"blockhash": "x", "lastValidBlockHeight": 1_150}}),
            ),
        ]);
        assert_eq!(
            ledger.blockhash_bound(&Hash::default()).unwrap(),
            Some(1_150)
        );
        let calls = node.1.lock().unwrap();
        assert_eq!(calls[1].1[0]["minContextSlot"], 77);
        let (lapsed, _) = rpc(vec![(
            "isBlockhashValid",
            json!({"context": {"slot": 77}, "value": false}),
        )]);
        assert_eq!(lapsed.blockhash_bound(&Hash::default()).unwrap(), None);
    }

    #[test]
    fn a_failed_simulation_keeps_the_ledgers_body_out_of_the_reason() {
        let (ledger, node) = rpc(vec![(
            "simulateTransaction",
            json!({"value": {"err": {"InstructionError": [2, {"Custom": 1}]}, "logs": ["secret"]}}),
        )]);
        let reason = ledger.simulate(&[1, 2, 3]).unwrap().unwrap();
        assert!(!reason.contains("Custom") && !reason.contains("secret"));
        assert_eq!(node.1.lock().unwrap()[0].1[1]["sigVerify"], false);
        let (fine, _) = rpc(vec![(
            "simulateTransaction",
            json!({"value": {"err": null}}),
        )]);
        assert_eq!(fine.simulate(&[1]).unwrap(), None);
        let (odd, _) = rpc(vec![("simulateTransaction", json!({"value": {}}))]);
        assert!(odd.simulate(&[1]).is_err());
    }
}
