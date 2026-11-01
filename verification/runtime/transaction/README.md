# Finite signed transaction/store experiment

Seven transactions are submitted; five reach program execution with unchanged published Solana custody/policy ELF files through pinned LiteSVM, using the isolated downstream [Cargo lock](Cargo.lock). Four successful transactions commit five token transfers. A three-instruction transaction (ComputeBudget, transfer, unsupported request) logs a successful custody transfer/token CPI, then fails with Custom(100); direct runtime-store observations retain the pre-transaction custody/token values. A transfer-only control with the same request nonce then succeeds. This is a finite transaction-abort witness under trusted LiteSVM semantics, separate from Mollusk's returned-failure-account convention.

| Case | Observed result | Fee |
| --- | --- | --- |
| Invalid blockhash | BlockhashNotFound; no program execution/store change | 0 |
| Single transfer | Commit, nonce 0 → 1 | 10,000 lamports |
| Two transfers | Commit, nonce 1 → 3 | 10,000 |
| Transfer then Unsupported | InstructionError(2, Custom(100)); protected-store frame | 10,000 |
| Reuse aborted request | Commit, nonce 3 → 4 | 10,000 |
| Corrupt executor signature | SignatureFailure; no program execution/store change | 0 |
| Uncorrupted original | Commit, nonce 4 → 5 | 10,000 |

A ComputeBudget instruction at index 0 sets a compute-unit limit of 1,400,000; no priority fee is requested. A distinct payer and executor sign each transaction. Test key seeds are fixed and public; they are fixture credentials only. The rejected corrupted signature is index 1, leaving the payer signature/transaction ID unchanged. Included transaction IDs are distinct; the corrupted copy is excluded from that condition and submitted before its original.

## Checked observations

[main.rs](main.rs) obtains account images from the same runtime store before/after submission, compares the entire protected store on failure and reads fee-payer effects separately. It performs no account restoration, clock warp, airdrop, program replacement or blockhash change inside any capture window. Initial setup injects an approved vault, supported mint and funded token accounts; owner approval, initialization and reachable funding are **not** established. The fixture has six-decimal units, 25,000,000 daily limit and Clock timestamp 86,401. Final spent is 5,000,000, nonce 5.

[validate.py](validate.py) independently parses canonical legacy transaction bytes, signatures' positions, message headers/account indices, exact instruction fields, and raw custody/token/mint/Clock layouts. It closes the instruction/key inventory and checks writable/signer/owner-absence bindings, supplied-bump PDA hash equality, loader program-to-ProgramData linkage, ELF hashes against bindings.json and observed policy invocation, exact custody/token effects, the closed token-owned inventory/supply and zero delegate/native/close-authority fields, fee frames, no protected-store effects on refusal, store continuity, prefix-success/final-failure log order, exact nonce reuse, ordered/nested invocation events and the one-byte executor-signature mutation. Mutated custody/token accounts also preserve lamports, owner, executable and rent-epoch metadata. The redundant abort terminal check is defense in depth; the exact invocation event sequence is the primary order check. Targeted negative tests protect selected repaired constraints, not exhaustive decoder correctness or mutation completeness.

It does not perform Ed25519 verification; actual signature enforcement and execution observations depend on the trusted runtime/compiler.

Full-store entries retain metadata and SHA256 data fingerprints. Raw bytes are retained for custody, three token accounts, mint and Clock throughout, plus all three programs and custody/policy ProgramData in the initial rejection record. They are not retained for every runtime account. ProgramData payloads and token program data are hashed independently against frozen artifact bindings; subsequent frames preserve those initial account identities. PDA hash equality uses the supplied bump; canonical off-curve/PDA selection remains trusted through Rust construction. The Rust observer supplies complete store enumeration and original equality checks; the Python frame check relies on its enumeration and SHA256 collision resistance for the remaining data. The relation between the raw Clock account and the program syscall view depends on trusted LiteSVM set_sysvar/cache fidelity; the fixture day is checked as 86,401 // 86,400. These assumptions are explicit; this is not a formal proof of observer completeness.

Two fresh native processes pass validation. A dedicated retained-replay test checks normalize(vectors) == normalize(replay). The normalized digest uses UTF-8 json.dumps of the complete normalized record list with sort_keys=True and separators=(",",":"), without a trailing newline, with ensure_ascii at its default True. [vectors.jsonl](vectors.jsonl) and [replay.jsonl](replay.jsonl) retain their original observations. Transactions, signatures, logs, fees and raw projections reproduce exactly. Full-store account names differ only for LiteSVM's random internal airdrop funding key. `normalize()` first checks original full frames, then requires that single funding account to have exactly the fixed metadata, remain unchanged and never appear in a message/raw projection before replacing its name for comparison. Normalization affects cross-process naming only; original protected-store checks retain it. No fresh-build byte reproduction or independent runtime reproduction is claimed.

## Identity and limits

[observation.json](observation.json) binds the corpus, checker/harness/lock/build log, executable/compiler/Cargo, committed Solana manifest and upstream tree. The third u64 in Transfer is expected_revision (0 here), not an expiry. Limit-binding/day-rollover paths are untested in this corpus; this native ABI has no expiry field. Error 100 maps to UnsupportedMethod in the [pinned source](https://github.com/ackrate/AllowIt-contracts-solana/blob/e0fc5a19985a7c1d1d184754dba98ddbc98e2841/programs/vault/src/lib.rs#L215), which checks the Unsupported variant before account loading. This is source inspection/finite error correspondence, not a compilation or universal error-cause proof. bindings.json.sourceFiles is an identity inventory, not read by the decoder as an ABI semantics proof; the manually inspected mapping from tag 7/field layouts remains trusted. The source-bundle identifier comes from the pinned committed manifest and does not establish source-to-ELF build correspondence.

The explicitly loaded token ELF is the 134,080-byte `spl_token-3.5.0.so` from the pinned LiteSVM source; it differs from the historical Mollusk token ELF. All three program payloads are checked with `try_program_elf_bytes` before observations. The synthetic program IDs are local fixture bindings, not deployment identity. No permissive substitute program is used.

The downstream resolved lock governs this experiment; upstream workspace lock identity does not govern downstream dependency selection. Compiler libraries, compiled caches and registry source closure are not recursively pinned. Build/translation/cache/runtime fidelity and token binary semantics remain trusted. This record is producer-observed finite correspondence, not a fully dependency-closed acceptance receipt or production build provenance.

No Lean theorem is added here. No failure within the custody transfer after its own token CPI, validator/public-chain rollback, universal authorization/readiness/adapter refinement, clients or deployment is proved. The abort needs a separate transaction-level relation; the successful State.Transition relation does not define rejected transactions. All 24 release obligations remain open; this supplies partial local-runtime V06–V08/V12/V23 evidence only.

## Reproduction

Copy this Cargo manifest/lock and main.rs into `/tmp/allowit-extraction-oct05/transaction-probe` (main.rs goes in src/), beside the pinned `litesvm-source`. Use Rust/Cargo 1.98 with isolated `CARGO_HOME=litesvm-cargo`, `CARGO_TARGET_DIR=transaction-target` and explicit RUSTC. Build with `cargo build --locked --offline`. Check/copy the manifest-matched custody/policy ELF and pinned upstream token ELF into `litesvm-artifacts`, named as in main.rs. The executable takes that directory as its sole argument. Missing cached dependencies are unsupported until explicitly populated; never change a pin silently.

```sh
python3 verification/runtime/transaction/validate.py verification/runtime/transaction/vectors.jsonl
PYTHONPYCACHEPREFIX="$(mktemp -d /tmp/allowit-extraction-oct05/python-cache.XXXXXX)" python3 -m unittest discover -s verification/tests
```

These instructions do not implement automated build/dependency freshness acceptance. Next formalize the separate transaction abort/fee-frame specification and connect the finite decoded observations, then pin the new environment's complete dependency identities. Same-custody-instruction failure, token-call failure and owner authorization require additional independent cases.
