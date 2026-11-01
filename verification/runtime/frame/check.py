#!/usr/bin/env python3
"""Fresh Lean check of locked retained corpora; never executes a VM or installs tools."""
import ast,argparse,hashlib,json,os,re,subprocess,sys,tempfile,types
from pathlib import Path
HERE=Path(__file__).resolve().parent
SDK=HERE.parents[2]
AXIOMS={'propext','Quot.sound'}
GENERIC=['charge_keys','charge_protected','charge_zero','fee_frame_protected','fee_frame_keys','failure_protected','before_execution_unchanged','abort_iff','funded_abort_exists','funded_debit_exact']
DENIED=r'\b(sorry|admit|axiom|unsafe|native_decide|implemented_by|extern|elab|macro|initialize|run_cmd|run_elab|run_meta)\b|debug\.skip(?:Kernel)?TC|#eval!?'
def digest(b):return hashlib.sha256(b).hexdigest()
def require(p,msg):
    if not p:raise ValueError(msg)
def tree_identity(directory):
    e=[(str(p.relative_to(directory)),digest(p.read_bytes())) for p in sorted(directory.rglob('*')) if p.is_file()]
    return [digest(json.dumps(e,separators=(',',':')).encode()),len(e)]
def audit(log,namespace,names):
    matches=re.findall(r"^'"+re.escape(namespace)+r"\.(\w+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)$",log,re.M)
    require([n for n,_ in matches]==names and not re.search(r'\b(error|warning|sorryAx)\b',log),'incomplete or failed proof audit')
    for n,a in matches:require(set(filter(None,a.replace(' ','').split(',')))<=AXIOMS,'unaccepted proof axiom '+n)
def strict_json(data):
    def pairs(items):
        result={}
        for k,v in items:
            require(k not in result,'duplicate JSON key');result[k]=v
        return result
    return json.loads(data,object_pairs_hook=pairs)
def import_check(data):
    for node in ast.walk(ast.parse(data)):
        if isinstance(node,ast.Import):
            require(all(n.name in {'copy','hashlib','json','re','struct','sys'} for n in node.names),'unapproved snapshot import')
        if isinstance(node,ast.ImportFrom):require(node.level==0 and node.module=='pathlib' and all(n.name=='Path' for n in node.names),'unapproved snapshot import')
        if isinstance(node,ast.Call) and isinstance(node.func,ast.Name):require(node.func.id not in {'__import__','eval','exec'},'dynamic snapshot import/execution')
def dataset_binding(binding,observation,source,manifest):
    require(binding['contractRevision']==source['revision'] and binding['manifestSha256']==source['files']['artifacts/manifest.json']==observation['manifest']['sha256'] and observation['manifest']['revision']==source['revision'],'dataset manifest binding')
    require(binding['sourceFiles']=={k:source['files'][k] for k in ['programs/vault/src/lib.rs','crates/interface/src/lib.rs']},'dataset source binding')
    require(binding['sourceBundleIdentifier']==manifest['source_bundle'],'dataset bundle binding')
    published={a['name']:a for a in manifest['artifacts']}
    require(set(published)=={'allowit_policy.so','allowit_vault.so'} and set(observation['artifacts'])==set(binding['artifacts'])==set(published)|{'token.so'},'dataset artifact inventory')
    for name,a in observation['artifacts'].items():
        require(a['sha256']==binding['artifacts'][name],'dataset artifact binding')
        if name in published:require(a==published[name],'published artifact descriptor changed')
    require(observation['artifacts']['token.so']['repository']=='LiteSVM/litesvm' and observation['artifacts']['token.so']['revision']==observation['upstreamRevision']=='980f39121cda14bc78d8c46489d2d12fb0cc6eae','token research identity')
def proof_screen(data,historical=False):
    text=data.decode() if isinstance(data,bytes) else data
    if historical:
        require(re.findall(r'^#eval.*$',text,re.M)==['#eval evaluate exampleContext'],'historical evaluation changed')
        text=text.replace('#eval evaluate exampleContext','',1)
    require(not re.search(DENIED,text),'unaccepted local proof construct')
def load_module(name,data,path):
    import_check(data)
    m=types.ModuleType(name);m.__file__=str(path);exec(compile(data,str(path),'exec'),m.__dict__);return m

def verify_lock(lock,tools):
    require(set(lock)=={'version','files','lean','sources'} and type(lock['version']) is int and lock['version']==1,'unsupported frame lock')
    required={'Frame.lean','certificates.py','check.py','README.md','Corpus.lean','../../adapter/State.lean','../../lean/NativeDaily.lean','../../adapter/lock.json','../../tests/test_frame.py'}
    for dataset in ['transaction','failure-boundary']:
        receipt=strict_json((HERE.parent/dataset/'observation.json').read_bytes())
        required.add('../'+dataset+'/observation.json')
        required.update('../'+dataset+'/'+f for f in receipt['files'])
        required.add('../../tests/test_'+('transaction' if dataset=='transaction' else 'failure_boundary')+'.py')
        require(digest((SDK/'verification/tests'/('test_'+('transaction' if dataset=='transaction' else 'failure_boundary')+'.py')).read_bytes())==receipt['testFileSha256'],'historical test identity changed')
        for f,h in receipt['files'].items():require(digest((HERE.parent/dataset/f).read_bytes())==h,'historical receipt file changed')
    require(set(lock['files'])==required,'frame input inventory mismatch')
    snapshots={f:(HERE/f).read_bytes() for f in sorted(required)}
    require({f:digest(b) for f,b in snapshots.items()}==lock['files'],'changed frame input')
    lean=tools/lock['lean']['executable'];require(digest(lean.read_bytes())==lock['lean']['sha256'],'changed Lean executable')
    require(tree_identity(tools/lock['lean']['libraries'])==lock['lean']['library_identity'],'changed Lean libraries')
    require(lock['lean']==strict_json(snapshots['../../adapter/lock.json'])['lean'],'Lean pin differs from historical core pin')
    expected_sources={'../../../AllowIt-contracts-solana':{'programs/vault/src/lib.rs','crates/interface/src/lib.rs','artifacts/manifest.json','policy/policy.rs','policy/policy_api.rs'}}
    require({i['repository']:set(i['files']) for i in lock['sources']}==expected_sources and len(lock['sources'])==1,'source inventory mismatch')
    for item in lock['sources']:
        repo=(SDK/item['repository']).resolve();git_env={'PATH':'/usr/bin:/bin','HOME':os.environ.get('HOME','/nonexistent'),'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'};head=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True,env=git_env).strip();require(head==item['revision'],'production head changed')
        for path,h in item['files'].items():
            committed=subprocess.check_output(['git','-C',str(repo),'show',head+':'+path],env=git_env);require(digest(committed)==h and digest((repo/path).read_bytes())==h,'production source changed')
    return snapshots,lean

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--tools',type=Path,required=True);ap.add_argument('--emit-receipt',action='store_true');ap.add_argument('--emit-evidence',type=Path);args=ap.parse_args();require(sys.flags.isolated and sys.dont_write_bytecode,'run acceptance with python3 -I -B');tools=args.tools.resolve(strict=True);lock_bytes=(HERE/'lock.json').read_bytes();lock=strict_json(lock_bytes);snapshots,lean=verify_lock(lock,tools)
    env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env['PATH']=str(lean.parent)+':/usr/bin:/bin'
    logs={};datasets={};validator_summaries={};digest_summaries={}
    with tempfile.TemporaryDirectory(prefix='allowit-frame-',dir=tools) as td:
        root=Path(td);env.update(LEAN_PATH=str(root),TMPDIR=str(root))
        for dataset in ['transaction','failure-boundary']:
            dr=root/dataset;dr.mkdir()
            for f in ['validate.py','bindings.json']: (dr/f).write_bytes(snapshots['../'+dataset+'/'+f])
            binding=strict_json(snapshots['../'+dataset+'/bindings.json']);observation=strict_json(snapshots['../'+dataset+'/observation.json']);source=lock['sources'][0];manifest=strict_json((SDK/source['repository']/'artifacts/manifest.json').read_bytes());dataset_binding(binding,observation,source,manifest)
            v=load_module(dataset.replace('-','_'),snapshots['../'+dataset+'/validate.py'],dr/'validate.py')
            rows=[strict_json(l) for l in snapshots['../'+dataset+'/vectors.jsonl'].decode().splitlines()];replay=[strict_json(l) for l in snapshots['../'+dataset+'/replay.jsonl'].decode().splitlines()];summary=v.check(rows);require(summary==strict_json(snapshots['../'+dataset+'/validation.json']),'historical validation summary changed');require(v.normalize(rows)==v.normalize(replay),'retained replay mismatch');nd=digest(json.dumps(v.normalize(rows),sort_keys=True,separators=(',',':')).encode());require(nd==strict_json(snapshots['../'+dataset+'/observation.json'])['normalizedCorpusSha256'],'historical normalized digest changed');datasets[dataset]=rows;validator_summaries[dataset]=summary;digest_summaries[dataset]=nd
        c=load_module('frame_certificates',snapshots['certificates.py'],root/'certificates.py');generated,names=c.generate(datasets);require(generated.encode()==snapshots['Corpus.lean'],'stale generated frame certificates')
        for name,source in [('NativeDaily.lean','../../lean/NativeDaily.lean'),('State.lean','../../adapter/State.lean'),('Frame.lean','Frame.lean'),('Corpus.lean','Corpus.lean')]:
            data=snapshots[source];proof_screen(data,name=='NativeDaily.lean');(root/name).write_bytes(data)
        def run(args):
            r=subprocess.run([str(lean)]+args,cwd=root,env=env,capture_output=True,text=True,timeout=180);require(r.returncode==0 and not r.stderr.strip(),'Lean check failed: '+r.stdout[-1800:]+r.stderr[-500:]);return r.stdout
        require(run(['--version']).strip()==lock['lean']['version'],'Lean version changed')
        for name,ns,expected in [('NativeDaily','AllowIt.NativeDaily',None),('State','AllowIt.Adapter',None),('Frame','AllowIt.Transaction',GENERIC),('Corpus','AllowIt.TransactionCorpus',names)]:
            logs[name]=run(['-o',name+'.olean',name+'.lean']);declared=re.findall(r'^theorem\s+(\w+)',(root/(name+'.lean')).read_text(),re.M);require(expected is None or declared==expected,'theorem inventory changed');audit(logs[name],ns,expected if expected is not None else declared)
        def control(fee,post_lamports,owner,protected_lamports):
            a='{ owner := 0, lamports := 5, executable := false, rentEpoch := 0, dataDigest := 0 }'
            b='{ owner := 0, lamports := 8, executable := false, rentEpoch := 0, dataDigest := 0 }'
            x='{ owner := '+str(owner)+', lamports := '+str(post_lamports)+', executable := false, rentEpoch := 0, dataDigest := 0 }'
            y='{ owner := 0, lamports := '+str(protected_lamports)+', executable := false, rentEpoch := 0, dataDigest := 0 }'
            return 'import Frame\nopen AllowIt.Transaction\nexample : FeeFrame [(1, '+a+'), (2, '+b+')] [(1, '+x+'), (2, '+y+')] 1 '+str(fee)+' := by\n  exact ⟨by decide, ⟨'+a+', by decide, by decide⟩, by decide⟩\n'
        (root/'Positive.lean').write_text(control(2,3,0,8));run(['Positive.lean'])
        negatives={}
        for name,params in [('Underfunded',(6,0,0,8)),('PayerMetadata',(2,3,1,8)),('ProtectedBalance',(2,3,0,7))]:
            filename='Negative'+name+'.lean';(root/filename).write_text(control(*params));r=subprocess.run([str(lean),filename],cwd=root,env=env,capture_output=True,text=True,timeout=180);require(r.returncode==1 and not r.stderr.strip() and "Tactic `decide` proved that the proposition" in r.stdout and 'is false' in r.stdout and 'sorryAx' not in r.stdout,'invalid negative proof control');negatives[name]={'exitCode':r.returncode,'falsePropositionRejected':True}
        # These controls perturb actual retained-store/request definitions, rather than only toy stores.
        base='failure_boundary_post_cpi_failure';good='failure_boundary_post_cpi_reuse';row=next(x for x in datasets['failure-boundary'] if x['name']=='post_cpi_failure');pk=row['message']['accountKeys'][0];pid=c.identity(pk);target=c.identity(next(k for k in row['afterStore'] if k!=pk))
        mutations={
            'CorpusProtectedDigest':f"import Corpus\nopen AllowIt.Transaction AllowIt.TransactionCorpus\nexample : FeeFrame {base}_before ({base}_after.map (fun e => if e.1 = {target} then (e.1, {{e.2 with dataDigest := e.2.dataDigest + 1}}) else e)) {pid} 10000 := by\n  exact ⟨by decide, ⟨{c.account(row['beforeStore'][pk])}, by decide, by decide⟩, by decide⟩\n",
            'CorpusWrongNonce':f"import Corpus\nopen AllowIt.TransactionCorpus\nexample : {good}_abort_action = (.transfer ⟨{c.transfer(row)['actor']}, true⟩ {c.transfer(row)['recipient']} {c.word(c.transfer(row)['amount'])} ⟨{c.transfer(row)['nonce']+1}, by decide⟩ {c.word(c.transfer(row)['revision'])} {c.word(c.transfer(row)['now'])}) := by decide\n"}
        for name,source in mutations.items():
            proof_screen(source);filename='Negative'+name+'.lean';(root/filename).write_text(source);r=subprocess.run([str(lean),filename],cwd=root,env=env,capture_output=True,text=True,timeout=180);require(r.returncode==1 and not r.stderr.strip() and "Tactic `decide` proved that the proposition" in r.stdout and 'is false' in r.stdout and 'sorryAx' not in r.stdout,'invalid corpus negative proof control: '+r.stdout[-600:]);negatives[name]={'exitCode':r.returncode,'falsePropositionRejected':True}
    after,_=verify_lock(lock,tools);require(after==snapshots and (HERE/'lock.json').read_bytes()==lock_bytes,'inputs changed during proof check')
    receipt={'evidence':'retained_corpus_finite_frame_and_reuse_certificates','lockSha256':digest(lock_bytes),'inputs':lock['files'],'lean':lock['lean'],'sources':lock['sources'],'genericTheorems':GENERIC,'finiteCertificates':names,'axiomAllowlist':sorted(AXIOMS),'proofLogSha256':{k:digest(v.encode()) for k,v in logs.items()},'normalizedCorpusSha256':digest_summaries,'validatorSummaries':validator_summaries,'freshLeanChecks':True,'isolatedInterpreterRequired':True,'bytecodeCache':'disabled','historicalEvaluationAllowlist':['NativeDaily.lean: #eval evaluate exampleContext'],'pythonVersion':sys.version,'pythonExecutableSha256':digest(Path(sys.executable).read_bytes()),'stdlibImportAllowlist':['copy','hashlib','json','pathlib.Path','re','struct','sys'],'snapshotImportCheck':'AST explicit import/dynamic-call screen; transitive stdlib loading and Python execution trusted','positiveFeeFrameControl':True,'negativeProofControls':negatives,'freshVMExecution':False,'observerAndParsingTrusted':True,'accountProjection':'opaque symbolic owner/data-digest identities; lamports/executable/rentEpoch checked; raw-byte/hash fidelity and complete enumeration trusted','stageClassification':'outside the formal fee relation; locked Python validators check observed outcome/log boundaries; no Lean instruction-trace theorem','successScope':'three immediately successful identical transfer actions satisfy handwritten custody Transition for arbitrary readiness predicate given its explicit environment hypothesis; readiness unproved','adapterSourceRefinement':False,'universalRuntimeRollback':False,'compiledBuildProvenance':False,'clientExecution':False,'deploymentIdentity':False,'releaseObligationsClosed':[]}
    rendered=json.dumps(receipt,indent=2)+'\n'
    if args.emit_evidence:
        out=args.emit_evidence.resolve();require(out==tools or tools in out.parents,'evidence output must stay in isolated tool root');out.mkdir(exist_ok=True,parents=True)
        for k,v in logs.items():(out/(k+'-check.txt')).write_text(v)
    if not args.emit_receipt:require((HERE/'receipt.json').read_bytes()==rendered.encode(),'stale frame receipt')
    print(rendered,end='')
if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError,TypeError,subprocess.SubprocessError) as e:
        print(json.dumps({'evidence':'not_accepted','error':str(e)}));raise SystemExit(1)
