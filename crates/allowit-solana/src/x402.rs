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
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature as EdSignature, Verifier, VerifyingKey};
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
/// The shortest settlement time that a payment can honour: a recent blockhash is valid for about
/// 60 seconds of blocks, and a signed payment cannot expire sooner.
pub const MIN_SETTLE_WITHIN: u64 = 60;
/// The most signatures that an `exact` payment of this rail carries: the fee payer's, the
/// agent's and the server's.
pub const MAX_SIGNATURES: usize = 3;
const MAX_REQUIREMENTS: usize = 32;
/// The largest accepted terms, as JSON. The proof echoes them.
pub const MAX_TERMS_BYTES: usize = 4096;
/// The prefix of the memo that names a purchase.
pub const MEMO_PREFIX: &str = "allowit:x402:";

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

/// The fee payer that `accepted` names, when it is a key that can sign.
fn fee_payer(accepted: &Value) -> Option<Address> {
    accepted["extra"]["feePayer"]
        .as_str()
        .and_then(parse_address)
        .filter(|key| signer_identity(&key.to_bytes()).is_ok())
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
    if fee_payer(accepted).is_none() {
        return Err(unsupported(
            "The seller's payment challenge names no fee payer that can sign.",
        ));
    }
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
    let id = match extra.get("challengeId").or_else(|| extra.get("nonce")) {
        None | Some(Value::Null) => None,
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
    // A signed payment lives as long as its blockhash; a seller that allows less is refused.
    let settle_within = match &accepted["maxTimeoutSeconds"] {
        Value::Null => MIN_SETTLE_WITHIN,
        value => {
            let seconds = value
                .as_u64()
                .filter(|seconds| (1..=MAX_SETTLE_WITHIN).contains(seconds))
                .ok_or_else(|| {
                    Error::usage("The seller's payment challenge has an invalid timeout.")
                })?;
            if seconds < MIN_SETTLE_WITHIN {
                return Err(unsupported(format!(
                    "The seller allows {seconds} seconds; a Solana payment stays valid for about {MIN_SETTLE_WITHIN}."
                )));
            }
            seconds
        }
    };
    let mut terms = json!({"x402Version": 2, "accepted": accepted});
    if document["resource"].is_object() {
        terms["resource"] = document["resource"].clone();
    }
    if serde_json::to_vec(&terms).map_or(true, |encoded| encoded.len() > MAX_TERMS_BYTES) {
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
            Ok(Some(challenge)) => return Ok(challenge),
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
}

fn terms(challenge: &Challenge) -> Result<Terms> {
    let accepted = &challenge.terms["accepted"];
    if challenge.network != DEVNET
        || challenge.scheme != SCHEME
        || challenge.settled_by != SettledBy::Seller
        || accepted["network"] != DEVNET
        || accepted["scheme"] != SCHEME
    {
        return Err(unsupported(
            "The payment challenge is not an exact payment of Solana Devnet.",
        ));
    }
    let units = token_units(&accepted["amount"])
        .filter(|units| challenge.amount.units == units.to_string());
    if accepted["payTo"] != challenge.pay_to.as_str()
        || accepted["asset"] != challenge.asset.as_str()
        || units.is_none()
    {
        return Err(Error::usage(
            "The payment challenge's terms name another payment.",
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
        units: units.expect("checked"),
        decimals: display.decimals,
    })
}

/// The memo that names one purchase: two purchases of the same amount to the same recipient sign
/// two transactions, and a retry of one purchase signs the same one.
pub fn purchase_memo(challenge: &Challenge) -> Result<String> {
    let context = serde_json::to_vec(&challenge.context())
        .map_err(|_| Error::config("The payment challenge cannot be encoded."))?;
    let accepted = serde_json::to_vec(&challenge.terms["accepted"])
        .map_err(|_| Error::config("The payment challenge cannot be encoded."))?;
    let mut hash = Sha256::new();
    hash.update(&context);
    hash.update([0]);
    hash.update(&accepted);
    let hex: String = hash.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(format!("{MEMO_PREFIX}{hex}"))
}

/// The Native wallet's payment of `challenge`: a transfer of exactly its amount of its mint to
/// the associated token account of its recipient, with the purchase memo, and the seller's
/// facilitator as fee payer. The facilitator is never one of the wallet's own keys: the wallet
/// would then pay a fee that the facilitator pays, and sign its place.
pub fn payment(
    wallet: &Wallet,
    challenge: &Challenge,
    budget: Budget,
    blockhash: Hash,
) -> Result<Prepared> {
    let t = terms(challenge)?;
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
    let memo = purchase_memo(challenge)?;
    wallet.payment(
        &associated_token_account(&t.pay_to, &t.mint),
        t.units,
        t.decimals,
        budget,
        Some(&memo),
        &t.fee_payer,
        blockhash,
    )
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
    pub memo: Option<String>,
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
    keys: Vec<Address>,
    instructions: Vec<Instruction<'a>>,
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
    let _blockhash = r.take(32)?;
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
        keys,
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
/// is present and valid.
pub fn check_payment(wire: &[u8], accepted: &Value) -> Result<PaymentCheck> {
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
    if read_u64(&transfer.data[1..9]) != units {
        return Err(Error::usage(
            "The payment moves another amount than the requirement.",
        ));
    }
    // The authority signs itself, or it is a multisig whose listed signers sign.
    let signs = |i: usize| i < tx.required;
    let signers = &transfer.accounts[4..];
    let authorized = if signers.is_empty() {
        signs(transfer.accounts[3])
    } else {
        signers.iter().all(|i| signs(*i)) && !signs(transfer.accounts[3])
    };
    if !authorized {
        return Err(invalid("the transfer's authority does not sign"));
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
            .verify(tx.message, &EdSignature::from_bytes(&tx.signatures[i]))
            .map_err(|_| invalid("a signature does not verify"))?;
    }
    Ok(PaymentCheck {
        id: Sha256::digest(tx.message).into(),
        fee_payer: named_fee_payer,
        source: account(0),
        destination: account(2),
        units,
        signatures: tx.required,
        compute_units: u32::from_le_bytes(limit.data[1..5].try_into().expect("4 bytes")),
        micro_lamports_per_unit: read_u64(&price.data[1..9]),
        memo,
    })
}

/// The proof of `challenge`: the signed payment that the operation recorded, for the seller's
/// facilitator to sign as fee payer and submit. The recorded transaction is checked to pay this
/// challenge, with its purchase memo and valid client signatures.
pub fn proof(challenge: &Challenge, receipt: &Value) -> Result<Proof> {
    terms(challenge)?;
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
    let transaction = receipt[AUTHORIZATION_KEY]["transaction"]
        .as_str()
        .unwrap_or_default();
    let bytes = (transaction.len() <= 2048)
        .then(|| STANDARD.decode(transaction).ok())
        .flatten()
        .ok_or_else(|| Error::config("The payment receipt holds no signed payment."))?;
    let checked = check_payment(&bytes, &challenge.terms["accepted"]).map_err(|e| {
        Error::config(format!(
            "The payment receipt holds no signed payment of this challenge: {}",
            e.message
        ))
    })?;
    if checked.memo != Some(purchase_memo(challenge)?) {
        return Err(Error::config(
            "The payment receipt holds a payment of another purchase.",
        ));
    }
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
    /// The client's signed payment of `c`, as the operation records it.
    fn signed(c: &Challenge) -> Vec<u8> {
        let p = payment(&wallet(), c, Budget::PAYMENT, Hash::default()).unwrap();
        p.wire(&[p.sign(&signer(2)).unwrap(), p.sign(&signer(3)).unwrap()])
            .unwrap()
    }
    fn receipt(c: &Challenge, wire: &[u8]) -> Value {
        json!({
            "status": "submitted",
            "network": DEVNET,
            "paidService": serde_json::to_value(c.context()).unwrap(),
            AUTHORIZATION_KEY: {"transaction": STANDARD.encode(wire)},
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
            ("maxTimeoutSeconds", json!(30)),
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
        for own in [&w.owner, &w.agent, &w.server] {
            let mut a = accepted();
            a["extra"]["feePayer"] = json!(own.to_string());
            let c = parse_challenge(&document(vec![a])).unwrap();
            assert!(payment(&w, &c, Budget::PAYMENT, Hash::default()).is_err());
        }
        let c = parse_challenge(&document(vec![accepted()])).unwrap();
        let mut restored = c.clone();
        restored.amount.units = "1".into();
        assert!(payment(&w, &restored, Budget::PAYMENT, Hash::default()).is_err());
        let mut restored = c.clone();
        restored.terms["accepted"]["network"] = json!("solana:other");
        assert!(payment(&w, &restored, Budget::PAYMENT, Hash::default()).is_err());
    }

    #[test]
    fn distinct_purchases_sign_distinct_payments_and_a_retry_the_same() {
        let first = parse_challenge(&document(vec![accepted()])).unwrap();
        let mut a = accepted();
        a["extra"]["challengeId"] = json!("order-2");
        let second = parse_challenge(&document(vec![a])).unwrap();
        assert_ne!(
            purchase_memo(&first).unwrap(),
            purchase_memo(&second).unwrap()
        );
        assert_ne!(signed(&first), signed(&second));
        assert_eq!(signed(&first), signed(&first));
        assert!(purchase_memo(&first).unwrap().len() <= MAX_MEMO_BYTES);
    }

    #[test]
    fn a_signed_payment_is_checked_against_its_requirement() {
        let c = parse_challenge(&document(vec![accepted()])).unwrap();
        let wire = signed(&c);
        let checked = check_payment(&wire, &accepted()).unwrap();
        assert_eq!((checked.units, checked.signatures), (2_500_000, 3));
        assert_eq!(checked.memo, Some(purchase_memo(&c).unwrap()));
        for (field, value) in [
            ("amount", json!("2500001")),
            ("payTo", json!(key(22))),
            ("asset", json!(key(22))),
            ("network", json!("solana:other")),
        ] {
            let mut bad = accepted();
            bad[field] = value;
            assert!(check_payment(&wire, &bad).is_err(), "{field}");
        }
        let mut other_fee_payer = accepted();
        other_fee_payer["extra"]["feePayer"] = json!(key(22));
        assert!(check_payment(&wire, &other_fee_payer).is_err());
        for at in [wire.len() - 1, wire.len() - 60, 200] {
            let mut bad = wire.clone();
            bad[at] ^= 1;
            assert!(check_payment(&bad, &accepted()).is_err(), "{at}");
        }
        let mut signed_place = wire.clone();
        signed_place[1] = 1;
        assert!(check_payment(&signed_place, &accepted()).is_err());
        let mut longer = wire.clone();
        longer.push(0);
        assert!(check_payment(&longer, &accepted()).is_err());
        assert!(check_payment(&wire[..wire.len() - 1], &accepted()).is_err());
        assert!(check_payment(&[], &accepted()).is_err());
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
        ] {
            let mut bad = good.clone();
            bad[field] = value;
            assert!(proof(&c, &bad).is_err(), "{field}");
        }
        // Arbitrary bytes, or the payment of another purchase, are no proof of this one.
        assert!(proof(&c, &receipt(&c, &[7u8; 600])).is_err());
        let mut a = accepted();
        a["extra"]["challengeId"] = json!("order-2");
        let other = parse_challenge(&document(vec![a])).unwrap();
        assert!(proof(&c, &receipt(&c, &signed(&other))).is_err());
    }
}
