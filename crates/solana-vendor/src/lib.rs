//! Solana host adapters for the Allowit SDK client facade.
//!
//! This crate does not run on chain. Contract programs and their interfaces
//! remain separate workspace members.

pub use allowit_sdk::client::{config, error, output};

pub mod paysh;

// Preserve the transport version during extraction from the CLI package.
const VERSION: &str = "0.3.0-dev";

fn flush_stderr(stderr: &mut String) {
    use std::io::Write;

    let text = redact(std::mem::take(stderr));
    let _ = std::io::stderr().write_all(text.as_bytes());
}

/// Remove both credentials from text before the host displays it.
pub fn redact(text: String) -> String {
    output::clean(
        output::clean(text, &config::env_value("ALLOWIT_TOKEN")),
        &config::env_value(paysh::TOKEN_ENV),
    )
}
