//! Agent and server keys: Ed25519, as every Solana signer. The address is the base58 public key.
//! The agent holds a key and no account: its key signs, and someone else pays every fee.
//!
//! A Solana signature covers the whole serialized transaction message, so
//! [`PrivateSigner::sign_hash`] signs the exact bytes it receives, of any length, without hashing
//! them; a 32-byte input is signed as those 32 bytes.
use allowit_core::vendor::{
    KeyProvider, PrivateSigner,
    error::{Error, Result},
};
use ed25519_dalek::{Signer as _, SigningKey, VerifyingKey};
use zeroize::Zeroizing;

/// The key type that a stored agent identity names.
pub const KEY_TYPE: &str = "ed25519";

/// The rail's key provider.
pub static KEYS: Keys = Keys;
pub struct Keys;

struct Key {
    signing: SigningKey,
    address: String,
}

impl Key {
    fn new(signing: SigningKey) -> Self {
        let address = bs58::encode(signing.verifying_key().as_bytes()).into_string();
        Self { signing, address }
    }
}

/// The base58 address of a 32-byte Ed25519 public key.
/// A small-order point decompresses but is the public key of no signer, so it is refused.
pub fn signer_identity(key: &[u8; 32]) -> Result<String> {
    let point = VerifyingKey::from_bytes(key)
        .map_err(|_| Error::usage("The key is not an Ed25519 public key"))?;
    if point.is_weak() {
        return Err(Error::usage(
            "The key is a small-order point, not a signer's public key",
        ));
    }
    Ok(bs58::encode(key).into_string())
}

fn public_key(address: &str) -> Result<[u8; 32]> {
    let bytes = bs58::decode(address)
        .into_vec()
        .map_err(|_| Error::usage("A Solana address is base58"))?;
    bytes
        .try_into()
        .map_err(|_| Error::usage("A Solana address is 32 bytes"))
}

impl KeyProvider for Keys {
    fn entropy_bytes(&self) -> usize {
        32
    }
    /// The key whose Ed25519 seed is `entropy`.
    fn derive(&self, entropy: &[u8]) -> Result<Box<dyn PrivateSigner>> {
        let seed: &[u8; 32] = entropy
            .try_into()
            .map_err(|_| Error::usage("A Solana key needs 32 bytes of entropy"))?;
        Ok(Box::new(Key::new(SigningKey::from_bytes(seed))))
    }
    /// A secret in the wallet export format: base58 of the 64 bytes seed and public key. The
    /// public half must belong to the seed.
    fn parse(&self, secret: &str) -> Result<Box<dyn PrivateSigner>> {
        // Decoded straight into a buffer that is wiped on every path, a failed decode included.
        let mut pair = Zeroizing::new([0u8; 64]);
        let len = bs58::decode(secret.trim())
            .onto(&mut pair[..])
            .map_err(|_| Error::usage("A Solana secret key is base58 of 64 bytes"))?;
        if len != 64 {
            return Err(Error::usage("A Solana secret key is 64 bytes"));
        }
        let signing = SigningKey::from_keypair_bytes(&pair)
            .map_err(|_| Error::usage("The Solana secret key does not match its public key"))?;
        Ok(Box::new(Key::new(signing)))
    }
    fn validate_identity(&self, address: &str, public_key: &str, key_type: &str) -> Result<()> {
        if key_type != KEY_TYPE {
            return Err(Error::usage(format!(
                "A Solana key is {KEY_TYPE}, not {key_type}"
            )));
        }
        if address != public_key {
            return Err(Error::usage("A Solana address is its public key"));
        }
        signer_identity(&self::public_key(address)?).map(|_| ())
    }
}

impl PrivateSigner for Key {
    fn address(&self) -> &str {
        &self.address
    }
    fn public_key(&self) -> &str {
        &self.address
    }
    fn key_type(&self) -> &str {
        KEY_TYPE
    }
    fn encoded_secret(&self) -> Zeroizing<String> {
        let pair = Zeroizing::new(self.signing.to_keypair_bytes());
        Zeroizing::new(bs58::encode(pair.as_slice()).into_string())
    }
    fn sign_hash(&self, message: &[u8]) -> Result<Vec<u8>> {
        Ok(self.signing.sign(message).to_bytes().to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier};

    fn verify(address: &str, message: &[u8], signature: &[u8]) -> bool {
        let key = VerifyingKey::from_bytes(&public_key(address).unwrap()).unwrap();
        let signature = Signature::from_slice(signature).unwrap();
        key.verify(message, &signature).is_ok()
    }

    #[test]
    fn a_derived_key_is_deterministic_and_its_address_is_the_public_key() {
        let a = KEYS.derive(&[7; 32]).unwrap();
        let b = KEYS.derive(&[7; 32]).unwrap();
        assert_eq!(a.address(), b.address());
        assert_ne!(a.address(), KEYS.derive(&[8; 32]).unwrap().address());
        assert_eq!(a.public_key(), a.address());
        assert_eq!(a.key_type(), "ed25519");
        assert_eq!(public_key(a.address()).unwrap().len(), 32);
        assert!(KEYS.derive(&[7; 31]).is_err());
        assert!(KEYS.derive(&[7; 33]).is_err());
    }

    #[test]
    fn it_signs_the_exact_bytes_of_a_whole_message() {
        let key = KEYS.derive(&[1; 32]).unwrap();
        let message: Vec<u8> = (0..=255u8).chain(0..155).collect();
        let signature = key.sign_hash(&message).unwrap();
        assert_eq!(signature.len(), 64);
        assert!(verify(key.address(), &message, &signature));
        let mut other = message.clone();
        other[0] ^= 1;
        assert!(!verify(key.address(), &other, &signature));
        let digest = [9u8; 32];
        assert!(verify(
            key.address(),
            &digest,
            &key.sign_hash(&digest).unwrap()
        ));
    }

    #[test]
    fn the_exported_secret_parses_back_to_the_same_key() {
        let key = KEYS.derive(&[3; 32]).unwrap();
        let secret = key.encoded_secret();
        assert_eq!(bs58::decode(secret.as_str()).into_vec().unwrap().len(), 64);
        let parsed = KEYS.parse(&secret).unwrap();
        assert_eq!(parsed.address(), key.address());
        assert!(KEYS.parse("not base58 0OIl").is_err());
        assert!(KEYS.parse(&bs58::encode([1u8; 32]).into_string()).is_err());
        let mut pair = bs58::decode(secret.as_str()).into_vec().unwrap();
        pair[63] ^= 1;
        assert!(KEYS.parse(&bs58::encode(&pair).into_string()).is_err());
        // A valid export with one more character, and one with an invalid character, are refused.
        assert!(KEYS.parse(&format!("{}2", secret.as_str())).is_err());
        assert!(KEYS.parse(&format!("{}0", secret.as_str())).is_err());
    }

    #[test]
    fn identities_are_checked() {
        let key = KEYS.derive(&[5; 32]).unwrap();
        KEYS.validate_identity(key.address(), key.public_key(), "ed25519")
            .unwrap();
        assert!(
            KEYS.validate_identity(key.address(), key.public_key(), "secp256k1")
                .is_err()
        );
        let other = KEYS.derive(&[6; 32]).unwrap();
        assert!(
            KEYS.validate_identity(key.address(), other.public_key(), "ed25519")
                .is_err()
        );
        assert!(KEYS.validate_identity("short", "short", "ed25519").is_err());
        // The all-zero key decompresses to a small-order point: no signer has it.
        let zero = bs58::encode([0u8; 32]).into_string();
        assert!(KEYS.validate_identity(&zero, &zero, "ed25519").is_err());
        assert!(signer_identity(&[0u8; 32]).is_err());
        let raw = public_key(key.address()).unwrap();
        assert_eq!(signer_identity(&raw).unwrap(), key.address());
    }
}
