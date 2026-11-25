//! The `price` evidence function of the Solana rail: what a share of an Allowit test vault pays
//! now. A server policy calls `allowit::price`, and `allowit price VAULT` asks the same function.
//!
//! On this rail the function prices the shares of the Devnet test vault only
//! (`programs/test-vault`): selling a share is a redeem, and the vault itself names the price.
//! The function reads the vault's state account from the finalized bank, checks that the account
//! sits at the address that its program derives for it, and computes what the program's
//! `PreviewRedeem` returns, with the program's rounding (down). The rail reads no order book and
//! no pool: any other `from` is refused, so no swap is priced here.
//!
//! Prices are units of the vault's asset for each share, in display units, scaled by [`SCALE`].
//! The observation has the shape of the vault observation of the other rails, so a host reads
//! them all the same way.
use crate::native::TOKEN_PROGRAM;
use crate::networks;
use crate::runtime::Chain;
use crate::x402::associated_token_account;
use serde_json::{Value, json};
use solana_address::Address;

/// The name under which policies call this function.
pub const FUNCTION: &str = "price";
/// Prices are scaled by 10^7, as in `AllowitPrice`.
pub const SCALE: u128 = 10_000_000;
/// The public RPC of Solana Devnet, read when the host names no RPC of its own.
pub const PUBLIC_DEVNET_RPC: &str = "https://api.devnet.solana.com";

/// The first bytes of a test vault's state: the layout's name and its version.
pub const TAG: [u8; 8] = *b"alwtvlt\x01";
/// The size of a test vault's state.
pub const STATE_LEN: usize = 148;
/// The first seed of a test vault's state; the admin and the name follow.
pub const VAULT_SEED: &[u8] = b"allowit-test-vault";
/// The first seed of a test vault's share mint; the state follows.
pub const SHARES_SEED: &[u8] = b"shares";
/// The size of an SPL Token account.
const TOKEN_ACCOUNT_LEN: usize = 165;
/// Most decimals of a price read: ten to their power fits 64 bits.
const MAX_DECIMALS: u8 = 18;

/// A price band: the expected price, scaled by [`SCALE`], and the slip in basis points.
pub type Band = Option<(u128, u32)>;

/// The state of a test vault, as `programs/test-vault` writes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TestVault {
    /// The address of the state.
    pub address: Address,
    /// The program that owns the state.
    pub program: Address,
    pub admin: Address,
    pub asset_mint: Address,
    pub share_mint: Address,
    pub asset_decimals: u8,
    pub share_decimals: u8,
    /// Asset base units for one share (ten to the share decimals in share units).
    pub share_price: u64,
}

fn key(data: &[u8], at: usize) -> Address {
    let bytes: [u8; 32] = data[at..at + 32].try_into().expect("32 bytes");
    Address::from(bytes)
}

impl TestVault {
    /// Read the state account at `address`, owned by `program`. It refuses bytes of another
    /// layout and a state that is not at the address that `program` derives from its seeds, or
    /// whose share mint is not.
    pub fn decode(address: &Address, program: &Address, data: &[u8]) -> Result<Self, String> {
        if data.len() != STATE_LEN || data[..8] != TAG {
            return Err(format!(
                "{address} is not the state of an Allowit test vault; name the state address of a deployed test vault"
            ));
        }
        let (bump, shares_bump) = (data[8], data[9]);
        let (asset_decimals, share_decimals) = (data[10], data[11]);
        let admin = key(data, 12);
        let name = &data[108..140];
        let derived = |seeds: &[&[u8]]| Address::create_program_address(seeds, program).ok();
        if derived(&[VAULT_SEED, admin.as_ref(), name, &[bump]]) != Some(*address) {
            return Err(format!(
                "{address} is not at the address that its program {program} derives for a test vault"
            ));
        }
        let share_mint = key(data, 76);
        if derived(&[SHARES_SEED, address.as_ref(), &[shares_bump]]) != Some(share_mint) {
            return Err(format!(
                "The test vault {address} names a share mint that its program {program} does not derive"
            ));
        }
        if asset_decimals > MAX_DECIMALS || share_decimals > MAX_DECIMALS {
            return Err(format!(
                "The test vault {address} names unreadable decimals"
            ));
        }
        let share_price = u64::from_le_bytes(data[140..148].try_into().expect("8 bytes"));
        if share_price == 0 {
            return Err(format!("The test vault {address} has no share price"));
        }
        Ok(Self {
            address: *address,
            program: *program,
            admin,
            asset_mint: key(data, 44),
            share_mint,
            asset_decimals,
            share_decimals,
            share_price,
        })
    }

    /// Share units in one share.
    pub fn one_share(&self) -> u64 {
        10u64.pow(self.share_decimals.into())
    }

    /// The asset base units that redeeming `shares` pays now, as the program's `PreviewRedeem`
    /// computes them: rounded down. `None` when they do not fit 64 bits.
    pub fn preview_redeem(&self, shares: u64) -> Option<u64> {
        let paid = u128::from(shares) * u128::from(self.share_price) / u128::from(self.one_share());
        u64::try_from(paid).ok()
    }

    /// What `paid` asset base units for `shares` share units are per share, in display units,
    /// scaled by [`SCALE`]; rounded down.
    pub fn display_price(&self, paid: u64, shares: u64) -> Option<u128> {
        let asset_unit = 10u128.pow(self.asset_decimals.into());
        u128::from(paid)
            .checked_mul(u128::from(self.one_share()))?
            .checked_mul(SCALE)?
            .checked_div(u128::from(shares).checked_mul(asset_unit)?)
    }
}

/// One observation of a test vault, in the shape that hosts read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    pub vault: TestVault,
    /// The asset's code when this rail lists it, such as `USDC`.
    pub asset_code: Option<&'static str>,
    /// What one share pays, in display units, scaled by [`SCALE`].
    pub price: u128,
    /// The share units that `price` and `paid` are for.
    pub shares: u64,
    /// What redeeming `shares` pays now, in asset base units.
    pub paid: u64,
    /// Whether the price is inside the host's band; true without one.
    pub inside: bool,
    /// The holder's share units and what redeeming them pays now.
    pub held: Option<(u64, u64)>,
    /// The time of the finalized block that the observation read.
    pub observed_at: u64,
}

impl Observation {
    pub fn to_json(&self) -> Value {
        let v = &self.vault;
        let mut out = json!({
            "price": self.price.to_string(),
            // The vault fills any amount at its one price.
            "depth": if self.inside { self.shares } else { 0 }.to_string(),
            "tradeAverage": "0",
            "trades": 0,
            "observedAt": self.observed_at,
            "source": format!("{} test vault state, program {}", v.address, v.program),
            "vault": {
                "asset": v.asset_mint.to_string(),
                "assetCode": self.asset_code,
                "shareDecimals": v.share_decimals,
                "shares": self.shares.to_string(),
                "paid": self.paid.to_string(),
            },
        });
        if let Some((held, value)) = self.held {
            out["vault"]["held"] = held.to_string().into();
            out["vault"]["heldValue"] = value.to_string().into();
        }
        out
    }
}

/// The code of the asset that `mint` is on `network`, when this rail lists it.
fn asset_code(network: &str, mint: &Address) -> Option<&'static str> {
    let mint = mint.to_string();
    networks::tokens(network)
        .iter()
        .find(|token| token.issuer == Some(mint.as_str()))
        .map(|token| token.code)
}

/// Observe what redeeming `shares` share units of the test vault at `vault` pays now; without
/// `shares`, one whole share. `to`, when given, must be the vault's asset, by code or by mint.
/// With `holder`, the observation adds the shares in the holder's associated token account and
/// what they pay.
pub fn observe_vault(
    chain: &dyn Chain,
    network: &str,
    vault: &Address,
    to: Option<&str>,
    shares: Option<u64>,
    band: Band,
    holder: Option<&Address>,
) -> Result<Observation, String> {
    let read = |address: &Address| {
        chain
            .account(address)
            .map_err(|e| format!("The Solana RPC gave no account {address}: {e}"))
    };
    let account = read(vault)?.ok_or_else(|| {
        format!(
            "The Solana RPC holds no account at {vault}; name the state address of a deployed test vault"
        )
    })?;
    let state = TestVault::decode(vault, &account.owner, &account.data)?;
    let code = asset_code(network, &state.asset_mint);
    if let Some(to) = to
        && to != state.asset_mint.to_string()
        && Some(to) != code
    {
        return Err(format!(
            "The test vault {vault} holds {}, not {to}",
            state.asset_mint
        ));
    }
    let shares = shares.unwrap_or(state.one_share());
    if shares == 0 {
        return Err("A price observation needs a positive amount".into());
    }
    let overflow = || "The price observation overflows".to_string();
    let paid = state.preview_redeem(shares).ok_or_else(overflow)?;
    let price = state.display_price(paid, shares).ok_or_else(overflow)?;
    let inside = match band {
        Some((expected, slip)) => {
            let slip = u128::from(slip.min(10_000));
            matches!(
                (
                    price.checked_mul(10_000),
                    expected.checked_mul(10_000 - slip),
                    expected.checked_mul(10_000 + slip),
                ),
                (Some(p), Some(floor), Some(ceiling)) if p >= floor && p <= ceiling
            )
        }
        None => true,
    };
    let held = match holder {
        Some(holder) => {
            let at = associated_token_account(holder, &state.share_mint);
            let held = match read(&at)? {
                None => 0,
                Some(account)
                    if account.owner == TOKEN_PROGRAM
                        && account.data.len() == TOKEN_ACCOUNT_LEN
                        && key(&account.data, 0) == state.share_mint
                        && key(&account.data, 32) == *holder =>
                {
                    u64::from_le_bytes(account.data[64..72].try_into().expect("8 bytes"))
                }
                Some(_) => {
                    return Err(format!(
                        "{at} is not the share account of {holder} in the test vault {vault}"
                    ));
                }
            };
            let worth = state.preview_redeem(held).ok_or_else(overflow)?;
            Some((held, worth))
        }
        None => None,
    };
    let observed_at = chain
        .bank()
        .map_err(|e| format!("The Solana RPC gave no finalized bank: {e}"))?
        .time
        .ok_or(
            "The Solana RPC gave no time for the finalized block; try again or name another RPC",
        )?;
    Ok(Observation {
        vault: state,
        asset_code: code,
        price,
        shares,
        paid,
        inside,
        held,
        observed_at,
    })
}

/// The `price` function of a server policy. `from` is the state address of a test vault;
/// `amount` (share units), `to`, `holder` and the band (`price`, `slip`) are optional. The host
/// may name its own Solana RPC as `rpc` in its facts; otherwise the public Devnet RPC is read.
pub fn price(args: &Value, facts: &Value) -> Result<Value, String> {
    let network = match (facts["network"].as_str(), args["network"].as_str()) {
        (Some(host), Some(asked)) if host != asked => {
            return Err("A price observation is for the network of its policy".into());
        }
        (Some(network), _) | (None, Some(network)) => network,
        (None, None) => return Err("A price observation needs `network`".into()),
    };
    networks::network(network).map_err(|e| e.to_string())?;
    let band = match (args["price"].as_str(), args["slip"].as_u64()) {
        (Some(price), Some(slip)) => Some((
            price
                .parse::<u128>()
                .ok()
                .filter(|price| *price > 0)
                .ok_or("A price band needs a positive decimal `price`")?,
            u32::try_from(slip)
                .ok()
                .filter(|slip| *slip <= 10_000)
                .ok_or("A price band needs `slip` in basis points")?,
        )),
        _ => None,
    };
    let shares = match args["amount"].as_str() {
        Some(text) => Some(
            text.parse()
                .map_err(|_| "A price observation needs a decimal `amount` of share units")?,
        ),
        None => None,
    };
    let from = args["from"]
        .as_str()
        .ok_or("A price observation needs `from`")?;
    if networks::tokens(network)
        .iter()
        .any(|token| token.code == from || token.issuer == Some(from))
    {
        return Err(format!(
            "The Solana rail reads no order book; it prices the shares of an Allowit test vault, not {from}"
        ));
    }
    let vault: Address = from
        .parse()
        .map_err(|_| format!("{from} is not a Solana address"))?;
    let holder: Option<Address> = match args["holder"].as_str() {
        Some(text) => Some(
            text.parse()
                .map_err(|_| format!("{text} is not a Solana address"))?,
        ),
        None => None,
    };
    let endpoint = facts["rpc"].as_str().unwrap_or(PUBLIC_DEVNET_RPC);
    let transport = allowit_core::vendor::plugin::RailPlugin::connect(
        &crate::plugin::PLUGIN,
        network,
        endpoint,
    )
    .map_err(|e| e.to_string())?;
    let observed = observe_vault(
        &crate::rpc::Rpc(transport),
        network,
        &vault,
        args["to"].as_str(),
        shares,
        band,
        holder.as_ref(),
    )?;
    Ok(observed.to_json())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::networks::{DEVNET, USDC_DEVNET};
    use crate::rpc::Rpc;
    use allowit_core::vendor::{
        error::{Error, Result},
        runtime::Transport,
    };
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::sync::Arc;

    /// The state account of a test vault, as the program wrote it in a LiteSVM run of
    /// `programs/test-vault/sbf-tests`, which checks that its run still writes these bytes.
    const RECORDED: &str = include_str!("../tests/fixtures/test_vault_state.json");

    fn recorded() -> (Address, Address, Vec<u8>) {
        let fixture: Value = serde_json::from_str(RECORDED).unwrap();
        let text = |name: &str| fixture[name].as_str().unwrap().to_string();
        (
            text("address").parse().unwrap(),
            text("owner").parse().unwrap(),
            STANDARD.decode(text("data")).unwrap(),
        )
    }

    /// A node that answers each method from a table.
    struct Node(Vec<(&'static str, Value)>);
    impl Transport for Node {
        fn call(&self, method: &str, params: Value) -> Result<Value> {
            let address = params[0].as_str().unwrap_or_default().to_string();
            self.0
                .iter()
                .find(|(name, reply)| {
                    *name == method
                        && (method != "getAccountInfo" || reply["address"] == address.as_str())
                })
                .map(|(_, reply)| reply["reply"].clone())
                .ok_or_else(|| Error::config("refused"))
        }
    }
    fn account(address: &Address, owner: &Address, data: &[u8]) -> (&'static str, Value) {
        (
            "getAccountInfo",
            json!({"address": address.to_string(), "reply": {"context":{"slot":9},"value":{
                "lamports": 1_000_000u64, "owner": owner.to_string(),
                "data": [STANDARD.encode(data), "base64"],
            }}}),
        )
    }
    fn node(mut accounts: Vec<(&'static str, Value)>) -> Rpc {
        accounts.push((
            "getEpochInfo",
            json!({"reply":{"blockHeight":100,"absoluteSlot":120}}),
        ));
        accounts.push(("getBlockTime", json!({"reply":1_800_000_000u64})));
        Rpc(Arc::new(Node(accounts)))
    }

    #[test]
    fn the_recorded_state_reads_as_the_vault_that_its_program_derives() {
        let (address, owner, data) = recorded();
        let vault = TestVault::decode(&address, &owner, &data).unwrap();
        assert_eq!(vault.asset_mint.to_string(), USDC_DEVNET);
        assert_eq!((vault.asset_decimals, vault.share_decimals), (6, 6));
        // The run set the price to 0.94 USDC a share.
        assert_eq!(vault.share_price, 940_000);
        // Another program, another address or another layout is not this vault.
        let other: Address = USDC_DEVNET.parse().unwrap();
        assert!(TestVault::decode(&address, &other, &data).is_err());
        assert!(TestVault::decode(&other, &owner, &data).is_err());
        let mut tagged = data.clone();
        tagged[7] = 2;
        assert!(TestVault::decode(&address, &owner, &tagged).is_err());
        assert!(TestVault::decode(&address, &owner, &data[1..]).is_err());
        let mut minted = data.clone();
        minted[76] ^= 1;
        assert!(TestVault::decode(&address, &owner, &minted).is_err());
    }

    #[test]
    fn a_price_read_of_recorded_bytes_is_what_preview_redeem_pays() {
        let (address, owner, data) = recorded();
        let chain = node(vec![account(&address, &owner, &data)]);
        let seen = observe_vault(&chain, DEVNET, &address, Some("USDC"), None, None, None).unwrap();
        // One share pays 0.94 USDC: 0.94 scaled by 10^7.
        assert_eq!(
            (seen.shares, seen.paid, seen.price),
            (1_000_000, 940_000, 9_400_000)
        );
        assert_eq!(seen.observed_at, 1_800_000_000);
        let out = seen.to_json();
        assert_eq!(out["price"], "9400000");
        assert_eq!(out["depth"], "1000000");
        assert_eq!(out["vault"]["asset"], USDC_DEVNET);
        assert_eq!(out["vault"]["assetCode"], "USDC");
        assert_eq!(out["vault"]["paid"], "940000");
        // An amount rounds down, as the program does: 3 share units pay 2.82, so 2.
        let seen = observe_vault(&chain, DEVNET, &address, None, Some(3), None, None).unwrap();
        assert_eq!((seen.paid, seen.price), (2, 6_666_666));
        // A band around 0.95 with 1.5% slip holds 0.94; with 1% it does not.
        let band = |slip| Some((9_500_000, slip));
        let at = |band| observe_vault(&chain, DEVNET, &address, None, None, band, None);
        assert_eq!(at(band(150)).unwrap().to_json()["depth"], "1000000");
        assert_eq!(at(band(100)).unwrap().to_json()["depth"], "0");
        // Another asset, no amount and no account are refused.
        assert!(observe_vault(&chain, DEVNET, &address, Some("SOL"), None, None, None).is_err());
        assert!(observe_vault(&chain, DEVNET, &address, None, Some(0), None, None).is_err());
        assert!(observe_vault(&chain, DEVNET, &owner, None, None, None, None).is_err());
    }

    #[test]
    fn a_holder_position_reads_its_share_account() {
        let (address, owner, data) = recorded();
        let vault = TestVault::decode(&address, &owner, &data).unwrap();
        let holder = Address::from([42; 32]);
        let at = associated_token_account(&holder, &vault.share_mint);
        let mut token = vec![0; TOKEN_ACCOUNT_LEN];
        token[..32].copy_from_slice(vault.share_mint.as_ref());
        token[32..64].copy_from_slice(holder.as_ref());
        token[64..72].copy_from_slice(&6_000_000u64.to_le_bytes());
        token[108] = 1;
        let chain = node(vec![
            account(&address, &owner, &data),
            account(&at, &TOKEN_PROGRAM, &token),
        ]);
        let seen =
            observe_vault(&chain, DEVNET, &address, None, None, None, Some(&holder)).unwrap();
        assert_eq!(seen.held, Some((6_000_000, 5_640_000)));
        assert_eq!(seen.to_json()["vault"]["heldValue"], "5640000");
        // A holder without a share account holds none.
        let chain = node(vec![
            account(&address, &owner, &data),
            (
                "getAccountInfo",
                json!({"address": at.to_string(), "reply": {"value": null}}),
            ),
        ]);
        let seen =
            observe_vault(&chain, DEVNET, &address, None, None, None, Some(&holder)).unwrap();
        assert_eq!(seen.held, Some((0, 0)));
    }

    #[test]
    fn the_function_refuses_an_order_book_and_another_network() {
        let facts = json!({"network": DEVNET});
        for from in ["USDC", USDC_DEVNET, "SOL"] {
            let error = price(&json!({"from": from}), &facts).unwrap_err();
            assert!(error.contains("reads no order book"), "{error}");
        }
        assert!(price(&json!({"from": "x"}), &facts).is_err());
        let error = price(&json!({"from": "x", "network": "solana:mainnet"}), &facts).unwrap_err();
        assert!(error.contains("network of its policy"), "{error}");
        assert!(price(&json!({"from": "x"}), &json!({"network": "solana:mainnet"})).is_err());
    }
}
