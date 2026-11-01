import Std

/-!
Executable specification of the native `policy/policy.rs` in the Solana and
Stellar contract repositories, inspected 2026-10-04. SHA-256 of that source:
eceb1d4f55c93ef7921f47f3ca0d35bc589c3c6a1b0f29ae63f5fb9f9ff37da8.

The field mapping is approved/approved, amount/amount, dailyLimit/daily_limit,
spent/spent, spentDay/spent_day, and now/now. Natural-number division implements
the source's unsigned division, and the explicit range check models checked_add.
Errors retain source order: approval, zero amount, parameter bound, day
regression, arithmetic overflow, then daily limit. Fin bounds every u64 input
and successful output. Amounts are six-decimal policy units.

These theorems prove this Lean specification, not Rust refinement, authentication,
transfers, storage updates, reservations, clock accuracy, upgrades or settlement.
Source identity is provenance, not a proof that deployed code has this behavior.
No external packages are required; checked with Lean 4.11.0.
-/
namespace AllowIt.NativeDaily

abbrev U64 := Fin (2 ^ 64)

def maxDailyLimit : Nat := 50000000
def daySeconds : Nat := 86400

structure Context where
  approved : Bool
  amount : U64
  dailyLimit : U64
  spent : U64
  spentDay : U64
  now : U64
  deriving Repr

inductive PolicyError where
  | notApproved
  | zeroAmount
  | parameterOutOfBounds
  | clockWentBackwards
  | overflow
  | dailyLimitExceeded
  deriving DecidableEq, Repr

def validateDailyLimit (value : U64) : Except PolicyError Unit :=
  if maxDailyLimit < value.val then .error .parameterOutOfBounds else .ok ()

def day (ctx : Context) : Nat := ctx.now.val / daySeconds

def effectiveSpent (ctx : Context) : Nat :=
  if day ctx = ctx.spentDay.val then ctx.spent.val else 0

def evaluate (ctx : Context) : Except PolicyError U64 :=
  if ctx.approved = false then .error .notApproved
  else if ctx.amount.val = 0 then .error .zeroAmount
  else match validateDailyLimit ctx.dailyLimit with
    | .error error => .error error
    | .ok () =>
      if day ctx < ctx.spentDay.val then .error .clockWentBackwards
      else
        let sum := effectiveSpent ctx + ctx.amount.val
        if h : sum < 2 ^ 64 then
          if ctx.dailyLimit.val < sum then .error .dailyLimitExceeded
          else .ok ⟨sum, h⟩
        else .error .overflow

/- Declarative permission does not duplicate ordered error control flow. -/
def validRequest (ctx : Context) : Prop :=
  ctx.approved = true ∧
  0 < ctx.amount.val ∧
  ctx.dailyLimit.val ≤ maxDailyLimit ∧
  ctx.spentDay.val ≤ day ctx ∧
  effectiveSpent ctx + ctx.amount.val ≤ ctx.dailyLimit.val

theorem validate_daily_limit_iff (value : U64) :
    validateDailyLimit value = .ok () ↔ value.val ≤ maxDailyLimit := by
  simp [validateDailyLimit]

theorem valid_request_sum_fits (ctx : Context) (h : validRequest ctx) :
    effectiveSpent ctx + ctx.amount.val < 2 ^ 64 :=
  Nat.lt_of_le_of_lt h.2.2.2.2 ctx.dailyLimit.isLt

theorem success_iff (ctx : Context) (next : U64) :
    evaluate ctx = .ok next ↔
      validRequest ctx ∧ next.val = effectiveSpent ctx + ctx.amount.val := by
  by_cases ha : ctx.approved = false
  · simp [evaluate, validRequest, ha]
  · have ht : ctx.approved = true := by cases h : ctx.approved <;> simp_all
    by_cases hz : ctx.amount.val = 0
    · simp [evaluate, validRequest, ha, hz]
    · by_cases hl : maxDailyLimit < ctx.dailyLimit.val
      · simp [evaluate, validateDailyLimit, validRequest, ha, hz, hl]
        omega
      · by_cases hd : day ctx < ctx.spentDay.val
        · simp [evaluate, validateDailyLimit, validRequest, ha, hz, hl, hd]
          omega
        · by_cases hf : effectiveSpent ctx + ctx.amount.val < 2 ^ 64
          · by_cases hb : ctx.dailyLimit.val < effectiveSpent ctx + ctx.amount.val
            · simp [evaluate, validateDailyLimit, validRequest, ha, hz, hl, hd, hf, hb]
              omega
            · have hp : validRequest ctx := ⟨ht, by omega, by omega, by omega, by omega⟩
              simp [evaluate, validateDailyLimit, ha, hz, hl, hd, hf, hb, hp,
                Fin.ext_iff, eq_comm]
          · have hn : ¬ validRequest ctx := fun h => hf (valid_request_sum_fits ctx h)
            simp [evaluate, validateDailyLimit, ha, hz, hl, hd, hf, hn]

theorem valid_request_succeeds (ctx : Context) (h : validRequest ctx) :
    ∃ next, evaluate ctx = .ok next := by
  let next : U64 := ⟨effectiveSpent ctx + ctx.amount.val, valid_request_sum_fits ctx h⟩
  exact ⟨next, (success_iff ctx next).mpr ⟨h, rfl⟩⟩

theorem returned_spend_exact (ctx : Context) (next : U64)
    (h : evaluate ctx = .ok next) :
    next.val = effectiveSpent ctx + ctx.amount.val ∧ next.val ≤ ctx.dailyLimit.val := by
  have hs := (success_iff ctx next).mp h
  exact ⟨hs.2, hs.2 ▸ hs.1.2.2.2.2⟩

/- Error theorems make the first failing condition explicit. -/
theorem not_approved_first (ctx : Context) (h : ctx.approved = false) :
    evaluate ctx = .error .notApproved := by simp [evaluate, h]

theorem zero_amount_next (ctx : Context) (ha : ctx.approved = true)
    (hz : ctx.amount.val = 0) :
    evaluate ctx = .error .zeroAmount := by simp [evaluate, ha, hz]

theorem invalid_parameter_next (ctx : Context) (ha : ctx.approved = true)
    (hz : ctx.amount.val ≠ 0) (hl : maxDailyLimit < ctx.dailyLimit.val) :
    evaluate ctx = .error .parameterOutOfBounds := by
  simp [evaluate, validateDailyLimit, ha, hz, hl]

theorem day_regression_error (ctx : Context) (ha : ctx.approved = true)
    (hz : ctx.amount.val ≠ 0) (hl : ctx.dailyLimit.val ≤ maxDailyLimit)
    (hd : day ctx < ctx.spentDay.val) :
    evaluate ctx = .error .clockWentBackwards := by
  simp [evaluate, validateDailyLimit, ha, hz, Nat.not_lt.mpr hl, hd]

theorem overflow_next (ctx : Context) (ha : ctx.approved = true)
    (hz : ctx.amount.val ≠ 0) (hl : ctx.dailyLimit.val ≤ maxDailyLimit)
    (hd : ctx.spentDay.val ≤ day ctx)
    (hf : 2 ^ 64 ≤ effectiveSpent ctx + ctx.amount.val) :
    evaluate ctx = .error .overflow := by
  simp [evaluate, validateDailyLimit, ha, hz, Nat.not_lt.mpr hl,
    Nat.not_lt.mpr hd, Nat.not_lt.mpr hf]

theorem exceeded_limit_last (ctx : Context) (ha : ctx.approved = true)
    (hz : ctx.amount.val ≠ 0) (hl : ctx.dailyLimit.val ≤ maxDailyLimit)
    (hd : ctx.spentDay.val ≤ day ctx)
    (hf : effectiveSpent ctx + ctx.amount.val < 2 ^ 64)
    (hb : ctx.dailyLimit.val < effectiveSpent ctx + ctx.amount.val) :
    evaluate ctx = .error .dailyLimitExceeded := by
  simp [evaluate, validateDailyLimit, ha, hz, Nat.not_lt.mpr hl,
    Nat.not_lt.mpr hd, hf, hb]

theorem day_regression_never_succeeds (ctx : Context)
    (hd : day ctx < ctx.spentDay.val) (next : U64) :
    evaluate ctx ≠ .ok next := by
  intro h
  have hs := ((success_iff ctx next).mp h).1.2.2.2.1
  omega

theorem zero_limit_never_succeeds (ctx : Context)
    (hl : ctx.dailyLimit.val = 0) (next : U64) :
    evaluate ctx ≠ .ok next := by
  intro h
  have hs := ((success_iff ctx next).mp h).1
  rcases hs with ⟨_, positive, _, _, budget⟩
  omega

theorem same_day_lower_limit_never_succeeds (ctx : Context)
    (hd : day ctx = ctx.spentDay.val) (hl : ctx.dailyLimit.val < ctx.spent.val)
    (next : U64) : evaluate ctx ≠ .ok next := by
  intro h
  have hs := ((success_iff ctx next).mp h).1.2.2.2.2
  simp [effectiveSpent, hd] at hs
  omega

theorem fresh_day_old_spend_irrelevant (ctx : Context) (oldSpent : U64)
    (hd : ctx.spentDay.val < day ctx) :
    evaluate { ctx with spent := oldSpent } = evaluate ctx := by
  have hn : day ctx ≠ ctx.spentDay.val := by omega
  simp [evaluate, validateDailyLimit, effectiveSpent, day] at *
  simp_all

def exampleContext : Context :=
  { approved := true, amount := ⟨10, by decide⟩,
    dailyLimit := ⟨25, by decide⟩, spent := ⟨15, by decide⟩,
    spentDay := ⟨1, by decide⟩, now := ⟨86401, by decide⟩ }

theorem exact_limit_example_succeeds :
    evaluate exampleContext = .ok ⟨25, by decide⟩ := by rfl

#eval evaluate exampleContext

#print axioms validate_daily_limit_iff
#print axioms valid_request_sum_fits
#print axioms success_iff
#print axioms valid_request_succeeds
#print axioms returned_spend_exact
#print axioms not_approved_first
#print axioms zero_amount_next
#print axioms invalid_parameter_next
#print axioms day_regression_error
#print axioms overflow_next
#print axioms exceeded_limit_last
#print axioms day_regression_never_succeeds
#print axioms zero_limit_never_succeeds
#print axioms same_day_lower_limit_never_succeeds
#print axioms fresh_day_old_spend_irrelevant
#print axioms exact_limit_example_succeeds

end AllowIt.NativeDaily
