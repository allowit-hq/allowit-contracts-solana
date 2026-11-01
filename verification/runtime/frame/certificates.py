"""Retained finite projections; observation, hashing and parsing remain trusted."""
import hashlib
import struct
ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
REFUSALS={'transaction':{'invalid_blockhash':'Some(BlockhashNotFound)','abort':'Some(InstructionError(2, Custom(100)))','invalid_signature':'Some(SignatureFailure)'},'failure-boundary':{'invalid_blockhash':'Some(BlockhashNotFound)','token_failure':'Some(InstructionError(1, ProgramFailedToComplete))','post_cpi_failure':'Some(InstructionError(1, ProgramFailedToComplete))','invalid_signature':'Some(SignatureFailure)'}}
PAIRS={'transaction':[('abort','reuse')],'failure-boundary':[('token_failure','token_reuse'),('post_cpi_failure','post_cpi_reuse')]}
CLOCK='SysvarC1ock11111111111111111111111111111111'
SYSTEM='11111111111111111111111111111111'
TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
def require(p,message):
    if not p:raise ValueError(message)
def identity(s):
    require(isinstance(s,str) and s and all(c in ALPHABET for c in s),'invalid identity')
    n=0
    for c in s:n=n*58+ALPHABET.index(c)
    zeros=len(s)-len(s.lstrip('1'));b=b'\0'*zeros+(n.to_bytes((n.bit_length()+7)//8,'big') if n else b'')
    require(len(b)==32,'identity width');return int.from_bytes(b,'big')
def number(n):
    require(type(n) is int and 0<=n<2**64,'invalid u64');return n
def account(a):
    require(set(a)=={'owner','lamports','executable','rentEpoch','dataSha256'} and type(a['executable']) is bool,'account schema')
    require(len(a['dataSha256'])==64 and all(c in '0123456789abcdef' for c in a['dataSha256']),'digest encoding')
    return '{ owner := '+str(identity(a['owner']))+', lamports := '+str(number(a['lamports']))+', executable := '+str(a['executable']).lower()+', rentEpoch := '+str(number(a['rentEpoch']))+', dataDigest := '+str(int(a['dataSha256'],16))+' }'
def store(s):
    require(len(s)==292,'store cardinality')
    return '[\n'+',\n'.join('('+str(identity(k))+', '+account(a)+')' for k,a in sorted(s.items(),key=lambda e:identity(e[0])))+'\n]'
def raw(row,side):
    result={};fingerprints=row[side+'Store']
    for e in row['raw']:
        key=e['key'];require(key not in result,'duplicate raw account');identity(key);a=e[side]
        require(set(a)=={'data','owner','lamports','executable','rentEpoch'},'raw account schema')
        b=bytes.fromhex(a['data']);projection={k:a[k] for k in ['owner','lamports','executable','rentEpoch']};projection['dataSha256']=hashlib.sha256(b).hexdigest()
        require(key in fingerprints and projection==fingerprints[key],'raw fingerprint mismatch');result[key]=b
    return result
def transfer(row):
    keys=row['message']['accountKeys'];r=raw(row,'before');candidates=[]
    for ix in row['message']['instructions']:
        program=keys[ix['programIndex']];require(program!=SYSTEM,'durable nonce outside corpus')
        d=bytes.fromhex(ix['data'])
        if len(d)==25 and d[0]==4:
            require(len(ix['accounts'])==8,'transfer account inventory');bound=[keys[i] for i in ix['accounts']];custody,executor,vault,recipient,mint,token,policy,api=bound
            require(row['beforeStore'][custody]['owner']==program and token==TOKEN,'transfer program binding')
            b=r[custody];require(len(b)==320 and b[0]==1 and b[298] in [0,1] and b[299:]==bytes(21),'custody layout')
            require([identity(executor),identity(vault),identity(mint),identity(policy)]==[int.from_bytes(b[o:o+32],'big') for o in [34,98,66,130]],'transfer role binding')
            require(row['beforeStore'][policy]['dataSha256']==hashlib.sha256(bytes([2,0,0,0])+identity(api).to_bytes(32,'big')).hexdigest(),'policy ProgramData binding')
            require(ix['accounts'][1]<row['message']['header']['required'],'executor signer position')
            payer=keys[0];require(row['beforeStore'][payer]['owner']==SYSTEM and payer not in [custody,vault,recipient],'payer binding')
            amount,nonce,revision=struct.unpack_from('<QQQ',d,1);clock=r[CLOCK];require(len(clock)==40,'clock layout');now=struct.unpack_from('<q',clock,32)[0];require(now>=0,'negative clock')
            candidates.append({'custody':custody,'program':program,'actor':identity(executor),'recipient':identity(recipient),'amount':amount,'nonce':nonce,'revision':revision,'now':now})
    require(len(candidates)==1,'transfer inventory');return candidates[0]
def word(n):return '⟨'+str(number(n))+', by decide⟩'
def state(row,side):
    request=transfer(row);r=raw(row,side);k=request['custody'];b=r[k];require(len(b)==320 and b[0]==1 and b[298] in [0,1] and b[299:]==bytes(21),'custody layout');require(row[side+'Store'][k]['owner']==request['program'],'custody owner');token=b[98:130];tokens=[(key,v) for key,v in r.items() if identity(key)==int.from_bytes(token,'big')];require(len(tokens)==1 and len(tokens[0][1])==165,'custody balance identity');tk,tb=tokens[0];require(row[side+'Store'][tk]['owner']==TOKEN and tb[:32]==b[66:98] and tb[32:64]==identity(k).to_bytes(32,'big'),'token binding');u=lambda o:struct.unpack_from('<Q',b,o)[0]
    return {'custody':identity(k),'owner':int.from_bytes(b[2:34],'big'),'executor':int.from_bytes(b[34:66],'big'),'asset':int.from_bytes(b[66:98],'big'),'policy':tuple(int.from_bytes(b[o:o+32],'big') for o in [130,162,194]),'limit':u(258),'spent':u(266),'spentDay':u(274),'nonce':u(282),'revision':u(290),'approved':b[298],'balance':struct.unpack_from('<Q',tb,64)[0]}
def state_text(s):
    return '{ '+', '.join(k+' := '+('⟨'+', '.join(map(str,v))+'⟩' if k=='policy' else word(v) if k in ['limit','spent','spentDay','nonce','revision'] else str(bool(v)).lower() if k=='approved' else str(v)) for k,v in s.items())+' }'
def action_text(r):return f'(.transfer ⟨{r["actor"]}, true⟩ {r["recipient"]} {word(r["amount"])} {word(r["nonce"])} {word(r["revision"])} {word(r["now"])})'
def generate(datasets):
    require(set(datasets)==set(REFUSALS),'dataset inventory');lines=['import Frame','set_option maxRecDepth 10000','set_option maxHeartbeats 10000000','namespace AllowIt.TransactionCorpus','open AllowIt.Transaction AllowIt.Adapter'];names=[]
    for dataset,rows in datasets.items():
        index={r['name']:r for r in rows};require(len(index)==len(rows),'duplicate case');prefix=dataset.replace('-','_')
        for case,outcome in REFUSALS[dataset].items():
            r=index[case];require(r['outcome']==outcome,'failure outcome');base=prefix+'_'+case;before=r['beforeStore'];after=r['afterStore'];pk=r['message']['accountKeys'][0];payer=identity(pk);fee=number(r['fee']);require(set(before)==set(after),'store inventory changed');require(pk in before and before[pk]['lamports']>=fee,'payer funding');raw(r,'before');raw(r,'after')
            pre=case in ['invalid_blockhash','invalid_signature'];failure='.beforeExecution' if pre else '.executedAbort'
            lines += ['def '+base+'_before : Store := '+store(before),'def '+base+'_after : Store := '+store(after)]
            name=base+'_frame';names.append(name);lines += [f'theorem {name} : FailureEffect {base}_before {base}_after {payer} {failure} {fee} := by']
            if pre:
                require(fee==0,'preexecution fee');lines += [f'  have h : {base}_after = {base}_before := by decide','  rw [h]','  exact FailureEffect.before _ _ (by decide)']
            else:lines += ['  apply abort_iff.mpr',f'  exact ⟨by decide, ⟨{account(before[pk])}, by decide, by decide⟩, by decide⟩']
        for fail,success in PAIRS[dataset]:
            f,r=index[fail],index[success];require(r['outcome']=='None' and f['afterStore']==r['beforeStore'],'reuse continuity');failed,request=transfer(f),transfer(r);require(failed==request,'request reuse');pre,post=state(r,'before'),state(r,'after');require(request['nonce']==pre['nonce'] and request['revision']==pre['revision'],'request state binding');base=prefix+'_'+success
            lines += [f'def {base}_before : State := '+state_text(pre),f'def {base}_after : State := '+state_text(post),f'def {base}_abort_before : State := '+state_text(state(f,'before')),f'def {base}_abort_after : State := '+state_text(state(f,'after')),f'def {base}_action : Action := '+action_text(request),f'def {base}_abort_action : Action := '+action_text(failed)]
            name=base+'_custody_preserved';names.append(name);lines += [f'theorem {name} : {base}_abort_before = {base}_abort_after ∧ {base}_abort_after = {base}_before := by decide']
            name=base+'_same_request';names.append(name);lines += [f'theorem {name} : {base}_abort_action = {base}_action ∧ {base}_action = (.transfer ⟨{request["actor"]}, true⟩ {request["recipient"]} {word(request["amount"])} {base}_before.nonce {base}_before.revision {word(request["now"])}) := by decide']
            name=base+'_success';names.append(name);lines += [f'theorem {name} (ready : State → Action → Prop) (env : ready {base}_before {base}_action) : Transition ready {base}_before {base}_action {base}_after := by',f'  have post : {base}_after = spendState {base}_before {word(request["amount"])} {word(request["now"])} {word(post["spent"])} (by decide) := by decide','  rw [post]',f'  change Transition ready {base}_before {action_text(request)} _','  apply Transition.transfer','  all_goals first | exact env | decide | exact ⟨by decide, by decide⟩ | exact ⟨by decide, by decide, by decide, by decide, by decide⟩']
            name=base+'_nonce_advance';names.append(name);lines += [f'theorem {name} : {base}_after.nonce.val = {base}_before.nonce.val + 1 := (transfer_effects ({base}_success (fun _ _ => True) trivial)).1']
    lines += ['#print axioms '+n for n in names]+['end AllowIt.TransactionCorpus'];return '\n'.join(lines)+'\n',names
