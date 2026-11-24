//! The agent's request proof: who asks the server, proven by the agent's key over the request.
//!
//! Core frames the proof and hashes the request into 32 bytes under the rail's domain; the rail
//! says whose key it is and checks the signature. The key signs those 32 bytes as they are. No
//! Solana transaction message is 32 bytes long (a message holds at least its header, one account
//! key and a blockhash), so a request proof is never a transaction signature.
use crate::keys;
use allowit_core::vendor::{
    error::{Error, Result},
    request_proof::Protocol,
};
use ed25519_dalek::{Signature, VerifyingKey};

/// The domain that separates a request proof of this rail from every other signed digest.
pub const REQUEST_PROOF_DOMAIN: &str = "allowit-solana-request-v1";
/// The scheme that a proof names in front of the account.
pub const REQUEST_PROOF_SCHEME: &str = "solana-proof";
/// An Ed25519 signature.
pub const REQUEST_PROOF_SIGNATURE_BYTES: usize = 64;

/// The key of an account that can sign a proof: a base58 address of a signer's public key.
fn account_key(account: &str) -> Result<[u8; 32]> {
    let key = keys::public_key(account)?;
    keys::signer_identity(&key)?;
    Ok(key)
}

/// The rail's request-proof protocol.
pub fn request_proof_protocol() -> Protocol {
    Protocol {
        domain: REQUEST_PROOF_DOMAIN,
        scheme: REQUEST_PROOF_SCHEME,
        signature_bytes: REQUEST_PROOF_SIGNATURE_BYTES,
        validate_account: |account| account_key(account).map(|_| ()),
        verify: |account, digest, signature| {
            let invalid = || Error::usage("The request proof's signature is invalid");
            VerifyingKey::from_bytes(&account_key(account)?)
                .map_err(|_| invalid())?
                .verify_strict(
                    digest,
                    &Signature::from_slice(signature).map_err(|_| invalid())?,
                )
                .map_err(|_| invalid())
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::KEYS;
    use allowit_core::vendor::{
        KeyProvider as _,
        request_proof::{authorize, verify},
    };

    fn proof(seed: u8, at: u64, path: &str, body: &[u8]) -> (String, String) {
        let key = KEYS.derive(&[seed; 32]).unwrap();
        let account = key.address().to_owned();
        let proof = authorize(
            request_proof_protocol(),
            &account,
            at,
            path,
            body,
            |digest| key.sign_hash(digest),
        )
        .unwrap();
        (account, proof)
    }
    fn bare(proof: &str) -> &str {
        proof.strip_prefix("Bearer ").unwrap_or(proof)
    }

    #[test]
    fn a_proof_names_its_signer_for_the_exact_request() {
        let (account, proof) = proof(7, 1_800_000_000, "/api/native/execute", b"{\"a\":1}");
        let verified = |at, path: &str, body: &[u8]| {
            verify(request_proof_protocol(), bare(&proof), at, path, body)
        };
        assert_eq!(
            verified(1_800_000_000, "/api/native/execute", b"{\"a\":1}").unwrap(),
            account
        );
        // Another path, another body or a far clock is another request.
        assert!(verified(1_800_000_000, "/api/native/limits", b"{\"a\":1}").is_err());
        assert!(verified(1_800_000_000, "/api/native/execute", b"{\"a\":2}").is_err());
        assert!(verified(1_800_000_000 + 3_600, "/api/native/execute", b"{\"a\":1}").is_err());
    }

    #[test]
    fn a_proof_of_another_key_or_another_rail_is_refused() {
        let (account, proof) = proof(7, 1_800_000_000, "/p", b"body");
        let (other, _) = self::proof(8, 1_800_000_000, "/p", b"body");
        let swapped = bare(&proof).replacen(&account, &other, 1);
        assert!(
            verify(
                request_proof_protocol(),
                &swapped,
                1_800_000_000,
                "/p",
                b"body"
            )
            .is_err()
        );
        let renamed = bare(&proof).replacen(REQUEST_PROOF_SCHEME, "another-proof", 1);
        assert!(
            verify(
                request_proof_protocol(),
                &renamed,
                1_800_000_000,
                "/p",
                b"body"
            )
            .is_err()
        );
        // A key that no signer holds is no account of a proof.
        let weak = bs58::encode([0u8; 32]).into_string();
        assert!((request_proof_protocol().validate_account)(&weak).is_err());
        assert!((request_proof_protocol().validate_account)("not base58!").is_err());
        (request_proof_protocol().validate_account)(&account).unwrap();
    }
}
