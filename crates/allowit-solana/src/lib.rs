//! The Solana rail of Allowit. This crate grows into the rail plugin that the SDK registers
//! (`RailPlugin`). It holds what every part reads: the networks, their tokens and units, explorer
//! links, deadlines, the agent and server keys, and the Native wallet's transactions. On top of
//! them: the owner's transactions and the server-paid payment, each retained before it is sent
//! and resolved by the ledger ([`owner`], [`payment`]); the RPC ledger and the journal ([`rpc`]);
//! the server hooks ([`server`]) and the agent's request proof ([`proof`]). The plugin itself is
//! [`plugin::PLUGIN`]: the installation document ([`config`]), the retained packets
//! ([`packets`]), the runtime of a Native wallet ([`runtime`]), the owner runtime
//! ([`owner_runtime`]) and the agent's check of a prepared payment ([`agent`]). The client's
//! transport to a backend is not in this revision.
//!
//! Solana Devnet is the only network until Mainnet; Solana Testnet is not served.
pub mod activation;
pub mod agent;
pub mod client;
pub mod config;
pub mod facilitator;
pub mod generation;
pub mod keys;
pub mod native;
pub mod networks;
pub mod owner;
pub mod owner_client;
pub mod owner_runtime;
pub mod packets;
pub mod payment;
pub mod paysh;
pub mod plugin;
pub mod proof;
pub mod rpc;
pub mod runtime;
pub mod server;
pub mod x402;

pub use keys::{KEY_TYPE, KEYS, KeySigner, signer_identity};
pub use networks::{
    DEVNET, FAMILY, ID, NETWORKS, USDC_DEVNET, deadlines, explorer, native_display, network, tokens,
};
pub use plugin::PLUGIN;
