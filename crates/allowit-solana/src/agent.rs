//! The agent's side of a payment, without its transport: the request that the agent builds, and
//! the check of what the server prepared before the agent's key signs it.
//!
//! The agent trusts its own wallet profile and its own request, not the server's reply. A
//! prepared payment is signed only when it is that request from that installation: the message is
//! built again from both and compared byte for byte, so a server cannot put another recipient,
//! amount, wallet or instruction under the agent's signature.
use crate::packets::{PreparedDoc, Request};
use crate::runtime::Bundle;
use allowit_core::vendor::{
    error::{Error, Result},
    runtime::{Signature, Signer},
    typed_request::operation_nonce,
};

/// The agent's request under `request_id`: a transfer of `units` to the token account
/// `recipient` from the wallet of `profile`. The operation id is the one that the server derives
/// from the same policy and request ids.
pub fn request(profile: &Bundle, request_id: &str, recipient: &str, units: u64) -> Result<Request> {
    profile.validate()?;
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(Error::usage("A request id has 1 to 128 characters"));
    }
    if units == 0 {
        return Err(Error::usage("A payment moves a positive amount"));
    }
    let wallet = profile.config.roles()?;
    let request = Request {
        policy_instance: profile.config.policy_instance,
        nonce: operation_nonce(&profile.policy_id, request_id),
        recipient: recipient.into(),
        units,
    };
    // A request that cannot become a payment of this wallet is refused before it leaves.
    crate::packets::payment_message(
        &wallet,
        &profile.config,
        &request,
        solana_hash::Hash::default(),
    )?;
    Ok(request)
}

/// Check the server's `prepared` document against the agent's own `profile` and `request`, at
/// the agent's clock `now`. Returns the document and the message bytes to sign.
pub fn check_prepared(
    profile: &Bundle,
    request: &Request,
    prepared: &[u8],
    now: u64,
) -> Result<(PreparedDoc, Vec<u8>)> {
    profile.validate()?;
    let doc: PreparedDoc = serde_json::from_slice(prepared)
        .map_err(|_| Error::usage("The server's reply is not a prepared Solana payment"))?;
    let (_, message) = doc.validate()?;
    if doc.config != profile.config {
        return Err(Error::usage(
            "The server prepared a payment of another installation than the agent's wallet profile",
        ));
    }
    if doc.request != *request {
        return Err(Error::usage(
            "The server prepared another payment than the agent asked for",
        ));
    }
    if now >= doc.expires_at {
        return Err(Error::usage("The prepared payment expired"));
    }
    Ok((doc, message))
}

/// The agent's detached signature of a prepared payment that passed [`check_prepared`].
pub fn sign(
    profile: &Bundle,
    request: &Request,
    prepared: &[u8],
    agent: &dyn Signer,
    now: u64,
) -> Result<Signature> {
    let (doc, message) = check_prepared(profile, request, prepared, now)?;
    // The agent keeps the rule on its own clock too: a server that ignored it gets no signature.
    crate::runtime::day_end(now)?;
    if agent.identity() != doc.config.agent {
        return Err(Error::usage("Only the wallet's agent signs its payments"));
    }
    let bytes = agent.sign_bytes(&message)?;
    crate::payment::verify(&doc.config.roles()?.agent, &message, &bytes)?;
    Ok(Signature {
        identity: agent.identity().into(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packets::{message_hash, payment_message, request_hash, tests::key};
    use crate::plugin::PLUGIN;
    use allowit_core::vendor::plugin::RailPlugin as _;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use solana_hash::Hash;

    fn profile() -> Bundle {
        serde_json::from_slice(&(PLUGIN.test_support().fixtures)().public_profile).unwrap()
    }
    fn recipient() -> String {
        solana_address::Address::new_from_array([8; 32]).to_string()
    }
    /// What an honest server prepares for `request` from `profile`.
    fn prepared(profile: &Bundle, request: &Request) -> PreparedDoc {
        let message = payment_message(
            &profile.config.roles().unwrap(),
            &profile.config,
            request,
            Hash::new_from_array([3; 32]),
        )
        .unwrap();
        PreparedDoc {
            version: 1,
            config: profile.config.clone(),
            request: request.clone(),
            request_hash: request_hash(request).unwrap(),
            message: STANDARD.encode(message.message_bytes()),
            transaction_hash: message_hash(message.message_bytes()),
            last_valid_block_height: 250,
            observed_height: 100,
            created_at: 1_800_000_000,
            expires_at: 1_800_000_060,
        }
    }
    fn bytes(doc: &PreparedDoc) -> Vec<u8> {
        serde_json::to_vec(doc).unwrap()
    }

    #[test]
    fn the_agent_signs_what_it_asked_for_from_its_own_wallet() {
        let profile = profile();
        let asked = request(&profile, "r1", &recipient(), 2_000_000).unwrap();
        assert_eq!(asked.nonce, operation_nonce("fixture-policy", "r1"));
        assert_ne!(
            asked.nonce,
            request(&profile, "r2", &recipient(), 2_000_000)
                .unwrap()
                .nonce
        );
        let doc = prepared(&profile, &asked);
        let signature = sign(&profile, &asked, &bytes(&doc), &key(2), 1_800_000_000).unwrap();
        assert_eq!(signature.identity, profile.config.agent);
        assert_eq!(signature.bytes.len(), 64);
        // The owner's or the server's key is not the agent, and a late reply is not signed.
        assert!(sign(&profile, &asked, &bytes(&doc), &key(3), 1_800_000_000).is_err());
        assert!(sign(&profile, &asked, &bytes(&doc), &key(2), 1_800_000_060).is_err());
        assert!(request(&profile, "", &recipient(), 1).is_err());
        assert!(request(&profile, "r1", &recipient(), 0).is_err());
        assert!(request(&profile, "r1", "not an address", 1).is_err());
        assert!(request(&profile, "r1", &profile.config.wallet, 1).is_err());
    }

    #[test]
    fn a_server_cannot_put_another_payment_under_the_agents_signature() {
        let profile = profile();
        let asked = request(&profile, "r1", &recipient(), 2_000_000).unwrap();
        let refused = |doc: &PreparedDoc| {
            sign(&profile, &asked, &bytes(doc), &key(2), 1_800_000_000).is_err()
        };
        // A consistent payment of another amount, recipient or operation.
        for other in [
            Request {
                units: 2_000_001,
                ..asked.clone()
            },
            Request {
                recipient: solana_address::Address::new_from_array([7; 32]).to_string(),
                ..asked.clone()
            },
            Request {
                nonce: [9; 32],
                ..asked.clone()
            },
        ] {
            assert!(refused(&prepared(&profile, &other)));
        }
        // The asked request with the message of another payment under it.
        let mut swapped = prepared(&profile, &asked);
        let other = prepared(
            &profile,
            &Request {
                units: 9_000_000,
                ..asked.clone()
            },
        );
        swapped.message = other.message;
        swapped.transaction_hash = other.transaction_hash;
        assert!(refused(&swapped));
        // A consistent payment of another installation: another server key in the document.
        let mut foreign = profile.clone();
        foreign.config.server = key(9).identity().to_owned();
        assert!(refused(&prepared(&foreign, &asked)));
        assert!(
            sign(&profile, &asked, b"{}", &key(2), 1_800_000_000).is_err(),
            "not a prepared payment"
        );
    }
}
