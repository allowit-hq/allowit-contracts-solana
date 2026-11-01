#!/usr/bin/env python3
"""Compile a separate single-fault observer and check finite Lean certificates."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import types

HERE=Path(__file__).resolve().parent
FILES={'check.py','witnesses.py','trace.rs','../traces/check.py','../traces/trace.rs','../traces/certificates.py',
       '../traces/lock.json','../traces/receipt.json','../adapter/State.lean','../lean/NativeDaily.lean',
       '../check_published.py','../check_native.py'}
BANNED=r'\b(sorry|admit|axiom|unsafe|native_decide|implemented_by|extern|elab|macro|initialize|run_cmd)\b|debug\.skip(?:Kernel)?TC'


def digest(b):return hashlib.sha256(b).hexdigest()


def snapshot(lock):
    if set(lock)!={'version','files'} or type(lock['version']) is not int or lock['version']!=1 or set(lock['files'])!=FILES:raise ValueError('Unsupported isolation inventory')
    data={n:(HERE/n).read_bytes() for n in FILES}
    if {n:digest(b) for n,b in data.items()}!=lock['files']:raise ValueError('Changed isolation dependency')
    return data


def verified_modules(data):
    def load(name,path,source):
        module=types.ModuleType(name);module.__file__=str(path.resolve())
        exec(compile(source,module.__file__,'exec'),module.__dict__)
        return module
    old={n:sys.modules.get(n) for n in ['check_native','check_published','certificates']}
    try:
        sys.modules['check_native']=load('check_native',HERE/'../check_native.py',data['../check_native.py'])
        sys.modules['check_published']=load('check_published',HERE/'../check_published.py',data['../check_published.py'])
        base=load('certificates',HERE/'../traces/certificates.py',data['../traces/certificates.py']);sys.modules['certificates']=base
        historical=load('historical_trace_checker',HERE/'../traces/check.py',data['../traces/check.py'])
        generated=load('isolation_witnesses',HERE/'witnesses.py',data['witnesses.py']);generated.base=base
        return historical,generated
    finally:
        for name,module in old.items():
            if module is None:sys.modules.pop(name,None)
            else:sys.modules[name]=module


_initial=snapshot(json.loads((HERE/'lock.json').read_bytes()))
trace,witnesses=verified_modules(_initial)


def audit(log,names):
    found=re.findall(r"^'AllowIt\.Isolation\.(\w+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)$",log,re.M)
    if [n for n,_ in found]!=names or re.search(r'\b(error|sorryAx)\b',log):raise ValueError('Incomplete isolation proof audit')
    for name,axioms in found:
        if not set(filter(None,axioms.replace(' ','').split(',')))<={'propext','Quot.sound'}:raise ValueError('Unexpected axiom: '+name)


def logs(stderr):
    lines=stderr.splitlines();token='TOKEN_ELF 108600 8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697'
    if not lines or lines[0]!=token:raise ValueError('Wrong token artifact')
    names=[];current=None;result=[token];events={}
    for line in lines[1:]:
        if line.startswith('TRACE_BEGIN '):
            if current:raise ValueError('Nested trace')
            current=line[12:];names.append(current);result.append(line);events[current]=[]
        elif line.startswith('TRACE_END '):
            if line[10:]!=current:raise ValueError('Unpaired trace')
            current=None;result.append(line)
        else:
            if current is None or not re.match(r'^\[[^]]+ DEBUG solana_runtime::message_processor::stable_log\] ',line):raise ValueError('Unexpected VM output')
            event=re.sub(r'^\[[^]]+\] ','',line);result.append(event);events[current].append(event)
    if current or names!=witnesses.CASES:raise ValueError('Incomplete VM trace')
    vault='gBxS1f6uyyGPuW5MzGBukidSb71jdsCb5fZaoSzULE5'
    token_program='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
    failures={'revoked':'custom program error: 0x68','wrong_executor':'custom program error: 0x6e',
              'unsigned_executor':'missing required signature for instruction','stale_revision':'custom program error: 0x65','replay':'custom program error: 0x65'}
    for name,rows in events.items():
        terminal='Program '+vault+(' failed: '+failures[name] if name in failures else ' success')
        if not rows or rows[0]!='Program '+vault+' invoke [1]' or rows[-1]!=terminal:raise ValueError('Wrong custody invocation/result log')
        calls=[i for i,row in enumerate(rows) if row.startswith('Program '+token_program+' invoke ')]
        if name in failures and calls:raise ValueError('Refusal invoked token CPI')
        if name in {'deposit','spend','valid','valid_after_refusals'}:
            success='Program '+token_program+' success'
            if len(calls)!=1 or rows[calls[0]]!='Program '+token_program+' invoke [2]' or success not in rows or not calls[0]<rows.index(success)<len(rows)-1:raise ValueError('Missing successful token CPI')
    return '\n'.join(result)+'\n'


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--tools',type=Path,required=True);parser.add_argument('--emit-receipt',action='store_true');parser.add_argument('--emit-evidence',type=Path)
    args=parser.parse_args();tools=args.tools.resolve(strict=True);lock_bytes=(HERE/'lock.json').read_bytes();lock=json.loads(lock_bytes);data=snapshot(lock)
    if data!=_initial:raise ValueError('Dependency drift after verified loading')
    historical=json.loads(data['../traces/lock.json']);bound=trace.bindings(historical,tools);published,intake,repo,compiler,deps,lean=bound
    fixture=trace.check_published.committed(repo,published['targets']['solana']['revision'],'sbf-tests/tests/vault.rs').decode()
    marker='#[path = "../../policy/source_hash.rs"]'
    if '#[test]' not in fixture or fixture.split('#[test]',1)[0].count(marker)!=1:raise ValueError('Unsupported fixture prefix')
    fixture=fixture.split('#[test]',1)[0].replace(marker,'#[path = "source_hash.rs"]')
    observer=data['../traces/trace.rs'].decode();marker='\nfn main() {'
    if observer.count(marker)!=1:raise ValueError('Unsupported observer prefix')
    observer=observer.split(marker,1)[0]
    if not observer.startswith('#![allow(dead_code)]\n'):raise ValueError('Unsupported observer attribute')
    observer=observer.removeprefix('#![allow(dead_code)]\n')
    env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env['PATH']=str(compiler.parent)+':'+str(lean.parent)+':/usr/bin:/bin'
    with tempfile.TemporaryDirectory(prefix='allowit-isolation-',dir=tools) as temp:
        root=Path(temp);env.update(TMPDIR=str(root),LEAN_PATH=str(root),SBF_OUT_DIR=str(root),RUST_LOG='solana_runtime::message_processor::stable_log=debug')
        for exe,flag,expected in [(compiler,'-vV',historical['compiler']['version']),(lean,'--version',historical['lean']['version'])]:
            out,err=trace.run([exe,flag],root,env)
            if err or out.strip()!=expected:raise ValueError('Wrong tool version')
        for name,b in {'fixture.rs':fixture.encode(),'observer.rs':observer.encode(),'trace.rs':data['trace.rs'],
                       'source_hash.rs':trace.check_published.committed(repo,published['targets']['solana']['revision'],'policy/source_hash.rs'),
                       'State.lean':data['../adapter/State.lean'],'NativeDaily.lean':data['../lean/NativeDaily.lean']}.items():(root/name).write_bytes(b)
        for entry in intake['solana']['manifest']['artifacts']:
            b=(repo/published['targets']['solana']['artifact_directory']/entry['name']).read_bytes()
            if digest(b)!=entry['sha256']:raise ValueError('Changed artifact')
            (root/entry['name']).write_bytes(b)
        command=[compiler,'--edition=2024','-C','debuginfo=0','--remap-path-prefix='+str(root)+'=/allowit-isolation','-L','dependency='+str(deps),root/'trace.rs','-o',root/'trace']
        for name,path in historical['externs'].items():command+=['--extern',name+'='+str(deps/path)]
        _,err=trace.run(command,root,env)
        if err:raise ValueError('Compiler diagnostics')
        executable=digest((root/'trace').read_bytes());stdout,stderr=trace.run([root/'trace'],root,env)
        if digest((root/'trace').read_bytes())!=executable:raise ValueError('Changed observer executable')
        vectors=[json.loads(line) for line in stdout.splitlines()];source,names=witnesses.generate(vectors);events=logs(stderr)
        for text in [source,data['../adapter/State.lean'].decode(),data['../lean/NativeDaily.lean'].decode()]:
            if re.search(BANNED,text):raise ValueError('Unaccepted proof construct')
        for name in ['NativeDaily','State']:
            _,err=trace.run([lean,'-o',name+'.olean',name+'.lean'],root,env)
            if err:raise ValueError('Model compilation diagnostics')
        (root/'Isolation.lean').write_text(source);proof,err=trace.run([lean,'Isolation.lean'],root,env)
        if err:raise ValueError('Certificate diagnostics')
        audit(proof,names)
    if trace.bindings(historical,tools)!=bound or snapshot(lock)!=data or (HERE/'lock.json').read_bytes()!=lock_bytes:raise ValueError('Inputs changed during acceptance')
    outputs={'vectors.jsonl':stdout,'events.txt':events,'Isolation.lean':source,'proof-check.txt':proof}
    receipt={'evidence':'finite_single_fault_model_and_vm_witnesses','lockSha256':digest(lock_bytes),'dependencies':lock['files'],
             'historicalTraceReceiptSha256':digest(data['../traces/receipt.json']),'contractRevisions':{k:v['revision'] for k,v in published['targets'].items()},
             'artifacts':intake['solana']['manifest']['artifacts'],'harnessExecutableSha256':executable,
             'cases':witnesses.CASES,'faults':witnesses.FAULTS,'certificates':names,'outputs':{n:digest(b.encode()) for n,b in outputs.items()},
             'cachedDependencyBuildFidelityTrusted':True,'listedPythonDependenciesLoadedFromVerifiedBytes':True,'transitivePythonImportClosureEnforced':False,'tokenAccountBindingFormallyProved':False,'assetEvidenceScope':'four Lean-rechecked arithmetic transcriptions of Python-decoded balance deltas; account identity and supply checks are Python-only','sameModuleRebind':True,
             'refusalLogsHaveNoTokenCpi':True,'observedProjectionContinuityChecked':True,'fixtureThreeAccountSupplyChecked':True,
             'singleFaultDomain':'11 non-environment transfer model conditions; excludes readiness and exact-next existential construction',
             'repairWitnessScope':'model counterfactuals with readiness=True; separate actual successes are recorded without claiming exact intervention correspondence',
             'realSignaturesProved':False,'platformReadinessProved':False,'rollbackProved':False,'universalAdapterRefinement':False,
             'errorCauseOrPrecedenceProved':False,'compiledProgramBuildProvenanceProved':False,'clientExecution':False,'deploymentChecked':False}
    rendered=json.dumps(receipt,indent=2)+'\n'
    if not args.emit_receipt:
        if (HERE/'receipt.json').read_bytes()!=rendered.encode():raise ValueError('Stale isolation receipt')
        for n,b in outputs.items():
            if (HERE/n).read_bytes()!=b.encode():raise ValueError('Changed isolation output')
    if args.emit_evidence:
        out=args.emit_evidence.resolve()
        if not out.is_relative_to(tools):raise ValueError('Candidate output outside tool root')
        out.mkdir(parents=True,exist_ok=True)
        for n,b in outputs.items():(out/n).write_text(b)
    print(rendered,end='')


if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError,TypeError,subprocess.SubprocessError) as error:
        print(json.dumps({'evidence':'not_accepted','error':str(error)}));raise SystemExit(1)
