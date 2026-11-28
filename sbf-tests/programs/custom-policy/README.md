# S2: Custom policy check programs (TASK-1066)

These three transfer-only fixtures exercise the ABI 3 vault's Custom CPI on the
Core pin used by the vault. The paper fixture measures the transfer rules of
Core's `sample-mandate.onchain.rs`. The other two isolate a destination
allowlist and daily spending and volume limits.

Each ELF embeds its fixture's policy values. The vault passes the transaction
facts and counters over CPI, and the check confirms the caller is the expected
Custom vault with that check program pinned. This experiment measures a build
with fixed values. T14 still needs a format that binds an owner's approved
values and source to the deployed ELF or to authenticated check state.

The derived code uses Core's thread-local failure latch through `.ok()`, which
fails to link for SBF. The fixtures use Core's typed `preflight` entry point
as ABI 3 Standard does. ABI 3 only executes transfers, so the paper fixture
does not measure the paper's swap and redeem branches.

From the repository root, with `cargo build-sbf` and platform tools v1.57:

```sh
cargo build-sbf --manifest-path programs/vault/Cargo.toml --arch v3 \
  --optimize-size --tools-version v1.57 --sbf-out-dir target/deploy -- --locked
bash scripts/build-custom-policy-spike.sh
(cd sbf-tests && RUST_LOG=warn cargo test --locked --test vault custom_policy -- --ignored --nocapture --test-threads=1)
```

The tests print ELF sizes, compute units for each allowed and refused vault
instruction, and serialized legacy creation packet sizes. The creation packet
assumes a prewritten buffer, with the server as its authority. It creates the
program, deploys from the buffer, revokes the upgrade authority, initializes
the vault and transfers funding to it in one packet. The owner, program
keypair and server sign. For ProgramData rent, query Devnet
`getMinimumBalanceForRentExemption` with the printed ProgramData length.
