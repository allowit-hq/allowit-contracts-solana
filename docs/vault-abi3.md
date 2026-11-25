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
                                      account and the state; every lamport returns to the owner. Refused in the
                                      slot of the state's creation (below).
Owner instructions never call the check program. Agent and server never act alone.

## Account order

| Instruction | Accounts, in order (w: writable, s: signer) |
| --- | --- |
| Initialize | state (w), owner (w, s), mint, vault token account (w), System, SPL Token, Associated Token |
| Execute | state (w), agent (s), server (s), mint, vault token account (w), destination token account (w), SPL Token; Custom adds the check program, then its optional wallet state (w) |
| SetPause | state (w), owner (s) |
| Stop, Recover, Close | state (w), owner (w, s), mint, vault token account (w), the owner's token account (w), SPL Token |
| UpdatePolicy | state (w), owner (w, s), System |

## Programs that the vault calls
Each call goes to the program that the vault pins, and to no account that the caller names:
- SPL Token (`TokenkegQ…`) on every transfer and close: Execute, Stop, Recover and Close check it before they read
  a token account. A mint or token account owned by another program is refused.
- System and Associated Token at Initialize; System at UpdatePolicy.
- The check program of a Custom wallet: the key in the state, which must be executable. The vault passes it the
  state PDA (read-only, signed) and the wallet's check state, and no token account or program, so the check
  program cannot move the wallet's tokens.

## Close and the creation slot
A request binds `created_slot` beside `nonce` and `version`. A wallet closed in its creation slot could be created
again at the same address in that slot, with the same `created_slot`, version 0 and nonce 0, and a request signed
for the first would then run on the second. Close is therefore refused in the creation slot: every later
instance has another `created_slot`.

## Request lifetime
A request names `expires_at`, and the vault refuses it from that time on, as the Stellar wallet does. The vault
also refuses an `expires_at` more than 600 seconds ahead, an outer bound: the rail signs a request for at most
60 seconds (`MAX_VALIDITY_SECS`), and the transaction's blockhash lapses after 150 slots. The rail uses no
durable nonces.

## Custom check call
On Execute only. invoke_signed into check_program with the state PDA as a signer and these accounts:
state PDA (signer, read-only), check state PDA of the wallet (writable, optional).
Data, little-endian: abi u8 = 3, amount u64, recipient [32], mint [32], now i64, day u64,
calls u64, spent i128, day_spent i128, day_total i128. The check program refuses by failing.

## Params
Each value follows the type of its rule in Core: amounts and counts as i128 or u64, `expires_at` as i64,
`destinations` and `tokens` as lists of 32-byte addresses, `operations` as `*` or a list of names.

## Errors
A refusal is `ProgramError::Custom(code)` with the code and meaning of the Stellar wallet's `AllowitWalletError`.
As on Stellar, a standard rule's denial collapses to `PolicyDenied`; a Core error about owner params, state,
overflow or an unsupported operation keeps its own code. A Custom check program refuses with its own error.

| Code | Name | Meaning |
| ---: | --- | --- |
| 1 | InvalidState | The state or token account is not this wallet's, or Close in the creation slot |
| 2 | InvalidParam | Invalid owner rules or params, or a param that a rule cannot decode (Core `MissingParam`, `InvalidParam`) |
| 3 | UnsupportedAsset | A mint not owned by SPL Token, without 6 decimals, or another token program |
| 4 | InvalidActor | A signer is not the owner, agent or server of the state; the three keys are not distinct |
| 5 | StaleRequest | The version, nonce or creation slot of a request differs from the state |
| 6 | Paused | The wallet is paused |
| 7 | Expired | `expires_at` has passed, or is more than 600 seconds ahead |
| 8 | InvalidAmount | An amount of zero |
| 9 | InvalidRecipient | A destination of another mint, the vault's own token account, or an owner step to another owner |
| 11 | Overflow | An arithmetic overflow (Core `Overflow`) |
| 14 | InsufficientFunds | The amount is above the token account's balance |
| 16 | UnsupportedOperation | An operation that the wallet does not run (Core `Unsupported`) |
| 17 | InvalidInvocation | The accounts do not fit the instruction |
| 18 | PolicyDenied | A standard rule denied the request (every other Core error) |

The runtime's own errors stay as they are: `MissingRequiredSignature`, `IncorrectProgramId` (another System,
Associated Token or check program) and `InvalidInstructionData`.

## Operations
ABI 3 runs transfers. Deposit and redeem in a tokenized vault, which scenarios 4 to 6 need, come with the Devnet
test vault (plan task T13), as typed operations with their own checked effects, not as a general call.
