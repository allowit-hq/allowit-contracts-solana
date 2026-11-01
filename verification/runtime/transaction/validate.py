#!/usr/bin/env python3
"""Independent finite wire/account validation; no cryptographic verification."""
import copy,hashlib,json,re,struct,sys
from pathlib import Path
BINDINGS=json.loads(Path(__file__).with_name("bindings.json").read_text())
ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
CASES=['invalid_blockhash','single','double','abort','reuse','invalid_signature','original']
EXPECTED=['Some(BlockhashNotFound)','None','None','Some(InstructionError(2, Custom(100)))','None','Some(SignatureFailure)','None']
def require(p,message):
    if not p:raise ValueError(message)
def b58(b):
    n=int.from_bytes(b,'big');s=''
    while n:n,r=divmod(n,58);s=ALPHABET[r]+s
    return '1'*(len(b)-len(b.lstrip(b'\0')))+s
class Reader:
    def __init__(self,b):self.b=b;self.i=0
    def take(self,n):
        require(n>=0 and self.i+n<=len(self.b),'truncated wire');x=self.b[self.i:self.i+n];self.i+=n;return x
    def short(self):
        start=self.i;n=0
        for k in range(3):
            v=self.take(1)[0];n|=(v&127)<<(7*k)
            if v<128:
                require(n<=65535 and (k==0 or n>=1<<(7*k)),'noncanonical shortvec');return n
        raise ValueError('overlong shortvec')
def wire(text):
    r=Reader(bytes.fromhex(text));signatures=[r.take(64) for _ in range(r.short())];header=r.take(3);keys=[b58(r.take(32)) for _ in range(r.short())];blockhash=r.take(32).hex();instructions=[]
    for _ in range(r.short()):
        program=r.take(1)[0];accounts=list(r.take(r.short()));data=r.take(r.short()).hex();require(program<len(keys) and all(i<len(keys) for i in accounts),'bad account index');instructions.append({'programIndex':program,'accounts':accounts,'data':data})
    require(r.i==len(r.b) and len(signatures)==header[0]==2 and header[1]==1 and header[2]==6 and len(keys)==len(set(keys))==11,'wire trailing/unsupported header or keys')
    return {'header':{'required':header[0],'readonlySigned':header[1],'readonlyUnsigned':header[2]},'accountKeys':keys,'instructions':instructions},signatures,blockhash
def rawmap(record,side):
    result={}
    for row in record['raw']:
        require(row['key'] not in result,'duplicate raw key');a=row[side];require(a is not None,'missing raw account');b=bytes.fromhex(a['data']);fp={k:v for k,v in a.items() if k!='data'};fp['dataSha256']=hashlib.sha256(b).hexdigest();require(fp==record[side+'Store'][row['key']],'raw/fingerprint mismatch');result[row['key']]=(a,b)
    return result
def check(rows):
    require([r['name'] for r in rows]==CASES,'case inventory');ids=[];previous=None;decoded=[];summaries=[]
    initial=rawmap(rows[0],'before');loader='BPFLoaderUpgradeab1e11111111111111111111111'
    program_data={}
    for byte,name in [(10,'allowit_vault.so'),(11,'allowit_policy.so')]:
        pk=b58(bytes([byte])*32);a,b=initial[pk];require(a['owner']==loader and a['executable'] and len(b)==36 and b[:4]==bytes([2,0,0,0]),'program account layout');pd=b58(b[4:]);da,db=initial[pd];require(da['owner']==loader and not da['executable'] and db[:4]==bytes([3,0,0,0]) and db[12:45]==bytes(33) and hashlib.sha256(db[45:]).hexdigest()==BINDINGS['artifacts'][name],'ProgramData/ELF binding');program_data[byte]=pd
    policy_data_key=program_data[11]
    ta,tb=initial['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'];require(ta['owner']=='BPFLoader2111111111111111111111111111111111' and ta['executable'] and hashlib.sha256(tb).hexdigest()==BINDINGS['artifacts']['token.so'],'token ELF binding')
    for k,(r,expected) in enumerate(zip(rows,EXPECTED)):
        require(r['outcome']==expected,'wrong outcome');m,sigs,bh=wire(r['transaction']);require(m==r['message'] and b58(sigs[0])==r['transactionId'],'wire disagreement');decoded.append((m,sigs,bh))
        require(bh==r['runtimeBlockhash'] if k!=0 else bh=='2a'*32 and bh!=r['runtimeBlockhash'],'blockhash binding')
        require(len(m['instructions'])==[2,2,3,3,2,2,2][k] and all(i['programIndex']>=5 for i in m['instructions']),'instruction inventory/program writable');
        before,after=r['beforeStore'],r['afterStore'];require(previous is None or previous==before,'store continuity');previous=after;require(set(before)==set(after),'account creation/removal');payer=m['accountKeys'][0]
        require(before[payer]['lamports']-after[payer]['lamports']==r['fee'],'fee delta');bp={**before[payer]};ap={**after[payer]};bp.pop('lamports');ap.pop('lamports');require(bp==ap,'payer metadata frame')
        for side in ['before','after']:rawmap(r,side)
        raw=rawmap(r,'before');states=[(key,a,b) for key,(a,b) in raw.items() if len(b)==320];require(len(states)==1,'state inventory');vault,va,s=states[0];require(s[0]==1 and s[298]==1 and s[299:]==bytes(21),'state ABI/approval/padding');executor=b58(s[34:66]);tokens=b58(s[98:130]);mint=b58(s[66:98]);owner=b58(s[2:34]);policy=b58(s[130:162]);recipient=b58(bytes([17])*32)
        require(m['header']['readonlySigned']==1 and executor==m['accountKeys'][1] and executor!=payer and owner not in m['accountKeys'],'executor signer binding/owner absence');
        require(va['owner']==b58(bytes([10])*32) and policy==b58(bytes([11])*32) and s[226:258]==bytes([18])*32,'fixture program/seed identities');
        pda=hashlib.sha256(b'allowit-vault-v1'+s[2:34]+s[226:258]+s[1:2]+bytes([10])*32+b'ProgramDerivedAddress').digest();require(b58(pda)==vault,'supplied-bump PDA hash');
        require(s[194:226].hex()==BINDINGS['artifacts']['allowit_policy.so'],'state artifact binding');require(struct.unpack_from('<Q',s,258)[0]==25_000_000 and struct.unpack_from('<Q',s,290)[0]==0,'constructed configuration');require(struct.unpack_from('<Q',s,274)[0]==86401//86400,'fixture day window');
        require(s[162:194].hex()==BINDINGS['sourceBundleIdentifier'],'fixture source-bundle identity')
        require(m['accountKeys'][m['instructions'][0]['programIndex']]=='ComputeBudget111111111111111111111111111111' and m['instructions'][0]['data']=='02c05c1500' and not m['instructions'][0]['accounts'],'budget bytes')
        # Every transfer request is checked against strict byte positions and actual account order.
        transfers=[i for i in m['instructions'][1:] if bytes.fromhex(i['data'])[:1]==b'\x04'];require(len(transfers)==(2 if k==2 else 1),'transfer inventory')
        nonce=struct.unpack_from('<Q',s,282)[0]
        for j,ix in enumerate(transfers):
            data=bytes.fromhex(ix['data']);require(len(data)==25 and struct.unpack_from('<QQQ',data,1)==(1_000_000,nonce+j,0),'transfer fields');actual=[m['accountKeys'][n] for n in ix['accounts']];require(actual[:7]==[vault,executor,tokens,recipient,mint,'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',policy] and len(actual)==8 and actual[7]==policy_data_key,'transfer accounts');
            writable=lambda n: n==0 or 2<=n<len(m['accountKeys'])-m['header']['readonlyUnsigned']
            require([writable(n) for n in ix['accounts']]==[True,False,True,True,False,False,False,False],'transfer writable bindings');
            require([n<m['header']['required'] for n in ix['accounts']]==[False,True,False,False,False,False,False,False],'transfer signer bindings');require(m['accountKeys'][ix['programIndex']]==va['owner'],'custody program binding')
        require(before[payer]['owner']=='11111111111111111111111111111111','payer system owner');
        rb=rawmap(r,'before');ra=rawmap(r,'after');changed={n for n in before if before[n]!=after[n]}
        policy_success='Program '+policy+' success'
        if k not in [0,5]:
            require(r['logs'].count('Program '+policy+' invoke [2]')==len(transfers) and r['logs'].count(policy_success)==len(transfers),'policy invocation evidence')
            budget='ComputeBudget111111111111111111111111111111';program=va['owner'];token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
            events=[l for l in r['logs'] if re.fullmatch(r'Program \S+ (invoke \[\d+\]|success|failed: .+)',l)]
            expected_events=['Program '+budget+' invoke [1]','Program '+budget+' success']
            for _ in transfers:expected_events+=['Program '+program+' invoke [1]','Program '+policy+' invoke [2]','Program '+policy+' success','Program '+token+' invoke [2]','Program '+token+' success','Program '+program+' success']
            if k==3:expected_events+=['Program '+program+' invoke [1]','Program '+program+' failed: custom program error: 0x64']
            require(events==expected_events,'invocation nesting/order')
        if k in [0,3,5]:
            require(changed<={payer},'refusal protected-store frame')
            if k!=3:require(before==after and r['fee']==0 and r['units']==0 and not r['logs'] and not r['historyRecorded'],'preexecution rejection')
            else:
                ix=m['instructions'][2];require(ix['data']=='0713000000' and not ix['accounts'] and m['accountKeys'][ix['programIndex']]==va['owner'],'unsupported abort request')
                lines=r['logs'];success='Program '+va['owner']+' success';token_success='Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success';failure='Program '+va['owner']+' failed: custom program error: 0x64';require(lines.count(success)==1 and lines.count(token_success)==1 and lines[-1]==failure and lines.index(token_success)<lines.index(success)<len(lines)-1,'abort log order')
        else:
            require(changed=={payer,vault,tokens,recipient},'successful effect frame');post=ra[vault][1];count=2 if k==2 else 1
            expected_state=bytearray(s);struct.pack_into('<Q',expected_state,266,struct.unpack_from('<Q',s,266)[0]+count*1_000_000);struct.pack_into('<Q',expected_state,282,nonce+count);require(bytes(expected_state)==post,'exact custody effects')
            for tk,delta in [(tokens,-count*1_000_000),(recipient,count*1_000_000)]:
                before_bytes=rb[tk][1];expected_token=bytearray(before_bytes);require(len(before_bytes)==165 and b58(before_bytes[:32])==mint and before_bytes[108]==1,'token format');struct.pack_into('<Q',expected_token,64,struct.unpack_from('<Q',before_bytes,64)[0]+delta);require(bytes(expected_token)==ra[tk][1],'exact token effects')
            for n in [vault,tokens,recipient]:require({x:y for x,y in rb[n][0].items() if x!='data'}=={x:y for x,y in ra[n][0].items() if x!='data'},'mutated-account metadata frame')
            require(r['logs'].count('Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success')==count,'positive CPI logs')
        if k not in [0,5]:require(r['fee']==10000 and r['historyRecorded'],'included fee/history');require(r['transactionId'] not in ids,'duplicate included ID');ids.append(r['transactionId'])
        for side,accounts in [('before',rb),('after',ra)]:
            mi=accounts[mint][1];require(len(mi)==82 and mi[44:46]==bytes([6,1]) and mi[:36]==bytes(36) and mi[46:82]==bytes(36),'mint');require({n for n,a in r[side+'Store'].items() if a['owner']=='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}=={mint,tokens,recipient,b58(bytes([15])*32)},'closed token-owned inventory');token_rows=[b for a,b in accounts.values() if len(b)==165];require(len(token_rows)==3 and all(b58(b[:32])==mint and b[108]==1 for b in token_rows) and sum(struct.unpack_from('<Q',b,64)[0] for b in token_rows)==struct.unpack_from('<Q',mi,36)[0]==100_000_000,'closed fixture supply');require(all(b[72:108]==bytes(36) and b[109:165]==bytes(56) for b in token_rows),'token delegate/native/close authority');require(b58(accounts[recipient][1][32:64])==b58(bytes([19])*32),'recipient fixture authority');require(all(a['owner']=='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' for a,b in accounts.values() if len(b) in [82,165]),'token/mint program owner');require(b58(accounts[tokens][1][32:64])==vault,'custody token authority');require(b58(accounts[b58(bytes([15])*32)][1][32:64])==owner,'source authority');clocks=[b for a,b in accounts.values() if len(b)==40];require(len(clocks)==1 and accounts['SysvarC1ock11111111111111111111111111111111'][1]==clocks[0] and accounts['SysvarC1ock11111111111111111111111111111111'][0]['owner']=='Sysvar1111111111111111111111111111111111111' and struct.unpack_from('<q',clocks[0],32)[0]==86401,'clock timestamp')
        summaries.append({'name':r['name'],'fee':r['fee'],'protectedStoreFrame':k in [0,3,5]})
    require(len({r['runtimeBlockhash'] for r in rows})==1,'runtime blockhash changed');
    a,b=decoded[5],decoded[6];require(a[0]==b[0] and a[2]==b[2],'signature control message changed');idx=a[0]['accountKeys'].index(executor);require(idx==1 and a[1][0]==b[1][0] and a[1][1][1:]==b[1][1][1:] and a[1][1][0]^b[1][1][0]==1,'executor signature mutation')
    require(decoded[3][0]['instructions'][1]==decoded[4][0]['instructions'][1],'nonce reuse request changed')
    return {'evidence':'finite_signed_transaction_store_checks','cases':summaries,'cryptographicVerification':'trusted LiteSVM; Python decoder does not verify Ed25519','rollbackScope':'three-instruction transaction abort (budget, transfer, unsupported); not failure within the custody transfer','leanProof':False}
def normalize(rows):
    # Validate actual full frames first; only cross-process naming is normalized.
    check(rows)
    template={'owner':'11111111111111111111111111111111','lamports':1000000000000000,'executable':False,'rentEpoch':0,'dataSha256':hashlib.sha256(b'').hexdigest()}
    keys=[k for k,v in rows[0]['beforeStore'].items() if v==template]
    require(len(keys)==1,'runtime funding account inventory');key=keys[0];out=copy.deepcopy(rows)
    for source,target in zip(rows,out):
        require(key not in source['message']['accountKeys'] and key not in [r['key'] for r in source['raw']],'referenced runtime funding account')
        for side in ['beforeStore','afterStore']:
            require(source[side].get(key)==template,'runtime funding account changed')
            target[side]['__UNREFERENCED_RUNTIME_FUNDING_ACCOUNT__']=target[side].pop(key)
    return out
if __name__=='__main__':
    try:print(json.dumps(check([json.loads(l) for l in open(sys.argv[1])]),indent=2))
    except (ValueError,KeyError,IndexError,struct.error) as e:raise SystemExit(str(e))
