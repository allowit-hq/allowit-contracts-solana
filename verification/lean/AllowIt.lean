import Std

/- A small executable model, not a proof of the Rust SDK or Go gateway. -/
namespace AllowIt

inductive Feature where
  | confidence_evidence
  | owner_input
  | purchase_history
  | runtime_context_u64
  | semantic_evidence
  deriving DecidableEq, Repr

def Feature.name : Feature → String
  | .confidence_evidence => "confidence_evidence"
  | .owner_input => "owner_input"
  | .purchase_history => "purchase_history"
  | .runtime_context_u64 => "runtime_context_u64"
  | .semantic_evidence => "semantic_evidence"

/- Branch conditions are observations. They do not classify natural-language claims. -/
inductive Flow where
  | done
  | use (feature : Feature)
  | seq (first second : Flow)
  | branch (condition : Bool) (yes no : Flow)
  deriving Repr

def required : Flow → List Feature
  | .done => []
  | .use feature => [feature]
  | .seq first second => required first ++ required second
  | .branch _ yes no => required yes ++ required no

def traversed : Flow → List Feature
  | .done => []
  | .use feature => [feature]
  | .seq first second => traversed first ++ traversed second
  | .branch condition yes no => if condition then traversed yes else traversed no

/- A conservative all-branch selection, with duplicate fragments removed. -/
def selected (flow : Flow) : List Feature :=
  [ .confidence_evidence, .owner_input, .purchase_history,
    .runtime_context_u64, .semantic_evidence ].filter (fun feature => decide (feature ∈ required flow))

theorem traversed_is_required (flow : Flow) (feature : Feature)
    (h : feature ∈ traversed flow) : feature ∈ required flow := by
  induction flow with
  | done => simp [traversed] at h
  | use other => exact h
  | seq first second ihFirst ihSecond =>
    simp only [traversed, List.mem_append] at h
    simp only [required, List.mem_append]
    cases h with
    | inl h => exact Or.inl (ihFirst h)
    | inr h => exact Or.inr (ihSecond h)
  | branch condition yes no ihYes ihNo =>
    simp only [required, List.mem_append]
    cases condition with
    | false => exact Or.inr (ihNo (by simpa [traversed] using h))
    | true => exact Or.inl (ihYes (by simpa [traversed] using h))

theorem selected_exactly_required (flow : Flow) (feature : Feature) :
    feature ∈ selected flow ↔ feature ∈ required flow := by
  cases feature <;> simp [selected]

theorem selected_covers_traversal (flow : Flow) (feature : Feature)
    (h : feature ∈ traversed flow) : feature ∈ selected flow :=
  (selected_exactly_required flow feature).mpr (traversed_is_required flow feature h)

/- Minimal by feature membership, not by word count or reachable policy paths. -/
theorem selected_is_minimal (flow : Flow) (candidate : List Feature)
    (covers : ∀ f, f ∈ required flow → f ∈ candidate) :
    ∀ f, f ∈ selected flow → f ∈ candidate := by
  intro feature h
  exact covers feature ((selected_exactly_required flow feature).mp h)

def supported (flow : Flow) (available : List Feature) : Prop :=
  ∀ feature, feature ∈ required flow → feature ∈ available

theorem missing_capability_is_not_supported (flow : Flow) (available : List Feature)
    (feature : Feature) (needed : feature ∈ selected flow)
    (missing : feature ∉ available) : ¬ supported flow available := by
  intro h
  exact missing (h feature ((selected_exactly_required flow feature).mp needed))

abbrev Amount := Fin (2 ^ 64)
abbrev Bps := Fin 10001

structure Thresholds where
  autoApprove : Bool
  approve : Bps
  autoDeny : Bool
  deny : Bps
  deriving Repr

structure Interval where
  lower : Bps
  upper : Bps
  ordered : lower.val ≤ upper.val

inductive Outcome where
  | pass
  | deny
  | needsEvidence
  | unresolved
  deriving DecidableEq, Repr

def accepts (thresholds : Thresholds) (interval : Interval) : Prop :=
  ¬ (thresholds.autoDeny = true ∧ interval.upper.val ≤ thresholds.deny.val) ∧
  thresholds.autoApprove = true ∧ thresholds.approve.val ≤ interval.lower.val

instance (thresholds : Thresholds) (interval : Interval) :
    Decidable (accepts thresholds interval) := inferInstanceAs
      (Decidable (¬ (thresholds.autoDeny = true ∧ interval.upper.val ≤ thresholds.deny.val) ∧
        thresholds.autoApprove = true ∧ thresholds.approve.val ≤ interval.lower.val))

def assess (thresholds : Thresholds) : Option Interval → Outcome
  | none =>
    if thresholds.autoApprove = false ∧ thresholds.autoDeny = false then .unresolved
    else .needsEvidence
  | some interval =>
    if thresholds.autoDeny = true ∧ interval.upper.val ≤ thresholds.deny.val then .deny
    else if thresholds.autoApprove = true ∧ thresholds.approve.val ≤ interval.lower.val then .pass
    else .unresolved

theorem assessment_pass_iff (thresholds : Thresholds) (evidence : Option Interval) :
    assess thresholds evidence = .pass ↔
      ∃ interval, evidence = some interval ∧ accepts thresholds interval := by
  cases evidence with
  | none =>
    by_cases off : thresholds.autoApprove = false ∧ thresholds.autoDeny = false <;>
      simp [assess, off]
  | some interval =>
    by_cases hd : thresholds.autoDeny = true ∧ interval.upper.val ≤ thresholds.deny.val
    · simp [assess, accepts, hd] <;> omega
    · by_cases ha : thresholds.autoApprove = true ∧ thresholds.approve.val ≤ interval.lower.val
      · simp [assess, accepts, hd, ha]
        intro enabled
        exact Nat.lt_of_not_ge (fun bound => hd ⟨enabled, bound⟩)
      · simp [assess, accepts, hd, ha] <;> omega

theorem missing_evidence_never_passes (thresholds : Thresholds) :
    assess thresholds none ≠ .pass := by
  by_cases off : thresholds.autoApprove = false ∧ thresholds.autoDeny = false <;>
    simp [assess, off]

theorem both_disabled_is_unresolved (thresholds : Thresholds) (evidence : Option Interval)
    (approveOff : thresholds.autoApprove = false) (denyOff : thresholds.autoDeny = false) :
    assess thresholds evidence = .unresolved := by
  cases evidence <;> simp [assess, approveOff, denyOff]

structure Request where
  amount : Amount
  allocation : Amount
  committed : Amount
  evidence : String → Option Interval

def budgetAllows (cap : Amount) (request : Request) : Prop :=
  0 < request.amount.val ∧
  request.committed.val + request.amount.val ≤ request.allocation.val ∧
  request.committed.val + request.amount.val ≤ cap.val

instance (cap : Amount) (request : Request) : Decidable (budgetAllows cap request) :=
  inferInstanceAs (Decidable (0 < request.amount.val ∧
    request.committed.val + request.amount.val ≤ request.allocation.val ∧
    request.committed.val + request.amount.val ≤ cap.val))

inductive Policy where
  | permit
  | budget (cap : Amount)
  | classification (question : String) (thresholds : Thresholds)
  | both (first second : Policy)

def evaluate : Policy → Request → Outcome
  | .permit, _ => .pass
  | .budget cap, request => if budgetAllows cap request then .pass else .deny
  | .classification question thresholds, request => assess thresholds (request.evidence question)
  | .both first second, request =>
    match evaluate first request with
    | .pass => evaluate second request
    | other => other

/- Declarative permission specification, separate from ordered execution. -/
def satisfies : Policy → Request → Prop
  | .permit, _ => True
  | .budget cap, request => budgetAllows cap request
  | .classification question thresholds, request =>
    ∃ interval, request.evidence question = some interval ∧ accepts thresholds interval
  | .both first second, request => satisfies first request ∧ satisfies second request

theorem pass_iff_specification (policy : Policy) (request : Request) :
    evaluate policy request = .pass ↔ satisfies policy request := by
  induction policy with
  | permit => simp [evaluate, satisfies]
  | budget cap => simp [evaluate, satisfies]
  | classification question thresholds =>
    exact assessment_pass_iff thresholds (request.evidence question)
  | both first second ihFirst ihSecond =>
    cases h : evaluate first request <;>
      simp [evaluate, satisfies, h, ← ihFirst, ← ihSecond]

def budgets : Policy → List Amount
  | .permit => []
  | .budget cap => [cap]
  | .classification _ _ => []
  | .both first second => budgets first ++ budgets second

theorem passing_preserves_every_budget (policy : Policy) (request : Request)
    (passed : evaluate policy request = .pass) :
    ∀ cap, cap ∈ budgets policy → budgetAllows cap request := by
  have hs := (pass_iff_specification policy request).mp passed
  clear passed
  induction policy with
  | permit => simp [budgets]
  | budget bound =>
    intro cap h
    simp [budgets] at h
    simpa [h, satisfies] using hs
  | classification question thresholds => simp [budgets]
  | both first second ihFirst ihSecond =>
    intro cap h
    simp only [budgets, List.mem_append] at h
    cases h with
    | inl h => exact ihFirst hs.1 cap h
    | inr h => exact ihSecond hs.2 cap h

theorem allowed_budget_cannot_overflow (cap : Amount) (request : Request)
    (allowed : budgetAllows cap request) :
    request.committed.val + request.amount.val < 2 ^ 64 :=
  Nat.lt_of_le_of_lt allowed.2.2 cap.isLt

/- No theorem below assumes that the classifier's assessment is true or calibrated. -/
theorem classification_cannot_bypass_budget (cap : Amount) (request : Request)
    (question : String) (thresholds : Thresholds)
    (passed : evaluate (.both (.classification question thresholds) (.budget cap)) request = .pass) :
    budgetAllows cap request :=
  ((pass_iff_specification _ request).mp passed).2

def exampleThresholds : Thresholds :=
  { autoApprove := true, approve := ⟨9000, by decide⟩,
    autoDeny := true, deny := ⟨3000, by decide⟩ }

def examplePolicy : Policy :=
  .both (.budget ⟨25000000, by decide⟩) (.classification "Research" exampleThresholds)

def exampleInterval : Interval where
  lower := ⟨9000, by decide⟩
  upper := ⟨9500, by decide⟩
  ordered := by decide

def exampleRequest : Request :=
  { amount := ⟨1000000, by decide⟩,
    allocation := ⟨25000000, by decide⟩,
    committed := ⟨0, by decide⟩,
    evidence := fun _ => some exampleInterval }

/- An allowed witness rules out a vacuous deny-all demonstration. -/
theorem example_passes : evaluate examplePolicy exampleRequest = .pass := by decide

#eval evaluate examplePolicy exampleRequest

#print axioms traversed_is_required
#print axioms selected_exactly_required
#print axioms selected_covers_traversal
#print axioms selected_is_minimal
#print axioms missing_capability_is_not_supported
#print axioms assessment_pass_iff
#print axioms missing_evidence_never_passes
#print axioms both_disabled_is_unresolved
#print axioms pass_iff_specification
#print axioms passing_preserves_every_budget
#print axioms allowed_budget_cannot_overflow
#print axioms classification_cannot_bypass_budget
#print axioms example_passes

end AllowIt
