---
# Vault program ABI 3

One program for the Simple, Standard and Custom wallet kinds of Allowit Core (`WalletKind`).
Classic SPL Token only; the mint has 6 decimals. Native wallets use no program.

## Accounts
- State: PDA with seeds `["allowit-vault-v3", owner, instance_id]` (`instance_id`: 32 bytes chosen by the owner).
- Token account: the associated token account of the state PDA for the mint.

## State (borsh, sized at Initialize, resized by UpdatePolicy)
abi u8 (= 3), bump u8, kind u8 (1 Simple, 2 Standard, 3 Custom), paused bool,
version u32 (deployment version; every owner step that names it moves it by exactly +1),
owner, agent, server, mint, instance_id: [u8; 32], created_slot u64,
source_hash [u8; 32], check_program [u8; 32] (all zero unless Custom), nonce u64,
figures { calls u64, spent i128, day u64 (unix time / 86 400), day_spent i128, day_total i128 },
rules: Vec<u8> (indices into Core `STANDARD_PARAMS`, in the owner's order; empty unless Standard),
params: the values of those rules, encoded as in section "Params".

## Instructions (borsh enum)
0 Initialize { instance_id, kind, agent, server, source_hash, check_program, rules, params }
  Signer: owner (pays every deposit). Creates the state and the token account.
  Refuses: agent, server and owner not pairwise distinct; a zero key; a mint not owned by SPL Token or
  without 6 decimals; check_program set unless Custom; rules unless Standard; params that Core refuses.
1 Execute { amount u64, nonce u64, version u32, created_slot u64, expires_at i64 }
  Signers: agent and server. Operation: transfer of `amount` from the token account to a destination
  token account of the same mint. The recipient for Core is the owner of the destination token account.
  Refuses: paused; version, nonce or created_slot not equal to the state; now >= expires_at;
  expires_at > now + 600; amount 0; destination equal to the vault's token account.
  Standard: Core's preflight for each stored rule in order. Custom: a CPI to check_program (below).
  Then the figures and the nonce move, and the program transfers with TransferChecked, signed by the PDA.
2 SetPause { paused, version }        Signer: owner.
3 Stop { version }                    Signer: owner. Pauses and moves the whole balance to an owner's token account.
4 Recover { amount }                  Signer: owner. Moves amount to a token account owned by the owner.
5 UpdatePolicy { version, agent, server, source_hash, check_program, rules, params }
                                      Signer: owner. Keeps `paused`. Resizes the state; the owner pays or is refunded.
6 Close { version }                   Signer: owner. Moves the balance to an owner's token account, closes the token
                                      account and the state; every lamport returns to the owner.
Owner instructions never call the check program. Agent and server never act alone.

## Custom check call
On Execute only. invoke_signed into check_program with the state PDA as a signer and these accounts:
state PDA (signer, read-only), check state PDA of the wallet (writable, optional).
Data, little-endian: abi u8 = 3, amount u64, recipient [32], mint [32], now i64, day u64,
calls u64, spent i128, day_spent i128, day_total i128. The check program refuses by failing.

## Params
Each value follows the type of its rule in Core: amounts and counts as i128 or u64, `expires_at` as i64,
`destinations` and `tokens` as lists of 32-byte addresses, `operations` as `*` or a list of names.

## Errors
Vault errors keep the numbers of the Stellar `AllowitWalletError` where the meaning matches.
A Core `AllowitError` returns as `1000 + its code`.

## Open
- Operations other than transfer (deposit and redeem in a tokenized vault).
- The maximum lifetime of a signed request (600 s here).
---
