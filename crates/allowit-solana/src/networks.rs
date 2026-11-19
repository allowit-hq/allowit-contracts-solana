//! Networks, tokens, units, explorer links and deadlines.
use allowit_core::vendor::{
    error::{Error, Result},
    input::asset::{AssetDisplay, Token},
    plugin::{Deadlines, LinkKind},
    routing::{Family, RailInfo},
};

/// The rail id: store namespaces, element tags and the policy-function namespace.
pub const ID: &str = "solana";
pub const FAMILY: Family = Family(ID);

/// Solana Devnet by its CAIP-2 id: the first 32 characters of its genesis hash. x402 offers carry
/// this id. The rail accepts no other spelling.
pub const DEVNET: &str = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/// Circle's USDC mint on Solana Devnet, 6 decimals.
pub const USDC_DEVNET: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/// The networks that this rail serves. Mainnet joins after the Devnet acceptance.
pub static NETWORKS: &[RailInfo] = &[RailInfo {
    id: DEVNET,
    label: "Solana Devnet",
    aliases: &[],
    family: FAMILY,
    testnet: true,
}];

static DEVNET_TOKENS: &[Token] = &[
    Token {
        code: "USDC",
        decimals: 6,
        native: false,
        issuer: Some(USDC_DEVNET),
    },
    Token {
        code: "SOL",
        decimals: 9,
        native: true,
        issuer: None,
    },
];

/// The network of `id`. Every other id, an alias included, is refused.
pub fn network(id: &str) -> Result<&'static RailInfo> {
    NETWORKS
        .iter()
        .find(|n| n.id == id)
        .ok_or_else(|| Error::usage(format!("unknown Solana network {id}")))
}

/// The tokens that the rail knows by code on `network`; none on an unknown network.
pub fn tokens(network: &str) -> &'static [Token] {
    match self::network(network) {
        Ok(_) => DEVNET_TOKENS,
        Err(_) => &[],
    }
}

/// SOL: 9 decimals. Fees and deposits are in its base unit, the lamport.
pub fn native_display() -> AssetDisplay {
    AssetDisplay {
        symbol: "SOL".into(),
        decimals: 9,
        name: "Solana".into(),
        native: true,
    }
}

/// The Solana Explorer link of an address, a program or a transaction signature on `network`.
/// `None` for an unknown network, or an id that is not base58 of the kind's length.
pub fn explorer(network: &str, kind: LinkKind, id: &str) -> Option<String> {
    let cluster = match self::network(network).ok()?.id {
        DEVNET => "devnet",
        _ => return None,
    };
    // An address or a program is 32 bytes (at most 44 base58 characters), a transaction signature
    // 64 (at most 88). Longer input is refused before it is decoded.
    let (path, len, chars) = match kind {
        LinkKind::Address | LinkKind::Contract => ("address", 32, 44),
        LinkKind::Transaction => ("tx", 64, 88),
    };
    if id.len() > chars || bs58::decode(id).into_vec().ok()?.len() != len {
        return None;
    }
    Some(format!(
        "https://explorer.solana.com/{path}/{id}?cluster={cluster}"
    ))
}

/// A transaction lapses when its recent blockhash expires: after 150 slots, about 60 seconds at
/// 400 ms a slot. An agent request and an owner step are signed against one blockhash, so both
/// are valid for at most that long; a lapsed owner step is prepared again.
pub fn deadlines(_network: &str) -> Deadlines {
    Deadlines {
        max_validity_secs: 60,
        owner_step_ttl_secs: 60,
        block_time_secs: 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devnet_is_the_only_network_and_has_no_alias() {
        assert_eq!(network(DEVNET).unwrap().label, "Solana Devnet");
        assert!(network(DEVNET).unwrap().testnet);
        for other in [
            "solana:devnet",
            "solana:testnet",
            "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
            "other:testnet",
            "",
        ] {
            assert!(network(other).is_err(), "{other}");
            assert!(tokens(other).is_empty(), "{other}");
        }
    }

    #[test]
    fn tokens_name_usdc_and_sol_with_their_units() {
        let tokens = tokens(DEVNET);
        let usdc = tokens.iter().find(|t| t.code == "USDC").unwrap();
        assert_eq!(
            (usdc.decimals, usdc.native, usdc.issuer),
            (6, false, Some(USDC_DEVNET))
        );
        let sol = tokens.iter().find(|t| t.code == "SOL").unwrap();
        assert_eq!((sol.decimals, sol.native, sol.issuer), (9, true, None));
        assert_eq!(native_display().decimals, 9);
        assert_eq!(bs58::decode(USDC_DEVNET).into_vec().unwrap().len(), 32);
    }

    #[test]
    fn explorer_links_name_each_kind_on_devnet_only() {
        let address = "9nZKgB5L7Gnhuu78yGifL4HA1Zc9rZdiNkpwQDMwuA11";
        assert_eq!(
            explorer(DEVNET, LinkKind::Address, address).unwrap(),
            format!("https://explorer.solana.com/address/{address}?cluster=devnet")
        );
        assert_eq!(
            explorer(DEVNET, LinkKind::Contract, address).unwrap(),
            format!("https://explorer.solana.com/address/{address}?cluster=devnet")
        );
        let signature = "5j3ocYm83XapXBs594S8nh2z9HLhU6gmqneXFKzfRu4KbJ7fE7GtXCtm3nMdbe3TCBvHeJ1xt1hmQBufrsUwYnW9";
        assert_eq!(
            explorer(DEVNET, LinkKind::Transaction, signature).unwrap(),
            format!("https://explorer.solana.com/tx/{signature}?cluster=devnet")
        );
        assert_eq!(explorer("solana:testnet", LinkKind::Address, address), None);
        assert_eq!(explorer(DEVNET, LinkKind::Address, "not/base58?x=1"), None);
        assert_eq!(explorer(DEVNET, LinkKind::Address, ""), None);
        assert_eq!(explorer(DEVNET, LinkKind::Transaction, "1"), None);
        assert_eq!(explorer(DEVNET, LinkKind::Transaction, address), None);
        assert_eq!(explorer(DEVNET, LinkKind::Address, signature), None);
        assert_eq!(
            explorer(DEVNET, LinkKind::Address, &"2".repeat(10_000)),
            None
        );
    }

    #[test]
    fn deadlines_fit_one_blockhash() {
        let d = deadlines(DEVNET);
        assert!(d.max_validity_secs <= 60 && d.owner_step_ttl_secs <= 60);
        assert_eq!(d.block_time_secs, 1);
    }
}
