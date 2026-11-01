import Certificates
namespace AllowIt.Refusals
open AllowIt.Adapter AllowIt.NativeDaily AllowIt.CustodyTraces
theorem tune_capacity {environment : State → Action → Prop} {s t : State} {a : Actor} {value revision : U64} (h : Transition environment s (.tune a value revision) t) : s.revision.val + 1 < 2 ^ 64 := by cases h; assumption
def request1 : Action := (.transfer ⟨5903126117980825649044795314168403145460822747660107186325288596481845824781, true⟩ 7719472615821079694904732333912527190217998977709370935963838933860875309329 ⟨1, by decide⟩ ⟨0, by decide⟩ ⟨0, by decide⟩ ⟨86401, by decide⟩)
theorem refuses_unapproved (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before1 request1 t := by
  intro h
  have impossible : ¬ validRequest (context before1 ⟨1, by decide⟩ ⟨86401, by decide⟩) := by unfold validRequest; decide
  exact impossible ((NativeDaily.success_iff _ _).mp (transfer_kernel h)).1
def request4 : Action := (.transfer ⟨5903126117980825649044795314168403145460822747660107186325288596481845824781, true⟩ 7719472615821079694904732333912527190217998977709370935963838933860875309329 ⟨1, by decide⟩ ⟨0, by decide⟩ ⟨1, by decide⟩ ⟨86401, by decide⟩)
theorem refuses_replay (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before4 request4 t := by
  intro h
  have impossible : ⟨0, by decide⟩ ≠ before4.nonce := by decide
  exact impossible (transfer_authorized h).2.1
def request6 : Action := (.transfer ⟨5903126117980825649044795314168403145460822747660107186325288596481845824781, true⟩ 7719472615821079694904732333912527190217998977709370935963838933860875309329 ⟨1, by decide⟩ ⟨1, by decide⟩ ⟨2, by decide⟩ ⟨86401, by decide⟩)
theorem refuses_lowered_denial (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before6 request6 t := by
  intro h
  have impossible : ¬ validRequest (context before6 ⟨1, by decide⟩ ⟨86401, by decide⟩) := by unfold validRequest; decide
  exact impossible ((NativeDaily.success_iff _ _).mp (transfer_kernel h)).1
def request8 : Action := (.transfer ⟨5903126117980825649044795314168403145460822747660107186325288596481845824781, true⟩ 7719472615821079694904732333912527190217998977709370935963838933860875309329 ⟨1, by decide⟩ ⟨1, by decide⟩ ⟨3, by decide⟩ ⟨86401, by decide⟩)
theorem refuses_paused_denial (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before8 request8 t := by
  intro h
  have impossible : ¬ validRequest (context before8 ⟨1, by decide⟩ ⟨86401, by decide⟩) := by unfold validRequest; decide
  exact impossible ((NativeDaily.success_iff _ _).mp (transfer_kernel h)).1
def request11 : Action := (.transfer ⟨5903126117980825649044795314168403145460822747660107186325288596481845824781, true⟩ 7719472615821079694904732333912527190217998977709370935963838933860875309329 ⟨1, by decide⟩ ⟨1, by decide⟩ ⟨3, by decide⟩ ⟨172800, by decide⟩)
theorem refuses_pause_new_day (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before11 request11 t := by
  intro h
  have impossible : ¬ validRequest (context before11 ⟨1, by decide⟩ ⟨172800, by decide⟩) := by unfold validRequest; decide
  exact impossible ((NativeDaily.success_iff _ _).mp (transfer_kernel h)).1
def request15 : Action := (.transfer ⟨5903126117980825649044795314168403145460822747660107186325288596481845824781, true⟩ 7719472615821079694904732333912527190217998977709370935963838933860875309329 ⟨1, by decide⟩ ⟨2, by decide⟩ ⟨5, by decide⟩ ⟨172800, by decide⟩)
theorem refuses_switch_revoked (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before15 request15 t := by
  intro h
  have impossible : ¬ validRequest (context before15 ⟨1, by decide⟩ ⟨172800, by decide⟩) := by unfold validRequest; decide
  exact impossible ((NativeDaily.success_iff _ _).mp (transfer_kernel h)).1
def request19 : Action := (.transfer ⟨5449039493520762137579811059232372134271528690147791248915651012137088453644, true⟩ 7719472615821079694904732333912527190217998977709370935963838933860875309329 ⟨1, by decide⟩ ⟨2, by decide⟩ ⟨8, by decide⟩ ⟨172800, by decide⟩)
theorem refuses_wrong_executor (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before19 request19 t := by
  intro h
  have impossible : ¬ authorized ⟨5449039493520762137579811059232372134271528690147791248915651012137088453644, true⟩ before19.executor := by unfold authorized; decide
  exact impossible (transfer_authorized h).1
def request20 : Action := (.transfer ⟨5903126117980825649044795314168403145460822747660107186325288596481845824781, false⟩ 7719472615821079694904732333912527190217998977709370935963838933860875309329 ⟨1, by decide⟩ ⟨2, by decide⟩ ⟨8, by decide⟩ ⟨172800, by decide⟩)
theorem refuses_unsigned_executor (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before20 request20 t := by
  intro h
  have impossible : ¬ authorized ⟨5903126117980825649044795314168403145460822747660107186325288596481845824781, false⟩ before20.executor := by unfold authorized; decide
  exact impossible (transfer_authorized h).1
def request21 : Action := (.transfer ⟨5903126117980825649044795314168403145460822747660107186325288596481845824781, true⟩ 7719472615821079694904732333912527190217998977709370935963838933860875309329 ⟨1, by decide⟩ ⟨2, by decide⟩ ⟨7, by decide⟩ ⟨172800, by decide⟩)
theorem refuses_stale_revision (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before21 request21 t := by
  intro h
  have impossible : ⟨7, by decide⟩ ≠ before21.revision := by decide
  exact impossible (transfer_authorized h).2.2
def request22 : Action := (.unsupported 19)
theorem refuses_unsupported (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before22 request22 t := by
  intro h
  cases h
def request23 : Action := (.transfer ⟨5903126117980825649044795314168403145460822747660107186325288596481845824781, true⟩ 7719472615821079694904732333912527190217998977709370935963838933860875309329 ⟨1, by decide⟩ ⟨18446744073709551615, by decide⟩ ⟨8, by decide⟩ ⟨172800, by decide⟩)
theorem refuses_nonce_overflow (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before23 request23 t := by
  intro h
  exact exhausted_nonce_cannot_transfer (by decide) h
def request24 : Action := (.tune ⟨5449039493520762137579811059232372134271528690147791248915651012137088453644, true⟩ ⟨1, by decide⟩ ⟨18446744073709551615, by decide⟩)
theorem refuses_revision_overflow (environment : State → Action → Prop) (t : State) :
    ¬ Transition environment before24 request24 t := by
  intro h
  have capacity := tune_capacity h
  have impossible : ¬ (before24.revision.val + 1 < 2 ^ 64) := by decide
  exact impossible capacity
def budgetRequest : Action := (.transfer ⟨5903126117980825649044795314168403145460822747660107186325288596481845824781, true⟩ 7719472615821079694904732333912527190217998977709370935963838933860875309329 ⟨1, by decide⟩ ⟨2, by decide⟩ ⟨8, by decide⟩ ⟨172800, by decide⟩)
theorem budget_model_permits : ∃ t, Transition (fun _ _ => True) before25 budgetRequest t := by
  refine ⟨spendState before25 ⟨1, by decide⟩ ⟨172800, by decide⟩ ⟨25000001, by decide⟩ (by decide), ?_⟩
  apply Transition.transfer
  all_goals first | decide | exact ⟨by decide, by decide⟩ | exact ⟨by decide, by decide, by decide, by decide, by decide⟩ | trivial
#print axioms tune_capacity
#print axioms refuses_unapproved
#print axioms refuses_replay
#print axioms refuses_lowered_denial
#print axioms refuses_paused_denial
#print axioms refuses_pause_new_day
#print axioms refuses_switch_revoked
#print axioms refuses_wrong_executor
#print axioms refuses_unsigned_executor
#print axioms refuses_stale_revision
#print axioms refuses_unsupported
#print axioms refuses_nonce_overflow
#print axioms refuses_revision_overflow
#print axioms budget_model_permits
end AllowIt.Refusals
