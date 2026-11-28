# Allowit on Solana

This repository is the Solana rail of [Allowit](https://allowit.xyz): the programs and the rail library that put an
agent's stablecoin payments on Solana under its owner's policy.

It holds the rail for Native wallets on Solana Devnet (plan task T9 of TASK-1066, with the npm half of T7):

- [`crates/allowit-solana`](crates/allowit-solana): the rail crate. Networks, tokens, keys, the Native wallet's
  transactions, the server's runtime and hooks, the agent's and the owner's clients, and the request proof. It
  depends on allowit-core only.
- [`npm/solana`](npm/solana): `@allowit/solana`, the browser side of the rail: its elements, Wallet Standard signing
  and the hooks of the owner workflows. Its [README](npm/solana/README.md) describes it.

A Native wallet is the owner's own SPL token account of one mint for one agent. Its delegate is an SPL Token
multisig of the agent and the server, two of two. No Allowit program runs. Simple, Standard and Custom wallets
run the vault program [`programs/vault`](programs/vault) (ABI 3), described with its build and its Devnet
deployment in [`docs/vault-abi3.md`](docs/vault-abi3.md); [`sbf-tests`](sbf-tests) tests it with Mollusk.

The earlier implementation is in the Git history, last at commit
[`fd44e94`](https://github.com/allowit-hq/allowit-contracts-solana/tree/fd44e94379560ef242e2d214c0d9832d41ec02cd):
the vault program (ABI 2) and its policy helper, the PaySH and mandate programs, the host crates, the native SDK
and the verification set. That code is not maintained.

## The facilitator on Devnet, for tests

The crate's settlement service is the Allowit facilitator for x402 `exact` payments on Solana Devnet (plan task T12).
Until the engine serves Solana, the example [`devnet_facilitator`](crates/allowit-solana/examples/devnet_facilitator.rs)
hosts it for Devnet tests: `GET /facilitator/supported`, `POST /facilitator/verify` and `POST /facilitator/settle` (also
under `/api/`), with the engine's paths and reply shapes, no authentication and a request rate per minute (HTTP 429,
code `facilitator_rate_limited`). It listens on 127.0.0.1 and refuses to start unless the RPC's genesis is Devnet's.

```sh
ALLOWIT_FACILITATOR_SOLANA_KEYPAIR=/path/to/fee-payer.json ALLOWIT_FACILITATOR_PORT=4402 cargo run -p allowit-solana --example devnet_facilitator
```

- `ALLOWIT_FACILITATOR_SOLANA_KEYPAIR` (required): a Solana CLI keypair file of the fee payer, kept outside any
  repository. The host never prints it. The fee payer needs Devnet SOL for the network fees of real settlements.
- `ALLOWIT_FACILITATOR_SOLANA_RPC`: the RPC endpoint, by default `https://api.devnet.solana.com`.
- `ALLOWIT_FACILITATOR_PORT` (4402), `ALLOWIT_FACILITATOR_REQUESTS_PER_MINUTE` (120),
  `ALLOWIT_FACILITATOR_MAX_FEE_UNITS` (50000 lamports) and `ALLOWIT_FACILITATOR_HOURLY_FEE_UNITS` (5000000 lamports).

A seller takes `http://127.0.0.1:4402/facilitator` as its facilitator URL; `/supported` names the network
`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, scheme `exact`, x402 version 2 and the fee payer in `extra.feePayer`.

## Part of Allowit

A rail owns its native programs, signing and chain semantics. It depends on Core and on no other Allowit
repository. The SDK registers each rail. The server, the CLI and the app reach a rail only through the SDK.

- [allowit.xyz](https://allowit.xyz): what Allowit is and how owners use it.
- [allowit-core](https://github.com/allowit-hq/allowit-core): common types, policy rules, primitives and TypeScript interfaces.
- [allowit-sdk](https://github.com/allowit-hq/allowit-sdk): CLI developer workflows, client validation and shared SDK engine logic.
- [allowit-contracts-stellar](https://github.com/allowit-hq/allowit-contracts-stellar): native Stellar contracts, signing and chain semantics.
- [allowit-engine](https://github.com/allowit-hq/allowit-engine): shared server REST API, private enforcement, storage, ADK agent and app, and shared policy web components.

[Wallet signing and contract custody](docs/architecture.md) states the custody rules that a program of this rail keeps.

## Contributing

[`rust-toolchain.toml`](rust-toolchain.toml) pins Rust 1.98.0. Check a change with `cargo fmt --all -- --check`,
`cargo clippy -p allowit-solana --all-targets -- -D warnings` and `cargo test -p allowit-solana`, and in
`npm/solana` with `pnpm run build:browser` and `pnpm run test:browser`. The `Project review` check of a pull request reports
the maintainers' review of its head. [`AGENTS.md`](AGENTS.md) describes what belongs in this repository and what
does not.

## License

MIT. See [LICENSE](LICENSE).
