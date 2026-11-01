# Finite model refusal correspondence

This separate proof layer leaves the [captured VM corpus](../traces/README.md), models and their receipts unchanged. For each of its 12 program-rejected non-environment requests, Lean proves `¬ Transition environment before request t` for **every** readiness predicate and post-state. A small universal tuning-capacity lemma supports the revision-overflow case. A positive existential witness proves that the budget-exhaustion request admits a successful model transition with readiness set to `True`. There are 14 checked statements in total.

The request is reconstructed from the captured instruction bytes, account metas and the harness-reported clock using the unchanged strict decoder. The clock observation is trusted through the pinned Rust harness and is not independently decoded from a Clock account. The before state is the same raw-account-checked projection imported from the trace certificates. The checker first reruns that full compiled VM acceptance, then freshly compiles with pinned Lean 4.31 the independent models, captured certificates and these new statements, audits every new axiom closure, and rechecks source/tool/library/dependency identity. Generated proof bytes, proof log and receipt must match retained evidence.

These statements prove finite model nonpermission for each observed non-environment rejection. They do not prove which production layer or failed predicate produced its error, or establish error precedence. The original error codes remain separate observed execution evidence. The unsupported-method statement follows by construction because the model has no successful unsupported transition. It does not prove universal adapter refinement, real signatures, readiness, rollback, initialization/reachable traces, clients or deployment. In particular, error-result account equality still follows Mollusk returning input accounts on failure. The revocation case also exceeds its limit; it remains a multi-cause witness. The budget case is an environment failure, deliberately excluded from the 12 nonpermission statements.

Run from the verification worktree:

```sh
PYTHONPYCACHEPREFIX="$(mktemp -d /tmp/allowit-extraction-oct05/python-cache.XXXXXX)" python3 verification/refusal/check.py --tools /tmp/allowit-extraction-oct05
PYTHONPYCACHEPREFIX="$(mktemp -d /tmp/allowit-extraction-oct05/python-cache.XXXXXX)" python3 -m unittest discover -s verification/tests -v
```

Python interpretation/observation and cache fidelity, compiler/translator fidelity, Lean/core, faithful cached dependency builds, native linking and VM semantics retain their documented trust boundaries. The tool environment and current contract identities are inherited from the pinned trace checker; this checker installs nothing. `--emit-evidence` writes candidate Lean source and proof log only inside the isolated tool root; `--emit-receipt` prints the candidate receipt to stdout for an explicit reviewed refresh. The retained receipt records the runtime replay required by acceptance, not a claim of perpetual freshness.

All 24 release obligations remain open. Remaining work includes single-fault refusal witnesses, platform prerequisites, real runtime rollback, compiled artifact build provenance and connected interface execution. These statements give partial V06–V08/V10–V13/V23 evidence and do not add a full-refinement gate to the immediate demonstration.

The `NativeDaily.lean` header records its original Lean 4.11 provenance. Those bytes remain unchanged; this acceptance compiles the same specification with pinned Lean 4.31.
