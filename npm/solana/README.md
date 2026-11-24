# Solana browser adapter

`@allowit/solana` is the browser side of the Solana rail: the networks and tokens that it lists, address and explorer
helpers, wallet signing through the Wallet Standard, the Native wallet's setup and the owner's policy approval.
Consumers supply their authenticated REST transport. The adapter owns no application session and no layout.

It is consumed from this repository by Git path (`#<commit>&path:/npm/solana`), so `dist/` is committed. It has two
runtime dependencies beside `@allowit/core`: `@noble/curves` and `@noble/hashes`. It builds and reads the few
transactions of the rail itself and uses no Solana SDK.

## Rail plugin

`@allowit/solana/plugin` is the Solana plugin for the AllowIt SDK registry. Only the SDK registration imports it.
Hosts reach it through `<allowit-rail kind network>` and the registry functions, never by name. The default export has
the rail `id`, its CAIP-2 `networks`, `validateAddress`, `explorerUrl`, `assets`, the test declaration and the element
tags. `define()` registers the elements once; importing the module touches no DOM.

| kind | element | `data` | events |
|---|---|---|---|
| `address` | `allowit-solana-address` | `{network, address, label?}` | none |
| `explorer-link` | `allowit-solana-explorer-link` | `{network, kind, id, text?}` | none |
| `amount` | `allowit-solana-amount` | `{network, asset, units}` | none |
| `wallet-sign-in` | `allowit-solana-wallet-sign-in` | `{network, message}` | `allowit-signed-in {address, signature}`, `allowit-error` |
| `owner-sign` | `allowit-solana-owner-sign` | `{network, step, summary, owner?, expected?}` | `allowit-signed {signedPayload, hash}`, `allowit-cancel`, `allowit-error` |
| `owner-answer` | `allowit-solana-owner-answer` | `{network, owner, message}` | `allowit-signed {signature, answer, snapshot}`, `allowit-cancel`, `allowit-error` |
| `receipt` | `allowit-solana-receipt` | `{network, receipt}` | none |
| `binding-review` | `allowit-solana-binding-review` | `{network, installation}` | `allowit-verified {ok, detail}` |

The rail serves Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`) and lists SOL and Circle's Devnet USDC. It
offers one wallet kind, `native`. An unlisted mint has no unit: `assetDisplay` gives null for it and the amount element
shows its base units.

### Owner steps

A transaction step has the base64 text of its **message** as `payload` and the SHA-256 of that message, as lowercase
hexadecimal, as `hash`. The hash exists before anyone signs. The network names a transaction by its signature instead,
so the rail remembers the signature of each hash when it reads signed bytes (`signatures.ts`, in the page and in
`localStorage`). A hash whose signed bytes this browser never saw has no record: `ownerChain.transaction` then gives
null, never `'missing'`, and the SDK keeps the step saved.

`owner-sign` signs only a message that one key signs, whose hash is the reviewed `step.hash`, before `step.expiresAt`.
The wallet gets the transaction without a signature and must return exactly that message with the owner's valid
signature. A wallet that changes the transaction, for example by adding its own instruction, is refused with
`wallet_signed_other_transaction` and nothing is reported as signed. The signed payload is the base64 text of the whole
signed transaction, which is what the server's `native/owner/submit` reads.

`wallet-sign-in` signs only a CAIP-122 message whose first line names the current site and whose second line is the
wallet account. The signature is the wallet's Ed25519 signature over the message bytes, as base64 text.

### Native wallet

The wallet of an agent is the owner's own SPL Token account of one mint, at an address that `createAccountWithSeed`
derives from the owner, the mint and the agent. Its delegate is an SPL Token multisig of the agent and the server, two
of two, at an address derived from the owner, the agent and the server. No AllowIt program runs.

`ownerChain.keypairSetup`:

- `prepare` reads the finalized bank at both addresses, the two deposits and a finalized blockhash, and builds one
  transaction: each account that is not there yet, then `ApproveChecked` of the allowance to the delegate, then a memo.
  Only the owner signs, so `complete` adds no signature: it checks that the wallet returned the same message with the
  owner's signature.
- The memo is `allowit:setup:<agent>:<server>:<valid until>`. `read` takes the agent and the server from it and
  accepts the bytes only when the setup builder makes exactly them from what was read, so the wallet and the delegate
  that the owner signs are the addresses of those roles. `validUntil` is the Unix time until which the workflow sends
  the same bytes again, about the life of a blockhash. It is not what decides whether the bytes can still run: the
  blockhash does, and `expiredRecord` reads it.
- `amount` is the **allowance**: what the agent and the server may spend together. The setup moves no tokens. The
  wallet pays from what its token account holds, so the owner sends tokens to the wallet address. The element says so.
- `checkAsset` reads the mint of signed setup bytes, or of the refill step that the server prepares, and refuses
  another mint than the reviewed policy's with `asset_mismatch`. A policy without a listed token is refused too: a
  Solana wallet holds a token, never SOL.
- `send` sends the bytes and returns the slot once the finalized bank holds the transaction without an error.
- `configuration` is the installation document that the server registers, the same document as the rail crate's
  `owner_client::installation`.

`ownerChain.expiredRecord` answers for signed bytes past their time bound. They ran when the finalized bank holds
their transaction without an error. They can never take effect when the finalized bank holds it as failed, or when
their blockhash is no longer valid at the finalized bank and a node at that bank or past it holds no transaction of
their signature. Anything else rejects, and the SDK keeps the step.

`ownerChain.approval` is the owner's approval of a policy: a message signature and no transaction. `read` reads the
exact text that the server writes, a title line and one line of JSON. `holds` checks every field against the policy
that the owner reviewed and the wallet. `signedBy` verifies the signature over the message itself, which the rail
keeps by the step's hash while the page lives.

## Agreement with the rail crate

`tests/vectors.json` is written by the crate's test `tests/npm_vectors.rs`, which fails when the crate no longer makes
the file. The package's tests compare with it byte for byte: the seeds and addresses of a wallet, the setup message for
every state of the two accounts, the refill step, the installation document and the approval text with its signature.

## Build and test

```sh
pnpm install
pnpm run build:browser   # tsc: src -> dist
pnpm run test:browser    # node --test tests/*.test.mjs, against dist
```

## Not covered

- No transaction of this package has been sent to a network, and no browser wallet has signed one: the tests use a fake
  RPC node and a fake Wallet Standard wallet.
- Wallets that add instructions to a transaction before signing (some do for single-signer transactions) cannot sign
  an owner step here. The step is refused; nothing is sent.
- The fee ceiling of a payment in the installation document is the constant `MAX_FEE_LAMPORTS` (20,000), which must
  equal the server's wallet template of the network.
