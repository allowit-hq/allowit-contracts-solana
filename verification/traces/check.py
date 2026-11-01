#!/usr/bin/env python3
"""Rebuild an isolated trace harness, execute pinned SBF, and check finite Lean correspondence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
import check_published
import certificates

FILES={'check.py','certificates.py','trace.rs','../adapter/State.lean','../adapter/lock.json',
       '../lean/NativeDaily.lean','../published-source-lock.json','../check_published.py','../check_native.py'}
AXIOMS={'propext','Quot.sound'}


def digest(b):return hashlib.sha256(b).hexdigest()


def identity(root, suffixes=None):
    files=[p for p in sorted(root.rglob('*')) if p.is_file() and (suffixes is None or p.suffix in suffixes)]
    entries=[(str(p.relative_to(root)),digest(p.read_bytes())) for p in files]
    return [digest(json.dumps(entries,separators=(',',':')).encode()),len(files)]


def run(args,cwd,env):
    r=subprocess.run(list(map(str,args)),cwd=cwd,env=env,capture_output=True,text=True,timeout=180)
    if r.returncode:raise ValueError(str(args[0])+' failed: '+r.stderr[-2000:])
    return r.stdout,r.stderr


def audit(log,names):
    actual=re.findall(r"^'AllowIt\.CustodyTraces\.(\w+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)$",log,re.M)
    if [n for n,_ in actual]!=names or re.search(r'\b(error|sorryAx)\b',log):raise ValueError('Incomplete trace certificate audit')
    for n,axioms in actual:
        if not set(filter(None,axioms.replace(' ','').split(',')))<=AXIOMS:raise ValueError('Unexpected certificate axiom: '+n)


def logs(stderr):
    expected='TOKEN_ELF 108600 8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697'
    lines=stderr.splitlines()
    if not lines or lines[0]!=expected:raise ValueError('Unexpected embedded token ELF')
    current=None;events={};normalized=[lines[0]]
    for line in lines[1:]:
        if line.startswith('TRACE_BEGIN '):
            name=line.split(' ',1)[1]
            if current or name in events:raise ValueError('Duplicate or nested runtime trace')
            current=name;events[name]=[];normalized.append(line)
        elif line.startswith('TRACE_END '):
            if line.split(' ',1)[1]!=current:raise ValueError('Unpaired runtime trace')
            current=None;normalized.append(line)
        else:
            if current is None or not re.match(r'^\[[^]]+ DEBUG solana_runtime::message_processor::stable_log\] ',line):raise ValueError('Unexpected runtime diagnostic')
            event=re.sub(r'^\[[^]]+\] ','',line);events[current].append(event);normalized.append(event)
    if current or list(events)!=certificates.CASES:raise ValueError('Incomplete runtime log')
    budget=events['budget_exhaustion_rollback']
    invoke='Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]'
    success='Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success'
    failures=[i for i,x in enumerate(budget) if 'failed: exceeded CUs meter at BPF instruction' in x]
    root_call=re.fullmatch(r'Program (\w+) invoke \[1\]',budget[0]) if budget else None
    if (invoke not in budget or success not in budget or not failures or not root_call
            or not budget[failures[0]].startswith('Program '+root_call[1]+' failed:')
            or not budget.index(invoke)<budget.index(success)<failures[0]):
        raise ValueError('Rollback witness did not reach successful token CPI before resource failure')
    return '\n'.join(normalized)+'\n'


def bindings(lock,tools):
    if (set(lock)!={'version','files','sources','compiler','dependencies','externs','lean'}
            or type(lock['version']) is not int or lock['version']!=1 or set(lock['files'])!=FILES
            or set(lock['sources'])!={'sbf-tests/tests/vault.rs','policy/source_hash.rs'}
            or set(lock['compiler'])!={'executable','sha256','libraries','library_identity','version'}
            or set(lock['dependencies'])!={'directory','identity'}
            or set(lock['externs'])!={'allowit_interface','borsh','mollusk_svm_programs_token','mollusk_svm',
                                    'solana_account','solana_instruction','solana_program','solana_pubkey',
                                    'spl_token','solana_program_error','serde_json'}):raise ValueError('Unsupported trace lock inventory')
    for p,h in lock['files'].items():
        if digest((HERE/p).read_bytes())!=h:raise ValueError('Changed trace dependency')
    published=json.loads((HERE.parent/'published-source-lock.json').read_text());intake=check_published.intake(published)
    target=published['targets']['solana'];repo=(check_published.ROOT/target['repository']).resolve()
    for path,h in lock['sources'].items():
        if digest(check_published.committed(repo,target['revision'],path))!=h:raise ValueError('Changed fixture source')
    compiler=Path(lock['compiler']['executable']).resolve(strict=True)
    if digest(compiler.read_bytes())!=lock['compiler']['sha256'] or identity(Path(lock['compiler']['libraries']))!=lock['compiler']['library_identity']:raise ValueError('Changed host Rust compiler/core')
    deps=repo/lock['dependencies']['directory']
    if lock['dependencies']['directory']!='sbf-tests/target/debug/deps' or identity(deps,{'.rlib','.rmeta','.dylib','.a','.so'})!=lock['dependencies']['identity']:raise ValueError('Changed cached Rust dependencies')
    for name,path in lock['externs'].items():
        if not re.fullmatch(r'lib'+name+r'-[0-9a-f]{16}\.rlib',path) or not (deps/path).is_file():raise ValueError('Invalid direct dependency')
    parent_lean=json.loads((HERE.parent/'adapter/lock.json').read_text())['lean']
    if lock['lean']!=parent_lean:raise ValueError('Changed Lean pin')
    lean=tools/lock['lean']['executable']
    if digest(lean.read_bytes())!=lock['lean']['sha256'] or identity(tools/lock['lean']['libraries'])!=lock['lean']['library_identity']:raise ValueError('Changed Lean binary/core')
    for path in ('../adapter/State.lean','../lean/NativeDaily.lean'):
        if re.search(r'\b(sorry|admit|axiom|unsafe|native_decide|implemented_by|extern|elab|macro|initialize|run_cmd)\b|debug\.skip(?:Kernel)?TC',(HERE/path).read_text()):raise ValueError('Unaccepted model proof construct')
    return published,intake,repo,compiler,deps,lean


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--tools',type=Path,required=True);p.add_argument('--emit-receipt',action='store_true');p.add_argument('--emit-evidence',type=Path)
    args=p.parse_args();tools=args.tools.resolve(strict=True);lock_bytes=(HERE/'lock.json').read_bytes();lock=json.loads(lock_bytes)
    bound=bindings(lock,tools);published,intake,repo,compiler,deps,lean=bound
    snapshots={n:(HERE/n).read_bytes() for n in FILES}
    if {n:digest(b) for n,b in snapshots.items()}!=lock['files']:raise ValueError('Changed frozen input')
    fixture=check_published.committed(repo,published['targets']['solana']['revision'],'sbf-tests/tests/vault.rs').decode()
    if '#[test]' not in fixture or fixture.split('#[test]',1)[0].count('#[path = "../../policy/source_hash.rs"]')!=1:raise ValueError('Unsupported fixture extraction boundary')
    fixture=fixture.split('#[test]',1)[0].replace('#[path = "../../policy/source_hash.rs"]','#[path = "source_hash.rs"]')
    source=check_published.committed(repo,published['targets']['solana']['revision'],'policy/source_hash.rs')
    env={k:os.environ[k] for k in ('HOME','LANG','LC_ALL') if k in os.environ};env['PATH']=str(compiler.parent)+':'+str(lean.parent)+':/usr/bin:/bin'
    with tempfile.TemporaryDirectory(prefix='allowit-custody-run-',dir=tools) as temp:
        root=Path(temp);env.update(TMPDIR=str(root),LEAN_PATH=str(root),SBF_OUT_DIR=str(root),RUST_LOG='solana_runtime::message_processor::stable_log=debug')
        lean_version,lean_err=run([lean,'--version'],root,env)
        if lean_err or lean_version.strip()!=lock['lean']['version']:raise ValueError('Wrong Lean version')
        version,err=run([compiler,'-vV'],root,env)
        if err or version.strip()!=lock['compiler']['version']:raise ValueError('Wrong host compiler')
        for n,b in {'fixture.rs':fixture.encode(),'source_hash.rs':source,'trace.rs':snapshots['trace.rs'],'State.lean':snapshots['../adapter/State.lean'],'NativeDaily.lean':snapshots['../lean/NativeDaily.lean']}.items():(root/n).write_bytes(b)
        for entry in intake['solana']['manifest']['artifacts']:
            b=(repo/published['targets']['solana']['artifact_directory']/entry['name']).read_bytes()
            if digest(b)!=entry['sha256']:raise ValueError('Changed artifact snapshot')
            (root/entry['name']).write_bytes(b)
        command=[compiler,'--edition=2024','-C','debuginfo=0',
                 '--remap-path-prefix='+str(root)+'=/allowit-custody','-L','dependency='+str(deps),root/'trace.rs','-o',root/'trace']
        for n,path in lock['externs'].items():command+=['--extern',n+'='+str(deps/path)]
        _,err=run(command,root,env)
        if err:raise ValueError('Unexpected compiler diagnostics')
        executable_digest=digest((root/'trace').read_bytes())
        stdout,stderr=run([root/'trace'],root,env)
        if digest((root/'trace').read_bytes())!=executable_digest:raise ValueError('Harness changed during execution')
        vectors=[json.loads(line) for line in stdout.splitlines()];generated,names=certificates.generate(vectors);event_log=logs(stderr)
        (root/'Certificates.lean').write_text(generated)
        if re.search(r'\b(sorry|admit|axiom|unsafe|native_decide|implemented_by|extern|elab|macro|initialize|run_cmd)\b|debug\.skip(?:Kernel)?TC',generated):raise ValueError('Unaccepted generated certificate construct')
        for module in ('NativeDaily','State'):
            _,err=run([lean,'-o',module+'.olean',module+'.lean'],root,env)
            if err:raise ValueError('Unexpected Lean diagnostics')
        proof,err=run([lean,'Certificates.lean'],root,env)
        if err:raise ValueError('Unexpected certificate diagnostics')
        audit(proof,names)
    if bindings(lock,tools)!=bound or (HERE/'lock.json').read_bytes()!=lock_bytes:raise ValueError('Trace inputs changed during execution')
    outputs={'vectors.jsonl':stdout,'events.txt':event_log,'Certificates.lean':generated,'proof-check.txt':proof}
    receipt={'evidence':'finite_compiled_adapter_projection_correspondence','lockSha256':digest(lock_bytes),
             'dependencies':lock['files'],'contractRevisions':{k:v['revision'] for k,v in published['targets'].items()},
             'artifacts':intake['solana']['manifest']['artifacts'],'compiler':lock['compiler'],
             'rustDependencyCache':lock['dependencies'],'lean':lock['lean'],
             'outputs':{n:digest(b.encode()) for n,b in outputs.items()},'harnessExecutableSha256':executable_digest,
             'ordinaryCases':len(vectors)-1,'successfulCases':sum(v['outcome']=='Success' for v in vectors[:-1]),
             'rejectedCases':sum(v['outcome']!='Success' for v in vectors[:-1]),'diagnosticCases':1,
             'certificates':names,'rustHarnessRebuilt':True,'cachedDependencyBuildFidelityTrusted':True,
             'fixtureThreeAccountSupplyChecked':True,'ordinarySuccessReadyInstantiatedTrue':True,
             'readyImplementationProved':False,'signatureCryptographyProved':False,
             'universalAdapterRefinement':False,'compiledProgramBuildProvenanceProved':False,
             'clientExecution':False,'deploymentChecked':False}
    rendered=json.dumps(receipt,indent=2)+'\n'
    if not args.emit_receipt:
        if (HERE/'receipt.json').read_bytes()!=rendered.encode():raise ValueError('Stale trace receipt')
        for n,b in outputs.items():
            if (HERE/n).read_bytes()!=b.encode():raise ValueError('Retained trace evidence changed: '+n)
    if args.emit_evidence:
        destination=args.emit_evidence.resolve()
        if not destination.is_relative_to(tools):raise ValueError('Candidate evidence must stay inside the isolated tool root')
        destination.mkdir(parents=True,exist_ok=True)
        for n,b in outputs.items():(destination/n).write_text(b)
    print(rendered,end='')


if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError,subprocess.SubprocessError) as error:
        print(json.dumps({'evidence':'not_accepted','error':str(error)}));raise SystemExit(1)
