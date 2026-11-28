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
