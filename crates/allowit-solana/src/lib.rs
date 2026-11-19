//! The Solana rail of Allowit. This crate grows into the rail plugin that the SDK registers
//! (`RailPlugin`). This first part holds what every other part reads: the networks, their tokens
//! and units, explorer links, deadlines, and the agent and server keys.
//!
//! Solana Devnet is the only network until Mainnet; Solana Testnet is not served.
pub mod keys;
pub mod networks;

pub use keys::{KEY_TYPE, KEYS, signer_identity};
pub use networks::{
    DEVNET, FAMILY, ID, NETWORKS, USDC_DEVNET, deadlines, explorer, native_display, network, tokens,
};
