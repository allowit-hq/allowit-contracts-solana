# Finite custody failure boundaries

Seven signed submissions use the unchanged published Solana custody/policy programs and the pinned LiteSVM/token ELF from the [transaction experiment](../transaction/README.md). Three transfers commit. Two resource failures separately exercise token CPI and immediate custody continuation after token CPI success. Independent Python decoding checks raw account effects, complete protected-store fingerprints, exact instruction/signature roles, artifact payload identities and fees. This is producer-observed finite runtime correspondence, with no new Lean theorem or release-obligation closure.

| Case | Budget | Observed result |
| --- | --- | --- |
| Invalid blockhash | 20,000 | BlockhashNotFound; no execution or fee |
| Token failure | 15,000 | Token CPI logs TransferChecked then budget failure; custody fails |
| Token reuse | 20,000 | Identical transfer instruction, nonce 0; commits |
| Post-CPI failure | 18,500 | Token CPI succeeds; the same custody instruction then fails |
| Post-CPI reuse | 20,000 | Identical transfer instruction, nonce 1; commits |
| Corrupted executor signature | 20,000 | SignatureFailure; no execution or fee |
| Uncorrupted original | 20,000 | Nonce 2; commits |

Both execution failures return InstructionError(1, ProgramFailedToComplete), consume their entire budget and charge 10,000 lamports. Store images before/after each failure are equal except the distinct payer fee. Each immediately following transfer-only control reuses the transfer instruction/account list with more compute units; its budget instruction and signed transaction bytes change. This is a local experiment, not a retry prescription for uncertain network transactions. Each success consumes 19,578 units and charges 10,000 lamports; final spent/nonce are 3,000,000/3. Included IDs are distinct. The corrupted copy is submitted before the original with only executor signature byte 0 changed.

## Interpretation

Logs distinguish failure inside the token call from failure after that call reports success. The former is compute exhaustion, **not** an SPL business-rule refusal. No intermediate account image is exposed: token-success logs do not independently show an intermediate token balance or establish the precise instruction where later failure occurs. Protected-store equality and successful nonce reuse are direct observations from the same trusted runtime store. The [pinned custody source](https://github.com/ackrate/AllowIt-contracts-solana/blob/e0fc5a19985a7c1d1d184754dba98ddbc98e2841/programs/vault/src/lib.rs#L521) stores accounting (lines 521–524) before invoking token transfer (lines 530–549); that inspected source ordering is not a compiled instruction/refinement proof. No harness restoration, account writes, clock warp, program replacement, airdrop or blockhash change intervenes between submissions or capture windows.

The initial approved vault and funded six-decimal accounts are constructed, not reachable-initialization evidence. Clock timestamp is 86,401, daily limit 25,000,000 and transfer amount 1,000,000. Owner approval, arbitrary accounts, semantic token errors, universal readiness/rollback/adapter refinement, program source-to-ELF provenance, compiled clients, validator/public-chain behavior and deployment identity remain unproved. Synthetic addresses are fixture identities. All 24 release obligations remain open.

[main.rs](main.rs) captures the signed wire, metadata/logs, complete-store fingerprints and raw custody/token/mint/Clock images. The first record also retains all loaded program/ProgramData bytes. [validate.py](validate.py) is a separate copy adapted from the historical transaction decoder; it does not import or alter that decoder. It checks strict wire and instruction inventory, exact budgets and failures, ordered/nested invocation events, request reuse, signatures' positions, fees/history, state/token effects, metadata frames, supply and bindings. Targeted tests protect selected constraints; they are not exhaustive decoder correctness or mutation completeness. Python does not verify Ed25519. Full-store enumeration, SHA256 collision resistance, runtime cryptography/logging/execution, Clock/syscall-cache fidelity, canonical PDA selection and manual ABI interpretation remain trusted. Only supplied-bump hash equality is independently checked.

Two fresh processes reproduce wire/signatures/logs/raw projections exactly. Cross-process normalization validates original full frames first, then changes only the one unchanged/unreferenced internal funding account name. Historical corpora/receipts remain unchanged. The prior whole-transaction transfer-prefix abort remains separate evidence. This experiment demonstrates failure within a single custody transfer instead.

## Build and reproduction

[observation.json](observation.json) pins harness/decoder/tests/lock/corpora, native executable, Rust/Cargo, published manifest and artifacts. It is an observation receipt, not an automated dependency-freshness acceptance service. The downstream Cargo lock is unchanged from the transaction experiment; it governs dependency selection, not the upstream workspace lock. Compiler-library, registry-source, compiled-cache and Python-library closure remain unpinned/trusted. No fresh-build byte reproduction or independent runtime reproduction is claimed.

The first new-target build and a later link failed with disk exhaustion. Only this task's newly created failed target was removed. The prior executable was copied and its retained SHA256 verified before reusing the isolated transaction-target dependency cache. The final offline/locked cached build succeeded; retained attempt/final logs disclose that sequence. No production or global cache was changed. Exploratory one-transfer budget probes selected 15,000 and 18,500; those exploratory outputs are not retained as accepted evidence; no universal or minimum-threshold claim follows from that selection.

Copy Cargo.toml, Cargo.lock and main.rs (as src/main.rs) into /tmp/allowit-extraction-oct05/failure-probe, beside the pinned litesvm-source. With explicit Rust/Cargo 1.98, CARGO_HOME=litesvm-cargo and CARGO_TARGET_DIR=transaction-target, build --locked --offline. Preserve prior executables before overwriting that target. Run the executable with /tmp/allowit-extraction-oct05/litesvm-artifacts as its only argument. Artifact files and pins are those documented by the transaction experiment. Missing dependencies or unsupported execution remain explicit failures; never substitute programs.

```sh
python3 verification/runtime/failure-boundary/validate.py verification/runtime/failure-boundary/vectors.jsonl
PYTHONPYCACHEPREFIX="$(mktemp -d /tmp/allowit-extraction-oct05/python-cache.XXXXXX)" python3 -m unittest discover -s verification/tests
```

Next specify a transaction failure/fee-frame relation independently in Lean and connect finite decoded observations. A handwritten relation or finite certificate will still require these observation assumptions and will not be extracted adapter refinement.

The retained [manifest](manifest.json) is byte-identical to the pinned production manifest. Tests connect its source bundle and custody/policy hashes to bindings.json and observation.json. The token hash is separately bound to the upstream token payload identity. The upstream tracked diff is clean at the post-build identity check; its pre-existing untracked loader example is unused by this package. Build-time source/cache fidelity remains trusted.

The Cargo package name is allowit-transaction-probe, so these experiments share an output filename. This experiment used the default dev profile and executable /tmp/allowit-extraction-oct05/transaction-target/debug/allowit-transaction-probe. The preserved historical transaction executable lives at /tmp/allowit-extraction-oct05/transaction-retained-bin/allowit-transaction-probe (SHA256 cb6701d683345801b227d00a6784b921c4ad8c5a03c3f37b369ea07d5e747d05). Historical documentation/receipts remain byte-identical; their cached output path currently holds this new executable and must not be used as historical evidence without checking its hash or rebuilding the historical source. The old preserved copy permits historical replay without changing either corpus.

Use absolute CARGO_HOME=/tmp/allowit-extraction-oct05/litesvm-cargo and CARGO_TARGET_DIR=/tmp/allowit-extraction-oct05/transaction-target, RUSTC=/Users/clawy/.rustup/toolchains/1.98.0-aarch64-apple-darwin/bin/rustc and /Users/clawy/.rustup/toolchains/1.98.0-aarch64-apple-darwin/bin/cargo. The retained corpora were captured by two separate invocations of:

```sh
/tmp/allowit-extraction-oct05/transaction-target/debug/allowit-transaction-probe /tmp/allowit-extraction-oct05/litesvm-artifacts > verification/runtime/failure-boundary/vectors.jsonl
/tmp/allowit-extraction-oct05/transaction-target/debug/allowit-transaction-probe /tmp/allowit-extraction-oct05/litesvm-artifacts > verification/runtime/failure-boundary/replay.jsonl
```

The retained captures ran from the verification worktree and wrote directly to those paths. For a new candidate, use fresh output paths before comparing retained evidence. Each JSON record has one trailing newline from Rust println; no newline rewriting is performed. Only cross-process comparison normalizes the funding key as documented. The corpus has no stale-nonce refusal control; the earlier Mollusk isolation corpus separately records the replay case (a different runtime). Successful nonce reuse here is evidence of preserved nonce plus acceptance, not a universal replay-protection proof.

The post-CPI witness has little remaining compute after token success. It establishes the observed failure/store frame immediately after successful CPI, with no observed intermediate balances or proof of later post-CPI writes. The validator checks exact token consumed/available-unit log lines for this fixture; equal consumption does not prove identical execution paths.

The manifest records build revision 8373496dbf4a67c639533f15cc343f484c639aed; the citation names evidence head e0fc5a19985a7c1d1d184754dba98ddbc98e2841. Producer Git-blob byte comparison confirms programs/vault/src/lib.rs is identical at both revisions (SHA256 049c9e030d5450e92335ae601ec0ea21817ea3957b07959315c9d04b1b8964fd). This source equality still does not prove the ELF was built from those bytes. Source bundle c4453481… frames only policy.rs and policy_api.rs; it excludes custody source.
