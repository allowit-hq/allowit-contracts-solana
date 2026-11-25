//! Server hooks: what the engine asks the rail without reading its configuration. The wallet
//! profiles that a server offers, the check of a network's configuration block, the wallet
//! sign-in signature and the price of a network fee in a wallet's asset.
use crate::{keys, networks};
use allowit_core::vendor::{
    error::{Error, Result},
    plugin::{ProfileInfo, ServerHooks},
    runtime::{ReceiptInfo, owner::Custody},
};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;

/// The wallet profiles a server offers. The Native wallet is the only kind until a contract
/// wallet joins: the owner's token account, with the agent and the server as its delegate.
pub static PROFILES: &[ProfileInfo] = &[ProfileInfo {
    id: "allowit-native-v1",
    custody: Custody::Owner,
    tier: None,
    label: "Native delegated token account",
}];

/// The rail's server hooks.
pub static HOOKS: Hooks = Hooks;
pub struct Hooks;

/// Keys of a network block in the server rail configuration.
const CONFIG_KEYS: &[&str] = &["rpc", "recoveryRpcs", "gasRates", "asset"];

/// Lamports in one SOL, and the scale of a rate: 9 decimals, as SOL has.
const LAMPORTS_PER_SOL: u128 = 1_000_000_000;

/// The code of a fee or a price that its type cannot hold.
pub const AMOUNT_OUT_OF_RANGE: &str = "amount_out_of_range";

impl ServerHooks for Hooks {
    /// A network block is an object with optional keys: `rpc` (an HTTPS URL), `recoveryRpcs`
    /// (HTTPS URLs), `gasRates` (token code or mint to its price: how many of the token one
    /// SOL costs, as a decimal such as "150.25") and `asset` (the installed asset's mint, set by the engine per receipt).
    fn configure(&self, network: &str, config: &Value) -> Result<()> {
        networks::network(network)?;
        let bad = |what: &str| Error::config(format!("Invalid Solana rail configuration: {what}"));
        let object = config.as_object().ok_or_else(|| bad("not an object"))?;
        if let Some(key) = object.keys().find(|k| !CONFIG_KEYS.contains(&k.as_str())) {
            return Err(bad(&format!("unknown key {key}")));
        }
        let url = |v: &Value| v.as_str().is_some_and(|s| s.starts_with("https://"));
        if object.get("rpc").is_some_and(|v| !url(v)) {
            return Err(bad("rpc must be an HTTPS URL"));
        }
        if object
            .get("recoveryRpcs")
            .is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().all(url)))
        {
            return Err(bad("recoveryRpcs must be HTTPS URLs"));
        }
        if let Some(rates) = object.get("gasRates") {
            let rates = rates.as_object().ok_or_else(|| bad("gasRates"))?;
            if rates.values().any(|v| v.as_str().and_then(rate).is_none()) {
                return Err(bad("gasRates values must be positive decimal strings"));
            }
        }
        if object.get("asset").is_some_and(|v| !v.is_string()) {
            return Err(bad("asset must be a mint address"));
        }
        Ok(())
    }

    fn profiles(&self) -> &'static [ProfileInfo] {
        PROFILES
    }

    /// An Ed25519 signature of the account's key over the exact bytes of the sign-in message:
    /// what a Solana wallet's `signMessage` returns. The key is one that a signer can hold, and
    /// the signature is verified strictly, so one signature has one message and one key.
    fn verify_sign_in(
        &self,
        network: &str,
        address: &str,
        message: &[u8],
        signature: &[u8],
    ) -> Result<()> {
        networks::network(network)?;
        let invalid = || Error::usage("The wallet sign-in signature is invalid");
        let key = keys::public_key(address)?;
        keys::signer_identity(&key)?;
        let signature = Signature::from_slice(signature).map_err(|_| invalid())?;
        VerifyingKey::from_bytes(&key)
            .map_err(|_| invalid())?
            .verify_strict(message, &signature)
            .map_err(|_| invalid())
    }

    /// The fee in lamports that the receipt reports, in units of the installed asset
    /// `config["asset"]`, rounded up: the same price as [`ServerHooks::price_fee`].
    fn charged_fee(&self, network: &str, config: &Value, receipt: &ReceiptInfo) -> Result<i128> {
        let asset = config
            .get("asset")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::config("The fee needs the installed asset"))?;
        self.price_fee(network, config, asset, receipt.fee.native_units)
    }

    /// The price of `native_units` lamports in base units of the wallet's asset `asset` (its
    /// mint), rounded up, at the rate of `asset_rate`. SOL itself is priced one to one. An
    /// asset without a rate is refused: a fee in another asset counts against a limit only at a
    /// configured rate.
    fn price_fee(
        &self,
        network: &str,
        config: &Value,
        asset: &str,
        native_units: u128,
    ) -> Result<i128> {
        let out_of_range =
            || Error::coded(AMOUNT_OUT_OF_RANGE, "The price of the fee is out of range");
        let price = match asset_rate(network, config, asset)? {
            None => native_units,
            // units = ceil(lamports * rate / 10^9), where `rate` carries 9 decimals.
            // base units = ceil(lamports / 10^9 * rate * 10^decimals), where `rate` carries 9
            // decimals: one division at the end, so nothing is rounded before it.
            Some((rate, decimals)) => native_units
                .checked_mul(rate)
                .and_then(|scaled| scaled.checked_mul(10u128.pow(u32::from(decimals))))
                .and_then(|scaled| scaled.checked_add(LAMPORTS_PER_SOL * LAMPORTS_PER_SOL - 1))
                .map(|scaled| scaled / (LAMPORTS_PER_SOL * LAMPORTS_PER_SOL))
                .ok_or_else(out_of_range)?,
        };
        i128::try_from(price).map_err(|_| out_of_range())
    }
}

/// The price of SOL in the wallet's asset `asset` from `config`, scaled by 10^9, with the asset's
/// decimals: the rate under the asset's mint, else the rate under its code. `None` for SOL, the
/// network's own asset, one to one. The asset is a token that the network lists: an amount of
/// another token has no known unit.
fn asset_rate(network: &str, config: &Value, asset: &str) -> Result<Option<(u128, u8)>> {
    let network = networks::network(network)?.id;
    let tokens = networks::tokens(network);
    let listed = tokens
        .iter()
        .find(|token| token.issuer == Some(asset) || (token.native && token.code == asset));
    if listed.is_some_and(|token| token.native) {
        return Ok(None);
    }
    let Some(token) = listed else {
        return Err(Error::config(
            "The Solana rail prices a fee only in a token that its network lists",
        ));
    };
    let rates = config.get("gasRates").and_then(Value::as_object);
    let found = rates.and_then(|rates| rates.get(asset).or_else(|| rates.get(token.code)));
    found
        .and_then(Value::as_str)
        .and_then(rate)
        .map(|rate| Some((rate, token.decimals)))
        .ok_or_else(|| {
            Error::config(
                "The Solana rail configuration has no gasRates entry for the wallet's asset",
            )
        })
}

/// A positive decimal with at most 9 fraction digits, scaled by 10^9.
fn rate(text: &str) -> Option<u128> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    if whole.is_empty()
        || whole.len() > 20
        || fraction.len() > 9
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let value = format!("{whole}{fraction:0<9}").parse::<u128>().ok()?;
    (value > 0).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::networks::{DEVNET, USDC_DEVNET};
    use allowit_core::vendor::{
        kinds::WalletKind,
        runtime::{Fee, Status},
    };
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    #[test]
    fn the_server_offers_the_native_wallet_only() {
        let kinds: Vec<_> = HOOKS
            .profiles()
            .iter()
            .map(ProfileInfo::wallet_kind)
            .collect();
        assert_eq!(kinds, [Some(WalletKind::Native)]);
    }

    #[test]
    fn a_network_block_is_checked_key_by_key() {
        let good = json!({"rpc":"https://rpc.example","recoveryRpcs":["https://other.example"],
            "gasRates":{"USDC":"150.5"},"asset":USDC_DEVNET});
        HOOKS.configure(DEVNET, &good).unwrap();
        HOOKS.configure(DEVNET, &json!({})).unwrap();
        assert!(HOOKS.configure("solana:devnet", &good).is_err());
        for bad in [
            json!([]),
            json!({"other":1}),
            json!({"rpc":"http://rpc.example"}),
            json!({"recoveryRpcs":"https://rpc.example"}),
            json!({"recoveryRpcs":["http://rpc.example"]}),
            json!({"gasRates":[]}),
            json!({"gasRates":{"USDC":150}}),
            json!({"gasRates":{"USDC":"0"}}),
            json!({"gasRates":{"USDC":"-1"}}),
            json!({"gasRates":{"USDC":"1.0000000001"}}),
            json!({"gasRates":{"USDC":"1e3"}}),
            json!({"asset":1}),
        ] {
            assert!(HOOKS.configure(DEVNET, &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_sign_in_is_the_wallets_signature_of_the_exact_message() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let address = bs58::encode(key.verifying_key().as_bytes()).into_string();
        let message = b"allowit.example wants you to sign in\nnonce: 1";
        let signature = key.sign(message).to_bytes();
        HOOKS
            .verify_sign_in(DEVNET, &address, message, &signature)
            .unwrap();
        let other =
            bs58::encode(SigningKey::from_bytes(&[8; 32]).verifying_key().as_bytes()).into_string();
        let mut flipped = signature;
        flipped[0] ^= 1;
        assert!(
            HOOKS
                .verify_sign_in(DEVNET, &address, b"another message", &signature)
                .is_err()
        );
        assert!(
            HOOKS
                .verify_sign_in(DEVNET, &other, message, &signature)
                .is_err()
        );
        assert!(
            HOOKS
                .verify_sign_in(DEVNET, &address, message, &flipped)
                .is_err()
        );
        assert!(
            HOOKS
                .verify_sign_in(DEVNET, &address, message, &signature[..63])
                .is_err()
        );
        assert!(
            HOOKS
                .verify_sign_in("solana:devnet", &address, message, &signature)
                .is_err()
        );
        // A small-order point is no signer's key, whatever signature comes with it.
        let weak = bs58::encode([0u8; 32]).into_string();
        assert!(
            HOOKS
                .verify_sign_in(DEVNET, &weak, message, &[0u8; 64])
                .is_err()
        );
    }

    #[test]
    fn a_fee_is_priced_in_the_wallets_asset_and_rounded_up() {
        // One SOL costs 150 USDC.
        let config = json!({"gasRates":{"USDC":"150"},"asset":USDC_DEVNET});
        let price = |lamports| HOOKS.price_fee(DEVNET, &config, USDC_DEVNET, lamports);
        // 5,000 lamports are 0.00075 USDC: 750 base units.
        assert_eq!(price(5_000).unwrap(), 750);
        // 10,001 lamports are 1500.15 base units, rounded up.
        assert_eq!(price(10_001).unwrap(), 1_501);
        assert_eq!(price(1).unwrap(), 1);
        assert_eq!(price(0).unwrap(), 0);
        assert_eq!(
            price(u128::MAX).unwrap_err().api_code.as_deref(),
            Some(AMOUNT_OUT_OF_RANGE)
        );
        // The rate under the mint is read before the rate under the code.
        let by_mint = json!({"gasRates":{"USDC":"1",USDC_DEVNET:"200.5"}});
        assert_eq!(
            HOOKS
                .price_fee(DEVNET, &by_mint, USDC_DEVNET, 1_000_000_000)
                .unwrap(),
            200_500_000
        );
        // SOL is its own price; an asset without a rate has none.
        assert_eq!(
            HOOKS.price_fee(DEVNET, &json!({}), "SOL", 5_000).unwrap(),
            5_000
        );
        assert!(
            HOOKS
                .price_fee(DEVNET, &json!({}), USDC_DEVNET, 5_000)
                .is_err()
        );
        assert!(HOOKS.price_fee(DEVNET, &config, "other", 5_000).is_err());
    }

    #[test]
    fn a_receipts_fee_is_charged_at_the_same_price() {
        let config = json!({"gasRates":{"USDC":"150"},"asset":USDC_DEVNET});
        let receipt = ReceiptInfo {
            transaction_hash: [1; 32],
            status: Status::Confirmed,
            observed_height: 10,
            fee: Fee {
                native_units: 10_001,
                ..Fee::default()
            },
            debits: Vec::new(),
            settlement_hash: None,
        };
        assert_eq!(HOOKS.charged_fee(DEVNET, &config, &receipt).unwrap(), 1_501);
        assert!(
            HOOKS
                .charged_fee(DEVNET, &json!({"gasRates":{"USDC":"1"}}), &receipt)
                .is_err()
        );
    }
}
