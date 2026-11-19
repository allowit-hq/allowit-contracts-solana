//! x402 `exact` payments on Solana from a Native wallet: the client side.
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
//! wallet's payment for it, and builds the proof header from the signed payment that the
//! operation recorded. Version 1, whose network names are not CAIP-2 ids, is refused.
use crate::{
    keys::signer_identity,
    native::{Address, Budget, Prepared, TOKEN_PROGRAM, Wallet},
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
use serde_json::{Value, json};
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
/// The time from the signature to the settlement when the seller states none: about one
/// blockhash life.
pub const DEFAULT_SETTLE_WITHIN: u64 = 60;
const MAX_REQUIREMENTS: usize = 32;
/// The largest accepted terms, as JSON. The proof echoes them.
pub const MAX_TERMS_BYTES: usize = 4096;

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
    // The facilitator pays the fee and signs as fee payer; it names its key.
    let fee_payer = extra["feePayer"].as_str().and_then(parse_address);
    if fee_payer.is_none_or(|key| signer_identity(&key.to_bytes()).is_err()) {
        return Err(unsupported(
            "The seller's payment challenge names no fee payer that can sign.",
        ));
    }
    if document["resource"]["url"]
        .as_str()
        .is_some_and(|named| named != resource)
    {
        return Err(Error::usage(
            "The seller's payment challenge names another resource.",
        ));
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
    let amount = match &accepted["amount"] {
        Value::String(text) => text.clone(),
        _ => String::new(),
    };
    let units = amount
        .parse::<u64>()
        .ok()
        .filter(|units| *units > 0 && !amount.starts_with('0') && !amount.starts_with('+'))
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
    let settle_within = match &accepted["maxTimeoutSeconds"] {
        Value::Null => DEFAULT_SETTLE_WITHIN,
        value => value
            .as_u64()
            .filter(|seconds| (1..=MAX_SETTLE_WITHIN).contains(seconds))
            .ok_or_else(|| {
                Error::usage("The seller's payment challenge has an invalid timeout.")
            })?,
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

/// The Native wallet's payment of `challenge`: a transfer of exactly its amount of its mint to
/// the associated token account of its recipient, with the seller's facilitator as fee payer.
pub fn payment(
    wallet: &Wallet,
    challenge: &Challenge,
    budget: Budget,
    blockhash: Hash,
) -> Result<Prepared> {
    if challenge.network != DEVNET
        || challenge.scheme != SCHEME
        || challenge.settled_by != SettledBy::Seller
    {
        return Err(unsupported(
            "The payment challenge is not an exact payment of Solana Devnet.",
        ));
    }
    let accepted = &challenge.terms["accepted"];
    if accepted["payTo"] != challenge.pay_to.as_str()
        || accepted["asset"] != challenge.asset.as_str()
    {
        return Err(Error::usage(
            "The payment challenge's terms name another payment.",
        ));
    }
    let mint = parse_address(&challenge.asset)
        .ok_or_else(|| Error::usage("The payment challenge names an invalid mint."))?;
    if mint != wallet.mint {
        return Err(Error::usage(
            "The payment challenge asks for another asset than the wallet holds.",
        ));
    }
    let display = token(DEVNET, &challenge.asset)
        .ok_or_else(|| unsupported("The payment challenge names an unlisted asset."))?;
    let pay_to = parse_address(&challenge.pay_to)
        .ok_or_else(|| Error::usage("The payment challenge names an invalid recipient."))?;
    let fee_payer = accepted["extra"]["feePayer"]
        .as_str()
        .and_then(parse_address)
        .ok_or_else(|| Error::usage("The payment challenge names no fee payer."))?;
    let units = challenge
        .units()?
        .try_into()
        .map_err(|_| Error::usage("The payment challenge's amount does not fit a token amount."))?;
    wallet.payment(
        &associated_token_account(&pay_to, &mint),
        units,
        display.decimals,
        budget,
        None,
        &fee_payer,
        blockhash,
    )
}

/// The proof of `challenge`: the signed payment that the operation recorded, for the seller's
/// facilitator to sign as fee payer and submit.
pub fn proof(challenge: &Challenge, receipt: &Value) -> Result<Proof> {
    if challenge.network != DEVNET
        || challenge.scheme != SCHEME
        || challenge.settled_by != SettledBy::Seller
    {
        return Err(unsupported(
            "The payment challenge does not state a proof that this rail builds.",
        ));
    }
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
    let bytes_ok = transaction.len() <= 2048
        && STANDARD.decode(transaction).is_ok_and(|bytes| {
            !bytes.is_empty() && bytes.len() <= crate::native::MAX_TRANSACTION_BYTES
        });
    if !bytes_ok {
        return Err(Error::config(
            "The payment receipt holds no signed payment.",
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
    use crate::networks::USDC_DEVNET;
    use allowit_core::vendor::KeyProvider;

    const RESOURCE: &str = "https://seller.example/report?id=7";

    fn signer_key(seed: u8) -> String {
        crate::KEYS
            .derive(&[seed; 32])
            .unwrap()
            .address()
            .to_owned()
    }
    fn accepted() -> Value {
        json!({
            "scheme": "exact",
            "network": DEVNET,
            "amount": "2500000",
            "asset": USDC_DEVNET,
            "payTo": signer_key(20),
            "maxTimeoutSeconds": 60,
            "extra": {"feePayer": signer_key(21)},
        })
    }
    fn reply_of(document: &Value) -> (Vec<(String, String)>, Vec<u8>) {
        let header = STANDARD.encode(serde_json::to_vec(document).unwrap());
        (
            vec![("payment-required".to_owned(), header)],
            b"{}".to_vec(),
        )
    }
    fn parse(document: &Value) -> Result<Challenge> {
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

    #[test]
    fn a_devnet_exact_requirement_becomes_a_seller_settled_challenge() {
        let c = parse(&document(vec![accepted()])).unwrap();
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
            parse(&document(vec![other.clone(), accepted()]))
                .unwrap()
                .pay_to,
            signer_key(20)
        );
        assert!(parse(&document(vec![other])).is_err());
        let cases: Vec<(&str, Value)> = vec![
            ("scheme", json!("upto")),
            ("asset", json!(signer_key(22))),
            ("amount", json!("0")),
            ("amount", json!("01")),
            ("amount", json!(2500000)),
            ("amount", json!("18446744073709551616")),
            ("payTo", json!("not base58 0OIl")),
            ("maxTimeoutSeconds", json!(0)),
        ];
        for (field, value) in cases {
            let mut bad = accepted();
            bad[field] = value;
            assert!(parse(&document(vec![bad])).is_err(), "{field}");
        }
        for fee_payer in [
            json!(null),
            json!("11111111111111111111111111111111"),
            json!("x"),
        ] {
            let mut bad = accepted();
            bad["extra"]["feePayer"] = fee_payer.clone();
            assert!(parse(&document(vec![bad])).is_err(), "{fee_payer}");
        }
        let mut doc = document(vec![accepted()]);
        doc["resource"]["url"] = json!("https://seller.example/other");
        assert!(parse(&doc).is_err());
        let mut doc = document(vec![accepted()]);
        doc["x402Version"] = json!(1);
        assert!(parse(&doc).is_err());
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
    fn a_proof_carries_the_recorded_signed_payment_and_nothing_else() {
        let c = parse(&document(vec![accepted()])).unwrap();
        let transaction = STANDARD.encode([7u8; 600]);
        let receipt = json!({
            "status": "submitted",
            "network": DEVNET,
            "paidService": serde_json::to_value(c.context()).unwrap(),
            AUTHORIZATION_KEY: {"transaction": transaction},
        });
        let p = proof(&c, &receipt).unwrap();
        assert_eq!(p.header, PROOF_HEADER);
        let decoded: Value = serde_json::from_slice(&STANDARD.decode(&p.value).unwrap()).unwrap();
        assert_eq!(decoded["x402Version"], 2);
        assert_eq!(decoded["accepted"], accepted());
        assert_eq!(decoded["payload"]["transaction"], transaction);
        for (field, value) in [
            ("status", json!("prepared")),
            ("network", json!("solana:other")),
            ("paidService", json!(null)),
        ] {
            let mut bad = receipt.clone();
            bad[field] = value;
            assert!(proof(&c, &bad).is_err(), "{field}");
        }
        let mut other = receipt.clone();
        other["paidService"]["amount"] = json!("1");
        assert!(proof(&c, &other).is_err());
        let mut huge = receipt.clone();
        huge[AUTHORIZATION_KEY]["transaction"] = json!(STANDARD.encode([7u8; 1300]));
        assert!(proof(&c, &huge).is_err());
        let mut none = receipt;
        none[AUTHORIZATION_KEY] = json!(null);
        assert!(proof(&c, &none).is_err());
    }
}
