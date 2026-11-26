# allowit-test-vault

A test counterparty for the Solana rail, **not a product vault**. Its admin decides what a share is
worth, it earns nothing and it holds no one else's strategy. Devnet evals and ledger tests use it to
give a wallet an honest vault for deposit, redeem and a share-price read (plan TASK-1066, task T13;
scenarios 4 to 6). Never deploy it to Mainnet and never hold real value in it.

It has the interface of the priced test vault that the other rails use: an admin sets the share
price; deposit, redeem, share price and preview.

## Behavior

- One underlying asset per vault, chosen at `Initialize`: a classic SPL Token mint with 6 decimals
  (Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). Token-2022 mints are refused.
- Shares are an SPL Token mint with 6 decimals at a program-derived address. The vault's state
  (also a program-derived address) is its mint authority; it has no freeze authority.
- The vault holds its assets in the associated token account of its state.
- The price is the asset amount, in base units, for one share (`SHARE` = 1_000_000 share units).
  `SHARE` itself is a price of one asset per share.
- A deposit takes exactly the assets it is asked to take and mints `assets * SHARE / price` shares.
  A redeem burns exactly the shares it is asked to burn and pays `shares * price / SHARE` assets.
  Both round down, toward the vault. A conversion to zero is refused.
- The admin keeps the vault solvent: a redeem fails when the vault holds fewer assets than it pays.
  Before raising the price, the admin moves the difference to the vault's asset account with a plain
  token transfer. Lowering the price leaves the difference in the vault.

## Instructions

Data: one tag byte, then the fields in order, integers little-endian. Read-only answers and the
results of deposit and redeem are the return data: eight bytes, little-endian.

| Tag | Instruction | Data after the tag | Accounts |
| --- | --- | --- | --- |
| 0 | `Initialize` | name (32 bytes, UTF-8, zero-padded), share price (u64) | state (w), admin (w, s), asset mint, share mint (w), vault asset account (w), System, SPL Token, Associated Token |
| 1 | `SetSharePrice` | share price (u64) | state (w), admin (s) |
| 2 | `Deposit` | assets (u64) | state, asset mint, share mint (w), vault asset account (w), source asset account (w), its authority (s), receiving share account (w), SPL Token, then multisig signers |
| 3 | `Redeem` | shares (u64) | state, asset mint, share mint (w), vault asset account (w), source share account (w), its authority (s), receiving asset account (w), SPL Token, then multisig signers |
| 4 | `SharePrice` | none | state |
| 5 | `PreviewDeposit` | assets (u64) | state |
| 6 | `PreviewRedeem` | shares (u64) | state |

The authority of a deposit or a redeem is the owner or the delegate of the source account: a signer
of the transaction, a program-derived address whose program signs in a CPI, or an SPL Token multisig
whose signers follow (at most 11).

Addresses:

- state: `["allowit-test-vault", admin, name]`
- share mint: `["shares", state]`
- vault asset account: the associated token account of the state for the asset mint.

## State

148 bytes, owned by the program:

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 | tag `alwtvlt` and layout version `0x01` |
| 8 | 1 | state bump |
| 9 | 1 | share mint bump |
| 10 | 1 | asset decimals (6) |
| 11 | 1 | share decimals (6) |
| 12 | 32 | admin |
| 44 | 32 | asset mint |
| 76 | 32 | share mint |
| 108 | 32 | name |
| 140 | 8 | share price (u64, little-endian) |

The rail reads this layout for `allowit price VAULT` (`crates/allowit-solana/src/price.rs`). It
accepts the state only at the address that its owning program derives from the stored seeds, with
the share mint that the same program derives. A change of layout changes the version byte, the
rail's reader and the recorded fixture `crates/allowit-solana/tests/fixtures/test_vault_state.json`
together.

## Errors

`ProgramError::Custom`: 1 not positive, 2 zero result, 3 insufficient shares, 4 insufficient assets,
5 overflow, 6 not this vault, 7 not the admin, 8 unsupported asset, 9 accounts do not fit.

## Build and test

The program builds on its own lock file, so a change of the rail crate's dependencies never changes
its bytes. Keep build output out of the repository: point `CARGO_TARGET_DIR` outside it.

```sh
cd programs/test-vault
cargo build-sbf --sbf-out-dir "$CARGO_TARGET_DIR/deploy" -- --locked
cargo test --locked                        # host unit tests: conversions, bytes
cd sbf-tests && SBF_OUT_DIR="$CARGO_TARGET_DIR/deploy" CARGO_TARGET_DIR="$CARGO_TARGET_DIR-sbf-tests" \
  cargo test --locked -- --nocapture       # LiteSVM: the built program
```

`sbf-tests` loads `allowit_test_vault.so` from `SBF_OUT_DIR`, else from `$CARGO_TARGET_DIR/deploy`.
Give `sbf-tests` a target folder of its own, as above. It has its own lock file, and in the program's
folder Cargo can take the program's library as it was built with the program's lock; the test then
fails to compile with two versions of `solana-address` in its graph.
Its run also checks the recorded state that the rail's price-read test reads; `RECORD_FIXTURE=1`
writes it again after a deliberate change.

Measured with `cargo build-sbf` 3.1.12, platform tools v1.52, on Windows: 116,392 bytes; LiteSVM
compute units: deposit 9,516, redeem 9,819.

## Deployment (Devnet only, by the owner)

Nothing here deploys. The steps below need a funded Devnet key that the owner controls; no faucet
step is part of this repository.

1. Build from a clean checkout of the commit to deploy and record the hash:
   `sha256sum "$CARGO_TARGET_DIR/deploy/allowit_test_vault.so"`.
   For a hash that any host can reproduce, build in the pinned verifiable-build image that the vault
   program uses (`scripts/build-sbf.sh` once the vault ABI 3 pull request is merged), with this
   manifest.
2. Generate a new program keypair outside the repository (do not reuse the one that `cargo
   build-sbf` writes beside the build): `solana-keygen new -o <outside-repo>/test-vault-program.json`.
3. Deploy immutable, with no upgrade authority:
   `solana program deploy --url devnet --program-id <outside-repo>/test-vault-program.json --final "$CARGO_TARGET_DIR/deploy/allowit_test_vault.so"`.
4. Check that it is immutable: `solana program show --url devnet <PROGRAM_ID>` names no upgrade
   authority (`Authority: none`).
5. Compare the deployed bytes with the build:
   `solana program dump --url devnet <PROGRAM_ID> dumped.so`, then
   `head -c "$(stat -c %s allowit_test_vault.so)" dumped.so | sha256sum` must equal step 1, and the
   rest of `dumped.so`, if any, must be zero bytes.
6. Initialize a vault with the admin key: tag 0, name (for example `devnet-usdc`), price 1_000_000
   (one USDC a share), USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, with the accounts in
   the table above. The repository has no client for this step yet.
7. Record the program id and the vault state address in the project's plan; `allowit price <STATE>`
   reads the price.
