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
        runtime::Signer,
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
            return Err(Error::config(format!(
                "The {role} belongs to another network than the wallet setup"
            )));
        }
    }
    // Refused before the owner signs anything, the sign-in included: one key in two roles
    // would make the wallet's two-of-two delegate the owner's own.
    if cx.signer.address() == cx.authority.public_key() {
        return Err(Error::config(
            "The owner's key is the server authority's key: a wallet needs two separate keys",
        ));
    }
    Ok(network)
}

/// Sign the owner in. The message must be the server's sign-in text for this owner and this
/// origin, and the owner's key signs its exact bytes, as a Solana wallet signs a message.
pub fn sign_in(cx: &Context<'_>) -> Result<owner_session::Client> {
    let owner = cx.signer.address().to_owned();
    let origin = cx.origin.to_owned();
    let mut session = owner_session::Client::new(cx.backend, cx.origin, &owner)?;
    session.authenticate("wallet", (cx.clock)()?, |challenge| {
        if !challenge.message.contains(&owner)
            || !challenge.message.contains(&origin)
            || !challenge.message.contains("does not authorize spending")
            || challenge.message.len() > 2_048
        {
            return Err(Error::config(
                "The server's sign-in message is not a sign-in for this owner and origin",
            ));
        }
        Ok(STANDARD.encode(cx.signer.sign_hash(challenge.message.as_bytes())?))
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
        Outcome::Pending { signature } => {
            document["status"] = "pending".into();
            document["signature"] = signature_text(&signature).into();
            document["next"] =
                "The setup is sent and not finalized yet. Run the setup again with the same request ID.".into();
            return Ok(document);
        }
        Outcome::Failed { signature } => {
            return Err(Error::config(format!(
                "The setup transaction {} failed on the ledger: nothing was set up, and its fee was paid. Use a new request ID after checking the owner's balance.",
                signature_text(&signature)
            )));
        }
    };
    let text = signature_text(&signature);
    document["status"] = "settled".into();
    document["explorer"] = json!(networks::explorer(network, LinkKind::Transaction, &text));
    document["signature"] = text.into();
    // The ledger holds the wallet: the server registers it from the ledger. A refusal leaves
    // the wallet set up, and the same request ID asks again and signs nothing.
    match session.owner_request::<Value>(
        Method::Post,
        &format!("/api/native/register?network={network}"),
        Some(&json!({"configuration": config})),
        (cx.clock)()?,
        false,
    ) {
        Ok(registration) => document["registration"] = registration,
        Err(error) => {
            document["registration"] = json!({"registered": false, "error": error.message});
        }
    }
    Ok(document)
}

/// Add `amount` to what the wallet of `document` may still spend: the owner's own approval,
/// which also resumes a stopped wallet. The server is not asked: it reads the allowance from
/// the ledger. No tokens move; the wallet spends what its account holds.
pub fn fund(cx: &Context<'_>, document: &[u8], request_id: &str, amount: &str) -> Result<Value> {
    let network = network(cx)?;
    let config = WalletConfig::decode(document)?;
    if config.network != network {
        return Err(Error::config(
            "The installation belongs to another network than this request",
        ));
    }
    let wallet = config.roles()?;
    if config.owner != cx.signer.address() {
        return Err(Error::usage("Only the wallet's owner refills it"));
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
    let (status, signature) = match outcome {
        Outcome::Settled { signature } => ("settled", signature),
        Outcome::Pending { signature } => ("pending", signature),
        Outcome::Failed { signature } => {
            return Err(Error::config(format!(
                "The refill transaction {} failed on the ledger: the allowance is unchanged, and its fee was paid. Use a new request ID.",
                signature_text(&signature)
            )));
        }
    };
    let text = signature_text(&signature);
    let mut document = json!({
        "requestId": request_id,
        "network": network,
        "wallet": config.wallet,
        "added": units.to_string(),
        "status": status,
        "explorer": networks::explorer(network, LinkKind::Transaction, &text),
        "signature": text,
    });
    if status == "pending" {
        document["next"] =
            "The refill is sent and not finalized yet. Run it again with the same request ID."
                .into();
    } else {
        document["allowance"] = owner::remaining(&chain, &wallet)?.to_string().into();
    }
    Ok(document)
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

/// The status document of a retained owner transaction.
pub fn status_document(
    network: &str,
    request_id: &str,
    signature: &[u8; 64],
    resolution: Resolution,
) -> Value {
    let (status, next) = match resolution {
        Resolution::Settled => ("settled", None),
        Resolution::Failed => (
            "failed",
            Some("Nothing of the request took effect, and its fee was paid. Use a new request ID."),
        ),
        Resolution::Pending => (
            "pending",
            Some("The transaction is on the ledger and not finalized yet. Ask again."),
        ),
        Resolution::Unsent => (
            "uncertain",
            Some(
                "The ledger does not show the transaction, and it can still settle. Run the same request again with the same request ID: the identical transaction is sent again.",
            ),
        ),
        Resolution::Lapsed => (
            "lapsed",
            Some(
                "The transaction never ran and can no longer run. Run the same request again with the same request ID: a new transaction is signed.",
            ),
        ),
    };
    let text = signature_text(signature);
    let mut document = json!({
        "requestId": request_id,
        "network": network,
        "status": status,
        "explorer": networks::explorer(network, LinkKind::Transaction, &text),
        "signature": text,
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
        let settled = status(Resolution::Settled);
        assert_eq!(settled["status"], "settled");
        assert!(settled.get("next").is_none());
        assert_eq!(settled["signature"], bs58::encode([7u8; 64]).into_string());
        // Not seen while its blockhash is valid is uncertain, not failed: it can still settle.
        let unsent = status(Resolution::Unsent);
        assert_eq!(unsent["status"], "uncertain");
        assert!(unsent["next"].as_str().unwrap().contains("identical"));
        assert_eq!(status(Resolution::Lapsed)["status"], "lapsed");
        assert_eq!(status(Resolution::Pending)["status"], "pending");
        assert_eq!(status(Resolution::Failed)["status"], "failed");
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
    }
}
