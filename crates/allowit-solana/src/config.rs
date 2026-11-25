//! The installation of a Native wallet: the document that binds one wallet to its owner, agent,
//! server, asset and policy, and the rail-neutral configuration that hosts read from it.
//!
//! The wallet's address is not free: it is the token account that the owner, the mint and the
//! agent derive ([`Wallet::token_account`]), so a document cannot name another wallet's account
//! with these roles, and a change of the agent or the mint is another wallet.
use crate::native::{Wallet, fee};
use crate::networks;
use allowit_core::{
    policy::PolicyValue,
    vendor::{
        error::{Error, Result},
        runtime::{
            Tier,
            owner::{Configuration, ConfigurationInfo, Custody, FeeBounds, PolicyIdentity},
        },
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// The lowest fee bound of an operation: one signature.
pub const MIN_FEE_LAMPORTS: u64 = 5_000;
/// The highest fee that an installation may allow one payment: 0.001 SOL.
pub const MAX_EXECUTION_FEE_LAMPORTS: u64 = 1_000_000;
/// What the owner's setup may cost with its two deposits: 0.01 SOL.
pub const DEFAULT_SETUP_LAMPORTS: u64 = 10_000_000;

/// 32 bytes as 64 lowercase hexadecimal characters.
pub mod hex32 {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn encode(bytes: &[u8; 32]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
    pub fn decode(text: &str) -> Option<[u8; 32]> {
        if text.len() != 64 || !text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok()?;
        }
        Some(out)
    }
    pub fn serialize<S: Serializer>(bytes: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&encode(bytes))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        decode(&String::deserialize(d)?)
            .ok_or_else(|| D::Error::custom("Expected 64 lowercase hexadecimal characters"))
    }
}

/// Where the policy of a wallet is enforced. The Native wallet is the only route of this rail:
/// the server evaluates the policy, and SPL Token checks the two signatures and the allowance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    Native,
}

/// The installation document of a Native wallet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalletConfig {
    pub network: String,
    #[serde(with = "hex32")]
    pub policy_instance: [u8; 32],
    /// The wallet: the owner's token account of `mint` for `agent`.
    pub wallet: String,
    pub owner: String,
    pub agent: String,
    pub server: String,
    pub route: Route,
    pub mint: String,
    pub asset_symbol: String,
    pub decimals: u8,
    pub policy_source: String,
    #[serde(with = "hex32")]
    pub source_hash: [u8; 32],
    #[serde(with = "hex32")]
    pub module_digest: [u8; 32],
    pub params: BTreeMap<String, PolicyValue>,
    /// The highest network fee of one payment, in lamports.
    pub max_fee_lamports: u64,
}

fn invalid(what: &str) -> Error {
    Error::config(format!("Invalid Solana installation: {what}"))
}

/// The SHA-256 of a policy source's exact bytes: the identity that the owner reviewed.
pub fn source_hash(source: &str) -> [u8; 32] {
    Sha256::digest(source.as_bytes()).into()
}

impl WalletConfig {
    /// The wallet of the document's roles.
    pub fn roles(&self) -> Result<Wallet> {
        let address = |text: &str, what: &str| {
            text.parse()
                .map_err(|_| invalid(&format!("{what} is not an address")))
        };
        Ok(Wallet {
            owner: address(&self.owner, "the owner")?,
            mint: address(&self.mint, "the mint")?,
            agent: address(&self.agent, "the agent")?,
            server: address(&self.server, "the server")?,
        })
    }

    /// Check the document by itself: a known network, three keys that can sign, the wallet that
    /// they derive, the token that the network lists, the source that the hash names and a fee
    /// bound within the rail's range.
    pub fn validate(&self) -> Result<Wallet> {
        let network = networks::network(&self.network)?.id;
        if network != self.network {
            return Err(invalid("the network is not a canonical id"));
        }
        let wallet = self.roles()?;
        wallet.check()?;
        if wallet.token_account().to_string() != self.wallet {
            return Err(invalid(
                "the wallet is not the token account of its owner, mint and agent",
            ));
        }
        let token = networks::tokens(network)
            .iter()
            .find(|token| token.issuer == Some(self.mint.as_str()))
            .ok_or_else(|| invalid("the network does not list the mint"))?;
        if token.code != self.asset_symbol || token.decimals != self.decimals {
            return Err(invalid("the asset is not the listed token of the mint"));
        }
        if self.policy_instance == [0; 32] || self.source_hash != source_hash(&self.policy_source) {
            return Err(invalid("the policy binding"));
        }
        if !(MIN_FEE_LAMPORTS..=MAX_EXECUTION_FEE_LAMPORTS).contains(&self.max_fee_lamports) {
            return Err(invalid("the fee bound"));
        }
        Ok(wallet)
    }

    /// Decode and check a retained document.
    pub fn decode(document: &[u8]) -> Result<Self> {
        let config: Self =
            serde_json::from_slice(document).map_err(|_| invalid("not a document of this rail"))?;
        config.validate()?;
        Ok(config)
    }
}

/// How a custody is written in a document of this rail. Only the Native wallet exists here.
pub fn custody_encoding(custody: Custody) -> Result<Value> {
    match custody {
        Custody::Owner => Ok(json!("native")),
        Custody::Policy | Custody::Retired => Err(Error::unsupported(
            "The Solana rail installs Native wallets only",
        )),
    }
}

/// How a tier is written: a Native wallet has none.
pub fn tier_encoding(tier: Option<Tier>) -> Result<Value> {
    match tier {
        None => Ok(Value::Null),
        Some(_) => Err(Error::unsupported(
            "A Native wallet of the Solana rail has no tier",
        )),
    }
}

/// The rail's fee range, in lamports.
pub fn fee_bounds() -> FeeBounds {
    FeeBounds {
        minimum: MIN_FEE_LAMPORTS,
        maximum_execution: MAX_EXECUTION_FEE_LAMPORTS,
        default_execution: fee(2, crate::packets::PAYMENT_BUDGET),
        default_deployment: DEFAULT_SETUP_LAMPORTS,
        decimals: 9,
        native_symbol: "SOL".into(),
    }
}

fn configured(config: &WalletConfig, document: Box<RawValue>) -> Result<Configuration> {
    let info = ConfigurationInfo {
        network: config.network.clone(),
        wallet: config.wallet.clone(),
        owner: config.owner.clone(),
        agent: config.agent.clone(),
        server: config.server.clone(),
        source: config.policy_source.clone(),
        source_hash: config.source_hash,
        // No on-chain part binds a source prefix: the server evaluates the whole source.
        binding_hash: [0; 32],
        rules: Vec::new(),
        is_retired: false,
        module_digest: config.module_digest,
        policy_instance: config.policy_instance,
        asset: config.mint.clone(),
        asset_symbol: config.asset_symbol.clone(),
        asset_issuer: Some(config.mint.clone()),
        max_fee_units: config.max_fee_lamports,
        is_native_asset: false,
        fee_decimals: 9,
        payment_asset_decimals: u32::from(config.decimals),
        params: config.params.clone(),
        custody: Custody::Owner,
        custody_encoding: custody_encoding(Custody::Owner)?,
        tier_encoding: Value::Null,
        tier: None,
    };
    Ok(Configuration::new(info, document))
}

/// The configuration of a retained installation document on `network`. The document's own
/// bytes are kept.
pub fn configuration(network: &str, document: &[u8]) -> Result<Configuration> {
    let config = WalletConfig::decode(document)?;
    if networks::network(network)?.id != config.network {
        return Err(Error::config(
            "Retained installation belongs to another network",
        ));
    }
    let raw = std::str::from_utf8(document)
        .ok()
        .and_then(|text| RawValue::from_string(text.into()).ok())
        .ok_or_else(|| invalid("its encoding"))?;
    configured(&config, raw)
}

/// The configuration of `config`, as its canonical document.
pub fn encode(config: &WalletConfig) -> Result<Configuration> {
    config.validate()?;
    let raw = serde_json::to_string(config)
        .ok()
        .and_then(|text| RawValue::from_string(text).ok())
        .ok_or_else(|| invalid("its encoding"))?;
    configured(config, raw)
}

/// The installation `c` with the policy that the owner approved. The wallet stays the same
/// account, so the owner, the mint and the agent stay: another agent is another wallet.
pub fn with_policy(c: &Configuration, identity: PolicyIdentity) -> Result<Configuration> {
    let mut config = WalletConfig::decode(c.bytes())?;
    if identity.asset != config.mint
        || identity.asset_symbol != config.asset_symbol
        || identity.asset_issuer.as_deref() != Some(config.mint.as_str())
    {
        return Err(Error::usage(
            "The approved policy names another asset than the wallet holds",
        ));
    }
    if identity.agent != config.agent {
        return Err(Error::usage(
            "The approved policy names another agent; a wallet belongs to one agent",
        ));
    }
    config.policy_instance = identity.policy_instance;
    config.module_digest = identity.module_digest;
    config.source_hash = source_hash(&identity.source);
    config.policy_source = identity.source;
    config.params = identity.params;
    config.server = identity.server;
    config.max_fee_lamports = identity.max_fee_units;
    // A new server key is a new delegate; the wallet's own account stays.
    encode(&config)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::networks::{DEVNET, USDC_DEVNET};
    use crate::{KEYS, KeySigner};
    use allowit_core::vendor::{KeyProvider as _, runtime::Signer as _};

    pub(crate) fn address(seed: u8) -> String {
        KeySigner(KEYS.derive(&[seed; 32]).unwrap())
            .identity()
            .to_owned()
    }
    /// A valid installation: owner 1, agent 2, server 3, Devnet USDC.
    pub(crate) fn sample() -> WalletConfig {
        let source = "pub async fn evaluate(ctx:&Context)->PolicyResult{Ok(())}";
        let mut config = WalletConfig {
            network: DEVNET.into(),
            policy_instance: [5; 32],
            wallet: String::new(),
            owner: address(1),
            agent: address(2),
            server: address(3),
            route: Route::Native,
            mint: USDC_DEVNET.into(),
            asset_symbol: "USDC".into(),
            decimals: 6,
            policy_source: source.into(),
            source_hash: source_hash(source),
            module_digest: [0; 32],
            params: BTreeMap::new(),
            max_fee_lamports: 20_000,
        };
        config.wallet = config.roles().unwrap().token_account().to_string();
        config
    }
    fn document(config: &WalletConfig) -> Vec<u8> {
        serde_json::to_vec(config).unwrap()
    }

    #[test]
    fn a_configuration_states_the_native_wallet_and_keeps_the_documents_bytes() {
        let config = sample();
        let bytes = document(&config);
        let c = configuration(DEVNET, &bytes).unwrap();
        assert_eq!(c.bytes(), bytes);
        assert_eq!(
            (c.custody, c.tier, c.is_retired, c.is_native_asset),
            (Custody::Owner, None, false, false)
        );
        assert_eq!(
            (c.fee_decimals, c.payment_asset_decimals, c.max_fee_units),
            (9, 6, 20_000)
        );
        assert_eq!(c.asset, USDC_DEVNET);
        assert_eq!(c.asset_issuer.as_deref(), Some(USDC_DEVNET));
        assert_eq!(c.custody_encoding, json!("native"));
        assert_eq!(c.wallet, config.wallet);
        assert!(c.rules.is_empty());
        assert_eq!(encode(&config).unwrap().bytes(), bytes);
        assert!(configuration("solana:devnet", &bytes).is_err());
    }

    #[test]
    fn a_document_is_refused_when_any_binding_is_off() {
        let change = |edit: &dyn Fn(&mut WalletConfig)| {
            let mut config = sample();
            edit(&mut config);
            configuration(DEVNET, &document(&config)).is_err()
        };
        // The wallet is the account that its roles derive: another agent or owner is another.
        assert!(change(&|c| c.wallet = address(9)));
        assert!(change(&|c| c.agent = address(9)));
        assert!(change(&|c| c.owner = address(9)));
        // The server takes no part in the wallet's address, but it is none of the other roles.
        assert!(!change(&|c| c.server = address(9)));
        assert!(change(&|c| c.server = c.agent.clone()));
        assert!(change(&|c| c.server = c.owner.clone()));
        assert!(change(&|c| c.network = "solana:devnet".into()));
        assert!(change(&|c| c.asset_symbol = "USDT".into()));
        assert!(change(&|c| c.decimals = 9));
        assert!(change(&|c| c.policy_source.push(' ')));
        assert!(change(&|c| c.policy_instance = [0; 32]));
        assert!(change(&|c| c.max_fee_lamports = 4_999));
        assert!(change(&|c| c.max_fee_lamports = 1_000_001));
        // A mint that the network does not list, with the wallet that it would derive.
        assert!(change(&|c| {
            c.mint = address(8);
            c.wallet = c.roles().unwrap().token_account().to_string();
        }));
        let mut extra: Value = serde_json::to_value(sample()).unwrap();
        extra["tier"] = json!("custom");
        assert!(configuration(DEVNET, &serde_json::to_vec(&extra).unwrap()).is_err());
        let mut upper: Value = serde_json::to_value(sample()).unwrap();
        upper["policyInstance"] = json!("05".repeat(31) + "0A");
        assert!(configuration(DEVNET, &serde_json::to_vec(&upper).unwrap()).is_err());
    }

    #[test]
    fn an_approved_policy_keeps_the_wallet_and_changes_what_the_owner_approved() {
        let config = sample();
        let c = encode(&config).unwrap();
        let identity = |edit: &dyn Fn(&mut PolicyIdentity)| {
            let mut identity = PolicyIdentity {
                policy_instance: [6; 32],
                module_digest: [7; 32],
                source: "pub async fn evaluate(ctx:&Context)->PolicyResult{Err(deny())}".into(),
                params: BTreeMap::new(),
                asset: USDC_DEVNET.into(),
                asset_symbol: "USDC".into(),
                asset_issuer: Some(USDC_DEVNET.into()),
                agent: address(2),
                server: address(4),
                max_fee_units: 30_000,
            };
            edit(&mut identity);
            identity
        };
        let approved = with_policy(&c, identity(&|_| {})).unwrap();
        assert_eq!(approved.wallet, config.wallet);
        assert_eq!(approved.policy_instance, [6; 32]);
        assert_eq!(approved.server, address(4));
        assert_eq!(approved.max_fee_units, 30_000);
        assert_eq!(approved.source_hash, source_hash(&approved.source));
        assert_ne!(approved.source_hash, config.source_hash);
        assert!(with_policy(&c, identity(&|i| i.agent = address(9))).is_err());
        assert!(with_policy(&c, identity(&|i| i.asset = address(8))).is_err());
        assert!(with_policy(&c, identity(&|i| i.asset_symbol = "SOL".into())).is_err());
        assert!(with_policy(&c, identity(&|i| i.server = address(2))).is_err());
        assert!(with_policy(&c, identity(&|i| i.max_fee_units = 1)).is_err());
        assert!(with_policy(&c, identity(&|i| i.policy_instance = [0; 32])).is_err());
    }

    #[test]
    fn the_rail_writes_only_the_native_custody_and_no_tier() {
        assert_eq!(custody_encoding(Custody::Owner).unwrap(), json!("native"));
        assert!(custody_encoding(Custody::Policy).is_err());
        assert!(custody_encoding(Custody::Retired).is_err());
        assert_eq!(tier_encoding(None).unwrap(), Value::Null);
        assert!(tier_encoding(Some(Tier::Standard)).is_err());
        let bounds = fee_bounds();
        assert_eq!(
            (bounds.minimum, bounds.default_execution, bounds.decimals),
            (5_000, 10_001, 9)
        );
        assert!(bounds.default_execution <= bounds.maximum_execution);
    }
}
