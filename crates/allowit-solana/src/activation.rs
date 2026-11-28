//! The owner's approval of a Native wallet's policy: the wallet's second owner signature, after the
//! setup (plan, section 3). It signs a message and moves nothing.
//!
//! 1. The client rebuilds, from the policy document that the owner reviewed and the wallet's roles,
//!    the installation that the server binds to the policy, and the exact text that approves it.
//! 2. The server's own text of the approval must be that text, byte for byte: the owner signs
//!    nothing that the client did not build itself.
//! 3. Before the owner signs, the ledger must hold the wallet as the owner's token account.
//! 4. The request is retained before anything is asked, and the signature before it is sent: a
//!    repeat of the request id sends the same signature and never signs twice.
//! 5. The server confirms the policy as active; an unclear answer keeps the request for a repeat.
//!
//! The public profile that an agent imports is the installation with the owner's signed approval
//! ([`Bundle`]); [`export`] gives it once the approval is confirmed.
use crate::client::Records;
use crate::config::{self, WalletConfig, hex32};
use crate::native::{Address, Wallet};
use crate::owner_client::{Template, installation};
use crate::owner_runtime::OWNER_RUNTIME;
use crate::payment;
use crate::runtime::{Bundle, Consent};
use allowit_core::vendor::{
    error::{Error, Result},
    plugin::OwnerRuntime as _,
    runtime::owner::{PolicyIdentity, SourceConsent},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// What the owner approves: the policy, the installation that the server binds to it, and the
/// exact text of the approval with its payload.
#[derive(Clone, Debug, PartialEq)]
pub struct Approval {
    pub policy_id: String,
    pub revision: u32,
    pub config: WalletConfig,
    pub payload: Value,
    pub message: String,
}

fn invalid(what: &str) -> Error {
    Error::usage(format!(
        "The policy document is not a Solana Native policy: {what}"
    ))
}

/// The text field `key` of `value`, or a refusal that names it.
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or_else(|| invalid(key))
}

/// The approval of `policy` for the wallet of `owner`, `agent` and `server` on `network`: the
/// installation that the server binds, as `keypair_policy_config` of the engine binds it, and the
/// rail's own consent text of it.
pub fn approval(
    network: &str,
    policy: &Value,
    owner: &str,
    agent: &str,
    server: &str,
) -> Result<Approval> {
    if text(policy, "network")? != network {
        return Err(invalid("it belongs to another network"));
    }
    let policy_id = text(policy, "id")?;
    if policy_id.is_empty() || policy_id.len() > 128 {
        return Err(invalid("id"));
    }
    let revision = policy["revision"]
        .as_u64()
        .and_then(|r| u32::try_from(r).ok())
        .filter(|r| *r > 0)
        .ok_or_else(|| invalid("revision"))?;
    let source = text(policy, "code")?;
    let source_hash = text(policy, "sourceHash")?;
    if source_hash != hex32::encode(&config::source_hash(source)) {
        return Err(invalid("its source hash is not the hash of its source"));
    }
    let ir_hash = policy["irHash"].as_str().unwrap_or("");
    let binding = &policy["runtime"]["instanceBinding"];
    if text(binding, "route")? != "native" {
        return Err(invalid("it binds another wallet kind than Native"));
    }
    let portable = &binding["portable"];
    if text(portable, "sourceHash")? != source_hash {
        return Err(invalid("its draft names another source"));
    }
    if portable["unresolved"]
        .as_array()
        .is_some_and(|open| !open.is_empty())
    {
        return Err(Error::usage(
            "The policy still has values to supply. Supply them before approving it.",
        ));
    }
    let hex = |key: &str| hex32::decode(text(binding, key)?).ok_or_else(|| invalid(key));
    let (policy_instance, module_digest) = (hex("policyInstance")?, hex("moduleDigest")?);
    let params_value = portable["params"].clone();
    let params = serde_json::from_value(params_value.clone()).map_err(|_| invalid("params"))?;
    let rules: Vec<String> = serde_json::from_value(portable["rules"].clone()).unwrap_or_default();
    let language = text(portable, "language")?;
    let tier = portable["tier"].as_str().unwrap_or("");
    let params_hash = text(portable, "paramsHash")?;

    // The token: the binding's mint, a token that the rail lists on the network.
    let mint = binding["assetIssuer"]
        .as_str()
        .or_else(|| binding["asset"].as_str())
        .ok_or_else(|| invalid("asset"))?;
    let symbol = text(binding, "assetSymbol")?;
    let token = crate::networks::tokens(network)
        .iter()
        .find(|t| t.issuer == Some(mint) && t.code == symbol)
        .ok_or_else(|| invalid("its token is not a token that the rail lists"))?;
    let max_fee_lamports = binding["maxFeeUnits"]
        .as_u64()
        .ok_or_else(|| invalid("maxFeeUnits"))?;
    let address = |key: &str, what: &str| -> Result<Address> {
        key.parse()
            .map_err(|_| Error::usage(format!("The {what} is not a Solana address")))
    };
    let wallet = Wallet {
        owner: address(owner, "owner")?,
        mint: address(mint, "token")?,
        agent: address(agent, "agent")?,
        server: address(server, "server")?,
    };
    wallet.check()?;
    if text(binding, "wallet")? != wallet.token_account().to_string() {
        return Err(Error::usage(
            "The policy names another wallet than the token account of this owner, agent and token",
        ));
    }
    let base = installation(
        network,
        &wallet,
        &Template {
            mint: mint.into(),
            symbol: symbol.into(),
            decimals: token.decimals,
            max_fee_lamports,
        },
    )?;
    let bound = config::with_policy(
        &config::encode(&base)?,
        PolicyIdentity {
            policy_instance,
            module_digest,
            source: source.into(),
            params,
            asset: binding["asset"].as_str().unwrap_or(mint).into(),
            asset_symbol: symbol.into(),
            asset_issuer: Some(mint.into()),
            agent: agent.into(),
            server: server.into(),
            max_fee_units: max_fee_lamports,
        },
    )?;
    let (payload, message) = OWNER_RUNTIME.source_consent(&SourceConsent {
        configuration: &bound,
        policy_id,
        revision,
        source,
        source_hash,
        ir_hash,
        module_digest: &hex32::encode(&module_digest),
        language,
        tier,
        rules: &rules,
        params: &params_value,
        params_hash,
    })?;
    Ok(Approval {
        policy_id: policy_id.into(),
        revision,
        config: WalletConfig::decode(bound.bytes())?,
        payload,
        message,
    })
}

/// The params of a policy document, a generation reply (its `policy`), a public profile of this
/// rail, or an installation (alone, as a refill reads it, or under `configuration` in the
/// document that `wallet setup` prints), with the token that their amounts count. The SDK
/// prints them.
pub fn draft_params(
    network: &str,
    document: &Value,
) -> Result<allowit_core::vendor::plugin::DraftParams> {
    let network = crate::networks::network(network)?.id;
    let document = document.get("policy").unwrap_or(document);
    let document = match document.get("configuration") {
        Some(installed) if document["action"] == crate::owner_client::SETUP => installed,
        _ => document,
    };
    // An installation holds its params and its token itself.
    let installed = document["route"] == "native" && document["params"].is_object();
    let config = if installed {
        document
    } else {
        &document["config"]
    };
    let binding = &document["runtime"]["instanceBinding"];
    let (params, mint, symbol) = if config.is_object() {
        (
            &config["params"],
            config["mint"].as_str(),
            config["assetSymbol"].as_str(),
        )
    } else {
        (
            &binding["portable"]["params"],
            binding["assetIssuer"]
                .as_str()
                .or_else(|| binding["asset"].as_str()),
            binding["assetSymbol"].as_str(),
        )
    };
    let params = params.as_object().ok_or_else(|| invalid("params"))?;
    let token = crate::networks::tokens(network)
        .iter()
        .find(|t| mint.is_some() && t.issuer == mint && Some(t.code) == symbol)
        .ok_or_else(|| invalid("its token is not a token that the rail lists"))?;
    Ok(allowit_core::vendor::plugin::DraftParams {
        params: params.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        asset: allowit_core::vendor::input::asset::AssetDisplay {
            symbol: token.code.into(),
            decimals: token.decimals,
            name: token.code.into(),
            native: token.native,
        },
    })
}

/// What the client retains of one approval, under its request id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activation {
    pub version: u8,
    pub origin: String,
    /// The hash of the policy, its revision and the approval text: a repeat must ask for the same.
    pub identity: String,
    /// The wallet's agent and server: the roles that [`export`] rebuilds the approval with.
    pub agent: String,
    pub server: String,
    /// The owner's signature of the approval text, base58, once the owner signed.
    pub signature: Option<String>,
    pub completed: bool,
}

/// The record name of an approval request: apart from the names of owner transactions.
pub fn record_name(request_id: &str) -> Result<String> {
    if request_id.is_empty()
        || request_id.len() > 80
        || !request_id.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(Error::usage(
            "An activation request ID has 1 to 80 visible ASCII characters",
        ));
    }
    Ok(format!("activation:{request_id}"))
}

fn identity(a: &Approval) -> String {
    let mut hash = Sha256::new();
    hash.update(b"allowit-solana-activation-v1\0");
    hash.update(a.policy_id.as_bytes());
    hash.update([0]);
    hash.update(a.revision.to_be_bytes());
    hash.update(a.message.as_bytes());
    hex32::encode(&hash.finalize().into())
}

/// The caller's request: Core's `Activate` without its lifetime ties to a context.
pub struct ActivateRequest<'a> {
    pub document: &'a [u8],
    pub agent: Option<&'a str>,
    pub server: Option<&'a str>,
    pub request_id: &'a str,
}

/// What an approval needs from its host: the server, the owner's key and the ledger.
pub trait Host {
    /// The server's backend address: a retained approval belongs to one server.
    fn backend(&self) -> &str;
    /// One owner request to the server. `uncertain` marks a request whose effect may be unknown
    /// when no whole answer comes.
    fn ask(&self, path: &str, body: &Value, uncertain: bool) -> Result<Value>;
    /// The owner's signature of `message`, as a Solana wallet signs a text message.
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>>;
    /// Refuses unless the ledger holds the wallet as the owner's token account of its mint.
    fn wallet_held(&self, wallet: &Wallet) -> Result<()>;
}

/// Approve `a` under `request_id`, or finish the approval that the id already names.
pub fn activate(
    host: &dyn Host,
    records: &dyn Records,
    a: &Approval,
    request_id: &str,
) -> Result<Value> {
    let name = record_name(request_id)?;
    let identity = identity(a);
    let mut record = match records.load(&name)? {
        None => Activation {
            version: 1,
            origin: host.backend().into(),
            identity: identity.clone(),
            agent: a.config.agent.clone(),
            server: a.config.server.clone(),
            signature: None,
            completed: false,
        },
        Some(saved) => {
            let saved: Activation = serde_json::from_value(saved)
                .map_err(|_| Error::config("The retained activation is unreadable"))?;
            if saved.identity != identity || saved.origin != host.backend() {
                return Err(Error::usage(
                    "This request ID names another approval; use a new ID for a new approval",
                ));
            }
            saved
        }
    };
    let owner: Address = a
        .config
        .owner
        .parse()
        .map_err(|_| Error::config("The installation's owner is invalid"))?;
    let done = |record: &Activation| {
        json!({
            "requestId": request_id,
            "state": "active",
            "policyId": a.policy_id,
            "revision": a.revision,
            "wallet": a.config.wallet,
            "signed": record.signature.is_some(),
        })
    };
    if record.completed {
        return Ok(done(&record));
    }
    records.save(&name, &serde_json::to_value(&record).expect("a record"))?;

    // The server's text must be the client's own, byte for byte.
    let offered = host.ask(
        "/api/native/approval",
        &json!({"policyId": a.policy_id}),
        false,
    )?;
    if offered["payload"] != a.payload || offered["message"].as_str() != Some(&a.message) {
        return Err(Error::config(
            "The server's approval differs from the policy that you reviewed. Nothing was signed.",
        ));
    }
    if offered["required"] == true && record.signature.is_none() {
        let wallet = a.config.roles()?;
        host.wallet_held(&wallet)?;
        let signature = host.sign(a.message.as_bytes())?;
        payment::verify(&owner, a.message.as_bytes(), &signature)
            .map_err(|_| Error::config("The owner's key did not sign the approval"))?;
        record.signature = Some(bs58::encode(&signature).into_string());
        // Retained before it is sent: a repeat sends this signature and signs nothing.
        records.save(&name, &serde_json::to_value(&record).expect("a record"))?;
    }
    let approvals: Vec<Value> = match &record.signature {
        Some(text) => {
            let bytes = bs58::decode(text)
                .into_vec()
                .map_err(|_| Error::config("The retained signature is unreadable"))?;
            payment::verify(&owner, a.message.as_bytes(), &bytes)
                .map_err(|_| Error::config("The retained signature is not the owner's"))?;
            vec![json!({"signer": a.config.owner, "signature": bytes})]
        }
        None => vec![],
    };
    let confirmed = host
        .ask(
            "/api/micro/allocation/confirm",
            &json!({
                "id": a.policy_id,
                "revision": a.revision,
                "requestId": request_id,
                "sourceApproval": approvals,
            }),
            true,
        )
        .map_err(|error| {
            if error.code == Error::uncertain("").code {
                error
            } else {
                Error::uncertain(format!(
                    "The approval was not confirmed: {}. It stays retained: run the same request again with the same request ID; nothing is signed twice.",
                    error.message
                ))
            }
        })?;
    if confirmed["active"] != true {
        return Err(Error::uncertain(
            "The server did not confirm the policy as active. The approval stays retained: run the same request again with the same request ID.",
        ));
    }
    record.completed = true;
    records.save(&name, &serde_json::to_value(&record).expect("a record"))?;
    Ok(done(&record))
}

/// The public profile of the wallet that `owner` approved for `policy` under `request_id`, as an
/// agent imports it. Only an approval that the server confirmed, with the owner's signature, gives
/// one. The approval is rebuilt from the policy and the retained roles, and must be the same.
pub fn export(
    records: &dyn Records,
    network: &str,
    policy: &Value,
    owner: &str,
    request_id: &str,
) -> Result<Bundle> {
    let missing = || {
        Error::config("Complete the approval of this policy before exporting its wallet profile")
    };
    let saved: Activation = records
        .load(&record_name(request_id)?)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| Error::config("The retained activation is unreadable"))?
        .ok_or_else(missing)?;
    let a = approval(network, policy, owner, &saved.agent, &saved.server)?;
    if saved.identity != identity(&a) {
        return Err(Error::usage(
            "This request ID names the approval of another policy",
        ));
    }
    let (true, Some(signature)) = (saved.completed, saved.signature) else {
        return Err(missing());
    };
    let bundle = Bundle {
        version: 1,
        policy_id: a.policy_id.clone(),
        config: a.config.clone(),
        consent: Consent {
            payload: a.payload.clone(),
            signature,
        },
    };
    // The profile is what the server and the agent check: it must pass the same check here.
    bundle.validate()?;
    Ok(bundle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::networks::{DEVNET, USDC_DEVNET};
    use crate::packets::tests::key;
    use allowit_core::vendor::runtime::Signer as _;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;

    const SOURCE: &str = "pub fn execute(ctx: &AllowitContext) -> allowit::Result { Ok(()) }";

    fn roles() -> (String, String, String) {
        (
            key(1).identity().to_owned(),
            key(2).identity().to_owned(),
            key(3).identity().to_owned(),
        )
    }

    /// A Native policy as the server stores it, for the wallet of owner 1, agent 2 and server 3.
    fn policy() -> Value {
        let (owner, agent, server) = roles();
        let wallet = Wallet {
            owner: owner.parse().unwrap(),
            mint: USDC_DEVNET.parse().unwrap(),
            agent: agent.parse().unwrap(),
            server: server.parse().unwrap(),
        };
        let source_hash = hex32::encode(&config::source_hash(SOURCE));
        json!({
            "id": "policy-1", "revision": 2, "network": DEVNET, "code": SOURCE,
            "sourceHash": source_hash, "irHash": "ab".repeat(32),
            "runtime": {"instanceBinding": {
                "route": "native", "policyInstance": "11".repeat(32), "moduleDigest": "00".repeat(32),
                "wallet": wallet.token_account().to_string(), "asset": USDC_DEVNET,
                "assetSymbol": "USDC", "assetIssuer": USDC_DEVNET, "maxFeeUnits": 20_000,
                "portable": {
                    "language": "allowit-portable-v1", "sourceHash": source_hash, "tier": "native",
                    "rules": ["payment_limit"], "params": {"payment_limit": {"Int": "1000000"}},
                    "paramsHash": "cd".repeat(32), "unresolved": [],
                },
            }},
        })
    }

    fn approved() -> Approval {
        let (owner, agent, server) = roles();
        approval(DEVNET, &policy(), &owner, &agent, &server).unwrap()
    }

    #[derive(Default)]
    struct Book(RefCell<BTreeMap<String, Value>>);
    impl Records for Book {
        fn load(&self, name: &str) -> Result<Option<Value>> {
            Ok(self.0.borrow().get(name).cloned())
        }
        fn save(&self, name: &str, record: &Value) -> Result<()> {
            self.0.borrow_mut().insert(name.into(), record.clone());
            Ok(())
        }
    }

    /// A server that answers the approval with `offered` and the confirmation with `confirm`.
    struct Server {
        offered: RefCell<Value>,
        confirm: RefCell<Result<Value>>,
        asked: RefCell<Vec<(String, Value)>>,
        signed: Cell<usize>,
        held: Cell<bool>,
    }
    impl Server {
        fn new(a: &Approval) -> Self {
            Self {
                offered: RefCell::new(
                    json!({"required": true, "payload": a.payload, "message": a.message, "method": "sep53"}),
                ),
                confirm: RefCell::new(Ok(json!({"active": true}))),
                asked: RefCell::default(),
                signed: Cell::new(0),
                held: Cell::new(true),
            }
        }
        fn confirmations(&self) -> Vec<Value> {
            self.asked
                .borrow()
                .iter()
                .filter(|(path, _)| path.ends_with("/confirm"))
                .map(|(_, body)| body.clone())
                .collect()
        }
    }
    impl Host for Server {
        fn backend(&self) -> &str {
            "https://allowit.example"
        }
        fn ask(&self, path: &str, body: &Value, _: bool) -> Result<Value> {
            self.asked.borrow_mut().push((path.into(), body.clone()));
            if path.ends_with("/confirm") {
                return self.confirm.borrow().clone();
            }
            Ok(self.offered.borrow().clone())
        }
        fn sign(&self, message: &[u8]) -> Result<Vec<u8>> {
            self.signed.set(self.signed.get() + 1);
            key(1).sign_bytes(message)
        }
        fn wallet_held(&self, _: &Wallet) -> Result<()> {
            if self.held.get() {
                Ok(())
            } else {
                Err(Error::usage("The wallet's token account is closed"))
            }
        }
    }

    #[test]
    fn the_approval_is_the_installation_that_the_server_binds_and_its_consent_text() {
        let a = approved();
        assert_eq!((a.policy_id.as_str(), a.revision), ("policy-1", 2));
        assert_eq!(a.config.policy_source, SOURCE);
        assert_eq!(a.config.policy_instance, [0x11; 32]);
        assert_eq!(a.config.max_fee_lamports, 20_000);
        assert!(
            a.message
                .starts_with("Allowit: I approve this policy source for my wallet.\n")
        );
        assert_eq!(a.payload["policyId"], "policy-1");
        assert_eq!(a.payload["wallet"], a.config.wallet);
        // The rail's own consent of the bound installation gives the same text.
        let (owner, agent, server) = roles();
        assert_eq!(
            approval(DEVNET, &policy(), &owner, &agent, &server).unwrap(),
            a
        );
        // Another agent is another wallet; a policy of another network, source or kind is refused.
        assert!(approval(DEVNET, &policy(), &owner, key(4).identity(), &server).is_err());
        let refused = |change: &dyn Fn(&mut Value)| {
            let mut p = policy();
            change(&mut p);
            approval(DEVNET, &p, &owner, &agent, &server).unwrap_err()
        };
        refused(&|p| p["network"] = json!("solana:other"));
        refused(&|p| p["code"] = json!(format!("{SOURCE} ")));
        refused(&|p| p["runtime"]["instanceBinding"]["route"] = json!("policyWallet"));
        refused(&|p| p["runtime"]["instanceBinding"]["assetIssuer"] = json!(agent));
        refused(&|p| p["revision"] = json!(0));
        let open = refused(&|p| {
            p["runtime"]["instanceBinding"]["portable"]["unresolved"] = json!(["destinations"])
        });
        assert!(
            open.message.contains("values to supply"),
            "{}",
            open.message
        );
    }

    #[test]
    fn the_owner_signs_the_servers_text_only_when_it_is_the_clients_own_and_once() {
        let (a, book) = (approved(), Book::default());
        let server = Server::new(&a);
        let done = activate(&server, &book, &a, "approve-1").unwrap();
        assert_eq!(done["state"], "active");
        assert_eq!(server.signed.get(), 1);
        let [confirm] = &server.confirmations()[..] else {
            panic!("one confirmation");
        };
        assert_eq!(confirm["id"], "policy-1");
        assert_eq!(confirm["revision"], 2);
        let approval = &confirm["sourceApproval"][0];
        assert_eq!(approval["signer"], a.config.owner);
        let bytes: Vec<u8> = serde_json::from_value(approval["signature"].clone()).unwrap();
        payment::verify(
            &a.config.roles().unwrap().owner,
            a.message.as_bytes(),
            &bytes,
        )
        .unwrap();
        // A repeat of the request id asks nothing and signs nothing.
        let asked = server.asked.borrow().len();
        activate(&server, &book, &a, "approve-1").unwrap();
        assert_eq!(
            (server.signed.get(), server.asked.borrow().len()),
            (1, asked)
        );
        // Another policy under the same id is refused before anything is asked.
        let mut other = a.clone();
        other.revision = 3;
        assert!(activate(&server, &book, &other, "approve-1").is_err());
        assert_eq!(server.asked.borrow().len(), asked);
    }

    #[test]
    fn a_server_text_that_differs_or_a_wallet_that_the_ledger_does_not_hold_signs_nothing() {
        let a = approved();
        let server = Server::new(&a);
        server.offered.borrow_mut()["message"] = json!(format!("{} ", a.message));
        let refused = activate(&server, &Book::default(), &a, "approve-2").unwrap_err();
        assert!(
            refused.message.contains("Nothing was signed"),
            "{}",
            refused.message
        );
        let server = Server::new(&a);
        server.offered.borrow_mut()["payload"]["revision"] = json!(9);
        assert!(activate(&server, &Book::default(), &a, "approve-3").is_err());
        let server = Server::new(&a);
        server.held.set(false);
        assert!(activate(&server, &Book::default(), &a, "approve-4").is_err());
        assert_eq!(server.signed.get(), 0);
        assert!(server.confirmations().is_empty());
    }

    #[test]
    fn an_unconfirmed_approval_is_sent_again_with_the_same_signature() {
        let (a, book) = (approved(), Book::default());
        let server = Server::new(&a);
        *server.confirm.borrow_mut() = Err(Error::config("connection reset"));
        let unclear = activate(&server, &book, &a, "approve-5").unwrap_err();
        assert_eq!(
            unclear.code,
            Error::uncertain("").code,
            "{}",
            unclear.message
        );
        *server.confirm.borrow_mut() = Ok(json!({"active": false}));
        assert!(activate(&server, &book, &a, "approve-5").is_err());
        *server.confirm.borrow_mut() = Ok(json!({"active": true}));
        activate(&server, &book, &a, "approve-5").unwrap();
        assert_eq!(server.signed.get(), 1, "one signature for three attempts");
        let sent: Vec<Value> = server
            .confirmations()
            .iter()
            .map(|c| c["sourceApproval"].clone())
            .collect();
        assert_eq!(sent.len(), 3);
        assert!(sent.iter().all(|s| *s == sent[0]));
    }

    #[test]
    fn an_approval_that_the_server_already_holds_is_confirmed_without_a_signature() {
        let (a, book) = (approved(), Book::default());
        let server = Server::new(&a);
        server.offered.borrow_mut()["required"] = json!(false);
        activate(&server, &book, &a, "approve-6").unwrap();
        assert_eq!(server.signed.get(), 0);
        assert_eq!(server.confirmations()[0]["sourceApproval"], json!([]));
        // Without the owner's signature there is no profile to export.
        let (owner, _, _) = roles();
        assert!(export(&book, DEVNET, &policy(), &owner, "approve-6").is_err());
    }

    #[test]
    fn the_profile_is_exported_only_after_the_confirmed_approval_and_passes_the_import_check() {
        let (a, book) = (approved(), Book::default());
        let (owner, _, _) = roles();
        assert!(export(&book, DEVNET, &policy(), &owner, "approve-7").is_err());
        let server = Server::new(&a);
        *server.confirm.borrow_mut() = Err(Error::config("connection reset"));
        let _ = activate(&server, &book, &a, "approve-7");
        assert!(
            export(&book, DEVNET, &policy(), &owner, "approve-7").is_err(),
            "signed but not confirmed"
        );
        *server.confirm.borrow_mut() = Ok(json!({"active": true}));
        activate(&server, &book, &a, "approve-7").unwrap();
        let bundle = export(&book, DEVNET, &policy(), &owner, "approve-7").unwrap();
        assert_eq!(bundle.config, a.config);
        bundle.validate().unwrap();
        // Another policy under that id gives no profile.
        let mut other = policy();
        other["revision"] = json!(3);
        assert!(export(&book, DEVNET, &other, &owner, "approve-7").is_err());
        assert!(record_name("").is_err() && record_name("a b").is_err());
    }
}
