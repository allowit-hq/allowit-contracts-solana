//! x402 `exact` payments on Solana from a Native wallet: the client side, and the check of a
//! signed payment that both the client's proof and a facilitator use.
//!
//! A seller answers a request for a paid resource with HTTP 402 and the base64 JSON of the
//! `PAYMENT-REQUIRED` header (x402 version 2). On Solana the `exact` scheme is settled by the
//! seller's facilitator: the client signs a transaction that pays the seller's associated token
//! account with `TransferChecked`, the facilitator signs it as fee payer and submits it. A Native
//! wallet's transfer has two client signatures, the agent's and the server's, so with the
//! facilitator's it needs three; a facilitator that accepts two signatures only refuses it, and the
//! Allowit facilitator accepts three.
//!
//! This module reads the requirement for Solana Devnet into a [`Challenge`], builds the Native
//! wallet's payment for it, checks a signed payment against its requirement ([`check_payment`]),
//! and builds the proof header from the signed payment that the operation recorded. Version 1,
//! whose network names are not CAIP-2 ids, is refused.
//!
//! A payment names its purchase and expires at a block height. Its memo binds the challenge and
//! the request ID of the operation that pays it, which a retry of the operation keeps: two
//! purchases on the same terms sign two transactions, and a retry signs the same one for the same
//! blockhash. The proof reads the request ID from the receipt and checks the memo again.
//!
//! The payment's blockhash stops being valid after a block height, which is the payment's expiry.
//! The seller's `settle_within` admits a blockhash that expires within `settle_within` seconds of
//! blocks at [`BLOCK_MILLIS`]. The ledger binds the payment to that height, not to a time: blocks
//! that come more slowly, or a halted network, reach it after `settle_within`, and no part of the
//! transaction can stop the transfer then; the operation that signs a payment accounts for that.
//! [`check_expiry`] checks a signed blockhash against the bound from the block heights that the
//! ledger reported for it: the operation's record of them in a proof, the facilitator's own read.
//!
//! A restored challenge is the record that Core keeps of what [`challenge`] read, and Core
//! deserializes it: this module sees its terms only as values, never as the seller's bytes. It
//! checks that they are consistent and within the proof's size bound. Whether the record is the
//! one that this module produced is the integrity of the host's store.
//!
//! [`check_payment`] checks what the signed message alone determines. Whether its accounts hold
//! what the transfer needs (the source a token account of the mint with the amount, the
//! recipient's account created) is the ledger's to say: the facilitator simulates the payment
//! before it signs.
use crate::{
    keys::signer_identity,
    native::{
        Address, Budget, COMPUTE_BUDGET_PROGRAM, MAX_MEMO_BYTES, MAX_TRANSACTION_BYTES,
        MEMO_PROGRAM, Prepared, TOKEN_PROGRAM, Wallet,
    },
    networks::{self, DEVNET},
};
use allowit_core::vendor::{
    error::{Error, Result},
    execution::Quantity,
    input::asset::AssetDisplay,
    paid_service::{
        Challenge, MAX_CHALLENGE_BYTES, MAX_SETTLE_WITHIN, PaidServiceProvider, Proof, SellerReply,
        SettledBy, challenge_id, resource_url,
    },
    request::request_id_valid,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature as EdSignature, VerifyingKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use solana_address::address;
use solana_hash::Hash;

/// The payment scheme.
pub const SCHEME: &str = "exact";
/// The response header of a challenge.
pub const CHALLENGE_HEADER: &str = "PAYMENT-REQUIRED";
/// The request header of a proof.
pub const PROOF_HEADER: &str = "PAYMENT-SIGNATURE";
/// The key under which an operation's outcome holds the signed payment that the facilitator
/// submits.
pub const AUTHORIZATION_KEY: &str = "paymentAuthorization";
/// The SPL Associated Token Account program.
pub const ASSOCIATED_TOKEN_PROGRAM: Address =
    address!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// The settlement time of a seller that states none, in seconds.
pub const DEFAULT_SETTLE_WITHIN: u64 = 60;
/// The block time that bounds a payment's expiry. Slots are 400 ms, and the block height grows
/// more slowly when slots are skipped; the longer time gives the earlier block height.
pub const BLOCK_MILLIS: u64 = 500;
/// The most blocks for which a blockhash stays valid.
pub const MAX_VALID_BLOCKS: u64 = 150;
/// The smallest compute-unit limit of a payment: [`Budget::PAYMENT`], which the ledger test shows
/// is enough for a Native payment with its memo.
pub const MIN_COMPUTE_UNITS: u32 = Budget::PAYMENT.units;
/// The accounts that the runtime reserves (Agave's reserved account keys): it never write-locks
/// them, so none can pay a fee or move tokens. A test keeps the list equal to Agave's.
const RESERVED: [Address; 31] = [
    address!("AddressLookupTab1e1111111111111111111111111"),
    address!("BPFLoader2111111111111111111111111111111111"),
    address!("BPFLoader1111111111111111111111111111111111"),
    address!("BPFLoaderUpgradeab1e11111111111111111111111"),
    address!("ComputeBudget111111111111111111111111111111"),
    address!("Config1111111111111111111111111111111111111"),
    address!("Ed25519SigVerify111111111111111111111111111"),
    address!("Feature111111111111111111111111111111111111"),
    address!("LoaderV411111111111111111111111111111111111"),
    address!("KeccakSecp256k11111111111111111111111111111"),
    address!("Secp256r1SigVerify1111111111111111111111111"),
    address!("StakeConfig11111111111111111111111111111111"),
    address!("Stake11111111111111111111111111111111111111"),
    address!("11111111111111111111111111111111"),
    address!("Vote111111111111111111111111111111111111111"),
    address!("ZkE1Gama1Proof11111111111111111111111111111"),
    address!("ZkTokenProof1111111111111111111111111111111"),
    address!("SysvarC1ock11111111111111111111111111111111"),
    address!("SysvarEpochRewards1111111111111111111111111"),
    address!("SysvarEpochSchedu1e111111111111111111111111"),
    address!("SysvarFees111111111111111111111111111111111"),
    address!("Sysvar1nstructions1111111111111111111111111"),
    address!("SysvarLastRestartS1ot1111111111111111111111"),
    address!("SysvarRecentB1ockHashes11111111111111111111"),
    address!("SysvarRent111111111111111111111111111111111"),
    address!("SysvarRewards111111111111111111111111111111"),
    address!("SysvarS1otHashes111111111111111111111111111"),
    address!("SysvarS1otHistory11111111111111111111111111"),
    address!("SysvarStakeHistory1111111111111111111111111"),
    address!("NativeLoader1111111111111111111111111111111"),
    address!("Sysvar1111111111111111111111111111111111111"),
];

/// Whether the runtime reserves `key`.
fn is_reserved(key: &Address) -> bool {
    RESERVED.contains(key)
}

/// The most signers of an SPL Token multisig.
const MAX_MULTISIG_SIGNERS: usize = 11;
/// The largest network fee, in lamports, of a payment that a proof presents for the facilitator
/// to pay: three signatures and 200,000 compute units at 1,000,000 micro-lamports a unit.
pub const MAX_FEE: u64 = 215_000;
/// The most signatures that an `exact` payment of this rail carries: the fee payer's, the
/// agent's and the server's.
pub const MAX_SIGNATURES: usize = 3;
const MAX_REQUIREMENTS: usize = 32;
/// The largest accepted terms, as JSON. The proof echoes them.
pub const MAX_TERMS_BYTES: usize = 4096;
/// The deepest nesting of accepted terms. serde_json reads at most 128 levels; a record that holds
/// a challenge nests its terms a few levels deeper, and this bound leaves it the room.
pub const MAX_TERMS_DEPTH: usize = 32;
/// The prefix of the memo that names a purchase.
pub const MEMO_PREFIX: &str = "allowit:x402:";
const PURCHASE_DOMAIN: &[u8] = b"allowit-solana-x402-purchase-v1";

fn unsupported(message: impl Into<String>) -> Error {
    Error::unsupported(message)
}

/// The associated token account of `owner` for `mint`: where an `exact` payment pays.
pub fn associated_token_account(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM,
    )
    .0
}

/// A 32-byte base58 address, at most 44 characters.
fn parse_address(text: &str) -> Option<Address> {
    if text.is_empty() || text.len() > 44 {
        return None;
    }
    text.parse().ok()
}

/// The key prefix that serde_json, with the `arbitrary_precision` and `raw_value` features that
/// Core enables, reads as a number or a raw value instead of an object.
const RESERVED_KEY: &str = "$serde_json::private::";

/// Whether no object key in the JSON `bytes`, once unescaped, starts with [`RESERVED_KEY`], so
/// that the parsed document keeps the literal types that the seller sent. A key is a string that a
/// colon follows; string values may hold anything. Malformed JSON passes here and fails to parse.
fn free_of_reserved_keys(bytes: &[u8]) -> bool {
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'"' {
            i += 1;
            continue;
        }
        i += 1;
        let mut text = String::new();
        while i < bytes.len() && bytes[i] != b'"' {
            let (c, step) = if bytes[i] == b'\\' {
                match bytes.get(i + 1) {
                    Some(b'u') => {
                        let code = bytes
                            .get(i + 2..i + 6)
                            .and_then(|hex| std::str::from_utf8(hex).ok())
                            .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                            .and_then(char::from_u32);
                        (code.unwrap_or('\u{fffd}'), 6)
                    }
                    Some(other) => (char::from(*other), 2),
                    None => break,
                }
            } else {
                (char::from(bytes[i]), 1)
            };
            if text.len() < RESERVED_KEY.len() {
                text.push(c);
            }
            i += step;
        }
        i += 1;
        let next = bytes
            .get(i..)
            .unwrap_or_default()
            .iter()
            .find(|b| !b" \t\n\r".contains(b));
        if next == Some(&b':') && text.starts_with(RESERVED_KEY) {
            return false;
        }
    }
    true
}

/// How deeply `value` nests: 1 for a scalar, one more for each array or object around it.
fn depth(value: &Value) -> usize {
    1 + match value {
        Value::Array(items) => items.iter().map(depth).max().unwrap_or(0),
        Value::Object(map) => map.values().map(depth).max().unwrap_or(0),
        _ => 0,
    }
}

/// The JSON of `value` when it fits in `max` bytes: the writer stops at the bound, so a large
/// value is never encoded whole.
fn encoded_within(value: &Value, max: usize) -> Option<Vec<u8>> {
    struct Bounded(Vec<u8>, usize);
    impl std::io::Write for Bounded {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.0.len() + buf.len() > self.1 {
                return Err(std::io::Error::other("over the bound"));
            }
            self.0.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut out = Bounded(Vec::new(), max);
    serde_json::to_writer(&mut out, value).ok()?;
    Some(out.0)
}

/// The requirements document of a 402 reply: the version 2 header.
fn requirements(reply: &SellerReply<'_>) -> Result<Value> {
    if reply.status != 402 {
        return Err(Error::usage(
            "The seller's reply is not a payment challenge (HTTP 402).",
        ));
    }
    let header = reply
        .header(CHALLENGE_HEADER)
        .ok_or_else(|| unsupported("The seller's payment challenge is not x402 version 2."))?;
    if header.len() > MAX_CHALLENGE_BYTES {
        return Err(Error::usage("The seller's payment challenge is too large."));
    }
    let invalid = || Error::usage("The seller's payment challenge is not valid x402 JSON.");
    let bytes = STANDARD.decode(header.trim()).map_err(|_| invalid())?;
    if !free_of_reserved_keys(&bytes) {
        return Err(invalid());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if !value.is_object() {
        return Err(invalid());
    }
    Ok(value)
}

/// The token of `network` whose mint is `asset`, with its display.
fn token(network: &str, asset: &str) -> Option<AssetDisplay> {
    networks::tokens(network)
        .iter()
        .find(|t| !t.native && t.issuer == Some(asset))
        .map(AssetDisplay::from)
}

/// A positive token amount as canonical decimal text.
fn token_units(value: &Value) -> Option<u64> {
    let text = value.as_str()?;
    if text.starts_with('0') || text.starts_with('+') {
        return None;
    }
    text.parse::<u64>().ok().filter(|units| *units > 0)
}

/// The fee payer that `accepted` names, when it is a key that can sign and an account that the
/// runtime write-locks.
fn fee_payer(accepted: &Value) -> Option<Address> {
    accepted["extra"]["feePayer"]
        .as_str()
        .and_then(parse_address)
        .filter(|key| signer_identity(&key.to_bytes()).is_ok() && !is_reserved(key))
}

/// The seller's settlement time of `accepted`, in seconds: `maxTimeoutSeconds`, or the default.
pub fn settle_within(accepted: &Value) -> Result<u64> {
    match &accepted["maxTimeoutSeconds"] {
        Value::Null => Ok(DEFAULT_SETTLE_WITHIN),
        value => value
            .as_u64()
            .filter(|seconds| (1..=MAX_SETTLE_WITHIN).contains(seconds))
            .ok_or_else(|| Error::usage("The seller's payment challenge has an invalid timeout.")),
    }
}

/// Read one requirement for Solana Devnet. `Ok(None)` means that it is for another network.
fn requirement(resource: &str, document: &Value, accepted: &Value) -> Result<Option<Challenge>> {
    if accepted["network"].as_str() != Some(DEVNET) {
        return Ok(None);
    }
    if accepted["scheme"] != SCHEME {
        return Err(unsupported(format!(
            "The seller's payment scheme is not {SCHEME}."
        )));
    }
    let extra = &accepted["extra"];
    let Some(named_fee_payer) = fee_payer(accepted) else {
        return Err(unsupported(
            "The seller's payment challenge names no fee payer that can sign.",
        ));
    };
    // An omitted resource is the requested one; a stated one must be it.
    match document.get("resource") {
        None | Some(Value::Null) => {}
        Some(named) if named["url"].as_str() == Some(resource) => {}
        Some(_) => {
            return Err(Error::usage(
                "The seller's payment challenge names another resource.",
            ));
        }
    }
    let pay_to = accepted["payTo"].as_str().unwrap_or_default();
    if parse_address(pay_to).is_none() {
        return Err(Error::usage(
            "The seller's payment challenge names an invalid recipient.",
        ));
    }
    // A listed token by its mint; an unlisted mint has no known unit and is never paid.
    let asset = accepted["asset"].as_str().unwrap_or_default();
    let Some(display) = token(DEVNET, asset) else {
        return Err(unsupported(
            "The seller's payment challenge names an asset that this network does not list.",
        ));
    };
    let units = token_units(&accepted["amount"])
        .ok_or_else(|| Error::usage("The seller's payment challenge names an invalid amount."))?;
    // The fee payer appears in no instruction of the payment: not the mint, a program or the
    // recipient's account. Such an offer is refused here, so that a later offer can be taken.
    let mint = parse_address(asset)
        .ok_or_else(|| Error::usage("The seller's payment challenge names an invalid mint."))?;
    let recipient = parse_address(pay_to).expect("checked above");
    if [
        mint,
        TOKEN_PROGRAM,
        MEMO_PROGRAM,
        COMPUTE_BUDGET_PROGRAM,
        associated_token_account(&recipient, &mint),
    ]
    .contains(&named_fee_payer)
    {
        return Err(unsupported(
            "The seller's payment challenge names an account of the payment as the fee payer.",
        ));
    }
    // A null id is an absent one.
    let named = |key: &str| extra.get(key).filter(|value| !value.is_null());
    let id = match named("challengeId").or_else(|| named("nonce")) {
        None => None,
        Some(value) => {
            let id = value.as_str().unwrap_or_default();
            challenge_id(id)
                .map_err(|_| Error::usage("The seller's payment challenge has an invalid id."))?;
            Some(id.to_owned())
        }
    };
    let expires_at = match extra.get("expiresAt") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_u64().ok_or_else(|| {
            Error::usage("The seller's payment challenge has an invalid expiry.")
        })?),
    };
    // The seller's bound on the time from the payment to its settlement: the payment's blockhash
    // expires within it (see the module documentation).
    let settle_within = settle_within(accepted)?;
    let mut terms = json!({"x402Version": 2, "accepted": accepted});
    if document["resource"].is_object() {
        terms["resource"] = document["resource"].clone();
    }
    if serde_json::to_vec(&terms).map_or(true, |encoded| encoded.len() > MAX_TERMS_BYTES)
        || depth(&terms) > MAX_TERMS_DEPTH
    {
        return Err(Error::usage(
            "The seller's payment terms are too large to present as a proof.",
        ));
    }
    Ok(Some(Challenge {
        id,
        resource: resource.to_owned(),
        network: DEVNET.to_owned(),
        scheme: SCHEME.to_owned(),
        pay_to: pay_to.to_owned(),
        amount: Quantity::new(i128::from(units), display),
        asset: asset.to_owned(),
        expires_at,
        settled_by: SettledBy::Seller,
        settle_within: Some(settle_within),
        terms,
    }))
}

/// The seller's challenge for `resource` on `network`: the first `exact` requirement of Solana
/// Devnet that this rail can pay.
pub fn challenge(network: &str, resource: &str, reply: &SellerReply<'_>) -> Result<Challenge> {
    challenge_at(network, resource, reply, unix_now()?)
}

/// The Unix time now, in seconds.
fn unix_now() -> Result<u64> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| Error::config("The system clock is before 1970."))?
        .as_secs())
}

/// Refuse `challenge` when the seller's `expiresAt` has passed at `now`: the seller no longer
/// accepts its payment.
fn live(challenge: &Challenge, now: u64) -> Result<()> {
    if challenge.expires_at.is_some_and(|at| at <= now) {
        return Err(Error::usage("The seller's payment offer has expired."));
    }
    Ok(())
}

/// [`challenge`] at the Unix time `now`: an offer whose `expiresAt` has passed gives way to the
/// next one.
fn challenge_at(
    network: &str,
    resource: &str,
    reply: &SellerReply<'_>,
    now: u64,
) -> Result<Challenge> {
    networks::network(network)?;
    resource_url(resource)?;
    let document = requirements(reply)?;
    if document["x402Version"].as_u64() != Some(2) {
        return Err(unsupported(
            "The seller's payment challenge is not x402 version 2.",
        ));
    }
    let accepts = document["accepts"]
        .as_array()
        .filter(|accepts| !accepts.is_empty() && accepts.len() <= MAX_REQUIREMENTS)
        .ok_or_else(|| Error::usage("The seller's payment challenge lists no requirement."))?;
    let mut refusal = None;
    for accepted in accepts {
        match requirement(resource, &document, accepted) {
            Ok(Some(challenge)) => match live(&challenge, now) {
                Ok(()) => return Ok(challenge),
                Err(expired) => refusal = refusal.or(Some(expired)),
            },
            Ok(None) => {}
            Err(error) => refusal = refusal.or(Some(error)),
        }
    }
    Err(refusal.unwrap_or_else(|| unsupported("The seller offers no payment on Solana Devnet.")))
}

/// The terms of a challenge, checked against its own fields: what a payment for it pays.
struct Terms {
    mint: Address,
    pay_to: Address,
    fee_payer: Address,
    units: u64,
    decimals: u8,
    settle_within: u64,
}

fn terms(challenge: &Challenge) -> Result<Terms> {
    // A restored challenge is read again from its own terms, as from the seller's reply, and must
    // be exactly what that reading gives.
    resource_url(&challenge.resource)?;
    if encoded_within(&challenge.terms, MAX_TERMS_BYTES).is_none() {
        return Err(Error::usage(
            "The payment challenge's terms are larger than a proof carries.",
        ));
    }
    let accepted = &challenge.terms["accepted"];
    let read = (challenge.terms["x402Version"] == 2)
        .then(|| requirement(&challenge.resource, &challenge.terms, accepted))
        .transpose()?
        .flatten();
    if read.as_ref() != Some(challenge) {
        return Err(Error::usage(
            "The payment challenge is not what its terms say.",
        ));
    }
    let display = token(DEVNET, &challenge.asset)
        .ok_or_else(|| unsupported("The payment challenge names an unlisted asset."))?;
    Ok(Terms {
        mint: parse_address(&challenge.asset)
            .ok_or_else(|| Error::usage("The payment challenge names an invalid mint."))?,
        pay_to: parse_address(&challenge.pay_to)
            .ok_or_else(|| Error::usage("The payment challenge names an invalid recipient."))?,
        fee_payer: fee_payer(accepted)
            .ok_or_else(|| Error::usage("The payment challenge names no fee payer."))?,
        units: token_units(&accepted["amount"])
            .ok_or_else(|| Error::usage("The payment challenge names an invalid amount."))?,
        decimals: display.decimals,
        settle_within: settle_within(accepted)?,
    })
}

/// The JSON of `value` with every object's keys in sorted order and arrays in their order, so
/// that a digest of it depends on the value, not on the map order of the serializer.
fn canonical(value: &Value, out: &mut Vec<u8>) -> Result<()> {
    let unencodable = |_| Error::config("The payment challenge cannot be encoded.");
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push(b'{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                serde_json::to_writer(&mut *out, key).map_err(unencodable)?;
                out.push(b':');
                canonical(&map[key], out)?;
            }
            out.push(b'}');
        }
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                canonical(item, out)?;
            }
            out.push(b']');
        }
        scalar => serde_json::to_writer(&mut *out, scalar).map_err(unencodable)?,
    }
    Ok(())
}

/// 16 bytes of the SHA-256 of `parts`, each with its length, as lowercase hex.
fn digest(parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    hash.update(PURCHASE_DOMAIN);
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    hash.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The memo that names one purchase: `allowit:x402:<challenge>:<request>`. The first part binds the
/// challenge's operation context and its whole terms, which the proof echoes; the second the
/// request ID of the operation that pays it.
pub fn purchase_memo(challenge: &Challenge, request_id: &str) -> Result<String> {
    if !request_id_valid(request_id) {
        return Err(Error::usage("The payment names no valid request ID."));
    }
    let context = serde_json::to_vec(&challenge.context())
        .map_err(|_| Error::config("The payment challenge cannot be encoded."))?;
    let mut terms = Vec::new();
    canonical(&challenge.terms, &mut terms)?;
    Ok(format!(
        "{MEMO_PREFIX}{}:{}",
        digest(&[b"challenge", &context, &terms]),
        digest(&[b"request", request_id.as_bytes()])
    ))
}

/// A blockhash as the ledger reported it, and the ledger's block height when it was read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recent {
    pub blockhash: Hash,
    /// The last block height at which a transaction with `blockhash` is valid.
    pub last_valid_block_height: u64,
    /// The ledger's block height.
    pub block_height: u64,
}

/// Check that a payment signed with `recent.blockhash` expires within `settle_within` seconds of
/// blocks at [`BLOCK_MILLIS`]: it is still valid at the reported block height (the last valid
/// height included), and it has at most that many blocks to go.
/// Returns its expiry, the last block height at which it can settle.
pub fn check_expiry(settle_within: u64, recent: &Recent) -> Result<u64> {
    let admitted = (settle_within.saturating_mul(1000) / BLOCK_MILLIS).min(MAX_VALID_BLOCKS);
    let remaining = recent
        .last_valid_block_height
        .checked_sub(recent.block_height)
        .ok_or_else(|| Error::usage("The payment's blockhash has expired."))?;
    if remaining > admitted {
        return Err(Error::usage(format!(
            "The payment's blockhash is valid for {remaining} blocks; the seller allows {admitted}. Take an older blockhash."
        )));
    }
    Ok(recent.last_valid_block_height)
}

/// A payment to sign, and the last block height at which it can settle.
#[derive(Clone, Debug)]
pub struct Payment {
    pub prepared: Prepared,
    pub expires_height: u64,
}

/// The Native wallet's payment of `challenge` for the operation of `request_id`: a transfer of
/// exactly its amount of its mint to the associated token account of its recipient, with the
/// purchase memo, and the seller's facilitator as fee payer. The facilitator is never one of the
/// wallet's own keys: the wallet would then pay a fee that the facilitator pays, and sign its
/// place. `recent` must expire within the seller's settlement time: a blockhash that is valid for
/// longer is refused, and the caller takes an older one.
pub fn payment(
    wallet: &Wallet,
    challenge: &Challenge,
    request_id: &str,
    budget: Budget,
    recent: Recent,
) -> Result<Payment> {
    payment_at(wallet, challenge, request_id, budget, recent, unix_now()?)
}

/// [`payment`] at the Unix time `now`: an offer whose `expiresAt` has passed is never signed.
fn payment_at(
    wallet: &Wallet,
    challenge: &Challenge,
    request_id: &str,
    budget: Budget,
    recent: Recent,
    now: u64,
) -> Result<Payment> {
    let t = terms(challenge)?;
    live(challenge, now)?;
    if [wallet.owner, wallet.agent, wallet.server].contains(&t.fee_payer) {
        return Err(Error::usage(
            "The payment challenge names one of the wallet's keys as the facilitator.",
        ));
    }
    if t.mint != wallet.mint {
        return Err(Error::usage(
            "The payment challenge asks for another asset than the wallet holds.",
        ));
    }
    // A payment that a proof could not present is never signed.
    if budget.units < MIN_COMPUTE_UNITS {
        return Err(Error::usage(format!(
            "The payment's compute-unit limit is below {MIN_COMPUTE_UNITS}."
        )));
    }
    let fee = crate::native::fee(MAX_SIGNATURES as u8, budget);
    if fee > MAX_FEE {
        return Err(Error::usage(format!(
            "The payment's network fee of {fee} lamports is above the bound of {MAX_FEE}."
        )));
    }
    let expires_height = check_expiry(t.settle_within, &recent)?;
    let memo = purchase_memo(challenge, request_id)?;
    let prepared = wallet.payment(
        &associated_token_account(&t.pay_to, &t.mint),
        t.units,
        t.decimals,
        budget,
        Some(&memo),
        &t.fee_payer,
        recent.blockhash,
    )?;
    // The fee payer signs first and appears in no instruction: not as the mint, a program or
    // an account of the transfer.
    let message = prepared.message();
    if message
        .instructions
        .iter()
        .any(|ix| ix.program_id_index == 0 || ix.accounts.contains(&0))
    {
        return Err(Error::usage(
            "The payment challenge names an account of the payment as the facilitator.",
        ));
    }
    Ok(Payment {
        prepared,
        expires_height,
    })
}

/// A signed `exact` payment, parsed and checked against its requirement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentCheck {
    /// The identity of the payment: the SHA-256 of its message.
    pub id: [u8; 32],
    /// The fee payer: the facilitator that signs last.
    pub fee_payer: Address,
    /// The token account that pays and the associated token account that receives.
    pub source: Address,
    pub destination: Address,
    pub units: u64,
    /// The required signatures, the fee payer's included.
    pub signatures: usize,
    pub compute_units: u32,
    pub micro_lamports_per_unit: u64,
    /// The network fee that the fee payer pays, in lamports.
    pub fee: u64,
    pub memo: Option<String>,
    /// The signed blockhash: [`check_expiry`] bounds its validity.
    pub blockhash: Hash,
}

fn invalid(what: &str) -> Error {
    Error::usage(format!("The payment transaction is invalid: {what}."))
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| invalid("truncated"))?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    /// A canonical compact-u16 length.
    fn short(&mut self) -> Result<usize> {
        let mut value = 0usize;
        for i in 0..3 {
            let byte = self.byte()?;
            value |= usize::from(byte & 0x7f) << (7 * i);
            if byte & 0x80 == 0 {
                if (i > 0 && byte == 0) || value > 0xffff {
                    return Err(invalid("a length is not canonical"));
                }
                return Ok(value);
            }
        }
        Err(invalid("a length is too long"))
    }
}

struct Instruction<'a> {
    program: Address,
    accounts: Vec<usize>,
    data: &'a [u8],
}

struct Wire<'a> {
    signatures: Vec<[u8; 64]>,
    message: &'a [u8],
    required: usize,
    readonly_signed: usize,
    readonly_unsigned: usize,
    keys: Vec<Address>,
    blockhash: Hash,
    instructions: Vec<Instruction<'a>>,
}

impl Wire<'_> {
    /// Whether the message lets its instructions write account `i`.
    fn writable(&self, i: usize) -> bool {
        if i < self.required {
            i < self.required - self.readonly_signed
        } else {
            i < self.keys.len() - self.readonly_unsigned
        }
    }
}

/// The wire format of a legacy transaction, parsed by hand and with bounds, so that no
/// deserializer decides what is checked.
fn parse(wire: &[u8]) -> Result<Wire<'_>> {
    if wire.len() > MAX_TRANSACTION_BYTES {
        return Err(invalid("it is larger than a transaction"));
    }
    let mut r = Reader { bytes: wire, at: 0 };
    let count = r.short()?;
    if count == 0 || count > MAX_SIGNATURES {
        return Err(invalid(
            "its signature count is not that of an exact payment",
        ));
    }
    let mut signatures = Vec::with_capacity(count);
    for _ in 0..count {
        signatures.push(r.take(64)?.try_into().expect("64 bytes"));
    }
    let message_start = r.at;
    let header = r.take(3)?;
    if header[0] & 0x80 != 0 {
        return Err(invalid("it is not a legacy message"));
    }
    let required = usize::from(header[0]);
    let keys_len = r.short()?;
    let mut keys = Vec::with_capacity(keys_len.min(64));
    for _ in 0..keys_len {
        keys.push(Address::new_from_array(
            r.take(32)?.try_into().expect("32 bytes"),
        ));
    }
    let blockhash = Hash::new_from_array(r.take(32)?.try_into().expect("32 bytes"));
    let ix_count = r.short()?;
    let mut instructions = Vec::with_capacity(ix_count.min(8));
    for _ in 0..ix_count {
        let program = usize::from(r.byte()?);
        let accounts_len = r.short()?;
        let accounts: Vec<usize> = r
            .take(accounts_len)?
            .iter()
            .map(|i| usize::from(*i))
            .collect();
        let data_len = r.short()?;
        let data = r.take(data_len)?;
        if program >= keys.len() || accounts.iter().any(|i| *i >= keys.len()) {
            return Err(invalid(
                "an instruction names an account that the message lacks",
            ));
        }
        instructions.push(Instruction {
            program: keys[program],
            accounts,
            data,
        });
    }
    if r.at != wire.len() {
        return Err(invalid("bytes follow the message"));
    }
    let (readonly_signed, readonly_unsigned) = (usize::from(header[1]), usize::from(header[2]));
    if count != required
        || required > keys.len()
        || readonly_signed >= required
        || required + readonly_unsigned > keys.len()
    {
        return Err(invalid(
            "its header does not match its signatures and accounts",
        ));
    }
    let mut sorted = keys.clone();
    sorted.sort();
    sorted.dedup();
    if sorted.len() != keys.len() {
        return Err(invalid("an account appears twice"));
    }
    Ok(Wire {
        signatures,
        message: &wire[message_start..],
        required,
        readonly_signed,
        readonly_unsigned,
        keys,
        blockhash,
        instructions,
    })
}

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("8 bytes"))
}

/// Check `wire`, a client's signed payment with the fee payer's place empty, against `accepted`,
/// the requirement that the seller accepted: a legacy message of the compute-unit limit, the
/// compute-unit price, one `TransferChecked` of exactly the required amount of the required mint
/// to the recipient's associated token account, and an optional UTF-8 memo; the fee payer is the
/// one that the requirement names and appears in no instruction; every other required signature
/// is present and valid; the network fee is at most `max_fee` lamports.
pub fn check_payment(wire: &[u8], accepted: &Value, max_fee: u64) -> Result<PaymentCheck> {
    if accepted["scheme"] != SCHEME || accepted["network"] != DEVNET {
        return Err(unsupported(
            "The payment is not an exact payment on Solana Devnet.",
        ));
    }
    let named_fee_payer = fee_payer(accepted)
        .ok_or_else(|| Error::usage("The requirement names no fee payer that can sign."))?;
    let asset = accepted["asset"].as_str().unwrap_or_default();
    let display = token(DEVNET, asset).ok_or_else(|| {
        unsupported("The requirement names an asset that this network does not list.")
    })?;
    let mint = parse_address(asset)
        .ok_or_else(|| Error::usage("The requirement names an invalid mint."))?;
    let pay_to = accepted["payTo"]
        .as_str()
        .and_then(parse_address)
        .ok_or_else(|| Error::usage("The requirement names an invalid recipient."))?;
    let units = token_units(&accepted["amount"])
        .ok_or_else(|| Error::usage("The requirement names an invalid amount."))?;

    let tx = parse(wire)?;
    if tx.keys[0] != named_fee_payer {
        return Err(Error::usage(
            "The payment's fee payer is not the facilitator that the requirement names.",
        ));
    }
    if tx
        .instructions
        .iter()
        .any(|ix| ix.accounts.contains(&0) || ix.program == named_fee_payer)
    {
        return Err(Error::usage(
            "The payment uses the fee payer's key in an instruction.",
        ));
    }
    let [limit, price, transfer, rest @ ..] = tx.instructions.as_slice() else {
        return Err(invalid(
            "it does not hold the instructions of an exact payment",
        ));
    };
    if limit.program != COMPUTE_BUDGET_PROGRAM
        || !limit.accounts.is_empty()
        || limit.data.len() != 5
        || limit.data[0] != 2
    {
        return Err(invalid(
            "its first instruction is not the compute-unit limit",
        ));
    }
    if price.program != COMPUTE_BUDGET_PROGRAM
        || !price.accounts.is_empty()
        || price.data.len() != 9
        || price.data[0] != 3
    {
        return Err(invalid(
            "its second instruction is not the compute-unit price",
        ));
    }
    if transfer.program != TOKEN_PROGRAM
        || transfer.data.len() != 10
        || transfer.data[0] != 12
        || transfer.accounts.len() < 4
    {
        return Err(invalid(
            "its third instruction is not a token TransferChecked",
        ));
    }
    let memo = match rest {
        [] => None,
        [memo]
            if memo.program == MEMO_PROGRAM
                && memo.accounts.is_empty()
                && memo.data.len() <= MAX_MEMO_BYTES =>
        {
            Some(
                std::str::from_utf8(memo.data)
                    .map_err(|_| invalid("its memo is not UTF-8"))?
                    .to_owned(),
            )
        }
        _ => return Err(invalid("it holds more than a payment and a memo")),
    };
    let account = |i: usize| tx.keys[transfer.accounts[i]];
    if account(1) != mint || transfer.data[9] != display.decimals {
        return Err(Error::usage(
            "The payment moves another mint than the requirement.",
        ));
    }
    if account(2) != associated_token_account(&pay_to, &mint) {
        return Err(Error::usage(
            "The payment pays another account than the recipient's associated token account.",
        ));
    }
    if account(0) == account(2) {
        return Err(Error::usage(
            "The payment pays the recipient's account from itself.",
        ));
    }
    // The transfer's accounts are distinct, and none is a program of the transaction: the source
    // is not the mint, and a multisig signer is listed once.
    let mut distinct = transfer.accounts.clone();
    distinct.sort_unstable();
    distinct.dedup();
    if distinct.len() != transfer.accounts.len()
        || transfer
            .accounts
            .iter()
            .any(|a| tx.instructions.iter().any(|ix| ix.program == tx.keys[*a]))
    {
        return Err(invalid(
            "the transfer names an account twice or names a program",
        ));
    }
    if !tx.writable(transfer.accounts[0]) || !tx.writable(transfer.accounts[2]) {
        return Err(invalid("the transfer's accounts are not writable"));
    }
    // The runtime never write-locks a reserved account, such as a builtin program or a sysvar,
    // whatever the header says.
    if is_reserved(&account(0)) || is_reserved(&account(2)) {
        return Err(invalid(
            "the transfer names an account that the runtime reserves",
        ));
    }
    // The fee payer, the source and the destination are the only writable accounts: the
    // transaction locks nothing else, such as the mint, for writing.
    if (0..tx.keys.len()).filter(|i| tx.writable(*i)).count() != 3 {
        return Err(invalid(
            "it writes other accounts than the fee payer, the source and the destination",
        ));
    }
    if read_u64(&transfer.data[1..9]) != units {
        return Err(Error::usage(
            "The payment moves another amount than the requirement.",
        ));
    }
    // The authority signs itself, or it is a multisig whose listed signers sign.
    let signs = |i: usize| i < tx.required;
    // A multisig lists at most its maximum of signers.
    let signers = &transfer.accounts[4..];
    if signers.len() > MAX_MULTISIG_SIGNERS {
        return Err(invalid(
            "the transfer lists more signers than a multisig has",
        ));
    }
    let authorized = if signers.is_empty() {
        signs(transfer.accounts[3])
    } else {
        signers.iter().all(|i| signs(*i)) && !signs(transfer.accounts[3])
    };
    if !authorized {
        return Err(invalid("the transfer's authority does not sign"));
    }
    let compute_units = u32::from_le_bytes(limit.data[1..5].try_into().expect("4 bytes"));
    let micro_lamports_per_unit = read_u64(&price.data[1..9]);
    if compute_units < MIN_COMPUTE_UNITS {
        return Err(invalid("its compute-unit limit cannot run the transfer"));
    }
    let fee = crate::native::fee(
        u8::try_from(tx.required).expect("at most three signatures"),
        Budget {
            units: compute_units,
            micro_lamports_per_unit,
        },
    );
    if fee > max_fee {
        return Err(Error::usage(format!(
            "The payment's network fee of {fee} lamports is above the bound of {max_fee}."
        )));
    }
    if tx.signatures[0] != [0u8; 64] {
        return Err(invalid("the fee payer's place is already signed"));
    }
    for i in 1..tx.required {
        let key = tx.keys[i].to_bytes();
        signer_identity(&key)?;
        let point =
            VerifyingKey::from_bytes(&key).map_err(|_| invalid("a signer is no Ed25519 key"))?;
        point
            .verify_strict(tx.message, &EdSignature::from_bytes(&tx.signatures[i]))
            .map_err(|_| invalid("a signature does not verify"))?;
    }
    Ok(PaymentCheck {
        id: Sha256::digest(tx.message).into(),
        fee_payer: named_fee_payer,
        source: account(0),
        destination: account(2),
        units,
        signatures: tx.required,
        compute_units,
        micro_lamports_per_unit,
        fee,
        memo,
        blockhash: tx.blockhash,
    })
}

/// The proof of `challenge`: the signed payment that the operation recorded, for the seller's
/// facilitator to sign as fee payer and submit. The recorded transaction is checked to pay this
/// challenge within [`MAX_FEE`], with the purchase memo of the receipt's request ID, valid client
/// signatures and a blockhash whose recorded block heights expire within the seller's settlement
/// time.
pub fn proof(challenge: &Challenge, receipt: &Value) -> Result<Proof> {
    let t = terms(challenge)?;
    if !matches!(receipt["status"].as_str(), Some("submitted" | "confirmed")) {
        return Err(Error::uncertain(
            "The payment is not signed. Read its status with the same request ID.",
        ));
    }
    if receipt["network"] != challenge.network.as_str() {
        return Err(Error::config(
            "The payment receipt is of another network than the challenge.",
        ));
    }
    // The server records what the operation paid for; the record must be this challenge.
    let expected = serde_json::to_value(challenge.context())
        .map_err(|_| Error::config("The payment challenge cannot be encoded."))?;
    if receipt["paidService"].is_null() {
        return Err(Error::config(
            "The payment receipt does not record what the payment bought.",
        ));
    }
    if receipt["paidService"] != expected {
        return Err(Error::config(
            "The payment receipt records another purchase.",
        ));
    }
    let request_id = receipt["requestId"]
        .as_str()
        .filter(|id| request_id_valid(id))
        .ok_or_else(|| Error::config("The payment receipt names no valid request ID."))?;
    let transaction = receipt[AUTHORIZATION_KEY]["transaction"]
        .as_str()
        .unwrap_or_default();
    let bytes = (transaction.len() <= 2048)
        .then(|| STANDARD.decode(transaction).ok())
        .flatten()
        .ok_or_else(|| Error::config("The payment receipt holds no signed payment."))?;
    let checked = check_payment(&bytes, &challenge.terms["accepted"], MAX_FEE).map_err(|e| {
        Error::config(format!(
            "The payment receipt holds no signed payment of this challenge: {}",
            e.message
        ))
    })?;
    if checked.memo != Some(purchase_memo(challenge, request_id)?) {
        return Err(Error::config(
            "The payment receipt holds a payment of another purchase.",
        ));
    }
    // The operation recorded the block heights that the ledger reported for the signed blockhash.
    let record = &receipt[AUTHORIZATION_KEY];
    let height = |key: &str| {
        record[key].as_u64().ok_or_else(|| {
            Error::config("The payment receipt holds no block heights of the payment's blockhash.")
        })
    };
    let recent = Recent {
        blockhash: checked.blockhash,
        last_valid_block_height: height("lastValidBlockHeight")?,
        block_height: height("blockHeight")?,
    };
    check_expiry(t.settle_within, &recent).map_err(|e| {
        Error::config(format!(
            "The recorded payment does not expire within the seller's settlement time: {}",
            e.message
        ))
    })?;
    let mut document = json!({
        "x402Version": 2,
        "accepted": challenge.terms["accepted"],
        "payload": {"transaction": transaction},
    });
    if challenge.terms["resource"].is_object() {
        document["resource"] = challenge.terms["resource"].clone();
    }
    let encoded = serde_json::to_vec(&document)
        .map_err(|_| Error::config("The payment proof cannot be encoded."))?;
    Ok(Proof {
        header: PROOF_HEADER.to_owned(),
        value: STANDARD.encode(encoded),
    })
}

/// The rail's paid-service hook.
pub struct PaidService;

impl PaidServiceProvider for PaidService {
    fn challenge(
        &self,
        network: &str,
        resource: &str,
        reply: &SellerReply<'_>,
    ) -> Result<Challenge> {
        challenge(network, resource, reply)
    }
    fn proof(&self, challenge: &Challenge, receipt: &Value) -> Result<Proof> {
        proof(challenge, receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{KeySigner, networks::USDC_DEVNET};
    use allowit_core::vendor::{KeyProvider, runtime::Signer};

    const RESOURCE: &str = "https://seller.example/report?id=7";

    fn signer(seed: u8) -> KeySigner {
        KeySigner(crate::KEYS.derive(&[seed; 32]).unwrap())
    }
    fn key(seed: u8) -> String {
        signer(seed).identity().to_owned()
    }
    fn accepted() -> Value {
        json!({
            "scheme": "exact",
            "network": DEVNET,
            "amount": "2500000",
            "asset": USDC_DEVNET,
            "payTo": key(20),
            "maxTimeoutSeconds": 60,
            "extra": {"feePayer": key(21)},
        })
    }
    fn reply_of(document: &Value) -> (Vec<(String, String)>, Vec<u8>) {
        let header = STANDARD.encode(serde_json::to_vec(document).unwrap());
        (
            vec![("payment-required".to_owned(), header)],
            b"{}".to_vec(),
        )
    }
    fn parse_challenge(document: &Value) -> Result<Challenge> {
        let (headers, body) = reply_of(document);
        challenge(
            DEVNET,
            RESOURCE,
            &SellerReply {
                status: 402,
                headers: &headers,
                body: &body,
            },
        )
    }
    fn document(accepts: Vec<Value>) -> Value {
        json!({"x402Version": 2, "resource": {"url": RESOURCE}, "accepts": accepts})
    }
    fn wallet() -> Wallet {
        let a = |s: u8| key(s).parse().unwrap();
        Wallet {
            owner: a(1),
            mint: USDC_DEVNET.parse().unwrap(),
            agent: a(2),
            server: a(3),
        }
    }
    const REQUEST: &str = "pay-0001";
    type Restore = fn(&mut Challenge);
    /// A blockhash with 120 blocks to go: what a seller's 60 seconds admit.
    fn recent() -> Recent {
        Recent {
            blockhash: Hash::default(),
            last_valid_block_height: 1_120,
            block_height: 1_000,
        }
    }
    /// The client's signed payment of `c` for `request`, as the operation records it.
    fn signed_for(c: &Challenge, request: &str) -> Vec<u8> {
        let p = payment(&wallet(), c, request, Budget::PAYMENT, recent())
            .unwrap()
            .prepared;
        p.wire(&[p.sign(&signer(2)).unwrap(), p.sign(&signer(3)).unwrap()])
            .unwrap()
    }
    fn signed(c: &Challenge) -> Vec<u8> {
        signed_for(c, REQUEST)
    }
    fn receipt(c: &Challenge, wire: &[u8]) -> Value {
        json!({
            "requestId": REQUEST,
            "status": "submitted",
            "network": DEVNET,
            "paidService": serde_json::to_value(c.context()).unwrap(),
            AUTHORIZATION_KEY: {
                "transaction": STANDARD.encode(wire),
                "lastValidBlockHeight": 1_120,
                "blockHeight": 1_000,
            },
        })
    }

    #[test]
    fn a_devnet_exact_requirement_becomes_a_seller_settled_challenge() {
        let c = parse_challenge(&document(vec![accepted()])).unwrap();
        assert_eq!(
            (c.network.as_str(), c.scheme.as_str(), c.asset.as_str()),
            (DEVNET, "exact", USDC_DEVNET)
        );
        assert_eq!(c.amount.units, "2500000");
        assert_eq!(c.amount.asset.decimals, 6);
        assert_eq!(c.settled_by, SettledBy::Seller);
        assert_eq!(c.settle_within, Some(60));
        assert_eq!(c.terms["accepted"], accepted());
        // A null challenge id is absent: the seller's nonce names the challenge.
        let mut a = accepted();
        a["extra"]["challengeId"] = json!(null);
        a["extra"]["nonce"] = json!("n-7");
        let c = parse_challenge(&document(vec![a])).unwrap();
        assert_eq!(c.id.as_deref(), Some("n-7"));
        let mut a = accepted();
        a["maxTimeoutSeconds"] = json!(null);
        let c = parse_challenge(&document(vec![a])).unwrap();
        assert_eq!(c.settle_within, Some(DEFAULT_SETTLE_WITHIN));
    }

    #[test]
    fn a_challenge_survives_a_round_trip_through_cores_record() {
        let nested = |levels: usize| {
            let mut v = json!(1);
            for _ in 0..levels {
                v = json!([v]);
            }
            v
        };
        let with = |levels: usize| {
            let mut doc = document(vec![accepted()]);
            doc["resource"]["extra"] = nested(levels);
            parse_challenge(&doc)
        };
        // The terms and the resource are two levels above the nested arrays and their scalar.
        let c = with(MAX_TERMS_DEPTH - 3).unwrap();
        let record = serde_json::to_vec(&json!({"operation": {"challenge": c}})).unwrap();
        let read: Value = serde_json::from_slice(&record).unwrap();
        let back: Challenge =
            serde_json::from_value(read["operation"]["challenge"].clone()).unwrap();
        assert_eq!(back, c);
        assert!(with(MAX_TERMS_DEPTH - 2).is_err());
        assert!(with(125).is_err());
    }

    #[test]
    fn the_memo_hashes_terms_with_sorted_keys() {
        let value: Value =
            serde_json::from_str(r#"{"b":1,"a":{"d":[3,{"f":1,"e":"x"}],"c":null}}"#).unwrap();
        let mut out = Vec::new();
        canonical(&value, &mut out).unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            r#"{"a":{"c":null,"d":[3,{"e":"x","f":1}]},"b":1}"#
        );
    }

    #[test]
    fn an_expired_offer_gives_way_to_a_live_one() {
        let at = |accepts: Vec<Value>, now: u64| {
            let (headers, body) = reply_of(&document(accepts));
            challenge_at(
                DEVNET,
                RESOURCE,
                &SellerReply {
                    status: 402,
                    headers: &headers,
                    body: &body,
                },
                now,
            )
        };
        let mut expired = accepted();
        expired["extra"]["expiresAt"] = json!(1_000);
        expired["payTo"] = json!(key(22));
        assert!(at(vec![expired.clone()], 1_000).is_err());
        assert_eq!(at(vec![expired.clone()], 999).unwrap().pay_to, key(22));
        assert_eq!(
            at(vec![expired.clone(), accepted()], 1_000).unwrap().pay_to,
            key(20)
        );
        // An offer read while live is not signed once it has expired.
        let c = at(vec![expired], 999).unwrap();
        let pay = |now| payment_at(&wallet(), &c, REQUEST, Budget::PAYMENT, recent(), now);
        assert!(pay(999).is_ok());
        assert!(pay(1_000).is_err());
    }

    #[test]
    fn the_reserved_accounts_are_agaves() {
        use agave_reserved_account_keys::ReservedAccountKeys;
        let mut ours: Vec<[u8; 32]> = RESERVED.iter().map(|k| k.to_bytes()).collect();
        let mut agave: Vec<[u8; 32]> = ReservedAccountKeys::all_keys_iter()
            .map(|k| k.to_bytes())
            .collect();
        ours.sort_unstable();
        agave.sort_unstable();
        assert_eq!(ours, agave);
        // A reserved fee payer gives way to the next offer.
        let mut reserved = accepted();
        reserved["extra"]["feePayer"] = json!("Feature111111111111111111111111111111111111");
        reserved["payTo"] = json!(key(22));
        assert!(parse_challenge(&document(vec![reserved.clone()])).is_err());
        let c = parse_challenge(&document(vec![reserved, accepted()])).unwrap();
        assert_eq!(c.pay_to, key(20));
    }

    #[test]
    fn seller_json_keeps_its_literal_types() {
        // serde_json reads these reserved keys as a raw value or a number, not as an object.
        for amount in [
            r#"{"$serde_json::private::RawValue": "\"2500000\""}"#,
            r#"{"\u0024serde_json::private::RawValue": "\"2500000\""}"#,
            r#"{"$serde_json::private::Number": "2500000"}"#,
        ] {
            let text = serde_json::to_string(&document(vec![accepted()]))
                .unwrap()
                .replace(r#""2500000""#, amount);
            let headers = vec![("PAYMENT-REQUIRED".to_owned(), STANDARD.encode(&text))];
            let reply = SellerReply {
                status: 402,
                headers: &headers,
                body: b"",
            };
            assert!(challenge(DEVNET, RESOURCE, &reply).is_err(), "{amount}");
        }
        // A string value may start with the prefix; a key may not, whatever the spacing.
        assert!(free_of_reserved_keys(
            br#"{"a": "$serde_json::private::RawValue"}"#
        ));
        assert!(!free_of_reserved_keys(
            br#"{"$serde_json::private::Number" : 1}"#
        ));
        let mut doc = document(vec![accepted()]);
        doc["resource"]["description"] = json!("$serde_json::private::RawValue");
        assert!(parse_challenge(&doc).is_ok());
    }

    #[test]
    fn an_offer_whose_fee_payer_is_an_account_of_the_payment_gives_way_to_the_next() {
        let mut mint_payer = accepted();
        mint_payer["extra"]["feePayer"] = json!(USDC_DEVNET);
        mint_payer["payTo"] = json!(key(22));
        if signer_identity(&parse_address(USDC_DEVNET).unwrap().to_bytes()).is_ok() {
            assert!(parse_challenge(&document(vec![mint_payer.clone()])).is_err());
        }
        for fee_payer in [
            TOKEN_PROGRAM,
            MEMO_PROGRAM,
            associated_token_account(&key(22).parse().unwrap(), &USDC_DEVNET.parse().unwrap()),
        ] {
            let mut a = mint_payer.clone();
            a["extra"]["feePayer"] = json!(fee_payer.to_string());
            if signer_identity(&fee_payer.to_bytes()).is_ok() {
                assert!(parse_challenge(&document(vec![a])).is_err(), "{fee_payer}");
            }
        }
        let c = parse_challenge(&document(vec![mint_payer, accepted()])).unwrap();
        assert_eq!(c.pay_to, key(20));
    }

    #[test]
    fn other_networks_are_skipped_and_wrong_requirements_refused() {
        let mut other = accepted();
        other["network"] = json!("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
        assert_eq!(
            parse_challenge(&document(vec![other.clone(), accepted()]))
                .unwrap()
                .pay_to,
            key(20)
        );
        assert!(parse_challenge(&document(vec![other])).is_err());
        let cases: Vec<(&str, Value)> = vec![
            ("scheme", json!("upto")),
            ("asset", json!(key(22))),
            ("amount", json!("0")),
            ("amount", json!("01")),
            ("amount", json!(2500000)),
            ("amount", json!("18446744073709551616")),
            ("payTo", json!("not base58 0OIl")),
            ("maxTimeoutSeconds", json!(0)),
            ("maxTimeoutSeconds", json!(MAX_SETTLE_WITHIN + 1)),
        ];
        for (field, value) in cases {
            let mut bad = accepted();
            bad[field] = value;
            assert!(parse_challenge(&document(vec![bad])).is_err(), "{field}");
        }
        for fee_payer in [
            json!(null),
            json!("11111111111111111111111111111111"),
            json!("x"),
        ] {
            let mut bad = accepted();
            bad["extra"]["feePayer"] = fee_payer.clone();
            assert!(
                parse_challenge(&document(vec![bad])).is_err(),
                "{fee_payer}"
            );
        }
        for resource in [
            json!({"url": "https://seller.example/other"}),
            json!({"url": 7}),
            json!("x"),
        ] {
            let mut doc = document(vec![accepted()]);
            doc["resource"] = resource.clone();
            assert!(parse_challenge(&doc).is_err(), "{resource}");
        }
        let mut doc = document(vec![accepted()]);
        doc["x402Version"] = json!(1);
        assert!(parse_challenge(&doc).is_err());
        let (headers, body) = reply_of(&document(vec![accepted()]));
        assert!(
            challenge(
                DEVNET,
                RESOURCE,
                &SellerReply {
                    status: 200,
                    headers: &headers,
                    body: &body
                }
            )
            .is_err()
        );
        assert!(
            challenge(
                DEVNET,
                RESOURCE,
                &SellerReply {
                    status: 402,
                    headers: &[],
                    body: &body
                }
            )
            .is_err()
        );
    }

    #[test]
    fn a_payment_never_names_a_wallet_key_as_facilitator_and_follows_its_terms() {
        let w = wallet();
        let pay = |c: &Challenge| payment(&w, c, REQUEST, Budget::PAYMENT, recent());
        // Neither a wallet key nor any other account or program of the payment is the facilitator.
        let accounts = [
            w.owner,
            w.agent,
            w.server,
            w.mint,
            w.token_account(),
            w.delegate(),
            TOKEN_PROGRAM,
            MEMO_PROGRAM,
            COMPUTE_BUDGET_PROGRAM,
        ];
        for own in &accounts {
            if signer_identity(&own.to_bytes()).is_err() {
                continue;
            }
            let mut a = accepted();
            a["extra"]["feePayer"] = json!(own.to_string());
            // The challenge refuses the accounts that it knows; the payment refuses the rest.
            let refused = parse_challenge(&document(vec![a])).map_or(true, |c| pay(&c).is_err());
            assert!(refused, "{own}");
        }
        let c = parse_challenge(&document(vec![accepted()])).unwrap();
        let restorations: [(&str, Restore); 9] = [
            ("amount", |c| c.amount.units = "1".into()),
            ("network", |c| {
                c.terms["accepted"]["network"] = json!("solana:other")
            }),
            ("resource", |c| {
                c.terms["resource"]["url"] = json!("https://seller.example/other")
            }),
            ("version", |c| c.terms["x402Version"] = json!(1)),
            ("size", |c| {
                c.terms["accepted"]["extra"]["pad"] = json!("x".repeat(MAX_TERMS_BYTES))
            }),
            ("settle_within", |c| c.settle_within = None),
            ("shorter terms", |c| {
                c.terms["accepted"]["maxTimeoutSeconds"] = json!(10)
            }),
            ("id", |c| c.id = Some("order-9".into())),
            ("display", |c| c.amount.asset.decimals = 2),
        ];
        for (what, restore) in restorations {
            let mut restored = c.clone();
            restore(&mut restored);
            assert!(pay(&restored).is_err(), "{what}");
        }
        for id in ["", "x", "pay 0001", &"x".repeat(101)] {
            assert!(
                payment(&w, &c, id, Budget::PAYMENT, recent()).is_err(),
                "{id:?}"
            );
        }
    }

    #[test]
    fn a_payment_expires_within_the_sellers_settlement_time() {
        let w = wallet();
        let c = parse_challenge(&document(vec![accepted()])).unwrap();
        let at = |remaining: u64, block_height: u64| Recent {
            blockhash: Hash::default(),
            last_valid_block_height: block_height + remaining,
            block_height,
        };
        // 60 seconds admit 120 blocks of 500 ms: a fresh blockhash's 150 blocks are too many.
        let p = payment(&w, &c, REQUEST, Budget::PAYMENT, at(120, 1_000)).unwrap();
        assert_eq!(p.expires_height, 1_120);
        let refused = payment(&w, &c, REQUEST, Budget::PAYMENT, at(150, 1_000)).unwrap_err();
        assert!(
            refused.message.contains("older blockhash"),
            "{}",
            refused.message
        );
        // The last valid height is still valid; the next one is not.
        assert!(payment(&w, &c, REQUEST, Budget::PAYMENT, at(0, 1_000)).is_ok());
        let expired = Recent {
            blockhash: Hash::default(),
            last_valid_block_height: 999,
            block_height: 1_000,
        };
        assert!(payment(&w, &c, REQUEST, Budget::PAYMENT, expired).is_err());
        let mut a = accepted();
        a["maxTimeoutSeconds"] = json!(10);
        let short = parse_challenge(&document(vec![a])).unwrap();
        assert!(payment(&w, &short, REQUEST, Budget::PAYMENT, at(20, 1_000)).is_ok());
        assert!(payment(&w, &short, REQUEST, Budget::PAYMENT, at(21, 1_000)).is_err());
        // A budget whose fee a proof would refuse is never signed.
        let pricey = Budget {
            units: 200_000,
            micro_lamports_per_unit: 2_000_000,
        };
        assert!(payment(&w, &c, REQUEST, pricey, at(120, 1_000)).is_err());
        // Nor is a compute-unit limit that cannot run the transfer.
        let starved = Budget {
            units: MIN_COMPUTE_UNITS - 1,
            micro_lamports_per_unit: 1,
        };
        assert!(payment(&w, &c, REQUEST, starved, at(120, 1_000)).is_err());
    }

    #[test]
    fn distinct_purchases_sign_distinct_payments_and_a_retry_the_same() {
        let first = parse_challenge(&document(vec![accepted()])).unwrap();
        // The same terms without a seller id: two operations, two transactions.
        assert_ne!(
            signed_for(&first, "pay-0001"),
            signed_for(&first, "pay-0002")
        );
        assert_ne!(
            purchase_memo(&first, "pay-0001").unwrap(),
            purchase_memo(&first, "pay-0002").unwrap()
        );
        // A retry of one operation signs the same transaction.
        assert_eq!(signed(&first), signed(&first));
        let mut a = accepted();
        a["extra"]["challengeId"] = json!("order-2");
        let second = parse_challenge(&document(vec![a])).unwrap();
        assert_ne!(signed(&first), signed(&second));
        let longest = "x".repeat(100);
        assert!(purchase_memo(&first, &longest).unwrap().len() <= MAX_MEMO_BYTES);
    }

    #[test]
    fn a_signed_payment_is_checked_against_its_requirement() {
        let c = parse_challenge(&document(vec![accepted()])).unwrap();
        let wire = signed(&c);
        let checked = check_payment(&wire, &accepted(), MAX_FEE).unwrap();
        assert_eq!(
            (checked.units, checked.signatures, checked.fee),
            (2_500_000, 3, 15_001)
        );
        assert_eq!(checked.memo, Some(purchase_memo(&c, REQUEST).unwrap()));
        // The facilitator's fee bound counts the signatures and the priority fee.
        assert!(check_payment(&wire, &accepted(), 15_000).is_err());
        for (field, value) in [
            ("amount", json!("2500001")),
            ("payTo", json!(key(22))),
            ("asset", json!(key(22))),
            ("network", json!("solana:other")),
        ] {
            let mut bad = accepted();
            bad[field] = value;
            assert!(check_payment(&wire, &bad, MAX_FEE).is_err(), "{field}");
        }
        let mut other_fee_payer = accepted();
        other_fee_payer["extra"]["feePayer"] = json!(key(22));
        assert!(check_payment(&wire, &other_fee_payer, MAX_FEE).is_err());
        for at in [wire.len() - 1, wire.len() - 60, 200] {
            let mut bad = wire.clone();
            bad[at] ^= 1;
            assert!(check_payment(&bad, &accepted(), MAX_FEE).is_err(), "{at}");
        }
        let mut signed_place = wire.clone();
        signed_place[1] = 1;
        assert!(check_payment(&signed_place, &accepted(), MAX_FEE).is_err());
        let mut longer = wire.clone();
        longer.push(0);
        assert!(check_payment(&longer, &accepted(), MAX_FEE).is_err());
        assert!(check_payment(&wire[..wire.len() - 1], &accepted(), MAX_FEE).is_err());
        assert!(check_payment(&[], &accepted(), MAX_FEE).is_err());

        // A transfer from the recipient's account to itself credits nothing.
        let accounts = parse(&wire).unwrap().instructions[2].accounts.clone();
        let pattern: Vec<u8> = std::iter::once(accounts.len() as u8)
            .chain(accounts.iter().map(|i| *i as u8))
            .collect();
        let at = wire
            .windows(pattern.len())
            .position(|w| w == pattern.as_slice())
            .unwrap()
            + 1;
        let mut to_itself = wire.clone();
        to_itself[at] = to_itself[at + 2];
        let refused = check_payment(&to_itself, &accepted(), MAX_FEE).unwrap_err();
        assert!(refused.message.contains("itself"), "{}", refused.message);
        // A message that makes the transfer's accounts read-only moves nothing.
        let header = 1 + 64 * 3;
        let mut readonly = wire.clone();
        readonly[header + 2] += 2;
        let refused = check_payment(&readonly, &accepted(), MAX_FEE).unwrap_err();
        assert!(refused.message.contains("writable"), "{}", refused.message);
        // A message that makes another account writable, a signer or the mint, is refused.
        for (at_header, what) in [(1, "a client signer"), (2, "an unsigned account")] {
            let mut wider = wire.clone();
            wider[header + at_header] -= 1;
            let refused = check_payment(&wider, &accepted(), MAX_FEE).unwrap_err();
            assert!(
                refused.message.contains("writes other"),
                "{what}: {}",
                refused.message
            );
        }
        // A multisig signer listed twice is refused.
        let mut twice = wire.clone();
        twice[at + 5] = twice[at + 4];
        let refused = check_payment(&twice, &accepted(), MAX_FEE).unwrap_err();
        assert!(refused.message.contains("twice"), "{}", refused.message);
        // A source that the runtime reserves, here the System Program, is never write-locked.
        let source = usize::from(wire[at]);
        let key_at = header + 3 + 1 + 32 * source;
        let mut system = wire.clone();
        system[key_at..key_at + 32].fill(0);
        let refused = check_payment(&system, &accepted(), MAX_FEE).unwrap_err();
        assert!(refused.message.contains("reserves"), "{}", refused.message);
        // A source that is the mint, or a program, is refused before anything else about it.
        let token = parse(&wire)
            .unwrap()
            .keys
            .iter()
            .position(|k| *k == TOKEN_PROGRAM)
            .unwrap() as u8;
        for (source, what) in [(wire[at + 1], "twice"), (token, "program")] {
            let mut alias = wire.clone();
            alias[at] = source;
            let refused = check_payment(&alias, &accepted(), MAX_FEE).unwrap_err();
            assert!(
                refused.message.contains(what),
                "{what}: {}",
                refused.message
            );
        }
        // A compute-unit limit below the floor cannot run the transfer.
        let starved = wallet()
            .payment(
                &associated_token_account(&key(20).parse().unwrap(), &wallet().mint),
                2_500_000,
                6,
                Budget {
                    units: MIN_COMPUTE_UNITS - 1,
                    micro_lamports_per_unit: 1,
                },
                Some(&purchase_memo(&c, REQUEST).unwrap()),
                &key(21).parse().unwrap(),
                Hash::default(),
            )
            .unwrap();
        let starved = starved
            .wire(&[
                starved.sign(&signer(2)).unwrap(),
                starved.sign(&signer(3)).unwrap(),
            ])
            .unwrap();
        let refused = check_payment(&starved, &accepted(), MAX_FEE).unwrap_err();
        assert!(
            refused.message.contains("compute-unit"),
            "{}",
            refused.message
        );
    }

    #[test]
    fn a_signature_with_a_small_order_commitment_is_refused() {
        use curve25519_dalek::{Scalar, edwards::CompressedEdwardsY, traits::Identity};
        use ed25519_dalek::{Signer as _, SigningKey, Verifier as _};
        use sha2::Sha512;
        use solana_signature::Signature;
        let (agent, server) = (
            SigningKey::from_bytes(&[9; 32]),
            SigningKey::from_bytes(&[10; 32]),
        );
        let at = |k: &SigningKey| Address::new_from_array(k.verifying_key().to_bytes());
        let w = Wallet {
            agent: at(&agent),
            server: at(&server),
            ..wallet()
        };
        let c = parse_challenge(&document(vec![accepted()])).unwrap();
        let p = payment(&w, &c, REQUEST, Budget::PAYMENT, recent())
            .unwrap()
            .prepared;
        let message = p.message_bytes();
        // R is the identity and s = H(R, A, M) * a: s*B = R + H*A holds, so a check that accepts a
        // small-order R accepts this signature; the ledger's strict check refuses it.
        let r = CompressedEdwardsY::identity().to_bytes();
        let h = Scalar::from_bytes_mod_order_wide(
            &Sha512::new()
                .chain_update(r)
                .chain_update(agent.verifying_key().as_bytes())
                .chain_update(message)
                .finalize()
                .into(),
        );
        let mut weak = [0u8; 64];
        weak[..32].copy_from_slice(&r);
        weak[32..].copy_from_slice((h * agent.to_scalar()).as_bytes());
        let lax = agent
            .verifying_key()
            .verify(message, &EdSignature::from_bytes(&weak));
        assert!(lax.is_ok(), "the condition reproduces");
        let good = [
            (at(&agent), Signature::from(agent.sign(message).to_bytes())),
            (
                at(&server),
                Signature::from(server.sign(message).to_bytes()),
            ),
        ];
        assert!(check_payment(&p.wire(&good).unwrap(), &accepted(), MAX_FEE).is_ok());
        let bad = [(at(&agent), Signature::from(weak)), good[1]];
        assert!(check_payment(&p.wire(&bad).unwrap(), &accepted(), MAX_FEE).is_err());
    }

    #[test]
    fn a_proof_carries_only_a_checked_payment_of_this_purchase() {
        let c = parse_challenge(&document(vec![accepted()])).unwrap();
        let wire = signed(&c);
        let p = proof(&c, &receipt(&c, &wire)).unwrap();
        assert_eq!(p.header, PROOF_HEADER);
        let decoded: Value = serde_json::from_slice(&STANDARD.decode(&p.value).unwrap()).unwrap();
        assert_eq!(decoded["x402Version"], 2);
        assert_eq!(decoded["accepted"], accepted());
        assert_eq!(decoded["resource"]["url"], RESOURCE);
        assert_eq!(
            STANDARD
                .decode(decoded["payload"]["transaction"].as_str().unwrap())
                .unwrap(),
            wire
        );
        let good = receipt(&c, &wire);
        for (field, value) in [
            ("status", json!("prepared")),
            ("network", json!("solana:other")),
            ("paidService", json!(null)),
            ("requestId", json!(null)),
            ("requestId", json!("pay-0002")),
        ] {
            let mut bad = good.clone();
            bad[field] = value;
            assert!(proof(&c, &bad).is_err(), "{field}");
        }
        // The recorded block heights must bound the blockhash within the seller's time.
        for (key, value) in [
            ("lastValidBlockHeight", json!(1_150)),
            ("lastValidBlockHeight", json!(null)),
            ("blockHeight", json!(1_121)),
        ] {
            let mut bad = good.clone();
            bad[AUTHORIZATION_KEY][key] = value;
            assert!(proof(&c, &bad).is_err(), "{key}");
        }
        // Arbitrary bytes, or the payment of another purchase, are no proof of this one.
        assert!(proof(&c, &receipt(&c, &[7u8; 600])).is_err());
        let mut a = accepted();
        a["extra"]["challengeId"] = json!("order-2");
        let other = parse_challenge(&document(vec![a])).unwrap();
        assert!(proof(&c, &receipt(&c, &signed(&other))).is_err());
        // A challenge of the same URL and requirement with another resource descriptor is another
        // purchase: its memo differs, and this payment is no proof of it.
        let mut doc = document(vec![accepted()]);
        doc["resource"]["description"] = json!("another report");
        let described = parse_challenge(&doc).unwrap();
        assert_ne!(
            purchase_memo(&c, REQUEST).unwrap(),
            purchase_memo(&described, REQUEST).unwrap()
        );
        assert!(proof(&described, &receipt(&described, &wire)).is_err());
        // A restored challenge whose echoed resource differs presents no proof.
        let mut restored = c.clone();
        restored.terms["resource"]["url"] = json!("https://seller.example/other");
        assert!(proof(&restored, &receipt(&c, &wire)).is_err());
    }
}
