//! The owner's request for a policy draft: the rail's side of `allowit policy generate`.
//!
//! A Native wallet exists before its policy: the owner sets it up, and the server registers its
//! installation. A draft is generated for that installation. The client signs the owner in,
//! checks that the server advertises the wallet profile for the network, reads the owner's
//! installation, asks for the draft, and accepts only a draft of that installation: the same
//! wallet, token and fee ceiling, a source whose hash is its own, the first revision. A reply
//! that fails a check is uncertain, never a draft: the server may have stored it. A request for
//! a new wallet is refused after the sign-in, so a server's own typed refusal comes first.
use crate::config::{self, WalletConfig, hex32};
use crate::networks;
use allowit_core::{
    transport::http::Method,
    vendor::{
        error::{Error, Result},
        generation::{GenerateRequest, GeneratedDraft, Target},
        kinds::WalletKind,
        owner_session,
        plugin::GenerateContext,
    },
};
use serde_json::{Value, json};

/// The source profile and the operation of a generated policy: transfers.
const SOURCE_PROFILE: &str = "allowit-transfer-v1";
const OPERATION: &str = "allowit::transfer";
/// The kind of a wallet whose owner holds it, as the server's discovery names it.
const OWNER_WALLET: &str = "owner-wallet";

/// The server advertises exactly one wallet of `profile` on `network` that generates transfer
/// policies for an owner-held wallet. Returns its network as the server spells it.
pub fn advertised(discovery: &Value, network: &str, profile: &str) -> Result<String> {
    let names = |list: &Value, name: &str| {
        list.as_array()
            .is_some_and(|items| items.iter().any(|item| item == name))
    };
    let matching: Vec<&Value> = discovery["wallets"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|w| {
            w["profile"] == profile
                && w["kind"] == OWNER_WALLET
                && w["capabilities"]["generate"] == true
                && names(&w["sourceProfiles"], SOURCE_PROFILE)
                && names(&w["operations"], OPERATION)
                && names(&w["networks"], network)
        })
        .collect();
    let offers_operation = discovery["operations"]
        .as_array()
        .is_some_and(|ops| ops.iter().any(|op| op["function"] == OPERATION));
    if matching.len() != 1 || !offers_operation {
        return Err(Error::config(
            "The server does not advertise this Solana wallet profile for policy generation on this network",
        ));
    }
    Ok(network.to_owned())
}

/// The owner's installation `id` (its policy instance as hexadecimal) of `profile` on `network`,
/// from the server's list of installations.
pub fn installation_of(
    installations: &Value,
    network: &str,
    owner: &str,
    profile: &str,
    id: &str,
) -> Result<WalletConfig> {
    let matching: Vec<WalletConfig> = installations["installations"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|i| i["profile"] == profile)
        .filter_map(|i| serde_json::to_vec(&i["config"]).ok())
        .filter_map(|bytes| WalletConfig::decode(&bytes).ok())
        .filter(|c| {
            c.network == network && c.owner == owner && hex32::encode(&c.policy_instance) == id
        })
        .collect();
    let [config] = &matching[..] else {
        return Err(Error::config(
            "The selected installation does not belong to this owner, profile and network. Set the wallet up first, then name its installation",
        ));
    };
    Ok(config.clone())
}

/// The selected policy of a generation reply.
pub fn selected(reply: &Value) -> Result<Value> {
    let invalid = || {
        Error::uncertain(
            "Generation returned an invalid workspace; inspect the owner workspace before retrying",
        )
    };
    let id = reply["selectedId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(invalid)?;
    let policies = reply["policies"]
        .as_array()
        .filter(|p| p.len() <= 30)
        .ok_or_else(invalid)?;
    let mut found = policies.iter().filter(|p| p["id"] == id);
    match (found.next(), found.next()) {
        (Some(policy), None) => Ok(policy.clone()),
        _ => Err(invalid()),
    }
}

/// A generated policy is a draft of `config`'s wallet: the first revision, on its network, with
/// a source whose hash is its own, bound to the Native route and to the same wallet, token and
/// fee ceiling. Returns the values that the owner must still supply.
pub fn check_generated(
    policy: &Value,
    config: &WalletConfig,
    kind: Option<WalletKind>,
) -> Result<Vec<String>> {
    let changed = |what: &str| {
        Error::uncertain(format!(
            "The generated policy {what}; inspect the owner workspace before retrying"
        ))
    };
    let binding = &policy["runtime"]["instanceBinding"];
    if policy["revision"] != 1 {
        return Err(changed("is another revision than the first"));
    }
    if policy["network"] != config.network.as_str() {
        return Err(changed("belongs to another network"));
    }
    let source = policy["code"].as_str().unwrap_or("");
    let hash = hex32::encode(&config::source_hash(source));
    if source.is_empty()
        || policy["sourceHash"] != hash.as_str()
        || binding["portable"]["sourceHash"] != hash.as_str()
    {
        return Err(changed("names another source hash than its source has"));
    }
    let mint = binding["assetIssuer"]
        .as_str()
        .or_else(|| binding["asset"].as_str());
    if binding["route"] != "native"
        || binding["wallet"] != config.wallet.as_str()
        || mint != Some(config.mint.as_str())
        || binding["assetSymbol"] != config.asset_symbol.as_str()
        || binding["maxFeeUnits"] != config.max_fee_lamports
    {
        return Err(changed(
            "changed the selected installation's wallet, token or fee ceiling",
        ));
    }
    if let (Some(chosen), Some(bound)) = (
        kind,
        policy[GeneratedDraft::WALLET_KIND_KEY]
            .as_str()
            .and_then(WalletKind::parse),
    ) && chosen != bound
    {
        return Err(changed("binds another wallet kind than the selected one"));
    }
    serde_json::from_value(binding["portable"]["unresolved"].clone())
        .map_err(|_| changed("does not list its open values"))
}

/// What the request itself must satisfy before the owner signs in: a Solana network of the owner
/// key and the Native kind.
pub fn preflight(r: &GenerateRequest, signer_network: &str) -> Result<&'static str> {
    r.validate_with_network(|network| networks::network(network).map(|_| ()))?;
    let network = networks::network(&r.network)?.id;
    if signer_network != network {
        return Err(Error::usage(
            "The owner key belongs to another network than the policy",
        ));
    }
    if r.wallet_kind.is_some_and(|kind| kind != WalletKind::Native) {
        return Err(Error::usage(
            "The Solana rail generates policies for the Native wallet kind only",
        ));
    }
    Ok(network)
}

/// The installation that a draft is generated for. A Native wallet exists before its policy, so
/// a request for a new wallet names none. It is refused after the sign-in: a server that refuses
/// the owner or the kind answers first, with its own typed refusal.
pub fn target(r: &GenerateRequest) -> Result<&str> {
    match &r.target {
        Target::Installation(id) => Ok(id),
        Target::NewWallet => Err(Error::usage(
            "A Native wallet on Solana exists before its policy: set the wallet up first, then generate a policy for its installation",
        )),
    }
}

/// Ask the backend for a policy draft of the owner's installation.
pub fn generate(cx: &GenerateContext<'_>, r: &GenerateRequest) -> Result<GeneratedDraft> {
    let network = preflight(r, cx.signer.network())?;
    let owner = cx.signer.address().to_owned();
    let mut session = owner_session::Client::new(cx.backend, cx.origin, &owner)?;
    session.authenticate("wallet", (cx.clock)()?, |challenge| {
        crate::owner_client::sign_in_signature(cx.signer, cx.origin, &challenge.message)
    })?;
    let id = target(r)?;
    let now = (cx.clock)()?;
    let discovery: Value =
        session.owner_request(Method::Get, "/api/micro/runtime", None, now, false)?;
    let advertised_network = advertised(&discovery, network, &r.profile)?;
    let installations: Value =
        session.owner_request(Method::Get, "/api/native/policies", None, now, false)?;
    let config = installation_of(&installations, network, &owner, &r.profile, id)?;
    let mut body = json!({
        "prompt": r.prompt,
        "network": advertised_network,
        "runtime": {"sourceProfile": SOURCE_PROFILE,
            "wallet": {"kind": OWNER_WALLET, "profile": r.profile}},
        "operation": {"function": OPERATION},
        "installationId": id,
    });
    // The owner's choice. The server binds it or refuses with a typed error.
    if let Some(kind) = r.wallet_kind {
        body[GeneratedDraft::WALLET_KIND_KEY] = json!(kind);
    }
    let reply: Value =
        session.owner_request(Method::Post, "/api/micro/generate", Some(&body), now, true)?;
    let policy = selected(&reply)?;
    let unresolved = check_generated(&policy, &config, r.wallet_kind)?;
    Ok(GeneratedDraft {
        document: policy,
        unresolved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::tests::sample;
    use crate::networks::DEVNET;

    const PROFILE: &str = "allowit-native-v1";
    const SOURCE: &str = "pub fn execute(ctx: &AllowitContext) -> allowit::Result { Ok(()) }";

    fn discovery() -> Value {
        json!({"wallets": [{"kind": OWNER_WALLET, "profile": PROFILE, "networks": [DEVNET],
            "sourceProfiles": [SOURCE_PROFILE], "operations": [OPERATION],
            "capabilities": {"generate": true}}],
            "operations": [{"function": OPERATION}]})
    }

    fn policy(config: &WalletConfig) -> Value {
        let hash = hex32::encode(&config::source_hash(SOURCE));
        json!({"id": "policy-1", "revision": 1, "network": DEVNET, "code": SOURCE,
            "sourceHash": hash, "walletKind": "native",
            "runtime": {"instanceBinding": {"route": "native", "wallet": config.wallet,
                "asset": config.mint, "assetIssuer": config.mint,
                "assetSymbol": config.asset_symbol, "maxFeeUnits": config.max_fee_lamports,
                "portable": {"sourceHash": hash, "unresolved": ["destinations"]}}}})
    }

    #[test]
    fn a_draft_is_asked_only_for_an_advertised_profile_and_the_owners_own_installation() {
        assert_eq!(advertised(&discovery(), DEVNET, PROFILE).unwrap(), DEVNET);
        let refused = |change: &dyn Fn(&mut Value)| {
            let mut d = discovery();
            change(&mut d);
            advertised(&d, DEVNET, PROFILE).unwrap_err()
        };
        refused(&|d| d["wallets"][0]["capabilities"]["generate"] = json!(false));
        refused(&|d| d["wallets"][0]["kind"] = json!("contract-wallet"));
        refused(&|d| d["wallets"][0]["networks"] = json!(["solana:other"]));
        refused(&|d| d["operations"] = json!([]));
        refused(&|d| {
            let copy = d["wallets"][0].clone();
            d["wallets"].as_array_mut().unwrap().push(copy);
        });
        assert!(advertised(&discovery(), DEVNET, "another-profile").is_err());

        let config = sample();
        let id = hex32::encode(&config.policy_instance);
        let list = json!({"installations": [{"profile": PROFILE, "config": config}]});
        let found = installation_of(&list, DEVNET, &config.owner, PROFILE, &id).unwrap();
        assert_eq!(found, config);
        assert!(installation_of(&list, DEVNET, &config.agent, PROFILE, &id).is_err());
        assert!(installation_of(&list, DEVNET, &config.owner, "other", &id).is_err());
        assert!(installation_of(&list, DEVNET, &config.owner, PROFILE, &"00".repeat(32)).is_err());
        assert!(installation_of(&json!({}), DEVNET, &config.owner, PROFILE, &id).is_err());
    }

    #[test]
    fn a_reply_is_a_draft_only_of_the_selected_installation_and_else_uncertain() {
        let config = sample();
        let reply =
            json!({"selectedId": "policy-1", "policies": [policy(&config), {"id": "other"}]});
        let chosen = selected(&reply).unwrap();
        assert_eq!(
            check_generated(&chosen, &config, Some(WalletKind::Native)).unwrap(),
            ["destinations"]
        );
        let uncertain = Error::uncertain("").code;
        let refused = |change: &dyn Fn(&mut Value)| {
            let mut p = policy(&config);
            change(&mut p);
            let error = check_generated(&p, &config, Some(WalletKind::Native)).unwrap_err();
            assert_eq!(error.code, uncertain, "{}", error.message);
        };
        refused(&|p| p["revision"] = json!(2));
        refused(&|p| p["network"] = json!("solana:other"));
        refused(&|p| p["code"] = json!(format!("{SOURCE} ")));
        refused(&|p| p["runtime"]["instanceBinding"]["route"] = json!("policyWallet"));
        refused(&|p| p["runtime"]["instanceBinding"]["wallet"] = json!(config.owner));
        refused(&|p| p["runtime"]["instanceBinding"]["assetIssuer"] = json!(config.owner));
        refused(&|p| p["runtime"]["instanceBinding"]["maxFeeUnits"] = json!(1));
        refused(&|p| p["walletKind"] = json!("standard"));
        refused(&|p| p["runtime"]["instanceBinding"]["portable"]["unresolved"] = json!("x"));
        // No selected policy, or the selected id twice, is no draft.
        for bad in [
            json!({"selectedId": "", "policies": []}),
            json!({"selectedId": "missing", "policies": [policy(&config)]}),
            json!({"selectedId": "policy-1", "policies": [policy(&config), policy(&config)]}),
        ] {
            assert_eq!(selected(&bad).unwrap_err().code, uncertain);
        }
    }

    #[test]
    fn another_kind_or_network_stops_before_the_sign_in_and_a_new_wallet_after_it() {
        let request = |target, kind| GenerateRequest {
            prompt: "Pay for data".into(),
            network: DEVNET.into(),
            profile: PROFILE.into(),
            target,
            wallet_kind: kind,
        };
        let id = "11".repeat(32);
        let ok = request(Target::Installation(id.clone()), Some(WalletKind::Native));
        assert_eq!(preflight(&ok, DEVNET).unwrap(), DEVNET);
        assert_eq!(target(&ok).unwrap(), id);
        assert!(preflight(&ok, "solana:other").is_err());
        // A new-wallet request passes the preflight and is refused after the sign-in.
        let new = request(Target::NewWallet, None);
        preflight(&new, DEVNET).unwrap();
        let refused = target(&new).unwrap_err();
        assert!(
            refused.message.contains("set the wallet up first"),
            "{}",
            refused.message
        );
        let kind = request(Target::Installation(id), Some(WalletKind::Standard));
        assert!(preflight(&kind, DEVNET).is_err());
    }
}
