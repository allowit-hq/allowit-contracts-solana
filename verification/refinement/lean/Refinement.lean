import AllowitKernel
import NativeDaily

namespace AllowIt.Refinement
open Aeneas Aeneas.Std

def word (x : U64) : AllowIt.NativeDaily.U64 := ⟨x.val, x.hBounds⟩

def context (x : allowit_kernel.policy_api.Context) : AllowIt.NativeDaily.Context :=
  { approved := x.approved, amount := word x.amount,
    dailyLimit := word x.daily_limit, spent := word x.spent,
    spentDay := word x.spent_day, now := word x.now }

def error : allowit_kernel.policy_api.PolicyError → AllowIt.NativeDaily.PolicyError
  | .NotApproved => .notApproved
  | .ZeroAmount => .zeroAmount
  | .ParameterOutOfBounds => .parameterOutOfBounds
  | .ClockWentBackwards => .clockWentBackwards
  | .Overflow => .overflow
  | .DailyLimitExceeded => .dailyLimitExceeded

def outcome : core.result.Result U64 allowit_kernel.policy_api.PolicyError → Except AllowIt.NativeDaily.PolicyError AllowIt.NativeDaily.U64
  | .Ok value => .ok (word value)
  | .Err e => .error (error e)

def observe (r : Aeneas.Std.Result (core.result.Result U64 allowit_kernel.policy_api.PolicyError)) :
    Aeneas.Std.Result (Except AllowIt.NativeDaily.PolicyError AllowIt.NativeDaily.U64) := do
  let value ← r
  .ok (outcome value)

theorem validate_refines (value : U64) :
    (do let r ← allowit_kernel.policy.validate_daily_limit value
        Aeneas.Std.Result.ok (match r with | .Ok _ => Except.ok () | .Err e => Except.error (error e)))
    = Aeneas.Std.Result.ok (AllowIt.NativeDaily.validateDailyLimit (word value)) := by
  by_cases h : 50000000 < value.val <;>
    simp [h, allowit_kernel.policy.validate_daily_limit, allowit_kernel.policy.MAX_DAILY_LIMIT,
    AllowIt.NativeDaily.validateDailyLimit, AllowIt.NativeDaily.maxDailyLimit, word, error]

def arithmetic (spent amount limit : U64) : Aeneas.Std.Result (core.result.Result U64 allowit_kernel.policy_api.PolicyError) := do
  let o ← lift (U64.checked_add spent amount)
  let r ← core.option.Option.ok_or o allowit_kernel.policy_api.PolicyError.Overflow
  let cf ← core.result.Result.Insts.CoreOpsTry.branch r
  match cf with
  | .Continue value =>
    if value > limit then .ok (.Err .DailyLimitExceeded) else .ok (.Ok value)
  | .Break residual =>
    core.result.Result.Insts.CoreOpsTry_traitFromResidualResult.from_residual
      U64 (core.convert.FromSame allowit_kernel.policy_api.PolicyError) residual

theorem arithmetic_refines (spent amount limit : U64) :
    observe (arithmetic spent amount limit) = Aeneas.Std.Result.ok
      (if h : spent.val + amount.val < 18446744073709551616 then
        if limit.val < spent.val + amount.val then .error .dailyLimitExceeded
        else .ok ⟨spent.val + amount.val, h⟩
      else .error .overflow) := by
  have hc := U64.checked_add_bv_spec spent amount
  cases h : U64.checked_add spent amount with
  | none =>
    simp only [h] at hc
    have hf : ¬ spent.val + amount.val < 18446744073709551616 := by
      simp [U64.max, U64.numBits] at hc
      omega
    simp [arithmetic, h, lift, observe, outcome, error, hf,
      core.option.Option.ok_or, core.result.Result.Insts.CoreOpsTry.branch,
      core.result.Result.Insts.CoreOpsTry_traitFromResidualResult.from_residual]
  | some value =>
    simp only [h] at hc
    have hf : spent.val + amount.val < 18446744073709551616 := by
      simp [U64.max, U64.numBits] at hc
      omega
    by_cases hl : limit.val < spent.val + amount.val
    all_goals simp [arithmetic, h, lift, observe, outcome, error, hf, hl, hc.2.1,
      word, core.option.Option.ok_or, core.result.Result.Insts.CoreOpsTry.branch]

theorem evaluate_refines (ctx : allowit_kernel.policy_api.Context) :
    observe (allowit_kernel.policy.evaluate ctx) = Aeneas.Std.Result.ok (AllowIt.NativeDaily.evaluate (context ctx)) := by
  have hdiv := UScalar.div_bv_spec ctx.now (y := 86400#u64) (by decide)
  obtain ⟨day, hdiv, hday, _⟩ := hdiv
  by_cases hz : ctx.amount.val = 0
  all_goals by_cases hl : 50000000 < ctx.daily_limit.val
  all_goals by_cases hd : ctx.now.val / 86400 < ctx.spent_day.val
  all_goals by_cases he : ctx.now.val / 86400 = ctx.spent_day.val
  all_goals cases ha : ctx.approved
  all_goals simp [allowit_kernel.policy.evaluate, allowit_kernel.policy.validate_daily_limit,
    observe, outcome, error, AllowIt.NativeDaily.evaluate, AllowIt.NativeDaily.validateDailyLimit,
    context, word, allowit_kernel.policy.MAX_DAILY_LIMIT, allowit_kernel.policy.DAY_SECONDS,
    AllowIt.NativeDaily.maxDailyLimit, AllowIt.NativeDaily.day, AllowIt.NativeDaily.daySeconds,
    AllowIt.NativeDaily.effectiveSpent, UScalar.eq_equiv, hdiv, hday, ha, hz, hl, hd, he,
    core.result.Result.Insts.CoreOpsTry.branch,
    core.result.Result.Insts.CoreOpsTry_traitFromResidualResult.from_residual]
  all_goals try omega
  · have h := arithmetic_refines ctx.spent ctx.amount ctx.daily_limit
    simp [arithmetic, observe, outcome, error, word,
      core.result.Result.Insts.CoreOpsTry.branch,
      core.result.Result.Insts.CoreOpsTry_traitFromResidualResult.from_residual]
      at h
    convert h using 1
    congr 6
  · have h := arithmetic_refines 0#u64 ctx.amount ctx.daily_limit
    simp [arithmetic, observe, outcome, error, word,
      core.result.Result.Insts.CoreOpsTry.branch,
      core.result.Result.Insts.CoreOpsTry_traitFromResidualResult.from_residual]
      at h
    convert h using 1
    congr 6

def scalar (x : NativeDaily.U64) : U64 := U64.ofNatCore x.val x.isLt

def nativeError : NativeDaily.PolicyError → allowit_kernel.policy_api.PolicyError
  | .notApproved => .NotApproved
  | .zeroAmount => .ZeroAmount
  | .parameterOutOfBounds => .ParameterOutOfBounds
  | .clockWentBackwards => .ClockWentBackwards
  | .overflow => .Overflow
  | .dailyLimitExceeded => .DailyLimitExceeded

def nativeOutcome : Except NativeDaily.PolicyError NativeDaily.U64 →
    core.result.Result U64 allowit_kernel.policy_api.PolicyError
  | .ok x => .Ok (scalar x)
  | .error e => .Err (nativeError e)

theorem scalar_word (x : U64) : scalar (word x) = x := by
  apply UScalar.eq_of_val_eq
  simp [scalar, word]

theorem word_scalar (x : NativeDaily.U64) : word (scalar x) = x := by
  apply Fin.ext
  simp [word, scalar]

theorem native_outcome_roundtrip (x : core.result.Result U64 allowit_kernel.policy_api.PolicyError) :
    nativeOutcome (outcome x) = x := by
  cases x with
  | Ok x => simp [outcome, nativeOutcome, scalar_word]
  | Err e => cases e <;> rfl

theorem observe_returns (r : Aeneas.Std.Result (core.result.Result U64 allowit_kernel.policy_api.PolicyError))
    (x : Except NativeDaily.PolicyError NativeDaily.U64)
    (h : observe r = Aeneas.Std.Result.ok x) :
    r = Aeneas.Std.Result.ok (nativeOutcome x) := by
  cases r using Aeneas.Std.Result.cases with
  | ret value =>
    have ho : outcome value = x := by simpa [observe] using h
    rw [← ho, native_outcome_roundtrip]
  | vis e k =>
    have hm := congrArg Aeneas.Std.Result.match h
    simp [observe] at hm
  | div =>
    have hm := congrArg Aeneas.Std.Result.match h
    simp [observe] at hm

/-- Exact equality includes a terminating return, all six errors, and the successful u64 value. -/
theorem evaluate_exact (ctx : allowit_kernel.policy_api.Context) :
    allowit_kernel.policy.evaluate ctx =
      Aeneas.Std.Result.ok (nativeOutcome (NativeDaily.evaluate (context ctx))) :=
  observe_returns _ _ (evaluate_refines ctx)

def nativeContext (x : NativeDaily.Context) : allowit_kernel.policy_api.Context :=
  { approved := x.approved, amount := scalar x.amount,
    daily_limit := scalar x.dailyLimit, spent := scalar x.spent,
    spent_day := scalar x.spentDay, now := scalar x.now }

theorem context_roundtrip (x : NativeDaily.Context) : context (nativeContext x) = x := by
  cases x
  simp [context, nativeContext, word_scalar]

/-- Every specification input is represented; no permissive precondition restricts the proof domain. -/
theorem evaluate_all_inputs (ctx : NativeDaily.Context) :
    allowit_kernel.policy.evaluate (nativeContext ctx) =
      Aeneas.Std.Result.ok (nativeOutcome (NativeDaily.evaluate ctx)) := by
  simpa [context_roundtrip] using evaluate_exact (nativeContext ctx)

/-- The model's independently checked successful witness also succeeds in the extracted kernel. -/
theorem extracted_exact_limit_witness :
    allowit_kernel.policy.evaluate (nativeContext NativeDaily.exampleContext) =
      Aeneas.Std.Result.ok (core.result.Result.Ok (scalar ⟨25, by decide⟩)) := by
  rw [evaluate_all_inputs, NativeDaily.exact_limit_example_succeeds]
  rfl

theorem outcome_native_roundtrip (x : Except NativeDaily.PolicyError NativeDaily.U64) :
    outcome (nativeOutcome x) = x := by
  cases x with
  | ok value => simp [outcome, nativeOutcome, word_scalar]
  | error e => cases e <;> rfl

/-- Permission and returned spend agree with the independently stated declarative predicate. -/
theorem extracted_permission_iff (ctx : NativeDaily.Context) (next : NativeDaily.U64) :
    allowit_kernel.policy.evaluate (nativeContext ctx) =
        Aeneas.Std.Result.ok (core.result.Result.Ok (scalar next)) ↔
    NativeDaily.validRequest ctx ∧ next.val = NativeDaily.effectiveSpent ctx + ctx.amount.val := by
  rw [evaluate_all_inputs]
  change Aeneas.Std.Result.ok (nativeOutcome (NativeDaily.evaluate ctx)) =
      Aeneas.Std.Result.ok (nativeOutcome (.ok next)) ↔ _
  constructor
  · intro h
    have h' := congrArg outcome (Aeneas.Std.Result.ok_injective h)
    simp only [outcome_native_roundtrip] at h'
    exact (NativeDaily.success_iff ctx next).mp h'
  · intro h
    rw [(NativeDaily.success_iff ctx next).mpr h]

#print axioms validate_refines
#print axioms arithmetic_refines
#print axioms evaluate_refines
#print axioms scalar_word
#print axioms word_scalar
#print axioms native_outcome_roundtrip
#print axioms observe_returns
#print axioms evaluate_exact
#print axioms context_roundtrip
#print axioms evaluate_all_inputs
#print axioms extracted_exact_limit_witness
#print axioms outcome_native_roundtrip
#print axioms extracted_permission_iff
end AllowIt.Refinement
