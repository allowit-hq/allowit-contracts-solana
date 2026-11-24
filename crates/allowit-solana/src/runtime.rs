//! The rail's runtime: what a server or a client does with a Native wallet on the ledger.
//!
//! The server evaluates the policy of a Native wallet before it prepares a payment; this runtime
//! builds no policy context. What it guarantees is the rest: the prepared transaction is the
//! requested transfer and nothing else, both keys sign the same bytes, the ledger is asked before
//! anything is called lost, and a receipt is what the ledger moved.
//!
//! A status is `Prepared` again only on the proof of a lapse: a finalized block height past the
//! blockhash's last valid block height with no status for the signature. Until then an unknown
//! outcome stays unknown.
use crate::config::{self, WalletConfig, hex32};
use crate::native::{Address, OwnerStep, TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM, Wallet, fee};
use crate::owner::{Ledger, Status as Seen};
use crate::packets::{
    self, OwnerDoc, OwnerSignedDoc, PACKETS, PreparedDoc, ReceiptDoc, Request, SignedDoc,
    SnapshotDoc, Transfer, decode, message_hash, packet, payment_message, request_hash,
};
use crate::payment::{self, Finalized, Receipts};
use allowit_core::vendor::{
    RuntimeProvider,
    config::ServerAuthority,
    error::{Error, Result},
    profiles::Description,
    runtime::{
        Accounting, Action, Evaluator, ExpenseBound, FeeCeiling, Installation,
        OWNER_TRANSACTION_EXPIRED, ObservedAuthorization, OperationOutcome, OwnerAction,
        OwnerPacket, OwnerSigned, PacketProvider as _, Poll, Prepared, Receipt, RequestPacket,
        Resources, Settlement, Signature, Signed, Signer, Snapshot, Status, Terms, Validity,
        owner::Configuration,
    },
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::sync::Arc;

type Retain<'a, T> = Box<dyn FnOnce(&T) -> Result<()> + 'a>;

/// The longest life of a prepared payment or owner step, in seconds: one blockhash.
pub const MAX_VALIDITY_SECS: u64 = 60;

/// A finalized bank: its block height, and the time of its block where the node states it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bank {
    pub height: u64,
    pub time: Option<u64>,
}

/// Everything the runtime reads from and writes to the ledger.
pub trait Chain: Ledger + Receipts + Send + Sync {
    /// The finalized bank now.
    fn bank(&self) -> Result<Bank>;
    /// The signatures of every finalized transaction that names `address` and whose block time
    /// is `since` or later, or unknown, read from a node at the finalized bank or past it. An
    /// answer that may be incomplete is an error: the caller proves an absence with it.
    fn history(&self, address: &Address, since: u64) -> Result<Vec<[u8; 64]>>;
}

/// The refusal code of a payment that the rail does not prepare or sign: Core's catalogue entry
/// for an agent's operation that the wallet refused. `details.reason` names the rule.
pub const OPERATION_REFUSED: &str = "operation_refused";

/// No payment is prepared, admitted or signed in the last two minutes of a UTC day (plan, section
/// 7). The daily limits count by UTC day, and a payment signed then can settle on the next day.
pub const DAY_END_MARGIN_SECS: u64 = 120;

/// Refuse at `now`, in Unix seconds, when the UTC day ends within [`DAY_END_MARGIN_SECS`].
pub fn day_end(now: u64) -> Result<()> {
    let left = 86_400 - now % 86_400;
    if left <= DAY_END_MARGIN_SECS {
        return Err(Error::coded(
            OPERATION_REFUSED,
            format!(
                "The Solana rail signs no payment in the last {DAY_END_MARGIN_SECS} seconds of a UTC day, because the daily limits count by UTC day. Nothing was signed. Ask again in {left} seconds."
            ),
        )
        .with_details(json!({"reason": "utc_day_end", "retryAfterSecs": left})));
    }
    Ok(())
}

/// Allowance for a host clock ahead of the ledger's block time, in seconds.
const HISTORY_CLOCK_MARGIN_SECS: u64 = 600;

/// The public profile of an installed wallet: its installation and the owner's consent to its
/// policy source. A server imports it; an agent's client carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    pub version: u8,
    pub policy_id: String,
    pub config: WalletConfig,
    pub consent: Consent,
}

/// The owner's signature over the consent message of `payload`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Consent {
    pub payload: Value,
    /// The owner's signature of the message, base58.
    pub signature: String,
}

/// The text that the owner signs for `payload`: one line that says what it is, then the
/// payload's JSON with its keys in order.
pub fn consent_message(payload: &Value) -> Result<String> {
    Ok(format!(
        "Allowit: I approve this policy source for my wallet.\n{}",
        serde_json::to_string(payload).map_err(|_| Error::config("Cannot encode the consent"))?
    ))
}

/// The consent payload of an installation: what the owner's signature binds.
#[allow(clippy::too_many_arguments)]
pub fn consent_payload(
    config: &WalletConfig,
    policy_id: &str,
    revision: u32,
    ir_hash: &str,
    language: &str,
    rules: &[String],
    params: &Value,
    params_hash: &str,
) -> Value {
    json!({
        "policyId": policy_id,
        "revision": revision,
        "network": config.network,
        "wallet": config.wallet,
        "route": "native",
        "policyInstance": hex32::encode(&config.policy_instance),
        "source": config.policy_source,
        "sourceHash": hex32::encode(&config.source_hash),
        "irHash": ir_hash,
        "moduleDigest": hex32::encode(&config.module_digest),
        "mint": config.mint,
        "agent": config.agent,
        "server": config.server,
        "maxFeeLamports": config.max_fee_lamports,
        "language": language,
        "tier": Value::Null,
        "rules": rules,
        "params": params,
        "paramsHash": params_hash,
    })
}

impl Bundle {
    /// Check the bundle by itself: a valid installation, and the owner's signature over a
    /// consent that names this installation.
    pub fn validate(&self) -> Result<Wallet> {
        let bad = |what: &str| Error::config(format!("Invalid Solana wallet profile: {what}"));
        let wallet = self.config.validate()?;
        if self.version != 1 || self.policy_id.is_empty() || self.policy_id.len() > 128 {
            return Err(bad("its version or policy id"));
        }
        let payload = &self.consent.payload;
        let same = |key: &str, value: Value| payload.get(key) == Some(&value);
        if !(same("policyId", json!(self.policy_id))
            && same("network", json!(self.config.network))
            && same("wallet", json!(self.config.wallet))
            && same("route", json!("native"))
            && same(
                "policyInstance",
                json!(hex32::encode(&self.config.policy_instance)),
            )
            && same("source", json!(self.config.policy_source))
            && same("sourceHash", json!(hex32::encode(&self.config.source_hash)))
            && same(
                "moduleDigest",
                json!(hex32::encode(&self.config.module_digest)),
            )
            && same("mint", json!(self.config.mint))
            && same("agent", json!(self.config.agent))
            && same("server", json!(self.config.server))
            && same("maxFeeLamports", json!(self.config.max_fee_lamports)))
        {
            return Err(bad("the consent names another installation"));
        }
        let signature = bs58::decode(&self.consent.signature)
            .into_vec()
            .map_err(|_| bad("the consent's signature"))?;
        payment::verify(
            &wallet.owner,
            consent_message(payload)?.as_bytes(),
            &signature,
        )
        .map_err(|_| bad("the owner did not sign this consent"))?;
        Ok(wallet)
    }
}

/// The description that hosts read of an installation.
fn description(config: &WalletConfig, policy_id: &str) -> Description {
    Description {
        network: config.network.clone(),
        wallet: config.wallet.clone(),
        agent: config.agent.clone(),
        policy_id: policy_id.into(),
        owner: config.owner.clone(),
        server: config.server.clone(),
        asset: config.mint.clone(),
        asset_symbol: config.asset_symbol.clone(),
        source: config.policy_source.clone(),
        source_hash: hex32::encode(&config.source_hash),
        module_digest: hex32::encode(&config.module_digest),
        params: config.params.clone(),
    }
}

/// What the ledger holds at a wallet's token account.
struct Held {
    delegate: Option<Address>,
    allowance: u64,
    balance: u64,
}

/// The rail's runtime over one network's ledger.
pub struct Runtime {
    pub network: &'static str,
    pub chain: Arc<dyn Chain>,
}

impl Runtime {
    pub fn new(network: &str, chain: Arc<dyn Chain>) -> Result<Self> {
        Ok(Self {
            network: crate::networks::network(network)?.id,
            chain,
        })
    }

    /// The installation's document, on this runtime's network.
    fn config(&self, i: &Installation) -> Result<(WalletConfig, Wallet)> {
        let config = WalletConfig::decode(i.config.get().as_bytes())?;
        if config.network != self.network {
            return Err(Error::config(
                "The installation belongs to another network than this runtime",
            ));
        }
        let wallet = config.roles()?;
        Ok((config, wallet))
    }

    /// The wallet's token account as the finalized bank holds it; `None` when it is closed.
    fn held(&self, wallet: &Wallet) -> Result<Option<Held>> {
        let Some(account) = self.chain.account(&wallet.token_account())? else {
            return Ok(None);
        };
        if account.data.len() != TOKEN_ACCOUNT_LEN as usize
            || !wallet.is_token_account(&account.data)
        {
            return Err(Error::config(
                "The wallet's address holds another account than its token account",
            ));
        }
        let data = &account.data;
        let u64_at = |at: usize| u64::from_le_bytes(data[at..at + 8].try_into().expect("8 bytes"));
        let delegate = (data[72..76] == [1, 0, 0, 0])
            .then(|| Address::new_from_array(data[76..108].try_into().expect("32 bytes")));
        Ok(Some(Held {
            allowance: if delegate.is_some() { u64_at(121) } else { 0 },
            delegate,
            balance: u64_at(64),
        }))
    }

    /// The recipient's token account of the wallet's mint, as the finalized bank holds it. A
    /// payment to anything else fails on the ledger and costs the fee, so it is refused before
    /// anything is prepared or signed. Opening that account is the recipient's step.
    fn recipient_ready(&self, wallet: &Wallet, recipient: &str) -> Result<()> {
        let at: Address = recipient
            .parse()
            .map_err(|_| Error::usage("The recipient is not a Solana address"))?;
        let refused = |what: String| {
            Error::coded(
                OPERATION_REFUSED,
                format!("The recipient {recipient} {what}. Nothing was signed."),
            )
            .with_details(json!({"reason": "recipient_token_account", "recipient": recipient}))
        };
        let mint = wallet.mint;
        let Some(account) = self.chain.account(&at)? else {
            return Err(refused(format!(
                "has no account on the ledger. A payment goes to a token account of the mint {mint}: the recipient opens one, and the agent asks again"
            )));
        };
        if account.owner != TOKEN_PROGRAM || account.data.len() != TOKEN_ACCOUNT_LEN as usize {
            return Err(refused(format!(
                "is not a token account. A payment goes to the recipient's token account of the mint {mint}, not to its wallet address"
            )));
        }
        if account.data[0..32] != mint.to_bytes() {
            return Err(refused(format!(
                "is a token account of another mint than {mint}, the wallet's token"
            )));
        }
        match account.data[108] {
            1 => Ok(()),
            2 => Err(refused(
                "is frozen by its mint's freeze authority and can receive nothing".into(),
            )),
            _ => Err(refused("is not an initialized token account".into())),
        }
    }

    fn observed(
        &self,
        config: &WalletConfig,
        wallet: &Wallet,
        accounting: Option<&Accounting>,
    ) -> Result<Snapshot> {
        // The server keeps the counters of a Native wallet: the ledger holds none.
        let accounting = accounting.cloned().ok_or_else(|| {
            Error::config("A Native wallet requires the server's own account of its usage")
        })?;
        let bank = self.chain.bank()?;
        let held = self
            .held(wallet)?
            .ok_or_else(|| Error::config("The wallet's token account is closed"))?;
        // A payment needs the wallet's own delegate. Without it the owner stopped the wallet,
        // or approved someone else: neither the agent nor the server can pay.
        let paused = held.delegate != Some(wallet.delegate());
        let evidence = SnapshotDoc {
            config: config.clone(),
            observed_height: bank.height,
            observed_at: bank.time,
            delegate: held.delegate.map(|delegate| delegate.to_string()),
            allowance: held.allowance,
            balance: held.balance,
        };
        Ok(Snapshot {
            accounting,
            observed_height: bank.height,
            paused,
            params: config.params.clone(),
            state: Default::default(),
            evidence: packet(self.network, &evidence)?,
        })
    }

    fn prepared_doc(
        &self,
        i: &Installation,
        p: &Prepared,
    ) -> Result<(PreparedDoc, Wallet, Vec<u8>)> {
        let (config, _) = self.config(i)?;
        let doc: PreparedDoc = decode(&p.0)?;
        let (wallet, message) = doc.validate()?;
        if doc.config != config {
            return Err(Error::config(
                "The prepared payment belongs to another installation",
            ));
        }
        Ok((doc, wallet, message))
    }

    /// The receipt of the finalized transaction `finalized` whose signed bytes are `wire`.
    fn receipt_of(
        &self,
        finalized: &Finalized,
        wire: &[u8],
        transfer: Option<(&Wallet, &WalletConfig, &Request)>,
    ) -> Result<Receipt> {
        let differs = |what: &str| {
            Error::config(format!(
                "The ledger's transaction differs from the retained one: {what}"
            ))
        };
        if finalized.wire != wire {
            return Err(differs("its bytes"));
        }
        let signatures = usize::from(wire[0]);
        let message = &wire[1 + 64 * signatures..];
        let moved = match transfer {
            Some((wallet, config, request)) if !finalized.failed => {
                let keys = payment::account_keys(message)?;
                let recipient: Address = request
                    .recipient
                    .parse()
                    .map_err(|_| differs("the recipient"))?;
                let change = |account: &Address| {
                    let index = keys.iter().position(|key| key == account)?;
                    finalized
                        .balances
                        .iter()
                        .find(|balance| balance.index == index && balance.mint == wallet.mint)
                        .map(|balance| (balance.before, balance.after))
                };
                let (before, after) = change(&wallet.token_account())
                    .ok_or_else(|| differs("the wallet's balance"))?;
                let debit = before
                    .checked_sub(after)
                    .ok_or_else(|| differs("the wallet's balance"))?;
                let (before, after) =
                    change(&recipient).ok_or_else(|| differs("the recipient's balance"))?;
                let credit = after
                    .checked_sub(before)
                    .ok_or_else(|| differs("the recipient's balance"))?;
                if debit != request.units || credit != request.units {
                    return Err(differs("the amount that moved"));
                }
                Some(Transfer {
                    mint: config.mint.clone(),
                    recipient: request.recipient.clone(),
                    units: debit,
                })
            }
            _ => None,
        };
        packets::receipt(&ReceiptDoc {
            network: self.network.into(),
            transaction_hash: message_hash(message),
            signature: bs58::encode(&wire[1..65]).into_string(),
            failed: finalized.failed,
            slot: finalized.slot,
            block_time: finalized.block_time,
            observed_height: self.chain.bank()?.height,
            fee_lamports: finalized.fee,
            transfer: moved,
            wire: STANDARD.encode(wire),
        })
    }

    /// Send `wire` once and say what is known afterwards.
    fn send(&self, wire: &[u8], signature: &[u8; 64]) -> Result<Status> {
        if self.chain.submit(wire).is_ok() {
            return Ok(Status::Submitted);
        }
        // A refusal proves nothing by itself: the ledger says whether it holds the transaction.
        Ok(match self.chain.observe(signature)?.status {
            Seen::Finalized { .. } | Seen::Pending => Status::Submitted,
            Seen::Unknown => Status::SubmissionUnknown,
        })
    }

    fn owner_doc(&self, p: &OwnerSigned) -> Result<(OwnerSignedDoc, Vec<u8>, [u8; 64])> {
        let doc: OwnerSignedDoc = decode(&p.0)?;
        let signature = doc.validate()?;
        if doc.original.network != self.network {
            return Err(Error::config("The owner step belongs to another network"));
        }
        let wire = STANDARD
            .decode(&doc.wire)
            .map_err(|_| Error::config("Invalid owner step"))?;
        Ok((doc, wire, signature))
    }
}

fn unsupported(what: &str) -> Error {
    Error::unsupported(format!("A Native wallet of the Solana rail {what}"))
}

fn units(value: i128) -> Result<u64> {
    u64::try_from(value)
        .ok()
        .filter(|units| *units > 0)
        .ok_or_else(|| Error::usage("An amount is a positive count of base units"))
}

impl RuntimeProvider for Runtime {
    fn discover_snapshot(
        &self,
        configuration: &Configuration,
        accounting: Option<&Accounting>,
    ) -> Result<Snapshot> {
        let config = WalletConfig::decode(configuration.bytes())?;
        if config.network != self.network {
            return Err(Error::config(
                "The installation belongs to another network than this runtime",
            ));
        }
        self.observed(&config, &config.roles()?, accounting)
    }

    fn current_height(&self) -> Result<u64> {
        Ok(self.chain.bank()?.height)
    }

    /// A Solana transaction is looked up by its signature, which a 32-byte name does not hold:
    /// the caller observes the signed packet instead.
    fn observe_hash(&self, _: &[u8; 32]) -> Result<Option<Receipt>> {
        Err(Error::unsupported(
            "The Solana rail looks a transaction up by its signed packet, not by a 32-byte hash",
        ))
    }

    /// Import a wallet's public profile for the server `authority`: the installation is valid,
    /// the owner consented to its source, the server is this authority, and the ledger holds
    /// the wallet's token account.
    fn import(&self, authority: &ServerAuthority, bytes: &[u8]) -> Result<Installation> {
        let bundle: Bundle = serde_json::from_slice(bytes)
            .map_err(|_| Error::config("Invalid Solana wallet profile"))?;
        let wallet = bundle.validate()?;
        if bundle.config.network != self.network || authority.network() != self.network {
            return Err(Error::config(
                "The wallet profile belongs to another network than this runtime",
            ));
        }
        if authority.public_key() != bundle.config.server {
            return Err(Error::config(
                "The wallet profile names another server than the configured authority",
            ));
        }
        if self.held(&wallet)?.is_none() {
            return Err(Error::config("The wallet's token account is closed"));
        }
        let raw = |text: String| {
            RawValue::from_string(text).map_err(|_| Error::config("Cannot retain the installation"))
        };
        Ok(Installation {
            description: description(&bundle.config, &bundle.policy_id),
            config: raw(serde_json::to_string(&bundle.config)
                .map_err(|_| Error::config("Cannot encode the installation"))?)?,
            export: Some(raw(String::from_utf8(bytes.to_vec())
                .map_err(|_| Error::config("Invalid Solana wallet profile"))?)?),
            authority: Some(authority.clone()),
        })
    }

    fn request(
        &self,
        i: &Installation,
        id: [u8; 32],
        a: Action,
        accounting: Option<&Accounting>,
    ) -> Result<RequestPacket> {
        let (config, wallet) = self.config(i)?;
        let Action::Transfer {
            recipient,
            units: amount,
        } = a
        else {
            return Err(unsupported("makes transfers only"));
        };
        if self.observed(&config, &wallet, accounting)?.paused {
            return Err(Error::usage(
                "The owner stopped this wallet: its delegate is not approved",
            ));
        }
        let request = Request {
            policy_instance: config.policy_instance,
            nonce: id,
            recipient,
            units: units(amount)?,
        };
        // The message is built once here, so a request that cannot become a payment is refused.
        payment_message(&wallet, &config, &request, solana_hash::Hash::default())?;
        Ok(RequestPacket(packet(self.network, &request)?))
    }

    fn read_request(&self, i: &Installation, bytes: &[u8]) -> Result<RequestPacket> {
        let (config, wallet) = self.config(i)?;
        let request: Request = serde_json::from_slice(bytes)
            .map_err(|_| Error::usage("Invalid Solana payment request"))?;
        if request.policy_instance != config.policy_instance {
            return Err(Error::usage("The request belongs to another installation"));
        }
        payment_message(&wallet, &config, &request, solana_hash::Hash::default())?;
        let raw = std::str::from_utf8(bytes)
            .ok()
            .and_then(|text| RawValue::from_string(text.into()).ok())
            .ok_or_else(|| Error::usage("Invalid Solana payment request"))?;
        Ok(RequestPacket(
            allowit_core::vendor::runtime::Packet::from_raw(self.network, raw, &PACKETS),
        ))
    }

    fn snapshot(&self, i: &Installation, a: Option<&Accounting>) -> Result<Snapshot> {
        let (config, wallet) = self.config(i)?;
        self.observed(&config, &wallet, a)
    }

    fn action(&self, i: &Installation, r: &RequestPacket) -> Result<Action> {
        let (config, _) = self.config(i)?;
        let request: Request = decode(&r.0)?;
        if request.policy_instance != config.policy_instance {
            return Err(Error::usage("The request belongs to another installation"));
        }
        Ok(Action::Transfer {
            recipient: request.recipient,
            units: i128::from(request.units),
        })
    }

    /// A Native wallet has no code: it is present while its token account is.
    fn resources(&self, i: &Installation) -> Result<Resources> {
        let (_, wallet) = self.config(i)?;
        Ok(Resources {
            code_present: true,
            wallet_present: self.held(&wallet)?.is_some(),
            lifetime: None,
        })
    }

    fn redeemable(&self, _: &Installation, _: &str, _: i128) -> Result<i128> {
        Err(unsupported("holds no vault shares"))
    }

    fn finish<'a>(
        &self,
        _: &Installation,
        _: &Prepared,
        _: Retain<'a, Prepared>,
    ) -> Result<Prepared> {
        Err(unsupported(
            "has no on-chain policy to simulate after the authorization",
        ))
    }

    /// Build the payment of `r` on a recent blockhash. Nothing is signed. The payment lives as
    /// long as its blockhash, so its validity is at most [`MAX_VALIDITY_SECS`].
    fn prepare(
        &self,
        i: &Installation,
        r: &RequestPacket,
        t: &Terms,
        a: Option<&Accounting>,
        v: Validity,
    ) -> Result<Prepared> {
        let (config, wallet) = self.config(i)?;
        let request: Request = decode(&r.0)?;
        if request.policy_instance != config.policy_instance {
            return Err(Error::usage("The request belongs to another installation"));
        }
        if t.gas_carry_units != 0 {
            return Err(unsupported("repays no network fee, so it carries none"));
        }
        if v.expires_at <= v.now {
            return Err(Error::usage("The payment's validity is already over"));
        }
        day_end(v.now)?;
        let snapshot = self.observed(&config, &wallet, a)?;
        if snapshot.paused {
            return Err(Error::usage(
                "The owner stopped this wallet: its delegate is not approved",
            ));
        }
        self.recipient_ready(&wallet, &request.recipient)?;
        let recent = self.chain.recent()?;
        let message = payment_message(&wallet, &config, &request, recent.blockhash)?;
        packets::prepared(&PreparedDoc {
            version: 1,
            request_hash: request_hash(&request)?,
            message: STANDARD.encode(message.message_bytes()),
            transaction_hash: message_hash(message.message_bytes()),
            last_valid_block_height: recent.last_valid_height,
            observed_height: snapshot.observed_height,
            created_at: v.now,
            expires_at: v.expires_at.min(v.now + MAX_VALIDITY_SECS),
            config,
            request,
        })
    }

    /// The server's admission of a prepared payment. The server evaluated the policy before it
    /// prepared; this runtime builds no policy context, so it refuses an evaluator instead of
    /// passing a payment whose policy it did not run.
    fn authorize_preparation(
        &self,
        i: &Installation,
        p: &Prepared,
        signer: &dyn Signer,
        evaluator: Option<Evaluator<'_>>,
        now: u64,
    ) -> Result<Prepared> {
        let (doc, _, _) = self.prepared_doc(i, p)?;
        if signer.identity() != doc.config.server {
            return Err(Error::usage("Only the wallet's server admits a payment"));
        }
        if now >= doc.expires_at {
            return Err(Error::usage("The prepared payment expired"));
        }
        day_end(now)?;
        if evaluator.is_some() {
            return Err(unsupported(
                "is admitted by the server's own evaluation; the rail evaluates no policy",
            ));
        }
        Ok(p.clone())
    }

    fn finalize<'a>(
        &self,
        _: &Installation,
        _: &Prepared,
        _: &dyn Signer,
        _: Option<Evaluator<'_>>,
        _: u64,
        _: Retain<'a, Prepared>,
    ) -> Result<Prepared> {
        Err(unsupported("has no on-chain policy to finalize"))
    }

    /// Before anyone signs: the payment is still the installation's, in time, on a live
    /// blockhash, and the wallet can still pay it.
    fn revalidate(&self, i: &Installation, p: &Prepared, now: u64) -> Result<Prepared> {
        let (doc, wallet, _) = self.prepared_doc(i, p)?;
        if now >= doc.expires_at || self.chain.bank()?.height > doc.last_valid_block_height {
            return Err(Error::usage("The prepared payment expired"));
        }
        day_end(now)?;
        self.recipient_ready(&wallet, &doc.request.recipient)?;
        let held = self
            .held(&wallet)?
            .ok_or_else(|| Error::uncertain("The wallet closed before signing"))?;
        if held.delegate != Some(wallet.delegate())
            || held.allowance < doc.request.units
            || held.balance < doc.request.units
        {
            return Err(Error::uncertain(
                "The wallet changed before signing: its delegate, allowance or balance no longer covers the payment",
            ));
        }
        Ok(p.clone())
    }

    /// The signature of the agent or the server over the payment's whole message.
    fn sign(&self, i: &Installation, p: &Prepared, s: &dyn Signer, now: u64) -> Result<Signature> {
        let (doc, wallet, message) = self.prepared_doc(i, p)?;
        if now >= doc.expires_at {
            return Err(Error::usage("The prepared payment expired"));
        }
        day_end(now)?;
        let key = if s.identity() == doc.config.agent {
            wallet.agent
        } else if s.identity() == doc.config.server {
            wallet.server
        } else {
            return Err(Error::usage(
                "Only the wallet's agent and server sign a payment",
            ));
        };
        let bytes = s.sign_bytes(&message)?;
        payment::verify(&key, &message, &bytes)?;
        Ok(Signature {
            identity: s.identity().into(),
            bytes,
        })
    }

    /// The signed payment: exactly the agent's and the server's signatures of the message.
    fn authorize(
        &self,
        i: &Installation,
        p: &Prepared,
        s: &[Signature],
        now: u64,
    ) -> Result<Signed> {
        let (doc, wallet, message) = self.prepared_doc(i, p)?;
        if now >= doc.expires_at {
            return Err(Error::usage("The prepared payment expired"));
        }
        let of = |identity: &str, key: &Address| -> Result<[u8; 64]> {
            let mut found = s.iter().filter(|signature| signature.identity == identity);
            let (Some(signature), None) = (found.next(), found.next()) else {
                return Err(Error::usage(
                    "A payment needs one signature of the agent and one of the server",
                ));
            };
            payment::verify(key, &message, &signature.bytes)?;
            Ok(signature.bytes[..].try_into().expect("64 bytes"))
        };
        if s.len() != 2 {
            return Err(Error::usage(
                "A payment needs one signature of the agent and one of the server",
            ));
        }
        let mut wire = Vec::with_capacity(129 + message.len());
        wire.push(2);
        wire.extend_from_slice(&of(&doc.config.server, &wallet.server)?);
        wire.extend_from_slice(&of(&doc.config.agent, &wallet.agent)?);
        wire.extend_from_slice(&message);
        packets::signed(&SignedDoc {
            prepared: doc,
            wire: STANDARD.encode(wire),
        })
    }

    fn validate_signed(&self, p: &Signed, now: u64) -> Result<()> {
        let doc: SignedDoc = decode(&p.0)?;
        doc.validate()?;
        if doc.prepared.config.network != self.network {
            return Err(Error::config("The payment belongs to another network"));
        }
        if now >= doc.prepared.expires_at {
            return Err(Error::usage("The signed payment expired"));
        }
        Ok(())
    }

    fn broadcast(&self, p: &Signed, now: u64) -> Result<Status> {
        self.validate_signed(p, now)?;
        let doc: SignedDoc = decode(&p.0)?;
        let signature = doc.validate()?;
        let wire = STANDARD
            .decode(&doc.wire)
            .map_err(|_| Error::config("Invalid signed payment"))?;
        self.send(&wire, &signature)
    }

    fn status(&self, p: &Signed) -> Result<Status> {
        let doc: SignedDoc = decode(&p.0)?;
        let signature = doc.validate()?;
        let seen = self.chain.observe(&signature)?;
        Ok(match seen.status {
            Seen::Finalized { failed: false } => Status::Confirmed,
            Seen::Finalized { failed: true } => Status::Failed,
            Seen::Pending => Status::Submitted,
            // The lapse: the bytes never ran and can no longer run.
            Seen::Unknown if seen.finalized_height > doc.prepared.last_valid_block_height => {
                Status::Prepared
            }
            Seen::Unknown => Status::SubmissionUnknown,
        })
    }

    fn observe(&self, p: &Signed) -> Result<Option<Receipt>> {
        let doc: SignedDoc = decode(&p.0)?;
        let signature = doc.validate()?;
        let Some(finalized) = self.chain.transaction(&signature)? else {
            return Ok(None);
        };
        let wire = STANDARD
            .decode(&doc.wire)
            .map_err(|_| Error::config("Invalid signed payment"))?;
        let wallet = doc.prepared.config.roles()?;
        self.receipt_of(
            &finalized,
            &wire,
            Some((&wallet, &doc.prepared.config, &doc.prepared.request)),
        )
        .map(Some)
    }

    /// The lapse of a prepared payment, signed or not: its blockhash expired at the finalized
    /// bank, and the wallet's finalized history since its preparation, read after that, holds no
    /// transaction of its message. A payment moves the wallet's token account, so a transaction
    /// that carried it names that account whoever paid its fee. A transaction of the message
    /// that the ledger holds, a failed one too, is no lapse: its receipt settles the operation.
    fn lapsed(&self, p: &Prepared) -> Result<bool> {
        let doc: PreparedDoc = decode(&p.0)?;
        let (wallet, _) = doc.validate()?;
        if doc.config.network != self.network {
            return Err(Error::config("The payment belongs to another network"));
        }
        if self.chain.bank()?.height <= doc.last_valid_block_height {
            return Ok(false);
        }
        let since = doc.created_at.saturating_sub(HISTORY_CLOCK_MARGIN_SECS);
        for signature in self.chain.history(&wallet.token_account(), since)? {
            let finalized = self.chain.transaction(&signature)?.ok_or_else(|| {
                Error::uncertain(
                    "The ledger lists a transaction of the wallet that it does not return; the lapse is not proven",
                )
            })?;
            let signatures = usize::from(*finalized.wire.first().unwrap_or(&0));
            let message = finalized.wire.get(1 + 64 * signatures..).unwrap_or(&[]);
            if message_hash(message) == doc.transaction_hash {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Nobody else settles a Native payment of this rail: the server sends it itself.
    fn observe_authorizations(&self, _: &[Prepared]) -> Result<Vec<ObservedAuthorization>> {
        Ok(Vec::new())
    }

    fn settle_receipt(
        &self,
        p: &Prepared,
        signed: &Signed,
        r: &Receipt,
        accounting: Option<&Accounting>,
        carry: u128,
    ) -> Result<Settlement> {
        PACKETS.verify_receipt(&r.0, &signed.0)?;
        let doc: SignedDoc = decode(&signed.0)?;
        if doc.prepared != decode::<PreparedDoc>(&p.0)? {
            return Err(Error::usage(
                "The signed packet carries another operation than the prepared one",
            ));
        }
        let accounting = accounting.ok_or_else(|| {
            Error::config("A Native wallet requires the server's own account of its usage")
        })?;
        let receipt: ReceiptDoc = decode(&r.0)?;
        let executed = !receipt.failed;
        Ok(Settlement {
            transaction: doc.validate()?.to_vec(),
            outcome: if executed {
                OperationOutcome::Executed
            } else {
                OperationOutcome::Failed
            },
            // The server counts the debit; the fee is the server's own and is priced apart.
            usage: None,
            fee_units: u128::from(receipt.fee_lamports),
            counted_gas: None,
            next_nonce: Some(accounting.nonce + u64::from(executed)),
            gas_carry: carry,
        })
    }

    fn expense(
        &self,
        i: &Installation,
        action: &Action,
        ceiling: &FeeCeiling,
    ) -> Result<ExpenseBound> {
        let (config, _) = self.config(i)?;
        let Action::Transfer { units: amount, .. } = action else {
            return Err(unsupported("makes transfers only"));
        };
        // The fee of a payment is fixed when it is built; the ceiling must cover it and stay
        // within what the installation allows.
        if ceiling.max_fee_units < u128::from(fee(2, packets::PAYMENT_BUDGET))
            || ceiling.max_fee_units > u128::from(config.max_fee_lamports)
        {
            return Err(Error::usage(
                "The fee ceiling is outside what this wallet's payments can be signed with",
            ));
        }
        Ok(ExpenseBound {
            gas_units: ceiling.gas_units,
            conversion_units: 0,
            spent_units: i128::from(units(*amount)?)
                .checked_add(ceiling.gas_units)
                .ok_or_else(|| Error::usage("The expense is out of range"))?,
            max_fee_units: ceiling.max_fee_units,
            observed_height: ceiling.observed_height,
            day: ceiling.day,
        })
    }

    /// The owner's steps: stop, refill, recover and close. A refill is a new approval of the
    /// wallet's own delegate for what it may still spend plus the refill, so it also resumes a
    /// stopped wallet. The tokens themselves come to the wallet's account by a plain transfer:
    /// the approval moves none.
    fn prepare_owner(
        &self,
        i: &Installation,
        a: OwnerAction,
        fee_limit: u64,
        now: u64,
    ) -> Result<OwnerPacket> {
        let (config, wallet) = self.config(i)?;
        if fee_limit < config::MIN_FEE_LAMPORTS {
            return Err(Error::usage(
                "The fee limit is below the fee of one owner signature",
            ));
        }
        let held = self
            .held(&wallet)?
            .ok_or_else(|| Error::usage("The wallet's token account is closed"))?;
        let to = |recipient: &str| -> Result<Address> {
            recipient
                .parse()
                .map_err(|_| Error::usage("The recipient is not a token account address"))
        };
        let (action, step) = match a {
            OwnerAction::SetPause { paused: true } => ("pause", OwnerStep::Stop),
            OwnerAction::Recover {
                units: Some(amount),
                recipient: Some(recipient),
            } => (
                "withdraw",
                OwnerStep::Recover {
                    to: to(&recipient)?,
                    amount: units(amount)?,
                    decimals: config.decimals,
                },
            ),
            OwnerAction::Recover {
                units: None,
                recipient: Some(recipient),
            } => {
                if held.balance == 0 {
                    return Err(Error::usage("The wallet holds nothing to return"));
                }
                (
                    "withdraw",
                    OwnerStep::Recover {
                        to: to(&recipient)?,
                        amount: held.balance,
                        decimals: config.decimals,
                    },
                )
            }
            OwnerAction::Recover {
                units: None,
                recipient: None,
            } => {
                if held.balance != 0 {
                    return Err(Error::usage(
                        "Return the wallet's balance before closing its token account",
                    ));
                }
                ("close", OwnerStep::Close)
            }
            OwnerAction::Recover { .. } => {
                return Err(Error::usage("A withdrawal names its recipient"));
            }
            OwnerAction::Fund { units: amount } => {
                // What the wallet's own delegate may still spend; another delegate's allowance
                // is not this wallet's and is replaced, not added to.
                let remaining = if held.delegate == Some(wallet.delegate()) {
                    held.allowance
                } else {
                    0
                };
                (
                    "fund",
                    OwnerStep::Approve {
                        allowance: remaining
                            .checked_add(units(amount)?)
                            .ok_or_else(|| Error::usage("The allowance is out of range"))?,
                        decimals: config.decimals,
                    },
                )
            }
            OwnerAction::SetPause { paused: false } => {
                return Err(Error::usage(
                    "A stopped wallet resumes with a refill: fund it with the allowance that it may spend",
                ));
            }
            OwnerAction::Create { .. } | OwnerAction::Extend => {
                return Err(unsupported("has no code to create or extend"));
            }
        };
        let recent = self.chain.recent()?;
        // The tag separates this step from the same step prepared on the same blockhash.
        let tag = format!(
            "allowit:owner:{}",
            hex32::encode(&Sha256::digest(format!("{action}:{now}:{}", config.wallet)).into())
        );
        let message = wallet.owner_steps_tagged(&[step], &tag, recent.blockhash)?;
        packets::owner_packet(&OwnerDoc {
            network: self.network.into(),
            action: action.into(),
            owner: config.owner,
            message: STANDARD.encode(message.message_bytes()),
            transaction_hash: message_hash(message.message_bytes()),
            last_valid_block_height: recent.last_valid_height,
            expires_at: now + MAX_VALIDITY_SECS,
        })
    }

    /// The owner's wallet returns the signed transaction as base64 text.
    fn read_owner_signed(&self, p: &OwnerPacket, signed_payload: &[u8]) -> Result<OwnerSigned> {
        let original: OwnerDoc = decode(&p.0)?;
        let wire = std::str::from_utf8(signed_payload)
            .map_err(|_| Error::usage("The signed owner step is base64 text"))?
            .trim();
        packets::owner_signed(&OwnerSignedDoc {
            original,
            wire: wire.into(),
        })
    }

    /// The superseded send-and-wait loop: retain, send once, read the receipt until it comes.
    fn submit_owner<'a>(
        &self,
        p: &OwnerSigned,
        retain: Retain<'a, OwnerSigned>,
        poll: Poll,
        now: u64,
    ) -> Result<Receipt> {
        self.validate_owner_signed(p, None, now)?;
        retain(p)?;
        self.broadcast_owner(p, None, now)?;
        for attempt in 0..poll.attempts.max(1) {
            if let Some(receipt) = self.observe_owner(p)? {
                return Ok(receipt);
            }
            if attempt + 1 < poll.attempts {
                std::thread::sleep(poll.interval);
            }
        }
        Err(Error::uncertain(
            "The owner step has no receipt yet; look it up before any replacement",
        ))
    }

    fn observe_owner(&self, p: &OwnerSigned) -> Result<Option<Receipt>> {
        let (_, wire, signature) = self.owner_doc(p)?;
        let Some(finalized) = self.chain.transaction(&signature)? else {
            return Ok(None);
        };
        self.receipt_of(&finalized, &wire, None).map(Some)
    }

    fn validate_owner_signed(
        &self,
        p: &OwnerSigned,
        _: Option<&Installation>,
        now: u64,
    ) -> Result<()> {
        let (doc, _, _) = self.owner_doc(p)?;
        if now >= doc.original.expires_at {
            return Err(Error::coded(
                OWNER_TRANSACTION_EXPIRED,
                "The owner step is past its send cutoff",
            ));
        }
        Ok(())
    }

    fn broadcast_owner(
        &self,
        p: &OwnerSigned,
        on: Option<&Installation>,
        now: u64,
    ) -> Result<Status> {
        self.validate_owner_signed(p, on, now)?;
        let (_, wire, signature) = self.owner_doc(p)?;
        self.send(&wire, &signature)
    }

    fn owner_status(&self, p: &OwnerSigned) -> Result<Status> {
        let (_, _, signature) = self.owner_doc(p)?;
        Ok(match self.chain.observe(&signature)?.status {
            Seen::Finalized { .. } | Seen::Pending => Status::Submitted,
            Seen::Unknown => Status::SubmissionUnknown,
        })
    }

    /// The lapse of a signed owner step: no status at a finalized height past its blockhash.
    fn owner_step_lapsed(&self, p: &OwnerSigned, _: u64) -> Result<bool> {
        let (doc, _, signature) = self.owner_doc(p)?;
        let seen = self.chain.observe(&signature)?;
        Ok(seen.status == Seen::Unknown
            && seen.finalized_height > doc.original.last_valid_block_height)
    }

    fn wallet_closed(&self, i: &Installation) -> Result<bool> {
        let (_, wallet) = self.config(i)?;
        Ok(self.held(&wallet)?.is_none())
    }

    fn prepare_close(&self, i: &Installation, fee_limit: u64, now: u64) -> Result<OwnerPacket> {
        self.prepare_owner(
            i,
            OwnerAction::Recover {
                units: None,
                recipient: None,
            },
            fee_limit,
            now,
        )
    }
}
