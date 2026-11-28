//! The owner's client: the setup of a Native wallet, from the owner's key to the server's
//! registration of the wallet.
//!
//! 1. The owner signs in to the server with a message signature. Nothing is authorized by it.
//! 2. The server's wallet template of the network names the asset that the wallet holds and the
//!    server's key on that network. The key must be the independently configured authority: a
//!    setup never installs a server key that only the server itself named.
//! 3. The owner's own transaction opens the wallet's token account and its delegate (the
//!    multisig of the agent and that server key) and approves the allowance, through
//!    [`crate::owner::send`]: retained before it is sent, and replaced only after a lapse.
//! 4. Once the ledger holds the wallet, the server registers it from the ledger. A refusal
//!    leaves the wallet set up: the same request id asks again and signs nothing.
//!
//! The setup moves no tokens. The owner funds the wallet's token account with a plain transfer;
//! the allowance bounds what the agent and the server can spend of it together.
use crate::config::{Route, WalletConfig, source_hash};
use crate::native::{Address, Wallet};
use crate::owner::{self, Outcome, Request, Resolution};
use crate::rpc::Rpc;
use crate::{keys, networks};
use allowit_core::{
    transport::http::Method,
    vendor::{
        error::{Error, Result},
        input::asset::decimal_units,
        owner::{Context, NativeWalletAsset, Setup},
        owner_session,
        plugin::LinkKind,
        runtime::{Signer, Status},
    },
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// The owner's key as the signer of the rail's own transactions.
struct OwnerKey<'a>(&'a dyn allowit_core::vendor::wallet::Signer);
impl Signer for OwnerKey<'_> {
    fn identity(&self) -> &str {
        self.0.address()
    }
    fn sign_hash(&self, digest: &[u8; 32]) -> Result<Vec<u8>> {
        self.0.sign_hash(digest)
    }
    fn sign_bytes(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        self.0.sign_hash(bytes)
    }
}

/// The asset of a new Native wallet as the server's template states it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Template {
    pub mint: String,
    pub symbol: String,
    pub decimals: u8,
    pub max_fee_lamports: u64,
}

/// The network of the setup, by its id. The owner's key and the server's authority are of the
/// same network: no setup installs the server key of one network in a wallet of another.
pub(crate) fn network(cx: &Context<'_>) -> Result<&'static str> {
    let network = networks::network(cx.network)?.id;
    for (role, other) in [
        ("owner key", cx.signer.network()),
        ("server authority", cx.authority.network()),
    ] {
        if other != network {
            return Err(Error::usage(format!(
                "The {role} belongs to another network than the wallet setup"
            )));
        }
    }
    // Refused before the owner signs anything, the sign-in included: one key in two roles
    // would make the wallet's two-of-two delegate the owner's own.
    if cx.signer.address() == cx.authority.public_key() {
        return Err(Error::usage(
            "The owner's key is the server authority's key: a wallet needs two separate keys",
        ));
    }
    Ok(network)
}

/// Whether `message` is the server's sign-in text for `owner` at `origin`: a CAIP-122 text whose
/// line 1 names the origin's host and line 2 is the owner, as the browser's sign-in element
/// requires. Any other text that merely contains the owner and the origin, such as a policy
/// consent, is refused: the owner's signature over it would be a valid signature of that text.
pub(crate) fn sign_in_message_for(message: &str, owner: &str, origin: &str) -> bool {
    let host = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .map(|rest| rest.split('/').next().unwrap_or_default())
        .unwrap_or_default();
    let mut lines = message.split('\n');
    let (first, second) = (lines.next().unwrap_or_default(), lines.next());
    !host.is_empty()
        && message.len() <= 2_048
        && lines.next().is_some()
        && first
            .strip_prefix(host)
            .and_then(|rest| rest.strip_prefix(" wants you to sign in with your "))
            .is_some_and(|rest| rest.ends_with(" account:"))
        && second == Some(owner)
        && message.contains(origin)
        && message.contains("does not authorize spending")
}

/// The owner's signature over the server's sign-in `message`, or a refusal of any other text.
pub(crate) fn sign_in_signature(
    signer: &dyn allowit_core::vendor::wallet::Signer,
    origin: &str,
    message: &str,
) -> Result<String> {
    if !sign_in_message_for(message, signer.address(), origin) {
        return Err(Error::config(
            "The server's sign-in message is not a sign-in for this owner and origin. Nothing was signed",
        ));
    }
    Ok(STANDARD.encode(signer.sign_hash(message.as_bytes())?))
}

/// Sign the owner in. The message must be the server's sign-in text for this owner and this
/// origin, and the owner's key signs its exact bytes, as a Solana wallet signs a message.
pub fn sign_in(cx: &Context<'_>) -> Result<owner_session::Client> {
    let owner = cx.signer.address().to_owned();
    let mut session = owner_session::Client::new(cx.backend, cx.origin, &owner)?;
    session.authenticate("wallet", (cx.clock)()?, |challenge| {
        sign_in_signature(cx.signer, cx.origin, &challenge.message)
    })?;
    Ok(session)
}

/// Read the server's template of `network` and check it against the configured `server` key.
pub fn template(
    session: &owner_session::Client,
    network: &str,
    server: &str,
    now: u64,
) -> Result<Template> {
    let reply: Value = session.owner_request(
        Method::Post,
        &format!("/api/native/templates?network={network}"),
        Some(&json!({})),
        now,
        false,
    )?;
    read_template(&reply, network, server)
}

/// The template of `network` in the server's `reply`.
pub fn read_template(reply: &Value, network: &str, server: &str) -> Result<Template> {
    let other_signer = || {
        Error::config(
            "The server's signer on this network differs from the configured server authority",
        )
    };
    if reply["server"].as_str() != Some(server) {
        return Err(other_signer());
    }
    let mut matching = reply["templates"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|template| template["network"] == network);
    let (Some(found), None) = (matching.next(), matching.next()) else {
        return Err(Error::config(
            "The server offers no Native wallet on this network",
        ));
    };
    if !found["server"].is_null() && found["server"].as_str() != Some(server) {
        return Err(other_signer());
    }
    let invalid = || Error::config("The server's wallet asset of this network is invalid");
    let mint = found["assetIssuer"].as_str().ok_or_else(invalid)?;
    let symbol = found["assetSymbol"].as_str().ok_or_else(invalid)?;
    // The rail's own token list decides the units: a mint that it does not list is refused.
    let token = networks::tokens(network)
        .iter()
        .find(|token| token.issuer == Some(mint) && token.code == symbol)
        .ok_or_else(invalid)?;
    let max_fee_lamports = found["maxFeeUnits"].as_u64().ok_or_else(invalid)?;
    Ok(Template {
        mint: mint.into(),
        symbol: symbol.into(),
        decimals: token.decimals,
        max_fee_lamports,
    })
}

/// The asset of a new Native wallet, read as the setup reads it. The owner signs in to read it
/// and signs nothing else.
pub fn native_wallet_asset(cx: &Context<'_>) -> Result<NativeWalletAsset> {
    let network = network(cx)?;
    let found = template(
        &sign_in(cx)?,
        network,
        cx.authority.public_key(),
        (cx.clock)()?,
    )?;
    Ok(NativeWalletAsset {
        symbol: found.symbol,
        issuer: Some(found.mint),
    })
}

/// The installation that the setup registers: the wallet of these roles with no policy yet.
/// The server binds the owner's reviewed policy to it afterwards. The installation's identity
/// is of this wallet and this request, so a second setup of the same wallet names the same one.
pub fn installation(network: &str, wallet: &Wallet, found: &Template) -> Result<WalletConfig> {
    let token_account = wallet.token_account();
    let mut instance = Sha256::new();
    instance.update(b"allowit-solana-installation-v1\0");
    instance.update(network.as_bytes());
    instance.update([0]);
    instance.update(token_account.as_ref());
    let config = WalletConfig {
        network: network.into(),
        policy_instance: instance.finalize().into(),
        wallet: token_account.to_string(),
        owner: wallet.owner.to_string(),
        agent: wallet.agent.to_string(),
        server: wallet.server.to_string(),
        route: Route::Native,
        mint: found.mint.clone(),
        asset_symbol: found.symbol.clone(),
        decimals: found.decimals,
        policy_source: String::new(),
        source_hash: source_hash(""),
        module_digest: [0; 32],
        params: Default::default(),
        max_fee_lamports: found.max_fee_lamports,
    };
    config.validate()?;
    Ok(config)
}

fn signature_text(signature: &[u8; 64]) -> String {
    bs58::encode(signature).into_string()
}

/// Set a Native wallet up for `r.agent` and register it with the server.
pub fn setup(cx: &Context<'_>, r: Setup<'_>) -> Result<Value> {
    let network = network(cx)?;
    if r.server != cx.authority.public_key() {
        return Err(Error::usage(
            "Setup server differs from independently configured authority",
        ));
    }
    // The caller's own values are checked before the owner is asked for any signature.
    let address = |text: &str, what: &str| -> Result<Address> {
        keys::signer_identity(&keys::public_key(text)?)
            .map_err(|_| Error::usage(format!("The {what} is not a key that can sign")))?;
        text.parse()
            .map_err(|_| Error::usage(format!("The {what} is not a Solana address")))
    };
    let owner = address(cx.signer.address(), "owner")?;
    let agent = address(r.agent, "agent")?;
    let server = address(r.server, "server")?;
    if agent == owner || agent == server {
        return Err(Error::usage(
            "The agent's key must differ from the owner's key and from the server's key",
        ));
    }
    let session = sign_in(cx)?;
    let found = template(&session, network, r.server, (cx.clock)()?)?;
    let wallet = Wallet {
        owner,
        mint: found
            .mint
            .parse()
            .map_err(|_| Error::config("The server's wallet asset of this network is invalid"))?,
        agent,
        server,
    };
    wallet.check()?;
    let allowance = match r.amount {
        None => 0,
        Some(text) => u64::try_from(decimal_units(text, found.decimals)?)
            .map_err(|_| Error::usage("The setup allowance is out of range"))?,
    };
    let config = installation(network, &wallet, &found)?;
    let chain = Rpc(transport(network, cx.rpc_url)?);
    // The journal is closed, and its lock released, before the server is asked.
    let outcome = {
        let journal = (cx.store)()?;
        owner::send(
            &chain,
            &journal,
            &OwnerKey(cx.signer),
            &wallet,
            r.request_id,
            &Request::Setup {
                allowance,
                decimals: found.decimals,
            },
        )?
    };
    let mut document = json!({
        "requestId": r.request_id,
        "network": network,
        "action": SETUP,
        "wallet": config.wallet,
        "delegate": wallet.delegate().to_string(),
        "asset": {"symbol": found.symbol, "mint": found.mint},
        "allowance": allowance.to_string(),
        // The setup approves; it moves no tokens. The wallet spends what its account holds.
        "funding": "Send the asset to the wallet address: the setup approved the allowance and moved no tokens.",
        "configuration": config,
    });
    let signature = match outcome {
        Outcome::Settled { signature } => signature,
        Outcome::Pending { .. } | Outcome::Unconfirmed { .. } => {
            return Err(unfinished(
                network,
                r.request_id,
                SETUP,
                &outcome,
                "The setup is sent and not finalized yet. Run the setup again with the same request ID: the owner signs in again, and the setup transaction is not signed again while it can still settle.",
            ));
        }
        Outcome::Failed { signature } => {
            return Err(failed(
                network,
                r.request_id,
                SETUP,
                &signature,
                "The setup transaction failed on the ledger: nothing was set up, and its fee was paid. Use a new request ID after checking the owner's balance.",
            ));
        }
    };
    document["transactions"] = json!([transaction(network, SETUP, &signature, Status::Confirmed)]);
    // The ledger holds the wallet: the server registers it from the ledger. A refusal leaves
    // the wallet set up, and the same request ID asks again and signs nothing.
    let registration = session
        .owner_request::<Value>(
            Method::Post,
            &format!("/api/native/register?network={network}"),
            Some(&json!({"configuration": config})),
            (cx.clock)()?,
            false,
        )
        .map_err(|error| not_registered(&document, error))?;
    if registration["registered"] != true {
        return Err(not_registered(
            &document,
            Error::usage("its reply does not say that the wallet is registered"),
        ));
    }
    document["registration"] = registration;
    document["registered"] = true.into();
    Ok(document)
}

/// The server did not register a wallet that the ledger holds, as on every rail: a refusal
/// that the server answered keeps its own code and status; a reply that never came leaves the
/// registration unknown (uncertain), since the server may have registered the wallet. Either
/// way the same setup asks again and signs no transaction, and the details name the setup's
/// transaction and the installation that a refill reads.
fn not_registered(document: &Value, error: Error) -> Error {
    let wallet = document["wallet"].as_str().unwrap_or_default();
    let again = "Run the same setup again with the same request ID: it signs in and asks the server again, and signs no transaction.";
    // A refusal is a client error that the server answered; a server or gateway error, a
    // timeout or a rate limit proves nothing about the registration.
    let answered = error
        .status
        .filter(|status| (400..500).contains(status) && ![408, 429].contains(status));
    let mut refused = match answered {
        Some(status) => Error::api(
            status,
            format!(
                "The wallet account {wallet} is set up on the ledger, but the server did not register it: {}. {again}",
                error.message
            ),
        ),
        None => Error::uncertain(format!(
            "The wallet account {wallet} is set up on the ledger, and the registration of it is unknown: {}. {again}",
            error.message
        )),
    }
    .with_details(json!({
        "requestId": document["requestId"],
        "network": document["network"],
        "wallet": wallet,
        "registered": answered.map(|_| false),
        "configuration": document["configuration"],
        "transactions": document["transactions"],
    }));
    refused.api_code = error.api_code;
    // The status stays, also on an uncertain answer: a rate limit, a gateway error and a lost
    // reply read apart.
    refused.status = error.status;
    refused
}

/// Add `amount` to what the wallet of `document` may still spend: the owner's own approval,
/// which also resumes a stopped wallet. The server is not asked: it reads the allowance from
/// the ledger. No tokens move; the wallet spends what its account holds. `fee_limit` bounds the
/// network fee in lamports and is checked before the owner signs.
pub fn fund(
    cx: &Context<'_>,
    document: &[u8],
    request_id: &str,
    amount: &str,
    fee_limit: &str,
) -> Result<Value> {
    owner::check_fee_limit(fee_limit)?;
    let network = network(cx)?;
    let config = installation_of(document)?;
    if config.network != network {
        return Err(Error::config(
            "The installation belongs to another network than this request",
        ));
    }
    let wallet = config.roles()?;
    if config.owner != cx.signer.address() {
        return Err(Error::usage("Only the wallet's owner refills it"));
    }
    // The refill approves the allowance of the wallet's delegate, the multisig of the agent and
    // the server. As at the setup, that server must be the independently configured authority:
    // a document that names another server key is refused before the owner signs.
    if config.server != cx.authority.public_key() {
        return Err(Error::usage(
            "The wallet's server key differs from the independently configured server authority: nothing was signed",
        ));
    }
    let units = u64::try_from(decimal_units(amount, config.decimals)?)
        .ok()
        .filter(|units| *units > 0)
        .ok_or_else(|| Error::usage("A refill adds a positive amount within range"))?;
    let chain = Rpc(transport(network, cx.rpc_url)?);
    let outcome = {
        let journal = (cx.store)()?;
        owner::send(
            &chain,
            &journal,
            &OwnerKey(cx.signer),
            &wallet,
            request_id,
            &Request::Refill {
                units,
                decimals: config.decimals,
            },
        )?
    };
    let signature = match outcome {
        Outcome::Settled { signature } => signature,
        Outcome::Pending { .. } | Outcome::Unconfirmed { .. } => {
            return Err(unfinished(
                network,
                request_id,
                REFILL,
                &outcome,
                "The refill is sent and not finalized yet. Run it again with the same request ID: the refill transaction is not signed again while it can still settle.",
            ));
        }
        Outcome::Failed { signature } => {
            return Err(failed(
                network,
                request_id,
                REFILL,
                &signature,
                "The refill transaction failed on the ledger: the allowance is unchanged, and its fee was paid. Use a new request ID.",
            ));
        }
    };
    Ok(json!({
        "requestId": request_id,
        "network": network,
        "action": REFILL,
        "wallet": config.wallet,
        "added": units.to_string(),
        "allowance": owner::remaining(&chain, &wallet)?.to_string(),
        "transactions": [transaction(network, REFILL, &signature, Status::Confirmed)],
    }))
}

/// The installation of a refill's `document`: the installation itself, or the document of the
/// setup that names it under `configuration`, as `wallet setup` prints it.
fn installation_of(document: &[u8]) -> Result<WalletConfig> {
    let value: Value = serde_json::from_slice(document)
        .map_err(|_| Error::usage("The wallet document is not JSON"))?;
    match value.get("configuration") {
        Some(configuration) if value["action"] == SETUP => WalletConfig::decode(
            &serde_json::to_vec(configuration)
                .map_err(|_| Error::usage("The setup document's configuration is not readable"))?,
        ),
        _ => WalletConfig::decode(document),
    }
}

/// What the owner confirms before this rail signs `step`: the owner's transaction approves an
/// allowance of the wallet's delegate, the agent and the server together, over the wallet's
/// token account. It moves no tokens. A deployment is none of this rail's steps.
pub fn question(network: &str, step: allowit_core::vendor::owner::Question<'_>) -> Option<String> {
    use allowit_core::vendor::owner::Question;
    let label = networks::network(network).ok()?.label;
    // The typed amount is shown only as a plain decimal: any other text is refused before
    // anything is signed, and it never reaches the terminal.
    let shown = |amount: &str| {
        let mut parts = amount.split('.');
        let whole = parts.next().unwrap_or_default();
        let fraction = parts.next();
        let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
        if amount.len() <= 40
            && digits(whole)
            && (whole == "0" || !whole.starts_with('0'))
            && fraction.is_none_or(digits)
            && parts.next().is_none()
        {
            amount.to_owned()
        } else {
            "the given amount".to_owned()
        }
    };
    match step {
        Question::Setup { amount } => Some(format!(
            "Set up this agent's wallet on {label} from the owner's account: open its token account and its delegate (the agent and the server sign together) where they do not exist yet, and set that delegate's allowance to {} of the wallet's asset, replacing any allowance that it has. The owner's account pays the SOL deposits of new accounts and the network fee; no wallet asset moves: send the asset to the wallet afterwards",
            amount.map_or_else(|| "0".to_owned(), shown)
        )),
        Question::Fund { amount } => Some(format!(
            "Set the on-chain allowance of the wallet's delegate (the agent and the server sign together) on {label} to its allowance as read when this refill is prepared, plus {} of the wallet's asset. A retry with the same request ID sends the same approval while it can still land; after it lapses, the approval is prepared again from the allowance then. The owner's account pays the network fee; no wallet asset moves: the wallet spends what its token account holds",
            shown(amount)
        )),
        _ => None,
    }
}

/// The action of a setup and of a refill, as an owner document names it.
pub(crate) const SETUP: &str = "native_setup";
const REFILL: &str = "refill";

/// One transaction of an owner document, as every host reads it: its action, its hash, Core's
/// status of it and its explorer link. Core's `confirmed` is the rail's finalized result.
fn transaction(network: &str, action: &str, signature: &[u8; 64], status: Status) -> Value {
    let text = signature_text(signature);
    json!({
        "action": action,
        "transactionHash": text,
        "status": status,
        "explorer": networks::explorer(network, LinkKind::Transaction, &text),
    })
}

/// A step that failed on the ledger: rejected (code 4), as the hosts read a failed owner step
/// and as `policy owner-status` exits for it. The step is over: a new request ID starts
/// again. The details name its transaction.
fn failed(
    network: &str,
    request_id: &str,
    action: &str,
    signature: &[u8; 64],
    message: &str,
) -> Error {
    // Core's classification of a finalized failure: a typed refusal, code 4.
    Error::coded(
        "owner_transaction_failed",
        format!("{message} Transaction: {}.", signature_text(signature)),
    )
    .with_details(json!({
        "requestId": request_id,
        "network": network,
        "transactions": [transaction(network, action, signature, Status::Failed)],
    }))
}

/// A step that is sent and not finalized: uncertain, so a host asks again with the same request
/// ID and never reports it done. The details name its transaction in Core's status:
/// `submitted` once the ledger holds it or the RPC accepted it, `submissionUnknown` otherwise,
/// as `owner-status` says of a transaction that the ledger does not show.
fn unfinished(
    network: &str,
    request_id: &str,
    action: &str,
    outcome: &Outcome,
    next: &str,
) -> Error {
    let (signature, status) = match outcome {
        Outcome::Pending { signature } => (signature, Status::Submitted),
        Outcome::Unconfirmed { signature }
        | Outcome::Settled { signature }
        | Outcome::Failed { signature } => (signature, Status::SubmissionUnknown),
    };
    Error::uncertain(next).with_details(json!({
        "requestId": request_id,
        "network": network,
        "transactions": [transaction(network, action, signature, status)],
    }))
}

/// Where the owner's transaction of `request_id` stands, from the journal and one read of the
/// ledger. Nothing is signed or sent.
pub fn status(
    journal: &dyn owner::Journal,
    network: &str,
    rpc_url: &str,
    request_id: &str,
) -> Result<Value> {
    let network = networks::network(network)?.id;
    let retained = journal
        .load(request_id)?
        .ok_or_else(|| Error::usage("No owner transaction is retained under this request ID"))?;
    let chain = Rpc(transport(network, rpc_url)?);
    Ok(status_document(
        network,
        request_id,
        &retained.signature,
        owner::resolve(&chain, &retained)?,
    ))
}

/// The status document of a retained owner transaction. Its transaction carries Core's status:
/// `confirmed` once finalized, `failed` once finalized with an error, `submitted` while the
/// ledger holds it unfinalized, and `submissionUnknown` while the ledger does not show it, as
/// after a lapse. `resolution` keeps the rail's own word, and `next` says what the owner does.
pub fn status_document(
    network: &str,
    request_id: &str,
    signature: &[u8; 64],
    resolution: Resolution,
) -> Value {
    let (word, status, next) = match resolution {
        Resolution::Settled => ("settled", Status::Confirmed, None),
        Resolution::Failed => (
            "failed",
            Status::Failed,
            Some("Nothing of the request took effect, and its fee was paid. Use a new request ID."),
        ),
        Resolution::Pending => (
            "pending",
            Status::Submitted,
            Some("The transaction is on the ledger and not finalized yet. Ask again."),
        ),
        Resolution::Unsent => (
            "uncertain",
            Status::SubmissionUnknown,
            Some(
                "The ledger does not show the transaction, and it can still settle. Run the same request again with the same request ID: the identical transaction is sent again.",
            ),
        ),
        Resolution::Lapsed => (
            "lapsed",
            Status::SubmissionUnknown,
            Some(
                "The transaction never ran and can no longer run. Run the same request again with the same request ID: a new transaction is signed.",
            ),
        ),
    };
    let mut document = json!({
        "requestId": request_id,
        "network": network,
        "resolution": word,
        "transactions": [transaction(network, "owner_step", signature, status)],
    });
    if let Some(next) = next {
        document["next"] = next.into();
    }
    document
}

/// The host of an approval: the signed-in session, the owner's key and the owner's RPC endpoint.
struct ApprovalHost<'a> {
    cx: &'a Context<'a>,
    session: owner_session::Client,
    network: &'static str,
}

impl crate::activation::Host for ApprovalHost<'_> {
    fn backend(&self) -> &str {
        self.cx.backend
    }
    fn ask(&self, path: &str, body: &Value, uncertain: bool) -> Result<Value> {
        self.session.owner_request(
            Method::Post,
            path,
            Some(body),
            (self.cx.clock)()?,
            uncertain,
        )
    }
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>> {
        self.cx.signer.sign_hash(message)
    }
    fn wallet_held(&self, wallet: &Wallet) -> Result<()> {
        let chain = Rpc(transport(self.network, self.cx.rpc_url)?);
        owner::remaining(&chain, wallet).map(|_| ())
    }
}

/// The roles of an approval: the agent that the caller names, and the server key that the caller
/// configured independently. A server that the caller names must be that key.
fn roles<'a>(
    cx: &'a Context<'a>,
    agent: Option<&'a str>,
    server: Option<&str>,
) -> Result<(&'a str, &'a str)> {
    let configured = cx.authority.public_key();
    if server.is_some_and(|named| named != configured) {
        return Err(Error::usage(
            "The named server differs from the independently configured server authority",
        ));
    }
    let agent = agent.ok_or_else(|| {
        Error::usage("Name the wallet's agent key: the policy document does not hold it")
    })?;
    Ok((agent, configured))
}

/// Approve the policy of a Native wallet: the owner's second signature, after the setup.
pub fn activate(cx: &Context<'_>, r: crate::activation::ActivateRequest<'_>) -> Result<Value> {
    let network = network(cx)?;
    let policy: Value = serde_json::from_slice(r.document)
        .map_err(|_| Error::usage("The policy document is not JSON"))?;
    let (agent, server) = roles(cx, r.agent, r.server)?;
    let approval =
        crate::activation::approval(network, &policy, cx.signer.address(), agent, server)?;
    let host = ApprovalHost {
        cx,
        session: sign_in(cx)?,
        network,
    };
    let store = (cx.store)()?;
    crate::activation::activate(&host, &store, &approval, r.request_id)
}

/// The public profile of an approved Native wallet, as its agent imports it.
pub fn export(
    cx: &Context<'_>,
    document: &[u8],
    request_id: &str,
) -> Result<Box<serde_json::value::RawValue>> {
    let network = network(cx)?;
    let policy: Value = serde_json::from_slice(document)
        .map_err(|_| Error::usage("The policy document is not JSON"))?;
    let store = (cx.store)()?;
    let bundle =
        crate::activation::export(&store, network, &policy, cx.signer.address(), request_id)?;
    serde_json::value::to_raw_value(&bundle)
        .map_err(|_| Error::config("Cannot encode the wallet profile"))
}

/// The transport of the owner's own RPC endpoint.
pub(crate) fn transport(
    network: &str,
    endpoint: &str,
) -> Result<Arc<dyn allowit_core::vendor::runtime::Transport>> {
    use allowit_core::vendor::plugin::RailPlugin as _;
    if endpoint.is_empty() {
        return Err(Error::config(
            "The owner's setup needs an RPC endpoint of the network",
        ));
    }
    crate::plugin::PLUGIN.connect(network, endpoint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::networks::{DEVNET, USDC_DEVNET};
    use crate::packets::tests::key;

    fn reply(server: &str) -> Value {
        json!({"server": server, "templates": [{"network": DEVNET, "server": server,
            "asset": USDC_DEVNET, "assetIssuer": USDC_DEVNET, "assetSymbol": "USDC",
            "maxFeeUnits": 20_000, "profiles": [],
            "tiers": {"common": null, "custom": false, "simple": null}}]})
    }

    #[test]
    fn only_the_sign_in_text_of_this_site_and_owner_is_a_sign_in() {
        let owner = key(1).identity().to_owned();
        let origin = "https://app.example.test";
        let sign_in = |host: &str, account: &str| {
            format!(
                "{host} wants you to sign in with your Solana account:\n{account}\n\nSign in to AllowIt. This does not authorize spending or move funds.\n\nURI: {origin}"
            )
        };
        assert!(sign_in_message_for(
            &sign_in("app.example.test", &owner),
            &owner,
            origin
        ));
        assert!(sign_in_message_for(
            &sign_in("localhost:5173", &owner).replace(origin, "http://localhost:5173"),
            &owner,
            "http://localhost:5173"
        ));
        // A policy consent whose source names the owner, the origin and the sign-in phrase: the
        // owner's signature over it would be a valid consent.
        let consent = crate::runtime::consent_message(&serde_json::json!({
            "policyId": "policy-1",
            "source": format!("// {owner} {origin} does not authorize spending"),
        }))
        .unwrap();
        assert!(!sign_in_message_for(&consent, &owner, origin));
        // Another site, another account, or the owner named elsewhere than line 2.
        assert!(!sign_in_message_for(
            &sign_in("evil.example.test", &owner),
            &owner,
            origin
        ));
        let other = key(2).identity().to_owned();
        assert!(!sign_in_message_for(
            &sign_in("app.example.test", &other).replace("URI:", &format!("{owner} URI:")),
            &owner,
            origin
        ));
        assert!(!sign_in_message_for(
            &format!(
                "app.example.test wants you to sign in with your Solana account:\nhello {owner}\n\nThis does not authorize spending.\n{origin}"
            ),
            &owner,
            origin
        ));
        // A text too long to be a sign-in.
        assert!(!sign_in_message_for(
            &format!(
                "{}{}",
                sign_in("app.example.test", &owner),
                " ".repeat(2_048)
            ),
            &owner,
            origin
        ));
    }

    #[test]
    fn a_template_is_believed_only_from_the_configured_server_and_for_a_listed_token() {
        let server = key(3).identity().to_owned();
        let found = read_template(&reply(&server), DEVNET, &server).unwrap();
        assert_eq!(
            found,
            Template {
                mint: USDC_DEVNET.into(),
                symbol: "USDC".into(),
                decimals: 6,
                max_fee_lamports: 20_000
            }
        );
        // The server names another key than the configured authority, at either place.
        let other = key(9).identity().to_owned();
        assert!(read_template(&reply(&other), DEVNET, &server).is_err());
        let mut mixed = reply(&server);
        mixed["templates"][0]["server"] = json!(other);
        assert!(read_template(&mixed, DEVNET, &server).is_err());
        // No template of the network, two of them, an unlisted mint or another code.
        let mut none = reply(&server);
        none["templates"] = json!([]);
        assert!(read_template(&none, DEVNET, &server).is_err());
        let mut twice = reply(&server);
        let copy = twice["templates"][0].clone();
        twice["templates"].as_array_mut().unwrap().push(copy);
        assert!(read_template(&twice, DEVNET, &server).is_err());
        let mut unlisted = reply(&server);
        unlisted["templates"][0]["assetIssuer"] = json!(other);
        assert!(read_template(&unlisted, DEVNET, &server).is_err());
        let mut renamed = reply(&server);
        renamed["templates"][0]["assetSymbol"] = json!("USDT");
        assert!(read_template(&renamed, DEVNET, &server).is_err());
    }

    /// The refusals that need no server: they come before the sign-in, whose clock panics here.
    #[test]
    fn a_setup_with_one_key_in_two_roles_is_refused_before_the_owner_signs_in() {
        use allowit_core::vendor::config::ServerAuthority;
        struct Owner(crate::KeySigner);
        impl allowit_core::vendor::wallet::Signer for Owner {
            fn network(&self) -> &str {
                DEVNET
            }
            fn address(&self) -> &str {
                self.0.identity()
            }
            fn sign_hash(&self, _: &[u8]) -> Result<Vec<u8>> {
                panic!("nothing is signed")
            }
        }
        let (owner, agent, server) = (Owner(key(1)), key(2), key(3));
        let store = || panic!("no journal is opened");
        let clock = || panic!("the owner is not signed in");
        let run = |authority: &str, agent: &str, named: &str| {
            let authority =
                ServerAuthority::validated(DEVNET, "http://localhost:8080", authority).unwrap();
            let cx = Context {
                network: DEVNET,
                backend: "http://localhost:8080",
                authority: &authority,
                origin: "http://localhost:5173",
                rpc_url: "http://localhost:8899",
                store: &store,
                signer: &owner,
                clock: &clock,
            };
            if authority.public_key() == owner.0.identity() {
                native_wallet_asset(&cx).unwrap_err();
            }
            setup(
                &cx,
                Setup {
                    agent,
                    server: named,
                    request_id: "setup-001",
                    fee_per_operation: "0",
                    amount: None,
                },
            )
            .unwrap_err()
        };
        let (owner_id, agent_id, server_id) = (
            owner.0.identity().to_owned(),
            agent.identity().to_owned(),
            server.identity().to_owned(),
        );
        // The owner's key as the server's, the agent's as the owner's or the server's, a server
        // other than the configured one, and an agent that is no key.
        run(&owner_id, &agent_id, &owner_id);
        run(&server_id, &owner_id, &server_id);
        run(&server_id, &server_id, &server_id);
        run(&server_id, &agent_id, &agent_id);
        run(&server_id, "not-a-key", &server_id);
    }

    #[test]
    fn a_status_names_what_the_owner_does_next_and_never_calls_an_unseen_transaction_lost() {
        let status = |resolution| status_document(DEVNET, "step-1", &[7; 64], resolution);
        // The hosts read Core's status of each transaction: only a finalized one is confirmed.
        let core = |document: &Value| document["transactions"][0]["status"].clone();
        let settled = status(Resolution::Settled);
        assert_eq!(settled["resolution"], "settled");
        assert_eq!(core(&settled), "confirmed");
        assert!(settled.get("next").is_none());
        assert_eq!(
            settled["transactions"][0]["transactionHash"],
            bs58::encode([7u8; 64]).into_string()
        );
        assert!(
            settled["transactions"][0]["explorer"]
                .as_str()
                .unwrap()
                .contains("devnet")
        );
        // Not seen while its blockhash is valid is uncertain, not failed: it can still settle.
        let unsent = status(Resolution::Unsent);
        assert_eq!(unsent["resolution"], "uncertain");
        assert_eq!(core(&unsent), "submissionUnknown");
        assert!(unsent["next"].as_str().unwrap().contains("identical"));
        let lapsed = status(Resolution::Lapsed);
        assert_eq!(lapsed["resolution"], "lapsed");
        assert_eq!(core(&lapsed), "submissionUnknown");
        assert_eq!(core(&status(Resolution::Pending)), "submitted");
        assert_eq!(core(&status(Resolution::Failed)), "failed");
    }

    /// A refusal that the server answered keeps its status; a lost reply leaves the
    /// registration unknown, never refused.
    #[test]
    fn a_lost_registration_reply_is_unknown_and_a_refusal_keeps_its_status() {
        let document = json!({"requestId": "setup-1", "network": DEVNET, "wallet": "W",
            "configuration": {}, "transactions": []});
        let refused = not_registered(&document, Error::refused(403, "not_allowed", "No."));
        assert_eq!(refused.status, Some(403));
        assert_eq!(refused.api_code.as_deref(), Some("not_allowed"));
        assert_eq!(refused.details.unwrap()["registered"], false);
        for status in [502, 504, 500, 408, 429] {
            let unknown = not_registered(&document, Error::api(status, "upstream"));
            assert_eq!(unknown.code, 5, "{status} is no answer");
            assert_eq!(unknown.status, Some(status));
            assert!(unknown.details.unwrap()["registered"].is_null());
        }
        let lost = not_registered(&document, Error::uncertain("timed out"));
        assert_eq!(lost.code, 5, "uncertain");
        assert_eq!(lost.status, None);
        assert!(lost.message.contains("unknown"), "{}", lost.message);
        assert!(lost.details.unwrap()["registered"].is_null());
    }

    /// A step that is sent and not finalized is an uncertain error, never a finished document,
    /// and its details name the transaction to ask about.
    #[test]
    fn an_unfinished_step_is_uncertain_and_names_its_transaction() {
        let pending = Outcome::Pending { signature: [7; 64] };
        let error = unfinished(DEVNET, "fund-1", REFILL, &pending, "Run it again.");
        assert_eq!(error.code, 5, "uncertain");
        let details = error.details.unwrap();
        assert_eq!(details["requestId"], "fund-1");
        assert_eq!(details["transactions"][0]["status"], "submitted");
        assert_eq!(details["transactions"][0]["action"], "refill");
        // A submission that the RPC did not accept and the ledger does not show is unknown, as
        // `owner-status` says of it: never `submitted`.
        let unconfirmed = Outcome::Unconfirmed { signature: [7; 64] };
        let error = unfinished(DEVNET, "fund-1", REFILL, &unconfirmed, "Run it again.");
        assert_eq!(error.code, 5, "uncertain");
        assert_eq!(
            error.details.unwrap()["transactions"][0]["status"],
            "submissionUnknown"
        );
        // A step that failed on the ledger is Core's typed `owner_transaction_failed` refusal
        // and names its failed transaction.
        let error = failed(DEVNET, "fund-1", REFILL, &[7; 64], "It failed.");
        assert_eq!(error.code, 4);
        assert_eq!(error.api_code.as_deref(), Some("owner_transaction_failed"));
        assert!(
            error
                .message
                .contains(&bs58::encode([7u8; 64]).into_string())
        );
        assert_eq!(
            error.details.unwrap()["transactions"][0]["status"],
            "failed"
        );
    }

    /// The owner confirms what the step signs: an allowance approval, never a transfer.
    #[test]
    fn the_owner_confirms_an_allowance_approval_and_no_transfer() {
        use allowit_core::vendor::owner::Question;
        let fund = question(DEVNET, Question::Fund { amount: "2.5" }).unwrap();
        // The approval replaces the on-chain allowance read when it is prepared: no increment.
        assert!(
            fund.contains("on-chain allowance") && fund.contains("is prepared, plus 2.5"),
            "{fund}"
        );
        assert!(fund.contains("no wallet asset moves"), "{fund}");
        assert!(!fund.to_lowercase().contains("transfer"), "{fund}");
        // A typed amount that is no plain decimal never reaches the terminal.
        for typed in [
            "1\nYes",
            "2\u{1b}[2J",
            "",
            "1e9",
            "1.2.3",
            ".5",
            "1.",
            "01",
            "00.5",
        ] {
            let asked = question(DEVNET, Question::Fund { amount: typed }).unwrap();
            assert!(asked.contains("the given amount"), "{asked}");
            assert!(!asked.chars().any(char::is_control), "{asked}");
        }
        let setup = question(DEVNET, Question::Setup { amount: Some("10") }).unwrap();
        assert!(
            setup.contains("allowance to 10") && setup.contains("replacing any allowance"),
            "{setup}"
        );
        assert!(setup.contains("pays the SOL deposits"), "{setup}");
        assert!(setup.contains("no wallet asset moves"), "{setup}");
        assert!(
            question(DEVNET, Question::Setup { amount: None })
                .unwrap()
                .contains("allowance to 0")
        );
        // No deployment of this rail, and no question on another network.
        assert_eq!(
            question(DEVNET, Question::NativeDeploy { amount: None }),
            None
        );
        assert_eq!(
            question("unknown:none", Question::Fund { amount: "1" }),
            None
        );
    }

    #[test]
    fn the_registered_installation_is_the_wallet_of_its_roles_with_no_policy_yet() {
        let server = key(3).identity().to_owned();
        let found = read_template(&reply(&server), DEVNET, &server).unwrap();
        let wallet = |agent: u8| Wallet {
            owner: key(1).identity().parse().unwrap(),
            mint: USDC_DEVNET.parse().unwrap(),
            agent: key(agent).identity().parse().unwrap(),
            server: server.parse().unwrap(),
        };
        let config = installation(DEVNET, &wallet(2), &found).unwrap();
        assert_eq!(config.wallet, wallet(2).token_account().to_string());
        assert_eq!(config.policy_source, "");
        assert_eq!(config.max_fee_lamports, 20_000);
        // One wallet, one installation: the same roles name the same one, another agent another.
        assert_eq!(
            installation(DEVNET, &wallet(2), &found)
                .unwrap()
                .policy_instance,
            config.policy_instance
        );
        assert_ne!(
            installation(DEVNET, &wallet(4), &found)
                .unwrap()
                .policy_instance,
            config.policy_instance
        );
        // The rail's own configuration reads the document that the server will register.
        let document = serde_json::to_vec(&config).unwrap();
        crate::config::configuration(DEVNET, &document).unwrap();
        // A refill reads the installation alone or the document that the setup prints, with
        // the installation under `configuration`; any other wrapper is refused.
        assert_eq!(installation_of(&document).unwrap(), config);
        let setup = json!({"action": SETUP, "wallet": config.wallet, "configuration": config,
            "registered": true});
        assert_eq!(
            installation_of(&serde_json::to_vec(&setup).unwrap()).unwrap(),
            config
        );
        let other = json!({"action": REFILL, "configuration": config});
        assert!(installation_of(&serde_json::to_vec(&other).unwrap()).is_err());
        assert!(installation_of(b"not json").is_err());
    }
}
