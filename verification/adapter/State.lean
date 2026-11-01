import NativeDaily

/- Independent successful-transition requirements. This is not extracted adapter code.
   Identifiers abstract authenticated byte identities; ready is a named environment
   precondition, not a proof of account decoding, CPI, rollback or token behavior. -/
namespace AllowIt.Adapter
open NativeDaily

structure Module where
  address : Nat
  source : Nat
  artifact : Nat
  deriving DecidableEq, Repr

structure Actor where
  identity : Nat
  signed : Bool
  deriving DecidableEq, Repr

structure State where
  custody : Nat
  owner : Nat
  executor : Nat
  asset : Nat
  policy : Module
  limit : U64
  spent : U64
  spentDay : U64
  nonce : U64
  revision : U64
  approved : Bool
  balance : Nat
  deriving DecidableEq, Repr

inductive Action where
  | deposit (actor : Actor) (amount : U64)
  | withdraw (actor : Actor) (recipient : Nat) (amount : U64)
  | approve (actor : Actor) (value : Bool) (revision : U64)
  | tune (actor : Actor) (value revision : U64)
  | switchPolicy (actor : Actor) (policy : Module) (revision : U64)
  | transfer (actor : Actor) (recipient : Nat) (amount nonce revision now : U64)
  | read
  | unsupported (method : Nat)
  deriving DecidableEq, Repr

def authorized (actor : Actor) (identity : Nat) : Prop :=
  actor.signed = true ∧ actor.identity = identity

def context (s : State) (amount now : U64) : NativeDaily.Context :=
  { approved := s.approved, amount, dailyLimit := s.limit,
    spent := s.spent, spentDay := s.spentDay, now }

def accounting (s : State) := (s.spent, s.spentDay, s.nonce)
def control (s : State) :=
  (s.custody, s.owner, s.executor, s.asset, s.policy, s.limit,
    s.spent, s.spentDay, s.nonce, s.revision, s.approved)

def successor (x : U64) (h : x.val + 1 < 2 ^ 64) : U64 := ⟨x.val + 1, h⟩

def approveState (s : State) (value : Bool) (h : s.revision.val + 1 < 2 ^ 64) :=
  { s with approved := value, revision := successor s.revision h }
def tuneState (s : State) (value : U64) (h : s.revision.val + 1 < 2 ^ 64) :=
  { s with limit := value, revision := successor s.revision h }
def switchState (s : State) (policy : Module) (h : s.revision.val + 1 < 2 ^ 64) :=
  { s with policy, approved := false, revision := successor s.revision h }
def dayWord (now : U64) : U64 :=
  ⟨now.val / daySeconds, Nat.lt_of_le_of_lt (Nat.div_le_self _ _) now.isLt⟩

def spendState (s : State) (amount now next : U64) (h : s.nonce.val + 1 < 2 ^ 64) :=
  { s with spent := next, spentDay := dayWord now, nonce := successor s.nonce h, balance := s.balance - amount.val }

/-- Successful effects, conditional on authenticated platform prerequisites.
    ready includes native asset/recipient/amount representability, artifact checks,
    and successful token execution. It is intentionally not inferred from metadata. -/
inductive Transition (ready : State → Action → Prop) : State → Action → State → Prop where
  | deposit (s a amount) (auth : a.signed = true) (positive : 0 < amount.val)
      (environment : ready s (.deposit a amount)) :
      Transition ready s (.deposit a amount) { s with balance := s.balance + amount.val }
  | withdraw (s a recipient amount) (auth : authorized a s.owner)
      (positive : 0 < amount.val) (funded : amount.val ≤ s.balance)
      (environment : ready s (.withdraw a recipient amount)) :
      Transition ready s (.withdraw a recipient amount) { s with balance := s.balance - amount.val }
  | approve (s a value revision) (auth : authorized a s.owner) (current : revision = s.revision)
      (fits : s.revision.val + 1 < 2 ^ 64) (environment : ready s (.approve a value revision)) :
      Transition ready s (.approve a value revision) (approveState s value fits)
  | tune (s a value revision) (auth : authorized a s.owner) (current : revision = s.revision)
      (bounded : value.val ≤ maxDailyLimit) (fits : s.revision.val + 1 < 2 ^ 64)
      (environment : ready s (.tune a value revision)) :
      Transition ready s (.tune a value revision) (tuneState s value fits)
  | switchPolicy (s a policy revision) (auth : authorized a s.owner) (current : revision = s.revision)
      (fits : s.revision.val + 1 < 2 ^ 64) (environment : ready s (.switchPolicy a policy revision)) :
      Transition ready s (.switchPolicy a policy revision) (switchState s policy fits)
  | transfer (s a recipient amount nonce revision now next)
      (auth : authorized a s.executor) (current : revision = s.revision) (fresh : nonce = s.nonce)
      (permission : validRequest (context s amount now))
      (exact : next.val = effectiveSpent (context s amount now) + amount.val)
      (fits : s.nonce.val + 1 < 2 ^ 64) (funded : amount.val ≤ s.balance)
      (environment : ready s (.transfer a recipient amount nonce revision now)) :
      Transition ready s (.transfer a recipient amount nonce revision now)
        (spendState s amount now next fits)
  | read (s) (environment : ready s .read) : Transition ready s .read s

/-- A maintenance trace excludes executor transfers and initialization. -/
inductive MaintenanceAction : Action → Prop where
  | deposit (a amount) : MaintenanceAction (.deposit a amount)
  | withdraw (a recipient amount) : MaintenanceAction (.withdraw a recipient amount)
  | approve (a value revision) : MaintenanceAction (.approve a value revision)
  | tune (a value revision) : MaintenanceAction (.tune a value revision)
  | switchPolicy (a policy revision) : MaintenanceAction (.switchPolicy a policy revision)
  | read : MaintenanceAction .read

inductive Maintenance (ready : State → Action → Prop) : State → State → Prop where
  | refl (s) : Maintenance ready s s
  | step (s t u action) (transition : Transition ready s action t)
      (maintenance : MaintenanceAction action) (rest : Maintenance ready t u) : Maintenance ready s u

theorem maintenance_frame (h : Transition ready s action t) (hm : MaintenanceAction action) :
    accounting t = accounting s := by
  cases h <;> try rfl
  cases hm

theorem maintenance_trace_frame (h : Maintenance ready s t) : accounting t = accounting s := by
  induction h with
  | refl => rfl
  | step _ _ _ _ transition maintenance _ ih =>
    exact ih.trans (maintenance_frame transition maintenance)

theorem deposit_control (h : Transition ready s (.deposit a amount) t) :
    control t = control s ∧ t.balance = s.balance + amount.val := by cases h; exact ⟨rfl, rfl⟩

theorem withdraw_control (h : Transition ready s (.withdraw a recipient amount) t) :
    control t = control s ∧ t.balance + amount.val = s.balance := by
  cases h
  constructor
  · rfl
  · exact Nat.sub_add_cancel (by assumption)

theorem tuning_frame (h : Transition ready s (.tune a value revision) t) :
    accounting t = accounting s ∧ t.approved = s.approved ∧ t.limit = value ∧
    t.revision.val = s.revision.val + 1 ∧ t.balance = s.balance := by cases h; exact ⟨rfl, rfl, rfl, rfl, rfl⟩

theorem switch_revokes (h : Transition ready s (.switchPolicy a policy revision) t) :
    t.approved = false ∧ accounting t = accounting s ∧ t.policy = policy ∧
    t.revision.val = s.revision.val + 1 ∧ t.balance = s.balance := by cases h; exact ⟨rfl, rfl, rfl, rfl, rfl⟩

theorem transfer_authorized (h : Transition ready s (.transfer a recipient amount nonce revision now) t) :
    authorized a s.executor ∧ nonce = s.nonce ∧ revision = s.revision := by
  cases h; exact ⟨by assumption, by assumption, by assumption⟩

theorem transfer_kernel (h : Transition ready s (.transfer a recipient amount nonce revision now) t) :
    NativeDaily.evaluate (context s amount now) = .ok t.spent := by
  cases h
  apply (NativeDaily.success_iff _ _).mpr
  exact ⟨by assumption, by assumption⟩

theorem transfer_effects (h : Transition ready s (.transfer a recipient amount nonce revision now) t) :
    t.nonce.val = s.nonce.val + 1 ∧ t.spentDay.val = now.val / daySeconds ∧
    t.balance + amount.val = s.balance ∧ t.revision = s.revision ∧ t.policy = s.policy := by
  cases h
  exact ⟨rfl, rfl, Nat.sub_add_cancel (by assumption), rfl, rfl⟩

/-- Converse: every stated precondition admits the specified successful effect. -/
theorem transfer_complete
    (auth : authorized a s.executor) (current : revision = s.revision) (fresh : nonce = s.nonce)
    (permission : validRequest (context s amount now))
    (exact : next.val = effectiveSpent (context s amount now) + amount.val)
    (fits : s.nonce.val + 1 < 2 ^ 64) (funded : amount.val ≤ s.balance)
    (environment : ready s (.transfer a recipient amount nonce revision now)) :
    Transition ready s (.transfer a recipient amount nonce revision now)
      (spendState s amount now next fits) :=
  Transition.transfer s a recipient amount nonce revision now next auth current fresh
    permission exact fits funded environment

theorem exhausted_nonce_cannot_transfer (exhausted : s.nonce.val + 1 = 2 ^ 64) :
    ¬ Transition ready s (.transfer a recipient amount nonce revision now) t := by
  intro h; cases h; omega

theorem switch_blocks_transfer (h : Transition ready s (.switchPolicy a policy revision) t) :
    ¬ Transition ready t (.transfer executor recipient amount nonce requestRevision now) u := by
  intro transfer
  have revoked := (switch_revokes h).1
  have permitted := NativeDaily.success_iff _ _ |>.mp (transfer_kernel transfer)
  have approved := permitted.1.1
  change t.approved = true at approved
  simp_all

theorem lowering_below_spent_blocks_same_day
    (h : Transition ready s (.tune a value revision) t) (lowered : value.val < s.spent.val)
    (sameDay : now.val / daySeconds = s.spentDay.val) :
    ¬ Transition ready t (.transfer executor recipient amount nonce requestRevision now) u := by
  intro transfer
  have frame := tuning_frame h
  have fields := frame.1
  have spent := congrArg (fun x => x.1) fields
  have spentDay := congrArg (fun x => x.2.1) fields
  change t.spent = s.spent at spent
  change t.spentDay = s.spentDay at spentDay
  have limit := frame.2.2.1
  apply NativeDaily.same_day_lower_limit_never_succeeds (context t amount now)
      (by simpa [context, NativeDaily.day] using sameDay.trans (congrArg Fin.val spentDay.symm))
      (by simpa [context, limit, spent] using lowered) u.spent (transfer_kernel transfer)

theorem transfer_replay_after_maintenance
    (h : Transition ready s (.transfer a recipient amount nonce revision now) t)
    (hm : Maintenance ready t u) :
    ¬ Transition ready u (.transfer a recipient amount nonce revision later) v := by
  intro replay
  have oldNonce := (transfer_authorized h).2.1
  have newNonce := (transfer_authorized replay).2.1
  have advance := (transfer_effects h).1
  have frame := congrArg (fun x => x.2.2) (maintenance_trace_frame hm)
  change u.nonce = t.nonce at frame
  have eq : s.nonce.val = t.nonce.val := congrArg Fin.val (oldNonce.symm.trans (newNonce.trans frame))
  omega

/-- The independent kernel predicate rejects earlier day buckets. -/
theorem transfer_day_monotone (h : Transition ready s (.transfer a recipient amount nonce revision now) t) :
    s.spentDay.val ≤ t.spentDay.val := by
  have permission := ((NativeDaily.success_iff _ _).mp (transfer_kernel h)).1
  have time := permission.2.2.2.1
  cases h
  exact time

inductive Trace (ready : State → Action → Prop) : State → State → Prop where
  | refl (s) : Trace ready s s
  | step (s t u action) (transition : Transition ready s action t)
      (rest : Trace ready t u) : Trace ready s u

theorem nonce_step_monotone (h : Transition ready s action t) : s.nonce.val ≤ t.nonce.val := by
  cases h <;> simp [approveState, tuneState, switchState, spendState, successor]

theorem trace_nonce_monotone (h : Trace ready s t) : s.nonce.val ≤ t.nonce.val := by
  induction h with
  | refl => exact Nat.le_refl _
  | step _ _ _ _ transition _ ih => exact Nat.le_trans (nonce_step_monotone transition) ih

/-- Any later request reusing the consumed nonce fails, even with a new recipient/revision/time. -/
theorem transfer_replay_after_any_trace
    (h : Transition ready s (.transfer a recipient amount nonce revision now) t)
    (trace : Trace ready t u) :
    ¬ Transition ready u (.transfer laterActor laterRecipient laterAmount nonce laterRevision laterTime) v := by
  intro replay
  have oldNonce := congrArg Fin.val (transfer_authorized h).2.1
  have newNonce := congrArg Fin.val (transfer_authorized replay).2.1
  have advance := (transfer_effects h).1
  have monotone := trace_nonce_monotone trace
  omega

theorem unsupported_never_succeeds : ¬ Transition ready s (.unsupported method) t := by
  intro h; cases h

theorem read_preserves_state (h : Transition ready s .read t) : t = s := by cases h; rfl

/-- New activation creates a new custody identity; no global-wallet cap is asserted. -/
def initial (custody owner executor asset : Nat) (policy : Module) (limit now : U64) : State :=
  { custody, owner, executor, asset, policy, limit,
    spent := ⟨0, by decide⟩, spentDay := dayWord now,
    nonce := ⟨0, by decide⟩, revision := ⟨0, by decide⟩, approved := false, balance := 0 }

def witness : State :=
  { (initial 1 2 3 4 ⟨5, 6, 7⟩ ⟨25, by decide⟩ ⟨86401, by decide⟩) with
    spent := ⟨15, by decide⟩, approved := true, balance := 100 }

theorem exact_limit_witness :
    Transition (fun _ _ => True) witness
      (.transfer ⟨3, true⟩ 9 ⟨10, by decide⟩ ⟨0, by decide⟩ ⟨0, by decide⟩ ⟨86401, by decide⟩)
      (spendState witness ⟨10, by decide⟩ ⟨86401, by decide⟩ ⟨25, by decide⟩ (by decide)) := by
  apply Transition.transfer
  · exact ⟨rfl, rfl⟩
  · rfl
  · rfl
  · exact ⟨rfl, by decide, by decide, by decide, by decide⟩
  · rfl
  · decide
  · trivial

#print axioms maintenance_frame
#print axioms maintenance_trace_frame
#print axioms deposit_control
#print axioms withdraw_control
#print axioms tuning_frame
#print axioms switch_revokes
#print axioms transfer_authorized
#print axioms transfer_kernel
#print axioms transfer_effects
#print axioms transfer_complete
#print axioms exhausted_nonce_cannot_transfer
#print axioms switch_blocks_transfer
#print axioms lowering_below_spent_blocks_same_day
#print axioms transfer_replay_after_maintenance
#print axioms transfer_day_monotone
#print axioms nonce_step_monotone
#print axioms trace_nonce_monotone
#print axioms transfer_replay_after_any_trace
#print axioms unsupported_never_succeeds
#print axioms read_preserves_state
#print axioms exact_limit_witness
end AllowIt.Adapter
