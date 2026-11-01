"""Finite single-fault model witnesses for an independent compiled VM corpus."""
base=None  # supplied by the checker from hash-verified source bytes
CASES=['deposit','approve','spend','switch','revoked','reapprove','valid','wrong_executor','unsigned_executor','stale_revision','replay','valid_after_refusals']
FAULTS={'revoked':'approved','wrong_executor':'executor','unsigned_executor':'signed','stale_revision':'revision','replay':'nonce'}
ERRORS={'revoked':'Failure(Custom(104))','wrong_executor':'Failure(Custom(110))','unsigned_executor':'Failure(MissingRequiredSignature)','stale_revision':'Failure(Custom(101))','replay':'Failure(Custom(101))'}
KEYS=['signed','executor','revision','nonce','approved','positive','bounded','day','headroom','capacity','funded']


def conditions(v):
    s=v['before'];r=base.decode(v['data']);a=v['accounts'][1];day=v['now']//86400;spent=s['spent'] if day==s['spentDay'] else 0
    return dict(zip(KEYS,[a['signed'],a['key']==s['executor'],r['revision']==s['revision'],r['nonce']==s['nonce'],s['approved'],r['amount']>0,s['limit']<=50000000,day>=s['spentDay'],spent+r['amount']<=s['limit'],s['nonce']+1<base.MAX,r['amount']<=s['balance']]))


def generate(vectors):
    if [v.get('name') for v in vectors]!=CASES:raise ValueError('Incomplete isolation inventory')
    lines=['import State','namespace AllowIt.Isolation','open AllowIt.Adapter AllowIt.NativeDaily',
           'def checks (s : State) (a : Actor) (amount nonce revision now : U64) : List (String × Bool) :=',
           '  [("signed", a.signed), ("executor", decide (a.identity = s.executor)),',
           '   ("revision", decide (revision = s.revision)), ("nonce", decide (nonce = s.nonce)),',
           '   ("approved", s.approved), ("positive", decide (0 < amount.val)),',
           '   ("bounded", decide (s.limit.val ≤ maxDailyLimit)), ("day", decide (s.spentDay.val ≤ day (context s amount now))),',
           '   ("headroom", decide (effectiveSpent (context s amount now) + amount.val ≤ s.limit.val)),',
           '   ("capacity", decide (s.nonce.val + 1 < 2 ^ 64)), ("funded", decide (amount.val ≤ s.balance))]']
    lines += ['theorem checks_spec {s : State} {a : Actor} {amount nonce revision now : U64} :', '    (∀ p ∈ checks s a amount nonce revision now, p.2 = true) ↔', '      authorized a s.executor ∧ revision = s.revision ∧ nonce = s.nonce ∧', '      validRequest (context s amount now) ∧ s.nonce.val + 1 < 2 ^ 64 ∧ amount.val ≤ s.balance := by', '  simp [checks, authorized, validRequest, context, and_assoc, and_left_comm, and_comm]', '', 'theorem checks_complete {recipient : Nat} {s : State} {a : Actor} {amount nonce revision now : U64} :', '    (∀ p ∈ checks s a amount nonce revision now, p.2 = true) ↔', '      ∃ t, Transition (fun _ _ => True) s (.transfer a recipient amount nonce revision now) t := by', '  rw [checks_spec]', '  constructor', '  · rintro ⟨auth, current, fresh, permission, fits, funded⟩', '    let next : U64 := ⟨effectiveSpent (context s amount now) + amount.val, valid_request_sum_fits _ permission⟩', '    exact ⟨spendState s amount now next fits, transfer_complete auth current fresh permission rfl fits funded trivial⟩', '  · rintro ⟨t, h⟩', '    cases h', '    exact ⟨by assumption, by assumption, by assumption, by assumption, by assumption, by assumption⟩']
    names=["checks_spec","checks_complete"]
    for i,v in enumerate(vectors):
        if set(v)!={'name','before','after','data','accounts','now','outcome','allReturnedAccountsUnchanged','returnData','beforeAccounts','afterAccounts'}:raise ValueError('Unknown isolation schema')
        pre,post=v['before'],v['after'];base.state(pre);base.state(post);base.number(v['now']);base.check_images(v)
        if i and (pre!=vectors[i-1]['after'] or v['beforeAccounts']!=vectors[i-1]['afterAccounts']):raise ValueError('Broken observed continuity')
        if any(pre[k]!=post[k] for k in ['abi','bump','tokenAccount','vaultId','mintSupply','sourceKey','recipientKey']):raise ValueError('Immutable metadata changed')
        for state in [pre,post]:
            if state['balance']+state['sourceBalance']+state['recipientBalance']!=state['mintSupply']:raise ValueError('Fixture supply mismatch')
        r=base.decode(v['data']);tag=r['tag'];expected_tag=1 if v['name']=='deposit' else 2 if v['name'] in {'approve','reapprove'} else 6 if v['name']=='switch' else 4
        if tag!=expected_tag or v['outcome']!=ERRORS.get(v['name'],'Success'):raise ValueError('Wrong isolation operation/outcome')
        if v['name']=='switch' and any(pre[k]!=post[k] for k in ['policy','source','artifact']):raise ValueError('Expected same-module rebind')
        for a in v['accounts']:
            if set(a)!={'key','signed','writable'} or type(a['signed']) is not bool or type(a['writable']) is not bool:raise ValueError('Malformed meta')
            base.identity(a['key'])
        if len(v['accounts'])<2 or v['accounts'][0]['key']!=pre['custody'] or base.tag_account_mismatch(v,r):raise ValueError('Wrong isolation account mapping')
        if type(v['allReturnedAccountsUnchanged']) is not bool:raise ValueError('Invalid equality flag')
        if tag==4:
            failed=[k for k,x in conditions(v).items() if not x]
            if failed!=([FAULTS[v['name']]] if v['name'] in FAULTS else []):raise ValueError('Not a single-fault witness')
        lines += [f'def before{i} : State := {base.state(pre)}',f'def after{i} : State := {base.state(post)}']
        a=v['accounts'][1];actor=f'⟨{base.identity(a["key"])}, {str(a["signed"]).lower()}⟩';amount=base.word(r['amount']) if r['amount'] is not None else None
        revision=base.word(r['revision']) if r['revision'] is not None else None;nonce=base.word(r['nonce']) if r['nonce'] is not None else None;now=base.word(v['now']);recipient=str(base.identity(v['accounts'][3]['key'])) if tag==4 else None
        if tag==4:act=f'(.transfer {actor} {recipient} {amount} {nonce} {revision} {now})'
        elif tag==1:act=f'(.deposit {actor} {amount})'
        elif tag==2:act=f'(.approve {actor} {str(r["approved"]).lower()} {revision})'
        else:
            module='⟨'+', '.join(str(base.identity(x)) for x in [v['accounts'][2]['key'],r['source'],r['artifact']])+'⟩';act=f'(.switchPolicy {actor} {module} {revision})'
        lines += [f'def request{i} : Action := {act}']
        if v['name'] in FAULTS:
            if pre!=post or not v['allReturnedAccountsUnchanged']:raise ValueError('Refusal returned changed projection')
            vector='['+', '.join(f'("{k}", {str(x).lower()})' for k,x in conditions(v).items())+']';name=f'fault_{i}'
            lines += [f'theorem {name} : checks before{i} {actor} {amount} {nonce} {revision} {now} = {vector} := by decide'];names.append(name)
            name=f'refuses_{i}';lines += [f'theorem {name} (environment : State → Action → Prop) (t : State) : ¬ Transition environment before{i} request{i} t := by','  intro h']
            fault=FAULTS[v['name']]
            if fault in {'signed','executor'}:lines += [f'  have impossible : ¬ authorized {actor} before{i}.executor := by unfold authorized; decide','  exact impossible (transfer_authorized h).1']
            elif fault in {'revision','nonce'}:
                value=revision if fault=='revision' else nonce;projection='2.2' if fault=='revision' else '2.1';lines += [f'  have impossible : {value} ≠ before{i}.{fault} := by decide',f'  exact impossible (transfer_authorized h).{projection}']
            else:lines += [f'  have impossible : ¬ validRequest (context before{i} {amount} {now}) := by unfold validRequest; decide','  exact impossible ((NativeDaily.success_iff _ _).mp (transfer_kernel h)).1']
            names.append(name)
            repaired_state=f'{{ before{i} with approved := true }}' if fault=='approved' else f'before{i}'
            repaired_actor=f'⟨before{i}.executor, true⟩' if fault in {'signed','executor'} else actor
            repaired_nonce=f'before{i}.nonce' if fault=='nonce' else nonce;repaired_revision=f'before{i}.revision' if fault=='revision' else revision
            repair=f'(.transfer {repaired_actor} {recipient} {amount} {repaired_nonce} {repaired_revision} {now})';next_spent=pre['spent']+r['amount'] if v['now']//86400==pre['spentDay'] else r['amount'];name=f'repair_permits_{i}'
            lines += [f'theorem {name} : ∃ t, Transition (fun _ _ => True) ({repaired_state}) {repair} t := by',f'  refine ⟨spendState ({repaired_state}) {amount} {now} {base.word(next_spent)} (by decide), ?_⟩','  apply Transition.transfer','  all_goals first | decide | exact ⟨by decide, by decide⟩ | exact ⟨by decide, by decide, by decide, by decide, by decide⟩ | trivial'];names.append(name)
            continue
        if tag==1:expected=f'{{ before{i} with balance := before{i}.balance + {r["amount"]} }}';constructor='deposit'
        elif tag==2:expected=f'approveState before{i} {str(r["approved"]).lower()} (by decide)';constructor='approve'
        elif tag==6:expected=f'switchState before{i} {module} (by decide)';constructor='switchPolicy'
        else:expected=f'spendState before{i} {amount} {now} {base.word(post["spent"])} (by decide)';constructor='transfer'
        name=f'success_{i}';lines += [f'theorem {name} : Transition (fun _ _ => True) before{i} request{i} after{i} := by',f'  have post : after{i} = {expected} := by decide','  rw [post]',f'  apply Transition.{constructor}','  all_goals first | decide | exact ⟨by decide, by decide⟩ | exact ⟨by decide, by decide, by decide, by decide, by decide⟩ | trivial'];names.append(name)
        if tag in {1,4}:
            name=f'asset_{i}';effect=f'({post["sourceBalance"]} : Nat) + {r["amount"]} = {pre["sourceBalance"]}' if tag==1 else f'({post["recipientBalance"]} : Nat) = {pre["recipientBalance"]} + {r["amount"]}';lines += [f'theorem {name} : {effect} := by decide'];names.append(name)
    if len(names)!=28:raise ValueError('Incomplete certificate inventory')
    lines += ['#print axioms '+n for n in names]+['end AllowIt.Isolation']
    return '\n'.join(lines)+'\n',names
