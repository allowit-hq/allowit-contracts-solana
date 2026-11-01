# Allowit contract rails

*The on-chain side of a policy: evaluate the compiled IR and move the tokens in one transaction.*

An owner approves a policy once. These adapters make sure that is the policy that runs when an agent spends. Each one takes a compiled Allowit mandate, evaluates it with the SDK's deterministic `evaluate_ir` under `Profile::Contract`, and performs a bounded token transfer in the same chain transaction. There is no second path: a reached `require_user_input` always returns `UserInputRequired`, and neither contract API accepts an answer or an oracle receipt in its place.

## What is here

- [Allowit core](https://github.com/allowit-hq/allowit-core) (`allowit-sdk`, feature `contract`) owns the mandate envelope, artifact checks, exact request binding, budget and nonce accounting, evidence checks and the host-side `allowit-contract-artifact` command.
- This package, [`allowit-solana`](src/lib.rs), is a native Rust program that spends through classic SPL Token `transfer_checked`.
- [`sbf-tests/`](sbf-tests/) runs the built SBF program against the real SPL Token processor.

Each package has its own Cargo lockfile and build root. Stellar custody lives in [allowit-contracts-stellar](https://github.com/allowit-hq/allowit-contracts-stellar); see [Stellar custody](#stellar-custody) below.

The rest of this page is the reference for the mandate model and the Solana program API.

## Artifact and authority boundary

The owner chooses an explicit compiler authority and executor when activating a mandate. The compiler must compile the reviewed source with this SDK and authenticate the resulting artifact. The owner and compiler both authorize the **same complete mandate and artifact**. There is no default compiler key or implicit global trust root.

The chain verifies compiler authorization, canonical IR hash, artifact hash, registry/core/compiler versions, structural/type/effect limits and every immutable envelope field. It does **not** run the host `syn` Rust parser. The compiler attestation is therefore the trust boundary for source-to-IR correspondence. A signer service must compile the owner-reviewed source itself; it must never attest an arbitrary caller-supplied IR/source pair. Owner authorization selects that compiler key and its key ID/version. Rotating authority or changing source, intent, scope or limits requires a newly activated mandate.

The immutable envelope binds a nonzero logical `policy_id`, owner, executor, compiler key/ID/version, optional evidence authority, registry/core versions, network, exact asset, asset decimals, recipient, action, merchant, revision, expiry, allocation, source hash, canonical IR hash and complete artifact hash. The artifact also stores the immutable original intent. `artifact_hash` covers that intent, and every evidence request hash covers the complete mandate and artifact hash.

Each owner/policy pair has one active revision. The first revision is 1; activation requires the previous revision plus one and immediately prevents older revisions from spending, including against an existing token allowance. Forks use a new `policy_id`. Revocation is permanent for a revision, and changing any immutable field requires a new activation.

Create exact artifact bytes from source and owner intent:

Run this in an [allowit-core](https://github.com/allowit-hq/allowit-core) checkout:

```sh
cargo run -p allowit-sdk --features compiler,contract \
  --bin allowit-contract-artifact -- policy.rs intent.txt > artifact.json
```

This command compiles source and emits exact bytes without a trailing newline. Set `artifact_hash` to SHA-256 of those exact bytes. Use `allowit_sdk::contract::Mandate`, `Request`, `mandate_hash` and `request_hash` when constructing client payloads. Borsh encoding, enum discriminants and the pinned version are part of this first wire protocol; arbitrary JSON is not an instruction.

## Requests and evidence

The executor authorizes the exact request. Every request binds the current mandate revision and source/IR hash, asset, recipient, network, action, merchant, atomic amount and monotonically increasing nonce. The wrapper checks revocation, expiry and remaining allocation independently of policy source. It cannot make arbitrary program/contract calls or sign arbitrary data. Its only spending operation is the bound token transfer.

`merchant` and `action` are owner-approved metadata authenticated by the executor. Neither blockchain can independently verify an off-chain merchant's commercial claims. The actual token, source owner, destination and amount are checked against on-chain accounts/addresses.

Confidence and semantic assessments require an **explicit evidence authority**, separately configured in the owner/compiler activation. The same key can fill both executor and evidence roles only when the owner explicitly chooses it. An evidence snapshot binds all request bytes and the full mandate, including original intent, nonce and complete runtime-context JSON. It carries authority key ID/version, issue/expiry times (at most five minutes), and up to four named intervals. Inverted or out-of-range bounds, duplicate names, stale evidence, wrong authority and substituted requests fail. `semantic` uses the SDK's SHA-256 question key. A provider's point score may be represented by equal bounds; this does not make it a statistically calibrated interval.

Runtime context is an object of at most 256 bytes on Solana, subject to the SDK nesting and type bounds. Nonempty runtime context requires evidence authorization. The core receives immutable original intent from stored artifact bytes; an executor cannot replace it.

The policy core measures USDC in six decimal places. These rail adapters accept only Circle's canonical USDC mint/asset on the chosen network, from its [official registry](https://developers.circle.com/stablecoins/usdc-contract-addresses). Solana checks the six-decimal classic SPL mint (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` on Mainnet, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` on Devnet). No canonical USDC mapping exists for Solana Testnet, so USDC mandate activation on that rail fails closed. A custom token cannot inherit the USDC label.


## Fixed Devnet paid-API vault

The separate [vault v1 interface](VAULT.md) supports a funded PDA wallet with fixed hard limits and per-challenge replay markers. It does not execute arbitrary IR and does not change the allowance API below.

## Solana API

The program has no hardcoded program ID or default authority. A deployment chooses its program ID. Build a separate artifact for each explicit network:

```sh
ALLOWIT_SOLANA_NETWORK=devnet cargo build-sbf \
  --manifest-path programs/mandate/Cargo.toml --sbf-out-dir "$PWD/programs/mandate/dist"
```

Use `mainnet`, `testnet` or `devnet`. The deployable SBF build refuses an absent/unknown network setting. Solana does not expose a genesis-hash sysvar to programs: the deployment process must check RPC genesis and record the matching artifact/program ID on each cluster. Native tests use Devnet as their fixture network.

`Instruction` is Borsh encoded; accounts are documented beside each variant in `src/lib.rs`:

1. Call `InitializeHead { policy_id }` once with the owner signer/payer, Rent, System Program and `head_address(program_id, owner, policy_id)` PDA. The program creates its 48-byte revision head with System CPI. A prefunded PDA is accepted.
2. The owner funds/creates a fresh program-owned, rent-exempt `STATE_BYTES` account. `Initialize` requires that account's signature, the owner signature, Rent and the revision head. It stores the immutable mandate in draft state.
3. `Upload` appends artifact chunks of at most 700 bytes, in order. Only the owner may upload; no modification is possible after activation or revocation.
4. `Activate` requires owner and compiler signatures, Clock, the writable revision head, and the exact `mandate_hash`. Both signatures cover this hash in the transaction. The program validates the uploaded artifact and advances the active revision atomically.
5. The owner approves an SPL Token allowance to `delegate_address(program_id, mandate_account)`, a PDA derived from `b"allowit"` and the mandate account. Tokens remain in the owner's token account.
6. `Execute` requires the bound executor signer and exact source/destination/mint accounts, Clock and the revision head. If evidence is supplied, the configured evidence authority must also sign the complete instruction; its account follows the revision head. The program verifies the active revision, PDA delegate, classic Token Program ID, actual token owners/mints/decimals and allowance, evaluates, then invokes only `transfer_checked` with PDA signing. It records spent amount and nonce after the transfer.
7. `Revoke` requires the owner and permanently disables this mandate account. The owner can independently revoke the wallet's SPL allowance. The program never closes/reuses a mandate account or resets its nonce.

Prepend `required_compute_budget_instructions()` to program transactions: the compiled allocator requires a 256 KiB heap, and tests enforce a 1,400,000 CU ceiling. Solana artifacts are limited to 8,192 bytes, 256 IR nodes and depth eight. The SDK uses Solana's SHA-256 syscall on the SBF target. Instruction data is capped at 1,024 bytes in addition to the full 1,232-byte transaction limit. The packet-size test serializes a complete v0 transaction with three 64-byte signature slots, compute-budget instructions, one semantic interval, a 256-byte context and an address lookup table. Clients must check the actual serialized transaction: longer metadata or additional intervals reduce the available context space. A source token account has one classic SPL delegate; approving another policy delegate replaces that account's previous delegation.

## Stellar custody

Stellar uses the owner-controlled ODC and shared veto engine in [allowit-contracts-stellar](https://github.com/allowit-hq/allowit-contracts-stellar). The [Stellar wallet SDK](https://github.com/allowit-hq/allowit-contracts-stellar/tree/main/stellar/core) maps canonical execution requests to native-account or ODC custody. Its static source generator emits the private policy checks used by the ODC `execute` wrapper. Persistent token allowances are outside that custody profile.

## Verification and deployment boundary

The 2026-09-28 target validation receipt records passing compiled SBF and Soroban VM runs, exact artifact hashes, resource measurements and the Opus 5.5 source-review identities.

```sh
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 \
  cargo test --locked --manifest-path programs/mandate/Cargo.toml
```

The common vectors in [Allowit core](https://github.com/allowit-hq/allowit-core) compare oracle and contract core outcomes/error codes, then test bindings, monetary boundaries, replay/revocation, confidence, semantic context and input rejection. Native Solana tests dispatch signed CPI to the actual SPL Token processor and assert balances.

[Mandate CI](../../.github/workflows/mandate.yml) builds the actual SBF program with checksum-pinned official Agave 4.3.0/platform-tools 1.57, runs it with the real SPL Token ELF and System Program in Mollusk 0.15.1, and uploads the ELF/hash/build logs/CU results. The maximum admitted artifact and depth-eight policy must activate and transfer within the configured resource limit. To run that suite after building:

```sh
SBF_OUT_DIR="$PWD/programs/mandate/dist" ALLOWIT_SOLANA_NETWORK=devnet \
  cargo test --locked --manifest-path programs/mandate/sbf-tests/Cargo.toml -- --nocapture
```


These tests are not evidence of public-chain deployment or wallet acceptance. Deployment must record program/contract and artifact hashes, target-VM/resource results, network, token and authority configuration before the consumer uses a program-controlled allowance. On Solana, deploy the reviewed program immutably or explicitly verify the upgrade authority: that authority can otherwise replace code controlling PDA allowances. No private key or live-chain transaction is included here.

The daily-cap core uses version `0.2.0` and registry `1.6.0`. Custody state stores lifetime spend separately from daily spend and its UTC Unix day. Both counters commit after successful transfer. Existing `0.1.0` state is decoded only as an inactive, revoked mandate so its owner can persist revocation after an upgrade. It cannot execute or activate. Older policy artifacts require owner-authorized activation of a new revision; they are rejected rather than reinterpreted.
