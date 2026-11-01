//! Standard x402 v2 SPL delegated payments. This adapter owns no keys or journal.
//!
//! The caller must reserve the exact action before invoking its signer, persist
//! the resulting credential before submission, and retain the reservation after
//! any uncertain delivery. Only a finalized RPC receipt can attest settlement.
pub mod setup;
use allowit_native::{
    client::{ATA_PROGRAM, TOKEN_PROGRAM},
    crypto::{Key, verify},
    transaction::{Instruction, Meta, Transaction},
};
use allowit_sdk::service::{Error, Result, coded};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::{Url, blocking::Client};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io::Read, time::Duration};

pub const SOLANA_MAINNET_CAIP2: &str = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
pub const SOLANA_USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub const SOLANA_DEVNET_CAIP2: &str = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
pub const SOLANA_DEVNET_GENESIS: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
pub const SOLANA_DEVNET_USDC_MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const COMPUTE: &str = "ComputeBudget111111111111111111111111111111";
const MEMO: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_CHALLENGE_BYTES: usize = 64 * 1024;
const MAX_DELIVERY_BYTES: usize = 1024 * 1024;
const MAX_RPC_BYTES: usize = 2 * 1024 * 1024;

fn invalid(message: &str) -> Error {
    coded(400, "x402_invalid_binding", message)
}
fn incompatible() -> Error {
    coded(
        502,
        "x402_incompatible",
        "The service does not offer the pinned Solana USDC x402 v2 exact payment.",
    )
}
fn uncertain() -> Error {
    coded(
        503,
        "x402_delivery_unknown",
        "Payment or delivery is unresolved. Retain the reservation and the original signed credential.",
    )
}
fn key(value: &str) -> Result<Key> {
    Key::parse(value).map_err(|_| invalid("Invalid Solana public key."))
}
fn is_false(value: &bool) -> bool {
    !*value
}

fn offer_amount(accepted: &Value, cap: u64) -> Result<u64> {
    let amount = accepted["amount"].as_str().ok_or_else(incompatible)?;
    if amount.is_empty() || amount.starts_with('0') || !amount.bytes().all(|b| b.is_ascii_digit()) {
        return Err(incompatible());
    }
    let amount_units = amount.parse::<u64>().map_err(|_| incompatible())?;
    if amount_units == 0
        || amount_units > cap
        || accepted["maxTimeoutSeconds"]
            .as_u64()
            .is_none_or(|v| v == 0 || v > 300)
        || !accepted["extra"].is_object()
        || (!accepted["extra"]["memo"].is_null()
            && accepted["extra"]["memo"]
                .as_str()
                .is_none_or(|v| v.is_empty() || v.len() > 256))
    {
        return Err(incompatible());
    }
    Ok(amount_units)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum X402Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

/// Deployment-owned pin. Workers select an id, never these fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct X402Endpoint {
    pub id: String,
    pub url: String,
    /// Some merchants identify a paid resource separately from the HTTP route
    /// (for example omitting query parameters). This is an explicit host pin,
    /// never inferred from an untrusted challenge. Omitted for old plan hashes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_url: Option<String>,
    pub method: X402Method,
    pub pay_to: String,
    pub mint: String,
    pub fee_payer: String,
    /// Explicit operator opt-in for a sponsor supplied by the pinned HTTPS
    /// merchant's fresh challenge. False is omitted to preserve old plan hashes.
    #[serde(default, skip_serializing_if = "is_false")]
    pub fee_payer_from_challenge: bool,
    /// Explicit operator mode for merchants publishing several price offers.
    /// Legacy pins keep strict single-offer selection and their old hashes.
    #[serde(default, skip_serializing_if = "is_false")]
    pub choose_lowest_amount: bool,
    pub max_amount_units: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct X402Request {
    #[serde(default)]
    pub body: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegatedSource {
    pub owner: String,
    pub delegate: String,
    /// An explicitly authorized SPL token account; it need not be an ATA.
    pub source_token_account: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedChallenge {
    pub accepted: Value,
    pub resource: Value,
    pub extensions: Value,
    pub amount_units: u64,
}

/// Exact bytes and operation binding to persist before asking a server signer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsignedDelegatedPayment {
    pub endpoint: X402Endpoint,
    pub request: X402Request,
    pub source: DelegatedSource,
    pub selected: SelectedChallenge,
    pub blockhash: String,
    pub last_valid_block_height: u64,
    pub nonce: String,
    pub destination_token_account: String,
    pub message_base64: String,
    pub unsigned_transaction_base64: String,
}

/// An HTTP result is delivery evidence, never settlement evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct X402Delivery {
    pub status: u16,
    pub content_type: String,
    pub body_base64: String,
    pub settlement_hint: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizedX402Payment {
    pub signature: String,
    pub finalized_slot: u64,
    pub network: String,
    pub mint: String,
    pub source_token_account: String,
    pub destination_token_account: String,
    pub amount_units: u64,
}

/// Narrow transport, parameterizable for a private validator without changing
/// production constants. The private constructor permits loopback URLs only.
pub struct DelegatedX402 {
    network: String,
    mint: String,
    private_validator: bool,
    client: Client,
}

impl DelegatedX402 {
    pub fn production() -> Result<Self> {
        Self::new(SOLANA_MAINNET_CAIP2, SOLANA_USDC_MINT, false)
    }

    /// Public networks have fixed token identities and identical protocol checks.
    pub fn for_public_network(network: &str) -> Result<Self> {
        match network {
            SOLANA_MAINNET_CAIP2 => Self::production(),
            SOLANA_DEVNET_CAIP2 => Self::new(SOLANA_DEVNET_CAIP2, SOLANA_DEVNET_USDC_MINT, false),
            _ => Err(invalid("Unsupported public delegated-payment network.")),
        }
    }

    /// Isolated integration mode: arbitrary mint/genesis, loopback transports.
    /// This mode must not be selected by worker input or enabled in production.
    pub fn for_private_validator(network: &str, mint: &str) -> Result<Self> {
        if matches!(
            network,
            SOLANA_MAINNET_CAIP2 | SOLANA_DEVNET_CAIP2 | "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"
        ) || !network.starts_with("solana:")
        {
            return Err(invalid(
                "Private-validator mode requires its actual Solana genesis id.",
            ));
        }
        Self::new(network, mint, true)
    }

    fn new(network: &str, mint: &str, private_validator: bool) -> Result<Self> {
        key(mint)?;
        if network.len() > 64 || network.len() <= "solana:".len() {
            return Err(invalid("Invalid x402 network id."));
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| uncertain())?;
        Ok(Self {
            network: network.into(),
            mint: mint.into(),
            private_validator,
            client,
        })
    }

    pub fn network(&self) -> &str {
        &self.network
    }

    fn check_url(&self, value: &str) -> Result<Url> {
        if value.len() > 4096 {
            return Err(invalid("Service URL is too long."));
        }
        let url = Url::parse(value).map_err(|_| invalid("Invalid pinned service URL."))?;
        let host = url
            .host_str()
            .ok_or_else(|| invalid("Missing service host."))?;
        let loopback = matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1");
        let host_is_literal = host.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[');
        let allowed_transport = if self.private_validator {
            loopback && matches!(url.scheme(), "http" | "https")
        } else {
            url.scheme() == "https"
                && !loopback
                && !host_is_literal
                && host.contains('.')
                && !host.ends_with(".localhost")
                && !host.ends_with(".local")
        };
        if !allowed_transport
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid(
                "Use the deployment-pinned HTTPS endpoint, without redirects or credentials.",
            ));
        }
        Ok(url)
    }

    pub fn validate_endpoint(&self, endpoint: &X402Endpoint) -> Result<()> {
        let request_url = self.check_url(&endpoint.url)?;
        if let Some(resource) = &endpoint.resource_url {
            let resource = self.check_url(resource)?;
            if resource.origin() != request_url.origin() {
                return Err(invalid(
                    "The pinned resource must belong to the registered merchant origin.",
                ));
            }
        }
        if endpoint.id.is_empty()
            || endpoint.id.len() > 128
            || !endpoint
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || endpoint.mint != self.mint
            || endpoint.max_amount_units == 0
        {
            return Err(invalid("Invalid pinned x402 endpoint."));
        }
        if endpoint.fee_payer_from_challenge {
            if !endpoint.fee_payer.is_empty() {
                return Err(invalid(
                    "Challenge fee-payer mode requires an empty configured feePayer.",
                ));
            }
        } else {
            let sponsor = key(&endpoint.fee_payer)?;
            if !sponsor.on_curve() {
                return Err(invalid("Fee payer must be a signing public key."));
            }
        }
        key(&endpoint.pay_to)?;
        Ok(())
    }

    fn request_body(
        &self,
        endpoint: &X402Endpoint,
        request: &X402Request,
    ) -> Result<Option<Vec<u8>>> {
        self.validate_endpoint(endpoint)?;
        if endpoint.method == X402Method::Get && request.body.is_some() {
            return Err(invalid("GET endpoints do not accept a request body."));
        }
        request
            .body
            .as_ref()
            .map(|body| {
                let bytes =
                    serde_json::to_vec(body).map_err(|_| invalid("Invalid request body."))?;
                if bytes.len() > MAX_REQUEST_BYTES {
                    return Err(invalid("Request body exceeds the service limit."));
                }
                Ok(bytes)
            })
            .transpose()
    }

    fn request(
        &self,
        endpoint: &X402Endpoint,
        request: &X402Request,
    ) -> Result<reqwest::blocking::RequestBuilder> {
        let body = self.request_body(endpoint, request)?;
        let builder = match endpoint.method {
            X402Method::Get => self.client.get(&endpoint.url),
            X402Method::Post => self.client.post(&endpoint.url),
            X402Method::Put => self.client.put(&endpoint.url),
            X402Method::Patch => self.client.patch(&endpoint.url),
            X402Method::Delete => self.client.delete(&endpoint.url),
        }
        .header("Accept", "application/json");
        Ok(if let Some(body) = body {
            builder
                .header("Content-Type", "application/json")
                .body(body)
        } else {
            builder
        })
    }

    /// The exact registered method only. No credentials, signed headers or redirects.
    pub fn challenge(
        &self,
        endpoint: &X402Endpoint,
        request: &X402Request,
    ) -> Result<SelectedChallenge> {
        let response = self
            .request(endpoint, request)?
            .send()
            .map_err(|_| incompatible())?;
        if response.status().as_u16() != 402 {
            return Err(incompatible());
        }
        let encoded = response
            .headers()
            .get("PAYMENT-REQUIRED")
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        let body = bounded_body(response, MAX_CHALLENGE_BYTES)?;
        let challenge: Value = if let Some(encoded) = encoded {
            if encoded.len() > MAX_CHALLENGE_BYTES * 2 {
                return Err(incompatible());
            }
            let raw = STANDARD.decode(encoded).map_err(|_| incompatible())?;
            if raw.len() > MAX_CHALLENGE_BYTES {
                return Err(incompatible());
            }
            serde_json::from_slice(&raw).map_err(|_| incompatible())?
        } else {
            serde_json::from_slice(&body).map_err(|_| incompatible())?
        };
        self.select_challenge(endpoint, &challenge)
    }

    /// Pure validation for a captured current challenge (never a saved catalog price).
    pub fn select_challenge(
        &self,
        endpoint: &X402Endpoint,
        challenge: &Value,
    ) -> Result<SelectedChallenge> {
        self.validate_endpoint(endpoint)?;
        if challenge["x402Version"] != 2
            || challenge["resource"]["url"]
                != endpoint.resource_url.as_deref().unwrap_or(&endpoint.url)
        {
            return Err(incompatible());
        }
        let accepts = challenge["accepts"]
            .as_array()
            .filter(|v| v.len() <= 32)
            .ok_or_else(incompatible)?;
        let mut matching = accepts.iter().filter(|r| {
            r["scheme"] == "exact"
                && r["network"] == self.network
                && r["asset"] == self.mint
                && r["payTo"] == endpoint.pay_to
                && if endpoint.fee_payer_from_challenge {
                    r["extra"]["feePayer"]
                        .as_str()
                        .and_then(|value| key(value).ok())
                        .is_some_and(|payer| payer.on_curve())
                } else {
                    r["extra"]["feePayer"] == endpoint.fee_payer
                }
        });
        let accepted = if endpoint.choose_lowest_amount {
            let mut cheapest: Option<(u64, &Value)> = None;
            let mut ambiguous = false;
            for offer in matching {
                let Ok(units) = offer_amount(offer, endpoint.max_amount_units) else {
                    continue;
                };
                match cheapest {
                    None => {
                        cheapest = Some((units, offer));
                        ambiguous = false;
                    }
                    Some((best, _)) if units < best => {
                        cheapest = Some((units, offer));
                        ambiguous = false;
                    }
                    Some((best, _)) if units == best => {
                        ambiguous = true;
                    }
                    _ => {}
                }
            }
            if ambiguous {
                return Err(incompatible());
            }
            cheapest.ok_or_else(incompatible)?.1.clone()
        } else {
            let accepted = matching.next().ok_or_else(incompatible)?.clone();
            if matching.next().is_some() {
                return Err(incompatible());
            }
            accepted
        };
        let amount_units = offer_amount(&accepted, endpoint.max_amount_units)?;
        let extensions = challenge
            .get("extensions")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !extensions.is_object() {
            return Err(incompatible());
        }
        Ok(SelectedChallenge {
            accepted,
            resource: challenge["resource"].clone(),
            extensions,
            amount_units,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn build_payment(
        &self,
        endpoint: &X402Endpoint,
        request: &X402Request,
        selected: &SelectedChallenge,
        source: &DelegatedSource,
        blockhash: &str,
        last_valid_block_height: u64,
        nonce: &str,
    ) -> Result<UnsignedDelegatedPayment> {
        self.request_body(endpoint, request)?;
        let checked = self.select_challenge(
            endpoint,
            &json!({
                "x402Version": 2, "resource": selected.resource,
                "accepts": [selected.accepted], "extensions": selected.extensions,
            }),
        )?;
        if &checked != selected
            || last_valid_block_height == 0
            || nonce.is_empty()
            || nonce.len() > 128
        {
            return Err(invalid(
                "Invalid payment plan binding or blockhash lifetime.",
            ));
        }
        let destination = associated_token_account(&endpoint.pay_to, &self.mint)?;
        let mut plan = UnsignedDelegatedPayment {
            endpoint: endpoint.clone(),
            request: request.clone(),
            source: source.clone(),
            selected: checked,
            blockhash: blockhash.into(),
            last_valid_block_height,
            nonce: nonce.into(),
            destination_token_account: destination.to_string(),
            message_base64: String::new(),
            unsigned_transaction_base64: String::new(),
        };
        let transaction = self.transaction(&plan)?;
        plan.message_base64 = STANDARD.encode(&transaction.message);
        plan.unsigned_transaction_base64 = STANDARD.encode(
            transaction
                .partially_signed(&[])
                .map_err(|_| incompatible())?,
        );
        Ok(plan)
    }

    fn transaction(&self, plan: &UnsignedDelegatedPayment) -> Result<Transaction> {
        let source = &plan.source;
        let owner = key(&source.owner)?;
        let delegate = key(&source.delegate)?;
        let source_token = key(&source.source_token_account)?;
        // The selected challenge is immutable journal data and part of the
        // action hash. Never refetch a sponsor when signing or recovering.
        let payer = key(plan.selected.accepted["extra"]["feePayer"]
            .as_str()
            .ok_or_else(incompatible)?)?;
        let recipient = key(&plan.endpoint.pay_to)?;
        let mint = key(&self.mint)?;
        let destination = associated_token_account(&plan.endpoint.pay_to, &self.mint)?;
        let token_program = key(TOKEN_PROGRAM)?;
        let compute = key(COMPUTE)?;
        let memo = key(MEMO)?;
        if !owner.on_curve()
            || !delegate.on_curve()
            || delegate == owner
            || payer == delegate
            || payer == owner
            || payer == source_token
            || payer == destination
            || payer == mint
            || payer == token_program
            || payer == compute
            || payer == memo
            || source_token == destination
            || delegate == source_token
            || delegate == destination
            || recipient == delegate
            || recipient == owner
            || destination.to_string() != plan.destination_token_account
        {
            return Err(invalid(
                "Source owner, delegate, recipient and fee-payer roles must be distinct.",
            ));
        }
        let meta = |key, writable, signer| Meta {
            key,
            writable,
            signer,
        };
        let mut transfer = vec![12];
        transfer.extend(plan.selected.amount_units.to_le_bytes());
        transfer.push(6);
        let mut units = vec![2];
        units.extend(40_000u32.to_le_bytes());
        let mut price = vec![3];
        price.extend(0u64.to_le_bytes());
        let memo_bytes = plan.selected.accepted["extra"]["memo"]
            .as_str()
            .unwrap_or(&plan.nonce)
            .as_bytes()
            .to_vec();
        let instructions = vec![
            Instruction {
                program: compute,
                accounts: vec![],
                data: units,
            },
            Instruction {
                program: compute,
                accounts: vec![],
                data: price,
            },
            Instruction {
                program: token_program,
                accounts: vec![
                    meta(source_token, true, false),
                    meta(mint, false, false),
                    meta(destination, true, false),
                    meta(delegate, false, true),
                ],
                data: transfer,
            },
            Instruction {
                program: memo,
                accounts: vec![],
                data: memo_bytes,
            },
        ];
        let mut transaction = Transaction::new(payer, key(&plan.blockhash)?, instructions)
            .map_err(|_| incompatible())?;
        if transaction.signers != [payer, delegate] {
            return Err(incompatible());
        }
        // Native SDK's static-account codec is shared by legacy and v0 messages.
        transaction.message.insert(0, 0x80);
        transaction.message.push(0); // no address lookup tables
        if transaction.message.len() + 129 > 1232 {
            return Err(incompatible());
        }
        Ok(transaction)
    }

    /// Rebuild the plan from its immutable bindings before signing or recovery.
    pub fn validate_plan(&self, plan: &UnsignedDelegatedPayment) -> Result<()> {
        let rebuilt = self.build_payment(
            &plan.endpoint,
            &plan.request,
            &plan.selected,
            &plan.source,
            &plan.blockhash,
            plan.last_valid_block_height,
            &plan.nonce,
        )?;
        if &rebuilt != plan {
            return Err(invalid(
                "Saved payment bytes do not match the authorized action.",
            ));
        }
        Ok(())
    }

    /// Reserve and persist this hash with the operation before signing. x402's
    /// transfer signature alone does not authenticate an HTTP request body.
    pub fn action_hash(&self, plan: &UnsignedDelegatedPayment) -> Result<String> {
        self.validate_plan(plan)?;
        let encoded = serde_json::to_vec(plan).map_err(|_| invalid("Invalid payment plan."))?;
        Ok(allowit_sdk::service::hash(encoded))
    }

    /// Future v2 owner reviews bind every economic and request fact, including
    /// canonical instruction bytes, independently of the unsigned wire lifetime.
    /// The normalized packet is only hash input: never persist, sign or submit it.
    /// Legacy callers must continue using `action_hash`.
    pub fn economic_action_hash_v2(&self, plan: &UnsignedDelegatedPayment) -> Result<String> {
        self.validate_plan(plan)?;
        let normalized = self.build_payment(
            &plan.endpoint,
            &plan.request,
            &plan.selected,
            &plan.source,
            "11111111111111111111111111111111",
            1,
            &plan.nonce,
        )?;
        let encoded = serde_json::to_vec(&json!({
            "domain":"allowit:delegated-x402:economic-action:v2",
            "plan":normalized,
        }))
        .map_err(|_| invalid("Invalid economic payment commitment."))?;
        Ok(allowit_sdk::service::hash(encoded))
    }

    /// Verify a host-signer result and build the complete standard outer payload.
    /// No key enters this module. Persist this credential before HTTP submission.
    pub fn attach_signature(
        &self,
        plan: &UnsignedDelegatedPayment,
        signature: &[u8; 64],
    ) -> Result<Value> {
        self.validate_plan(plan)?;
        let transaction = self.transaction(plan)?;
        let raw = transaction
            .partially_signed(&[(key(&plan.source.delegate)?, *signature)])
            .map_err(|_| {
                invalid("Delegate signature does not authorize the exact payment message.")
            })?;
        Ok(
            json!({ "x402Version": 2, "accepted": plan.selected.accepted,
            "resource": plan.selected.resource, "extensions": plan.selected.extensions,
            "payload": { "transaction": STANDARD.encode(raw) } }),
        )
    }

    /// Submit an already persisted credential exactly once per caller decision.
    /// A timeout, failed delivery, 402 or missing receipt never releases a budget.
    pub fn submit(
        &self,
        plan: &UnsignedDelegatedPayment,
        credential: &Value,
    ) -> Result<X402Delivery> {
        self.validate_plan(plan)?;
        self.validate_credential(plan, credential)?;
        let raw =
            serde_json::to_vec(credential).map_err(|_| invalid("Invalid payment credential."))?;
        let response = self
            .request(&plan.endpoint, &plan.request)?
            .header("PAYMENT-SIGNATURE", STANDARD.encode(raw))
            .send()
            .map_err(|_| uncertain())?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("Content-Type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let hint = response
            .headers()
            .get("PAYMENT-RESPONSE")
            .and_then(|h| h.to_str().ok())
            .filter(|h| h.len() <= MAX_CHALLENGE_BYTES * 2)
            .and_then(|h| STANDARD.decode(h).ok())
            .filter(|v| v.len() <= MAX_CHALLENGE_BYTES)
            .and_then(|v| serde_json::from_slice(&v).ok());
        let body = bounded_body(response, MAX_DELIVERY_BYTES)?;
        Ok(X402Delivery {
            status,
            content_type,
            body_base64: STANDARD.encode(body),
            settlement_hint: hint,
        })
    }

    pub fn validate_credential(
        &self,
        plan: &UnsignedDelegatedPayment,
        credential: &Value,
    ) -> Result<()> {
        if credential["x402Version"] != 2
            || credential["accepted"] != plan.selected.accepted
            || credential["resource"] != plan.selected.resource
            || credential["extensions"] != plan.selected.extensions
        {
            return Err(invalid(
                "Payment credential changed the authorized HTTP bindings.",
            ));
        }
        let encoded = credential["payload"]["transaction"]
            .as_str()
            .ok_or_else(incompatible)?;
        if encoded.len() > 1700 {
            return Err(incompatible());
        }
        let raw = STANDARD.decode(encoded).map_err(|_| incompatible())?;
        let message = STANDARD
            .decode(&plan.message_base64)
            .map_err(|_| incompatible())?;
        if raw.len() != 129 + message.len()
            || raw[0] != 2
            || raw[129..] != message
            || raw[1..65] != [0; 64]
        {
            return Err(invalid(
                "Payment credential changed the authorized transaction.",
            ));
        }
        verify(key(&plan.source.delegate)?, &message, &raw[65..129]).map_err(|_| incompatible())
    }

    /// Read finalized status and the exact finalized transaction from a trusted
    /// deployment-configured RPC. Missing/pending evidence returns None.
    pub fn finalized_receipt(
        &self,
        rpc_url: &str,
        plan: &UnsignedDelegatedPayment,
        signature: &str,
    ) -> Result<Option<FinalizedX402Payment>> {
        self.validate_plan(plan)?;
        validate_signature(signature)?;
        self.check_url(rpc_url)?;
        let statuses = self.rpc(
            rpc_url,
            "getSignatureStatuses",
            json!([[signature], {"searchTransactionHistory": true}]),
        )?;
        let status = &statuses["value"][0];
        if status.is_null() || status["confirmationStatus"] != "finalized" {
            return Ok(None);
        }
        if status.get("err") != Some(&Value::Null) {
            return Err(uncertain());
        }
        let tx = self.rpc(
            rpc_url,
            "getTransaction",
            json!([signature, {
                "encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 0
            }]),
        )?;
        if tx.is_null() {
            return Ok(None);
        }
        let receipt = self.verify_finalized_receipt(&tx, plan, signature)?;
        if status["slot"].as_u64() != Some(receipt.finalized_slot) {
            return Err(uncertain());
        }
        Ok(Some(receipt))
    }

    fn rpc(&self, url: &str, method: &str, params: Value) -> Result<Value> {
        let response = self
            .client
            .post(url)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send()
            .map_err(|_| uncertain())?;
        if response.status().as_u16() != 200 {
            return Err(uncertain());
        }
        let value: Value = serde_json::from_slice(&bounded_body(response, MAX_RPC_BYTES)?)
            .map_err(|_| uncertain())?;
        if !value["error"].is_null() || value.get("result").is_none() {
            return Err(uncertain());
        }
        Ok(value["result"].clone())
    }

    /// Pure attestation helper. `transaction` must originate from a trusted RPC's
    /// getTransaction(commitment=finalized), not a worker or merchant body.
    pub fn verify_finalized_receipt(
        &self,
        transaction: &Value,
        plan: &UnsignedDelegatedPayment,
        signature: &str,
    ) -> Result<FinalizedX402Payment> {
        self.validate_plan(plan)?;
        validate_signature(signature)?;
        if !transaction["meta"].is_object()
            || transaction["meta"].get("err") != Some(&Value::Null)
            || transaction["transaction"][1] != "base64"
        {
            return Err(uncertain());
        }
        let slot = transaction["slot"]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or_else(uncertain)?;
        let encoded = transaction["transaction"][0]
            .as_str()
            .filter(|v| v.len() <= 1700)
            .ok_or_else(uncertain)?;
        let raw = STANDARD.decode(encoded).map_err(|_| uncertain())?;
        let message = STANDARD
            .decode(&plan.message_base64)
            .map_err(|_| uncertain())?;
        if raw.len() != 129 + message.len()
            || raw[0] != 2
            || raw[129..] != message
            || bs58::encode(&raw[1..65]).into_string() != signature
        {
            return Err(invalid(
                "Finalized receipt is not the exact signed transaction.",
            ));
        }
        verify(
            key(plan.selected.accepted["extra"]["feePayer"]
                .as_str()
                .ok_or_else(incompatible)?)?,
            &message,
            &raw[1..65],
        )
        .map_err(|_| incompatible())?;
        verify(key(&plan.source.delegate)?, &message, &raw[65..129]).map_err(|_| incompatible())?;
        let accounts = message_accounts(&message)?;
        let source_index = accounts
            .iter()
            .position(|v| v.to_string() == plan.source.source_token_account)
            .ok_or_else(incompatible)?;
        let destination_index = accounts
            .iter()
            .position(|v| v.to_string() == plan.destination_token_account)
            .ok_or_else(incompatible)?;
        let before = &transaction["meta"]["preTokenBalances"];
        let after = &transaction["meta"]["postTokenBalances"];
        let source_before = token_balance(before, source_index, &self.mint, &plan.source.owner)?;
        let source_after = token_balance(after, source_index, &self.mint, &plan.source.owner)?;
        let destination_before =
            token_balance(before, destination_index, &self.mint, &plan.endpoint.pay_to)?;
        let destination_after =
            token_balance(after, destination_index, &self.mint, &plan.endpoint.pay_to)?;
        if source_before.checked_sub(source_after) != Some(plan.selected.amount_units)
            || destination_after.checked_sub(destination_before) != Some(plan.selected.amount_units)
        {
            return Err(invalid(
                "Finalized token deltas do not match the exact authorized transfer.",
            ));
        }
        Ok(FinalizedX402Payment {
            signature: signature.into(),
            finalized_slot: slot,
            network: self.network.clone(),
            mint: self.mint.clone(),
            source_token_account: plan.source.source_token_account.clone(),
            destination_token_account: plan.destination_token_account.clone(),
            amount_units: plan.selected.amount_units,
        })
    }
}

fn bounded_body(response: reqwest::blocking::Response, maximum: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|n| n > maximum as u64)
    {
        return Err(uncertain());
    }
    let mut bytes = Vec::new();
    response
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| uncertain())?;
    if bytes.len() > maximum {
        return Err(uncertain());
    }
    Ok(bytes)
}

fn associated_token_account(owner: &str, mint: &str) -> Result<Key> {
    let owner = key(owner)?;
    let mint = key(mint)?;
    let token = key(TOKEN_PROGRAM)?;
    Key::find_program_address(&[&owner.0, &token.0, &mint.0], key(ATA_PROGRAM)?)
        .map(|v| v.0)
        .map_err(|_| incompatible())
}

fn validate_signature(signature: &str) -> Result<()> {
    if signature.len() > 90
        || bs58::decode(signature)
            .into_vec()
            .ok()
            .is_none_or(|v| v.len() != 64)
    {
        return Err(invalid("Invalid Solana transaction signature."));
    }
    Ok(())
}

fn message_accounts(message: &[u8]) -> Result<Vec<Key>> {
    // This module only builds v0 with two signatures, fewer than 128 static
    // accounts, and no lookup tables. Never parse a merchant-supplied message.
    if message.len() < 5 || message[0] != 0x80 || message[1] != 2 || message[4] >= 128 {
        return Err(incompatible());
    }
    let count = message[4] as usize;
    let end = 5 + count * 32;
    if message.len() < end {
        return Err(incompatible());
    }
    Ok(message[5..end]
        .as_chunks::<32>()
        .0
        .iter()
        .copied()
        .map(Key)
        .collect())
}

fn token_balance(balances: &Value, index: usize, mint: &str, owner: &str) -> Result<u64> {
    let mut matched = balances
        .as_array()
        .ok_or_else(uncertain)?
        .iter()
        .filter(|balance| balance["accountIndex"].as_u64() == Some(index as u64));
    let value = matched.next().ok_or_else(uncertain)?;
    if matched.next().is_some()
        || value["mint"] != mint
        || value["owner"] != owner
        || value["uiTokenAmount"]["decimals"] != 6
        || value.get("programId").is_some_and(|v| v != TOKEN_PROGRAM)
    {
        return Err(incompatible());
    }
    value["uiTokenAmount"]["amount"]
        .as_str()
        .and_then(|v| v.parse().ok())
        .ok_or_else(uncertain)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod economic_commitment_tests {
    use super::*;

    fn public(hex: &str) -> String {
        Key(std::array::from_fn(|index| {
            u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap()
        }))
        .to_string()
    }

    fn fixture() -> (DelegatedX402, UnsignedDelegatedPayment) {
        let transport = DelegatedX402::for_private_validator(
            "solana:privateEconomicCommitmentFixture",
            &Key([10; 32]).to_string(),
        )
        .unwrap();
        let endpoint = X402Endpoint {
            id: "private-research".into(),
            url: "http://127.0.0.1:18403/research".into(),
            resource_url: None,
            method: X402Method::Post,
            pay_to: Key([8; 32]).to_string(),
            mint: Key([10; 32]).to_string(),
            fee_payer: public("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"),
            fee_payer_from_challenge: false,
            choose_lowest_amount: false,
            max_amount_units: 3000,
        };
        let request = X402Request {
            body: Some(json!({"query":"Solana transaction fees"})),
        };
        let source = DelegatedSource {
            owner: public("fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025"),
            delegate: public("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"),
            source_token_account: Key([9; 32]).to_string(),
        };
        let selected = transport
            .select_challenge(&endpoint, &json!({
                "x402Version":2,"resource":{"url":endpoint.url},
                "accepts":[{"scheme":"exact","network":transport.network(),"asset":endpoint.mint,
                    "amount":"1000","payTo":endpoint.pay_to,"maxTimeoutSeconds":60,
                    "extra":{"feePayer":endpoint.fee_payer}}],
                "extensions":{"catalog":{"description":"Research data"}},
            }))
            .unwrap();
        let plan = transport
            .build_payment(
                &endpoint,
                &request,
                &selected,
                &source,
                &Key([11; 32]).to_string(),
                1234,
                "economic-fixture",
            )
            .unwrap();
        (transport, plan)
    }

    fn rebuild(
        transport: &DelegatedX402,
        plan: &UnsignedDelegatedPayment,
    ) -> UnsignedDelegatedPayment {
        transport
            .build_payment(
                &plan.endpoint,
                &plan.request,
                &plan.selected,
                &plan.source,
                &plan.blockhash,
                plan.last_valid_block_height,
                &plan.nonce,
            )
            .unwrap()
    }

    #[test]
    fn unsigned_wire_refresh_preserves_v2_review_but_changes_legacy_action() {
        let (transport, original) = fixture();
        let refreshed = transport
            .build_payment(
                &original.endpoint,
                &original.request,
                &original.selected,
                &original.source,
                &Key([12; 32]).to_string(),
                5678,
                &original.nonce,
            )
            .unwrap();
        assert_ne!(original.message_base64, refreshed.message_base64);
        assert_ne!(
            transport.action_hash(&original).unwrap(),
            transport.action_hash(&refreshed).unwrap()
        );
        assert_eq!(
            transport.economic_action_hash_v2(&original).unwrap(),
            transport.economic_action_hash_v2(&refreshed).unwrap()
        );
        assert_ne!(
            transport.economic_action_hash_v2(&original).unwrap(),
            transport.action_hash(&original).unwrap()
        );
        assert_eq!(
            transport.action_hash(&original).unwrap(),
            allowit_sdk::service::hash(serde_json::to_vec(&original).unwrap())
        );
        assert_eq!(original.blockhash, Key([11; 32]).to_string());
        assert_eq!(original.last_valid_block_height, 1234);
    }

    #[test]
    fn changing_scope_amount_recipient_source_nonce_or_terms_invalidates_v2_review() {
        let (transport, original) = fixture();
        let expected = transport.economic_action_hash_v2(&original).unwrap();
        let mut variants = Vec::new();
        let mut body = original.clone();
        body.request.body = Some(json!({"query":"A different purchase"}));
        variants.push(body);
        let mut amount = original.clone();
        amount.selected.amount_units += 1;
        amount.selected.accepted["amount"] = json!(amount.selected.amount_units.to_string());
        variants.push(amount);
        let mut recipient = original.clone();
        recipient.endpoint.pay_to = Key([16; 32]).to_string();
        recipient.selected.accepted["payTo"] = json!(recipient.endpoint.pay_to);
        variants.push(recipient);
        let mut source = original.clone();
        source.source.source_token_account = Key([17; 32]).to_string();
        variants.push(source);
        let mut nonce = original.clone();
        nonce.nonce = "another-request".into();
        variants.push(nonce);
        let mut cap = original.clone();
        cap.endpoint.max_amount_units += 1;
        variants.push(cap);
        let mut claims = original.clone();
        claims.selected.extensions["catalog"]["description"] = json!("Changed merchant claims");
        variants.push(claims);
        for variant in variants {
            assert_ne!(
                expected,
                transport
                    .economic_action_hash_v2(&rebuild(&transport, &variant))
                    .unwrap()
            );
        }
    }

    #[test]
    fn v2_commitment_rejects_noncanonical_wire_bytes_and_destination_tampering() {
        let (transport, original) = fixture();
        let mut message = original.clone();
        message.message_base64.push('A');
        let mut transaction = original.clone();
        transaction.unsigned_transaction_base64.push('A');
        let mut destination = original;
        destination.destination_token_account = Key([18; 32]).to_string();
        for tampered in [message, transaction, destination] {
            assert!(transport.economic_action_hash_v2(&tampered).is_err());
        }
    }
}
