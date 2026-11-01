//! Operator-adopted discovery metadata. It grants no payment or execution authority.
use allowit_sdk::service::{Result, fault};
use serde_json::Value;

pub fn operator_catalog() -> Result<Value> {
    let value: Value = serde_json::from_str(include_str!("../catalog-mainnet.json"))
        .map_err(|_| fault(503, "The SDK service catalog is invalid."))?;
    if value["schema"] != "allowit-paysh-operator-registry-v1"
        || !value["providers"].is_array()
        || !value["endpoints"].is_array()
    {
        return Err(fault(503, "The SDK service catalog is invalid."));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn operator_snapshot_remains_byte_identical_and_structured() {
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("../catalog-mainnet.json"))
            ),
            "f9cf41beecbb3f7f7c1a6596dca495b2b16f086038fd8b71a1f261ec86546eba"
        );
        let catalog = operator_catalog().unwrap();
        assert!(!catalog["providers"].as_array().unwrap().is_empty());
        assert!(!catalog["endpoints"].as_array().unwrap().is_empty());
    }
}
