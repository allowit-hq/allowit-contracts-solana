# Host service packages

When an agent pays for a service through PaySH, the on-chain program only sees a signed request and moves tokens. Everything around it, from discovering a service to building the HTTP call and the payment packet, happens off-chain. These crates are that off-chain half, packaged so the Allowit SDK's service facade can use them.

## The packages

| Crate | Role |
| --- | --- |
| [`service-upstreams`](../crates/service-upstreams/src/lib.rs) | Picks the configured provider from `ALLOWIT_PAYSH_UPSTREAM` (`google-air-quality` by default, or `open-meteo`) and validates service input. |
| [`provider-google-air-quality`](../crates/provider-google-air-quality/src/lib.rs) | Air-quality lookups against Google's API. |
| [`provider-open-meteo`](../crates/provider-open-meteo/src/lib.rs) | Air-quality lookups against Open-Meteo. |
| [`paysh-catalog`](../crates/paysh-catalog/src/lib.rs) | The operator discovery catalog, shipped as a byte-pinned JSON snapshot. |
| [`delegated-x402`](../crates/delegated-x402/src/lib.rs) | Builds and checks standard x402 v2 SPL delegated-payment packets for Solana. |
| [`paysh-stock`](../crates/paysh-stock/src/lib.rs) | The stock MPP challenge, funding, packet and HTTP protocol. |
| [`paysh-cooperating`](../crates/paysh-cooperating/src/lib.rs) | Fixed-origin HTTP transport for the cooperating PaySH gateway protocol. |
| [`service-rpc`](../crates/service-rpc/src/lib.rs) | Typed Solana JSON-RPC request builders and the list of read-only methods. |

Two boundaries hold throughout:

- **No keys, no journal.** The server keeps policy admission, spending limits, operation journals, signatures and recovery decisions. These crates construct and check; they do not decide or sign.
- **Catalog entries grant nothing.** A service appearing in the catalog is discovery metadata. Execution authority comes from the owner's PaySH configuration and the evaluator's signature.

None of this code runs inside an on-chain program.

## Building and testing

Each package is a member of the root Cargo workspace and uses the root lockfile:

```sh
cargo fmt --all --check
cargo clippy --locked -p allowit-solana-service-upstreams --all-targets -- -D warnings
cargo test --locked -p allowit-solana-service-upstreams
```

The [`Host service packages`](../.github/workflows/service-packages.yml) workflow runs clippy and the tests for every package whenever one of them changes.

## Provenance and licensing

Each package declares its own license in `Cargo.toml`. The packages extracted from the Allowit engine carry `LicenseRef-Proprietary` plus a `[package.metadata.allowit-source]` block that names the engine repository, the exact revision and the source paths they came from.
