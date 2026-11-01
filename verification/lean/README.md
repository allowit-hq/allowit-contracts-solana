# Lean proof demonstrator

`AllowIt.lean` is an executable, machine-checked model of feature selection and a small policy decision language. Its production-to-model connection has not been proved or differentially tested. `NativeDaily.lean` separately models the new literal native daily policy; [its source-bound check](../check_native.py) compares Lean and the actual Rust source. Neither module proves the Rust SDK, Go assembler, generated Markdown, chain adapters or compiled/deployed contracts.

## Run

Use the pinned stable toolchain in `lean-toolchain`:

```sh
cd verification/lean
elan toolchain install leanprover/lean4:v4.11.0
python3 check.py
```

With an independently installed official release, `LEAN_BIN=/absolute/path/to/lean python3 verification/lean/check.py` works from the repository root. The script rejects a missing or different checker, rejects proof holes/custom axioms/native proof evaluation, checks both files, and audits every theorem's dependencies. Lean's standard `propext` and `Quot.sound` axioms occur; no application-specific axiom is assumed. The executable example's `#eval` output is a demonstration, separate from its kernel-checked `example_passes` theorem.

The checker checks both modules separately: 13 bounded policy/feature theorems and 16 native daily-rule theorems. This is an audit of these reviewed files, not a generic verifier for externally supplied or hostile Lean code.

CI can run the same two commands after installing Elan; it must fail if the pinned checker cannot run. There are no Mathlib or other package dependencies. Version 4.11.0 was chosen to keep the standalone checker small; the model does not require newer Lean features. [Official release](https://github.com/leanprover/lean4/releases/tag/v4.11.0).

## Proved domains

| Model | Universal property |
| --- | --- |
| `Flow` built from feature uses, sequence and binary branches | Every feature encountered by any evaluated branch belongs to the conservative all-branch requirement list. |
| `selected` | Selected feature membership equals required feature membership; every candidate covering the requirements contains the selection. This is minimal feature membership, not minimum prose or reachable-path analysis. |
| Capability availability | A required feature absent from available capabilities makes the flow unsupported. No capability or actor is assumed to exist. |
| `assess` | Passing requires present, ordered evidence within 0–10,000 basis points, enabled approval at/above its threshold, and no enabled denial at/below its threshold. Missing evidence never passes; both automatic outcomes disabled gives `unresolved` even without evidence. |
| Finite `Policy` trees | Ordered evaluation passes exactly when the declarative permission specification holds. Both directions are proved, so denying everything does not satisfy the permission specification. |
| Every budget leaf in a passing policy | The positive requested amount plus committed spending fits both allocation and cap, without unsigned 64-bit overflow. Classification cannot override a budget leaf. |
| `examplePolicy` | A concrete budget-plus-classification request passes, establishing a nonempty approval example. |

Features use the SDK's five identifiers: `confidence_evidence`, `owner_input`, `purchase_history`, `runtime_context_u64`, `semantic_evidence`. Adding a feature requires updating the typed enumeration and selection universe; the exact-coverage theorem then checks that the selection includes it. `Flow` models conservative traversal, including inactive branches. It has no early returns or expression short-circuiting and makes no claim about a reachable approval path.

`Policy` models permit, a budget gate, a supplied classification assessment and ordered conjunction. Amounts are `Fin (2^64)` with exact natural-number arithmetic; intervals are `Fin 10001` with a proof of ordered endpoints. `committed` represents a trusted snapshot including relevant reservations, not a proved concurrent ledger. Malformed external input and stale bindings are outside these typed inputs.

This policy model omits source parsing, general SDK expressions, `set_cap` preflight before control flow, resource limits, owner-input continuation, network/asset binding, purchase tiers and settlement. `permit` can pass without a budget, unlike the SDK's global context checks. The model therefore proves neither SDK evaluation equivalence nor a production authorization invariant. `unresolved` does not assert that an operator exists or that a harness can obtain an answer.

Jev's output is an external observation. No theorem establishes classification truth, personalization correctness, calibration, natural-language intent completeness or execution capability. A Noul point score does not establish a calibrated interval. The interval model specifies how valid bounds would be handled; it does not supply them.

## Native daily rule

`NativeDaily.lean` models the inspected native source hash `eceb1d4f55c93ef7921f47f3ca0d35bc589c3c6a1b0f29ae63f5fb9f9ff37da8` with all inputs/results bounded to `u64`. `success_iff` proves both permission directions and the exact returned spending; a successful exact-limit witness rules out vacuous safety. The other theorems cover parameter bounds, all errors in source order, day regression, zero limit, same-day lowering below spent and fresh-day independence of old spending.

This function returns the next spending value. It does not authenticate its context or persist that value. The model therefore proves no actual transfer, storage update, authority, reservation, migration or settlement property. The completeness contract defines those separate obligations.

With the two contract checkouts at the paths pinned in `verification/native-source-lock.json`, run from the repository root:

```sh
LEAN_BIN=/absolute/path/to/lean python3 verification/check_native.py
```

The script first checks the proofs, verifies both policy/API hashes and each embedded SOURCE_HASH, snapshots source, compiles host Rust runners, compares exact outcomes with Lean and specification vectors, and detects specified mutations. The corpus includes bucket boundaries, same-day regression, maximum timestamps/spent_day, overflow, and seeded samples near limits and the current day. Nine kernel mutations test caps, counter reset, exact-limit refusal, deny-all, error priority, day comparison/constants and inverted reset. Temporary mutation files never edit the contracts. Missing tools/source, stale hashes, incomplete results or any disagreement fail explicitly. Output reports **tested correspondence**, with production refinement, chain-adapter execution and deployment checks marked false. It does not compile SBF/Soroban or establish universal correspondence. The Lean compiler/runtime, host Rust compiler/runtime and Python specification implementation are trusted for this replay evidence. Pin candidate contract revisions separately when they are delivered; the current lock identifies inspected source bytes, not a release.

## Architecture implication

The October 4 verification plan incorporates the divergent customer workspace, owner-review flow and separate fixed-policy Devnet vault. It prioritizes shared-rule semantics and custody/journal transitions, then the actual IR bridge; all production proof milestones remain proposed.

Lean can own the typed language specification, executable reference evaluator, extension laws and proofs. Rust can continue to own parsing, source-preserving edits, validated IR, deterministic execution and WASM/contract adapters. Go can own transport, lifecycle and capability-aware skill assembly. A verified Lean model plus Rust/Go tests remains a tested correspondence; a production correctness claim needs a proved refinement or a verified/extracted implementation with its trust boundary stated.

A useful next bridge is to compare the actual Rust requirement extractor and Go fragment selector with this model over generated typed trees, including every registered function and both branches. That would add differential evidence, not a theorem about either implementation. A separate lowering theorem should establish that `check_preference`'s actual IR implements the interval/disabled-state specification. A skill renderer can then derive fragments from the verified machine descriptor; its English interpretation still is not a formal proof.

The closest primary reference is Cedar: [its Lean language and compiler proofs](https://github.com/cedar-policy/cedar-spec/blob/main/cedar-lean/README.md) and [symbolic-compilation theorems](https://cedar-policy.github.io/cedar-spec/docs/Cedar/Thm/SymbolicCompilation.html). Cedar distinguishes these proofs from [differential testing of its Rust validator](https://docs.cedarpolicy.com/policies/validation.html). Lean explains [kernel checking](https://lean-lang.org/doc/reference/latest/Elaboration-and-Compilation/) and [axiom auditing](https://lean-lang.org/doc/reference/latest/Axioms/).
