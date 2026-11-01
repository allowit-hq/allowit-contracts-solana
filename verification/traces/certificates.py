"""Strict Borsh request decoding and Lean certificates for observed custody projections."""
import re

MAX = 2 ** 64
STATE_KEYS = {'custody','owner','executor','asset','policy','source','artifact','limit','spent','spentDay',
              'nonce','revision','approved','balance','sourceBalance','recipientBalance','abi','bump',
              'tokenAccount','vaultId','mintSupply','sourceKey','recipientKey'}
IDS = {'custody','owner','executor','asset','policy','source','artifact','tokenAccount','vaultId','sourceKey','recipientKey'}
NUMBERS = STATE_KEYS - IDS - {'approved'}
CASES = ['deposit','unapproved','approve','spend','replay','lower_below_spent','lowered_denial',
         'pause','paused_denial','top_up','withdraw','pause_new_day','resume_limit','next_day_exact_limit',
         'switch','switch_revoked','revoke','reapprove','raise_limit','wrong_executor','unsigned_executor',
         'stale_revision','unsupported','nonce_overflow','revision_overflow','budget_exhaustion_rollback',
         'injected_supply_violation']
ERRORS = {'unapproved':'Failure(Custom(104))','replay':'Failure(Custom(101))',
          'lowered_denial':'Failure(Custom(1006))','paused_denial':'Failure(Custom(1006))',
          'pause_new_day':'Failure(Custom(1006))','switch_revoked':'Failure(Custom(104))',
          'wrong_executor':'Failure(Custom(110))','unsigned_executor':'Failure(MissingRequiredSignature)',
          'stale_revision':'Failure(Custom(101))','unsupported':'Failure(Custom(100))',
          'nonce_overflow':'Failure(Custom(102))','revision_overflow':'Failure(Custom(102))',
          'budget_exhaustion_rollback':'UnknownError(ProgramFailedToComplete)'}


def number(n):
    if type(n) is not int or not 0 <= n < MAX:
        raise ValueError('Non-u64 observed value')
    return n


def identity(s):
    if type(s) is not str or not re.fullmatch('[0-9a-f]{64}',s):
        raise ValueError('Noncanonical 32-byte identity')
    return int(s,16)


def state(s):
    if set(s) != STATE_KEYS or type(s['approved']) is not bool or s['abi'] != 1 or not 0 <= s['bump'] < 256:
        raise ValueError('Unsupported observed state schema')
    for key in IDS:identity(s[key])
    for key in NUMBERS:number(s[key])
    fields=[f'{key} := {identity(s[key])}' for key in ['custody','owner','executor','asset']]
    fields+=['policy := ⟨'+', '.join(str(identity(s[k])) for k in ['policy','source','artifact'])+'⟩']
    fields += [f'{k} := ⟨{s[k]}, by decide⟩' for k in ['limit','spent','spentDay','nonce','revision']]
    fields += ['approved := '+str(s['approved']).lower(),f'balance := {s["balance"]}']
    return '{ '+', '.join(fields)+' }'


def word(n):return '⟨'+str(number(n))+', by decide⟩'


def decode(data):
    if type(data) is not str or not re.fullmatch('(?:[0-9a-f]{2})+',data):raise ValueError('Invalid wire bytes')
    b=bytes.fromhex(data);tag=b[0]; lengths={1:9,2:10,3:17,4:25,5:9,6:73,7:5}
    if tag not in lengths or len(b)!=lengths[tag]:raise ValueError('Unsupported or malformed request')
    w=lambda i:int.from_bytes(b[i:i+8],'little')
    if tag==2 and b[1]>1:raise ValueError('Invalid approval boolean')
    return {'tag':tag,'amount':w(1) if tag in {1,4,5} else None,
            'approved':b[1]==1 if tag==2 else None,'value':w(1) if tag==3 else None,
            'revision':w(2) if tag==2 else w(9) if tag==3 else w(17) if tag==4 else w(65) if tag==6 else None,
            'nonce':w(9) if tag==4 else None,
            'source':b[1:33].hex() if tag==6 else None,'artifact':b[33:65].hex() if tag==6 else None}


def account_map(rows):
    result={}
    for row in rows:
        if set(row)!={'key','owner','lamports','executable','data'} or type(row['executable']) is not bool:raise ValueError('Unsupported raw account schema')
        identity(row['key']);identity(row['owner']);number(row['lamports'])
        if row['key'] in result or type(row['data']) is not str or not re.fullmatch('(?:[0-9a-f]{2})*',row['data']):raise ValueError('Malformed raw account')
        result[row['key']]=row
    return result


def check_images(v):
    before=account_map(v['beforeAccounts']);after=account_map(v['afterAccounts'])
    if before.keys()!=after.keys():raise ValueError('Returned account key set changed')
    for snapshot,accounts in [(v['before'],before),(v['after'],after)]:
        if len({snapshot[k] for k in ['custody','tokenAccount','sourceKey','recipientKey','asset']})!=5:raise ValueError('Projected account aliasing')
        raw=bytes.fromhex(accounts[snapshot['custody']]['data'])
        if len(raw)!=320 or raw[298]>1:raise ValueError('Invalid raw custody bytes')
        fields={'abi':raw[0],'bump':raw[1],'approved':raw[298]==1}
        for i,k in enumerate(['owner','executor','asset','tokenAccount','policy','source','artifact','vaultId']):fields[k]=raw[2+i*32:34+i*32].hex()
        for i,k in enumerate(['limit','spent','spentDay','nonce','revision']):fields[k]=int.from_bytes(raw[258+i*8:266+i*8],'little')
        for k,value in fields.items():
            if snapshot[k]!=value:raise ValueError('Shared interface decoder disagrees with independent raw custody decode')
        for key,value in [('tokenAccount','balance'),('sourceKey','sourceBalance'),('recipientKey','recipientBalance')]:
            raw_token=bytes.fromhex(accounts[snapshot[key]]['data'])
            if len(raw_token)!=165 or int.from_bytes(raw_token[64:72],'little')!=snapshot[value]:raise ValueError('Raw token balance disagrees')
            if raw_token[:32].hex()!=snapshot['asset']:raise ValueError('Token mint binding changed')
            if key in {'tokenAccount','sourceKey'} and raw_token[32:64].hex()!=snapshot['custody' if key=='tokenAccount' else 'owner']:raise ValueError('Token authority binding changed')
        mint=bytes.fromhex(accounts[snapshot['asset']]['data'])
        if len(mint)!=82 or int.from_bytes(mint[36:44],'little')!=snapshot['mintSupply']:raise ValueError('Raw mint supply disagrees')
    if v['outcome']!='Success':
        if before!=after:raise ValueError('Runtime returned changed account images on failure')
        return
    token_keys={v['before'][k] for k in ['tokenAccount','sourceKey','recipientKey']}
    for key,old in before.items():
        new=after[key]
        if any(old[k]!=new[k] for k in ['owner','lamports','executable']):raise ValueError('Account metadata changed')
        a,b=bytes.fromhex(old['data']),bytes.fromhex(new['data'])
        if key in token_keys:
            if a[:64]+a[72:]!=b[:64]+b[72:]:raise ValueError('Token non-amount fields changed')
        elif key==v['before']['custody']:
            if a[299:]!=b[299:]:raise ValueError('Custody trailing bytes changed')
        elif a!=b:raise ValueError('Unrelated account bytes changed')
    tag=decode(v['data'])['tag'];pre,post=v['before'],v['after']
    if tag in {2,3,6} and any(pre[k]!=post[k] for k in ['sourceBalance','recipientBalance']):raise ValueError('Control action moved external tokens')
    if tag==4 and pre['sourceBalance']!=post['sourceBalance']:raise ValueError('Transfer moved source tokens')
    if tag in {1,5} and pre['recipientBalance']!=post['recipientBalance']:raise ValueError('Funding moved recipient tokens')


def tag_account_mismatch(v,r):
    a=v['accounts'];s=v['before'];tag=r['tag']
    if tag==1:return len(a)<4 or a[2]['key']!=s['sourceKey'] or a[3]['key']!=s['tokenAccount']
    if tag in {4,5}:return len(a)<4 or a[2]['key']!=s['tokenAccount'] or a[3]['key']!=s['recipientKey' if tag==4 else 'sourceKey']
    return False


def witness(v,r):
    name=v['name'];s=v['before'];accounts=v['accounts']
    if name=='unsupported':return
    if len(accounts)<2:raise ValueError('Missing witness actor')
    a=accounts[1];actor=a['key'];signed=a['signed'];ok=True
    if name in {'unapproved','switch_revoked'}:ok=not s['approved']
    elif name=='replay':ok=r['nonce']!=s['nonce'] and r['revision']==s['revision']
    elif name=='stale_revision':ok=r['nonce']==s['nonce'] and r['revision']!=s['revision']
    elif name=='wrong_executor':ok=signed and actor!=s['executor']
    elif name=='unsigned_executor':ok=not signed and actor==s['executor']
    elif name=='nonce_overflow':ok=s['nonce']==MAX-1 and r['nonce']==s['nonce'] and r['revision']==s['revision']
    elif name=='revision_overflow':ok=s['revision']==MAX-1 and r['revision']==s['revision']
    elif name in {'lowered_denial','paused_denial','pause_new_day'}:
        spent=s['spent'] if v['now']//86400==s['spentDay'] else 0
        ok=s['approved'] and spent+r['amount']>s['limit']
        if name!='lowered_denial':ok=ok and s['limit']==0
    elif name=='budget_exhaustion_rollback':
        spent=s['spent'] if v['now']//86400==s['spentDay'] else 0
        ok=(signed and actor==s['executor'] and s['approved'] and r['nonce']==s['nonce'] and r['revision']==s['revision']
            and 0<r['amount']<=s['balance'] and v['now']//86400>=s['spentDay'] and spent+r['amount']<=s['limit']<=50000000)
    if not ok:raise ValueError('Distinguishing witness precondition changed: '+name)


def generate(vectors):
    if [v.get('name') for v in vectors]!=CASES:raise ValueError('Incomplete trace case inventory')
    lines=['import State','namespace AllowIt.CustodyTraces','open AllowIt.Adapter AllowIt.NativeDaily',
           'def ready : State → Action → Prop := fun _ _ => True']
    audits=[]
    for i,v in enumerate(vectors):
        if set(v)!={'name','before','after','data','accounts','now','outcome','allReturnedAccountsUnchanged','returnData','beforeAccounts','afterAccounts'}:
            raise ValueError('Unsupported trace schema')
        pre,post=v['before'],v['after'];request=decode(v['data']);number(v['now'])
        expected_tag=1 if v['name'] in {'deposit','top_up'} else 5 if v['name']=='withdraw' else 6 if v['name']=='switch' else 7 if v['name']=='unsupported' else 2 if v['name'] in {'approve','revoke','reapprove'} else 3 if v['name'] in {'lower_below_spent','pause','resume_limit','raise_limit','revision_overflow'} else 4
        if request['tag']!=expected_tag:raise ValueError('Case/request tag mismatch')
        check_images(v)
        if request['tag']!=7:
            if len(v['accounts'])<2 or v['accounts'][0]['key']!=pre['custody']:raise ValueError('Unexpected custody account mapping')
            if tag_account_mismatch(v,request):raise ValueError('Asset account identity mismatch')
        if type(v['returnData']) is not str or not re.fullmatch('(?:[0-9a-f]{2})*',v['returnData']):raise ValueError('Invalid return data')
        lines += [f'def before{i} : State := {state(pre)}',f'def after{i} : State := {state(post)}']
        for account in v['accounts']:
            if set(account)!={'key','signed','writable'} or type(account['signed']) is not bool or type(account['writable']) is not bool:raise ValueError('Invalid account meta')
            identity(account['key'])
        if type(v['allReturnedAccountsUnchanged']) is not bool:raise ValueError('Invalid account equality flag')
        if v['outcome']!=ERRORS.get(v['name'],'Success'):raise ValueError('Unexpected exact outcome')
        witness(v,request)
        if v['name']=='injected_supply_violation':
            if pre['sourceBalance']+pre['balance']+pre['recipientBalance']<=pre['mintSupply']:raise ValueError('Diagnostic input does not violate supply')
            if post['recipientBalance']!=(pre['recipientBalance']+request['amount'])%MAX:raise ValueError('Diagnostic exact wrap disappeared; investigate explicitly')
            if post['balance']+request['amount']!=pre['balance'] or post['nonce']!=pre['nonce']+1 or post['spent']!=pre['spent']+request['amount']:raise ValueError('Diagnostic custody effect changed')
            name='diagnostic_recipient_mismatch'
            lines += [f'theorem {name} : ({post["recipientBalance"]} : Nat) = ({pre["recipientBalance"]} + {request["amount"]}) % {MAX} ∧ ({post["recipientBalance"]} : Nat) ≠ {pre["recipientBalance"]} + {request["amount"]} := by decide']
            audits.append(name);continue
        if any(pre[k]!=post[k] for k in ['abi','bump','tokenAccount','vaultId','mintSupply','sourceKey','recipientKey']):raise ValueError('Immutable custody/asset metadata changed')
        for s in (pre,post):
            if s['sourceBalance']+s['balance']+s['recipientBalance']!=s['mintSupply']:raise ValueError('Ordinary fixture violates token supply')
        if v['outcome']!='Success':
            if not v['allReturnedAccountsUnchanged'] or pre!=post:raise ValueError('Rejected instruction mutated returned state')
            name=f'rejection_{i}';lines += [f'theorem {name} : before{i} = after{i} := by decide'];audits.append(name);continue
        a=v['accounts'][1];actor='⟨'+str(identity(a['key']))+', '+str(a['signed']).lower()+'⟩'
        r=word(request['revision']) if request['revision'] is not None else None
        n=word(request['nonce']) if request['nonce'] is not None else None
        amount=word(request['amount']) if request['amount'] is not None else None
        tag=request['tag'];name=f'success_{i}'
        if tag==1:
            action=f'(.deposit {actor} {amount})';expected=f'{{ before{i} with balance := before{i}.balance + {request["amount"]} }}';constructor='deposit'
        elif tag==5:
            recipient=identity(v['accounts'][3]['key']);action=f'(.withdraw {actor} {recipient} {amount})';expected=f'{{ before{i} with balance := before{i}.balance - {request["amount"]} }}';constructor='withdraw'
        elif tag==2:
            boolean=str(request['approved']).lower();action=f'(.approve {actor} {boolean} {r})';expected=f'approveState before{i} {boolean} (by decide)';constructor='approve'
        elif tag==3:
            value=word(request['value']);action=f'(.tune {actor} {value} {r})';expected=f'tuneState before{i} {value} (by decide)';constructor='tune'
        elif tag==6:
            policy='⟨'+', '.join(str(identity(x)) for x in [v['accounts'][2]['key'],request['source'],request['artifact']])+'⟩'
            action=f'(.switchPolicy {actor} {policy} {r})';expected=f'switchState before{i} {policy} (by decide)';constructor='switchPolicy'
        elif tag==4:
            recipient=identity(v['accounts'][3]['key']);now=word(v['now']);action=f'(.transfer {actor} {recipient} {amount} {n} {r} {now})';expected=f'spendState before{i} {amount} {now} {word(post["spent"])} (by decide)';constructor='transfer'
        else:raise ValueError('Unsupported successful method')
        lines += [f'theorem {name} : Transition ready before{i} {action} after{i} := by',
                  f'  have post : after{i} = {expected} := by decide','  rw [post]',
                  f'  apply Transition.{constructor}',
                  '  all_goals first | decide | exact ⟨by decide, by decide⟩ | exact ⟨by decide, by decide, by decide, by decide, by decide⟩ | trivial']
        audits.append(name)
        if tag in {1,5,4}:
            key='recipientBalance' if tag==4 else 'sourceBalance'
            effect=f'({post[key]} : Nat) + {request["amount"]} = {pre[key]}' if tag==1 else f'({post[key]} : Nat) = {pre[key]} + {request["amount"]}'
            name=f'asset_effect_{i}';lines+=[f'theorem {name} : {effect} := by decide'];audits.append(name)
    lines += ['#print axioms '+n for n in audits]+['end AllowIt.CustodyTraces']
    return '\n'.join(lines)+'\n',audits
