import State

/- Independently specified finite-store projection. Digest/identifier equality is
   symbolic; this does not authenticate bytes, runtime logs or execution. -/
namespace AllowIt.Transaction

structure Account where
  owner : Nat
  lamports : Nat
  executable : Bool
  rentEpoch : Nat
  dataDigest : Nat
  deriving DecidableEq, Repr

abbrev Store := List (Nat × Account)
def keys (s : Store) := s.map Prod.fst
def protectedAccounts (s : Store) (payer : Nat) := s.filter (fun e => e.1 != payer)
def charge (s : Store) (payer fee : Nat) : Store :=
  s.map (fun e => if e.1 = payer then (e.1, {e.2 with lamports := e.2.lamports - fee}) else e)
def funded (s : Store) (payer fee : Nat) : Prop :=
  ∃ a, (payer, a) ∈ s ∧ fee ≤ a.lamports
def FeeFrame (s t : Store) (payer fee : Nat) : Prop :=
  (keys s).Nodup ∧ funded s payer fee ∧ t = charge s payer fee

inductive Failure where
  | beforeExecution
  | executedAbort
  deriving DecidableEq, Repr

/-- Recent-blockhash fixture profile; expectedFee is supplied, not calculated here.
    Failure-site classification is outside this postcondition relation. -/
inductive FailureEffect : Store → Store → Nat → Failure → Nat → Prop where
  | before (s payer) (unique : (keys s).Nodup) :
      FailureEffect s s payer .beforeExecution 0
  | abort (s t payer fee) (frame : FeeFrame s t payer fee) :
      FailureEffect s t payer .executedAbort fee

theorem charge_keys : keys (charge s payer fee) = keys s := by
  induction s with
  | nil => rfl
  | cons e es ih =>
      simp only [charge, List.map_cons, keys, List.map_cons] at *
      split <;> simp_all

theorem charge_protected : protectedAccounts (charge s payer fee) payer = protectedAccounts s payer := by
  induction s with
  | nil => rfl
  | cons e es ih =>
      by_cases h : e.1 = payer
      · simp_all [charge, protectedAccounts]
      · simp_all [charge, protectedAccounts]

theorem charge_zero : charge s payer 0 = s := by
  induction s with
  | nil => rfl
  | cons e es ih =>
      rcases e with ⟨id, a⟩
      cases a
      by_cases h : id = payer <;> simp_all [charge]

theorem fee_frame_protected (h : FeeFrame s t payer fee) :
    protectedAccounts t payer = protectedAccounts s payer := by
  rw [h.2.2]; exact charge_protected

theorem fee_frame_keys (h : FeeFrame s t payer fee) : keys t = keys s := by
  rw [h.2.2]; exact charge_keys

theorem failure_protected (h : FailureEffect s t payer outcome fee) :
    protectedAccounts t payer = protectedAccounts s payer := by
  cases h with
  | before => rfl
  | abort => exact fee_frame_protected (by assumption)

theorem before_execution_unchanged
    (h : FailureEffect s t payer .beforeExecution fee) : t = s ∧ fee = 0 := by
  cases h; exact ⟨rfl, rfl⟩

theorem abort_iff : FailureEffect s t payer .executedAbort fee ↔ FeeFrame s t payer fee := by
  constructor
  · intro h; cases h; assumption
  · intro h; exact FailureEffect.abort s t payer fee h

/-- Nonvacuity/converse for every funded unique finite store, not an implementation claim. -/
theorem funded_abort_exists (unique : (keys s).Nodup) (pay : funded s payer fee) :
    ∃ t, FailureEffect s t payer .executedAbort fee := by
  exact ⟨charge s payer fee, FailureEffect.abort _ _ _ _ ⟨unique, pay, rfl⟩⟩

/-- Exact debit arithmetic requires funding; natural subtraction cannot hide underflow. -/
theorem funded_debit_exact {fee balance : Nat} (h : fee ≤ balance) : balance - fee + fee = balance :=
  Nat.sub_add_cancel h

#print axioms charge_keys
#print axioms charge_protected
#print axioms charge_zero
#print axioms fee_frame_protected
#print axioms fee_frame_keys
#print axioms failure_protected
#print axioms before_execution_unchanged
#print axioms abort_iff
#print axioms funded_abort_exists
#print axioms funded_debit_exact
end AllowIt.Transaction
