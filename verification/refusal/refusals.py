"""Generate finite nonpermission statements from unchanged captured request bytes."""
from pathlib import Path
import sys

TRACE=Path(__file__).resolve().parents[1]/'traces'
sys.path.insert(0,str(TRACE))
import certificates as corpus

CASES=[name for name in corpus.CASES if name in corpus.ERRORS and name!='budget_exhaustion_rollback']


def action(v):
    r=corpus.decode(v['data']);a=v['accounts']
    if r['tag']==7:return '(.unsupported '+str(int.from_bytes(bytes.fromhex(v['data'])[1:],'little'))+')'
    actor='⟨'+str(corpus.identity(a[1]['key']))+', '+str(a[1]['signed']).lower()+'⟩'
    if r['tag']==3:return f'(.tune {actor} {corpus.word(r["value"])} {corpus.word(r["revision"])})'
    if r['tag']==4:return f'(.transfer {actor} {corpus.identity(a[3]["key"])} '+ ' '.join(corpus.word(x) for x in [r['amount'],r['nonce'],r['revision'],v['now']])+')'
    raise ValueError('Unsupported refusal action')


def generate(vectors):
    corpus.generate(vectors)  # independently decoded raw images, tags and witnesses
    lines=['import Certificates','namespace AllowIt.Refusals','open AllowIt.Adapter AllowIt.NativeDaily AllowIt.CustodyTraces',
           'theorem tune_capacity {environment : State → Action → Prop} {s t : State} {a : Actor} {value revision : U64} (h : Transition environment s (.tune a value revision) t) : s.revision.val + 1 < 2 ^ 64 := by cases h; assumption']
    names=['tune_capacity']
    for i,v in enumerate(vectors):
        if v['name'] not in CASES:continue
        name='refuses_'+v['name'];r=corpus.decode(v['data']);act=action(v)
        lines += [f'def request{i} : Action := {act}',f'theorem {name} (environment : State → Action → Prop) (t : State) :',f'    ¬ Transition environment before{i} request{i} t := by', '  intro h']
        if v['name']=='unsupported':lines+=['  cases h']
        elif v['name']=='revision_overflow':lines+=[f'  have capacity := tune_capacity h',f'  have impossible : ¬ (before{i}.revision.val + 1 < 2 ^ 64) := by decide','  exact impossible capacity']
        elif v['name']=='nonce_overflow':lines+=[f'  exact exhausted_nonce_cannot_transfer (by decide) h']
        elif v['name'] in {'wrong_executor','unsigned_executor'}:
            actor=act.split('(.transfer ',1)[1].split('⟩',1)[0]+'⟩'
            lines+=[f'  have impossible : ¬ authorized {actor} before{i}.executor := by unfold authorized; decide','  exact impossible (transfer_authorized h).1']
        elif v['name'] in {'replay','stale_revision'}:
            key='nonce' if v['name']=='replay' else 'revision';projection='2.1' if key=='nonce' else '2.2'
            lines+=[f'  have impossible : {corpus.word(r[key])} ≠ before{i}.{key} := by decide',f'  exact impossible (transfer_authorized h).{projection}']
        else:
            lines+=[f'  have impossible : ¬ validRequest (context before{i} {corpus.word(r["amount"])} {corpus.word(v["now"])}) := by unfold validRequest; decide','  exact impossible ((NativeDaily.success_iff _ _).mp (transfer_kernel h)).1']
        names.append(name)
    if len(CASES)!=12 or names[1:]!=['refuses_'+name for name in CASES]:raise ValueError('Incomplete refusal proof inventory')
    budget_index,v=next((i,v) for i,v in enumerate(vectors) if v['name']=='budget_exhaustion_rollback')
    r=corpus.decode(v['data']);s=v['before'];effective=s['spent'] if v['now']//86400==s['spentDay'] else 0;next_spent=effective+r['amount']
    lines += [f'def budgetRequest : Action := {action(v)}',
              f'theorem budget_model_permits : ∃ t, Transition (fun _ _ => True) before{budget_index} budgetRequest t := by',
              f'  refine ⟨spendState before{budget_index} {corpus.word(r["amount"])} {corpus.word(v["now"])} {corpus.word(next_spent)} (by decide), ?_⟩',
              '  apply Transition.transfer','  all_goals first | decide | exact ⟨by decide, by decide⟩ | exact ⟨by decide, by decide, by decide, by decide, by decide⟩ | trivial']
    names.append('budget_model_permits')
    lines += ['#print axioms '+name for name in names]+['end AllowIt.Refusals']
    return '\n'.join(lines)+'\n',names
