# Native vault ABI v2

Native vault setup is one owner-signed Solana transaction: two fixed Compute
Budget instructions, idempotent vault-token-account creation, vault
initialization, the initial owner-funded deposit, and activation. Wallet connect
or sign-in is separate from this single setup confirmation. The shared policy
and custody programs must already be deployed.

The vault's policy identifies both enforcement layers. The daily limit and the
action limit are the on-chain integer-token limits. The execution-policy and
requirements digests and the semantic flag identify the server-side policy gate;
they are distinct from the identity of the small on-chain numeric adapter.

The configured authority is the trusted server signing key's public address and
must be different from the owner and the executor. The vault state adds the
authority, the action limit and the replay-safe instance slot. ABI-v1 320-byte
state is rejected; ABI v2 is 352 bytes and uses the `allowit-vault-v2` PDA seed.
The instruction and state encodings are in [`crates/interface`](../crates/interface/).

The release remains bound to one initialized, six-decimal classic SPL Token
mint. That mint may retain its issuer freeze authority, but every token account
used by an operation must be unfrozen. If the issuer freezes a vault or
destination account, SPL Token blocks payment, withdrawal, or closure until
the issuer unfreezes it; this does not relax mint, network, or artifact checks.

## Operations

| Operation | Signers | Result |
| --- | --- | --- |
| `deploy` | owner | Create, configure, initially fund, and activate atomically. |
| `fund` | owner | Deposit only from the owner's token account; it does not reset spend, nonce, or revision. |
| `execute` | executor + trusted authority | Pay the exact recipient and amount using expiry, commitment, nonce, revision, and instance slot. No owner prompt. |
| `tune` | owner | Change the daily limit and increment revision. |
| `tune_action` | owner | Change the per-action limit and increment revision. |
| `revoke` | owner | Withdraw standing approval and increment revision. |
| `withdraw` | owner | Return a specified amount to the owner's token account. |
| `close` | owner | Return the full balance, close the vault token account and state, and refund rent. |

The vault's nonce makes a resent `execute` fail, so a client that saves the
signed bytes before it broadcasts can look the original up before it signs a
replacement.
