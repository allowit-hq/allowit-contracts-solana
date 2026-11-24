//! The server's side of the owner's steps and consent: what the owner is shown and asked to
//! sign, and the checks of what comes back.
use crate::config::{self, WalletConfig, hex32};
use crate::networks;
use crate::packets::{OwnerDoc, OwnerSignedDoc, message_hash};
use crate::payment;
use crate::runtime::{consent_message, consent_payload};
use allowit_core::vendor::{
    error::{Error, Result},
    plugin::{OwnerRuntime, OwnerStep},
    runtime::{
        OwnerPacket, Tier,
        owner::{Configuration, Custody, FeeBounds, PolicyIdentity, SourceConsent},
    },
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;

/// The rail's owner runtime.
pub static OWNER_RUNTIME: OwnerSteps = OwnerSteps;
pub struct OwnerSteps;

fn text(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes)
        .map(str::trim)
        .map_err(|_| Error::usage("An owner step travels as base64 text"))
}

impl OwnerRuntime for OwnerSteps {
    fn configuration(&self, network: &str, document: &[u8]) -> Result<Configuration> {
        config::configuration(network, document)
    }

    /// The 32-byte name of an owner step. Unsigned, `payload` is the message that the owner is
    /// asked to sign. Signed, it is the transaction, and the owner's signature (the fee payer's)
    /// must be valid over its message.
    fn envelope_hash(
        &self,
        network: &str,
        payload: &[u8],
        require_signature: bool,
    ) -> Result<[u8; 32]> {
        networks::network(network)?;
        let bad = || Error::usage("Invalid owner step payload");
        let bytes = STANDARD.decode(text(payload)?).map_err(|_| bad())?;
        if !require_signature {
            payment::account_keys(&bytes)?;
            return Ok(message_hash(&bytes));
        }
        if bytes.len() < 65 + 36 || bytes[0] != 1 {
            return Err(bad());
        }
        let message = &bytes[65..];
        let owner = *payment::account_keys(message)?.first().ok_or_else(bad)?;
        payment::verify(&owner, message, &bytes[1..65])?;
        Ok(message_hash(message))
    }

    /// `signed` is the step `original` with its owner's signature.
    fn validate_signed(&self, network: &str, original: &[u8], signed: &[u8]) -> Result<[u8; 32]> {
        let original: OwnerDoc = serde_json::from_slice(original)
            .map_err(|_| Error::usage("Invalid retained owner step"))?;
        if networks::network(network)?.id != original.network {
            return Err(Error::usage("The owner step belongs to another network"));
        }
        let hash = original.transaction_hash;
        OwnerSignedDoc {
            original,
            wire: text(signed)?.into(),
        }
        .validate()?;
        Ok(hash)
    }

    fn with_policy(&self, c: &Configuration, identity: PolicyIdentity) -> Result<Configuration> {
        config::with_policy(c, identity)
    }

    fn code_hash(&self, _: &[u8]) -> Result<[u8; 32]> {
        Err(Error::unsupported(
            "A Native wallet of the Solana rail has no code",
        ))
    }

    fn fee_bounds(&self) -> FeeBounds {
        config::fee_bounds()
    }

    /// A Native wallet's address needs its mint and its agent, which an owner and an instance do
    /// not give: the installation states the wallet.
    fn wallet_address(&self, _: &str, _: &str, _: &[u8; 32]) -> Result<String> {
        Err(Error::unsupported(
            "The Solana rail derives a wallet from its owner, mint and agent, not from an instance",
        ))
    }

    fn custody_encoding(&self, c: Custody) -> Result<Value> {
        config::custody_encoding(c)
    }

    fn tier_encoding(&self, t: Option<Tier>) -> Result<Value> {
        config::tier_encoding(t)
    }

    /// What the owner signs to approve the policy source of an installation, and the text of it.
    /// The source and its hashes are the installation's own.
    fn source_consent(&self, input: &SourceConsent<'_, Value>) -> Result<(Value, String)> {
        let config = WalletConfig::decode(input.configuration.bytes())?;
        if input.source != config.policy_source
            || input.source_hash != hex32::encode(&config.source_hash)
            || input.module_digest != hex32::encode(&config.module_digest)
        {
            return Err(Error::usage(
                "The consent names another source than the installation holds",
            ));
        }
        if input.tier != "native" && !input.tier.is_empty() {
            return Err(Error::unsupported(
                "A Native wallet of the Solana rail has no tier",
            ));
        }
        let payload = consent_payload(
            &config,
            input.policy_id,
            input.revision,
            input.ir_hash,
            input.language,
            input.rules,
            input.params,
            input.params_hash,
        );
        let message = consent_message(&payload)?;
        Ok((payload, message))
    }

    /// The step that the owner's wallet signs: the transaction message as base64 text. Its
    /// transaction has no id before the owner signs, so there is no explorer link yet.
    fn step(&self, network: &str, packet: &OwnerPacket) -> Result<OwnerStep> {
        if networks::network(network)?.id != packet.network() {
            return Err(Error::usage("The owner step belongs to another network"));
        }
        let info = packet.0.provider().owner_info(&packet.0)?;
        let payload = String::from_utf8(info.signing_payload)
            .map_err(|_| Error::config("Invalid owner step payload"))?;
        if self.envelope_hash(network, payload.as_bytes(), false)? != info.transaction_hash {
            return Err(Error::config(
                "The owner step's payload is not the step that its hash names",
            ));
        }
        Ok(OwnerStep {
            action: info.action,
            payload,
            hash: info.transaction_hash,
            expires_at: info.expires_at,
            explorer: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::tests::sample;
    use crate::native::OwnerStep as WalletStep;
    use crate::networks::DEVNET;
    use crate::packets::{owner_packet, tests::key};
    use allowit_core::vendor::runtime::Signer as _;
    use serde_json::json;
    use solana_hash::Hash;

    fn step() -> (OwnerDoc, Vec<u8>) {
        let config = sample();
        let message = config
            .roles()
            .unwrap()
            .owner_steps_tagged(
                &[WalletStep::Stop],
                "allowit:t",
                Hash::new_from_array([3; 32]),
            )
            .unwrap();
        let bytes = message.message_bytes().to_vec();
        (
            OwnerDoc {
                network: config.network,
                action: "pause".into(),
                owner: config.owner,
                message: STANDARD.encode(&bytes),
                transaction_hash: message_hash(&bytes),
                last_valid_block_height: 250,
                expires_at: 1_800_000_060,
            },
            bytes,
        )
    }
    fn wire(message: &[u8], seed: u8) -> String {
        let mut wire = vec![1u8];
        wire.extend(key(seed).sign_bytes(message).unwrap());
        wire.extend_from_slice(message);
        STANDARD.encode(wire)
    }

    #[test]
    fn the_owner_is_shown_the_message_and_only_the_owners_signature_comes_back() {
        let (doc, message) = step();
        let shown = OWNER_RUNTIME
            .step(DEVNET, &owner_packet(&doc).unwrap())
            .unwrap();
        assert_eq!(shown.payload, doc.message);
        assert_eq!(shown.hash, doc.transaction_hash);
        assert_eq!((shown.action.as_str(), shown.explorer), ("pause", None));
        assert_eq!(
            OWNER_RUNTIME
                .envelope_hash(DEVNET, shown.payload.as_bytes(), false)
                .unwrap(),
            doc.transaction_hash
        );
        let original = serde_json::to_vec(&doc).unwrap();
        let signed = wire(&message, 1);
        assert_eq!(
            OWNER_RUNTIME
                .validate_signed(DEVNET, &original, signed.as_bytes())
                .unwrap(),
            doc.transaction_hash
        );
        assert_eq!(
            OWNER_RUNTIME
                .envelope_hash(DEVNET, signed.as_bytes(), true)
                .unwrap(),
            doc.transaction_hash
        );
        // The agent's signature, an unsigned message where a signature is required, another
        // network, and text that is not base64.
        let forged = wire(&message, 2);
        assert!(
            OWNER_RUNTIME
                .validate_signed(DEVNET, &original, forged.as_bytes())
                .is_err()
        );
        assert!(
            OWNER_RUNTIME
                .envelope_hash(DEVNET, forged.as_bytes(), true)
                .is_err()
        );
        assert!(
            OWNER_RUNTIME
                .envelope_hash(DEVNET, doc.message.as_bytes(), true)
                .is_err()
        );
        assert!(
            OWNER_RUNTIME
                .validate_signed("solana:devnet", &original, signed.as_bytes())
                .is_err()
        );
        assert!(
            OWNER_RUNTIME
                .envelope_hash(DEVNET, b"not base64!", false)
                .is_err()
        );
    }

    #[test]
    fn a_consent_names_the_installations_own_source() {
        let config = sample();
        let c = config::encode(&config).unwrap();
        let (source_hash, module) = (
            hex32::encode(&config.source_hash),
            hex32::encode(&config.module_digest),
        );
        let params = json!({});
        let rules: Vec<String> = Vec::new();
        let input = |source: &'static str| SourceConsent {
            configuration: &c,
            policy_id: "policy-1",
            revision: 2,
            source,
            source_hash: &source_hash,
            ir_hash: "ir",
            module_digest: &module,
            language: "portable",
            tier: "",
            rules: &rules,
            params: &params,
            params_hash: "params",
        };
        let leaked: &'static str = Box::leak(config.policy_source.clone().into_boxed_str());
        let (payload, message) = OWNER_RUNTIME.source_consent(&input(leaked)).unwrap();
        assert_eq!(payload["wallet"], config.wallet);
        assert_eq!(payload["revision"], 2);
        assert_eq!(payload["sourceHash"], source_hash);
        assert!(message.starts_with("Allowit: I approve this policy source for my wallet.\n{"));
        assert!(message.contains(&config.wallet));
        assert!(
            OWNER_RUNTIME
                .source_consent(&input("another source"))
                .is_err()
        );
        assert!(OWNER_RUNTIME.code_hash(b"code").is_err());
        assert!(
            OWNER_RUNTIME
                .wallet_address(DEVNET, &config.owner, &[1; 32])
                .is_err()
        );
    }
}
