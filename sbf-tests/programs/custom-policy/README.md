# S2: Custom policy check programs (TASK-1066)

These three transfer-only fixtures exercise the ABI 3 vault's Custom CPI on the
Core pin used by the vault. Each is one feature of this crate:

| Feature | Rules, in order |
| --- | --- |
| `paper-transfer` | `operations`, `tokens`, `expires_at`, `lifetime_spending_limit`, `daily_spending_limit`, `daily_volume_limit`, `destinations`, `payment_limit` |
| `destination-list` | `destinations` |
| `daily-limits` | `daily_spending_limit`, `daily_volume_limit` |

## Typed Core fixtures, not the generated sample

The fixtures are hand-written. They call Core's typed `preflight` for each rule,
as ABI 3 Standard does, with parameter values fixed in the ELF. They are not the
code that Core generates for `sample-mandate.onchain.rs`, and they do not measure
it:

- The generated expression uses Core's thread-local failure latch through
  `.ok()`, which fails to link for SBF. No generated program is built here.
- `paper-transfer` takes the transfer rules of the paper's sample and its
  values. ABI 3 only runs transfers, so the sample's swap and redeem branches
  are left out.

The ELF sizes and compute units of these fixtures therefore bound a typed check
program, not a generated one. T14 still needs a format that binds an owner's
approved values and source to the deployed ELF or to authenticated check state.

The vault passes the transaction facts and counters over CPI. Each fixture
confirms that the caller is a Custom vault state of the test or Devnet vault
program, with this check program pinned, and refuses with `Custom(3001)`.

## Build and tests

`scripts/build-sbf.sh` builds the three fixtures in the pinned verifiable-build
image together with the vault and the test check program, and writes
`target/deploy/{paper_transfer,destination_list,daily_limits}.so`. The
`Vault program` workflow runs it and then the Mollusk tests, these included:

```sh
scripts/build-sbf.sh
(cd sbf-tests && cargo test --locked --test vault custom_policy -- --nocapture --test-threads=1)
```

The tests print ELF sizes, compute units for each allowed and refused vault
instruction, and serialized legacy creation packet sizes. The creation packet
assumes a prewritten buffer, with the server as its authority. It creates the
program, deploys from the buffer, revokes the upgrade authority, initializes
the vault and transfers funding to it in one packet. The owner, program
keypair and server sign. For ProgramData rent, query Devnet
`getMinimumBalanceForRentExemption` with the printed ProgramData length.
