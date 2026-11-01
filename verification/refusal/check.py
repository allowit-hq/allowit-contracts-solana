#!/usr/bin/env python3
"""Replay unchanged VM evidence and check separate finite model nonpermission certificates."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import refusals

HERE=Path(__file__).resolve().parent
FILES={'check.py','refusals.py','../traces/check.py','../traces/certificates.py','../traces/lock.json',
       '../traces/receipt.json','../traces/vectors.jsonl','../traces/Certificates.lean',
       '../traces/proof-check.txt','../adapter/State.lean','../adapter/lock.json','../lean/NativeDaily.lean'}
BANNED=r'\b(sorry|admit|axiom|unsafe|native_decide|implemented_by|extern|elab|macro|initialize|run_cmd)\b|debug\.skip(?:Kernel)?TC'


def digest(b):return hashlib.sha256(b).hexdigest()


def snapshot(lock):
    if set(lock)!={'version','files'} or type(lock['version']) is not int or lock['version']!=1 or set(lock['files'])!=FILES:raise ValueError('Unsupported refusal inventory')
    result={n:(HERE/n).read_bytes() for n in FILES}
    if {n:digest(b) for n,b in result.items()}!=lock['files']:raise ValueError('Changed refusal dependency')
    return result


def audit(log,names):
    observed=re.findall(r"^'AllowIt\.Refusals\.(\w+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)$",log,re.M)
    if [n for n,_ in observed]!=names or re.search(r'\b(error|sorryAx)\b',log):raise ValueError('Incomplete refusal certificate audit')
    for name,axioms in observed:
        if not set(filter(None,axioms.replace(' ','').split(',')))<={'propext','Quot.sound'}:raise ValueError('Unexpected refusal axiom: '+name)


def run(command,root,env):
    result=subprocess.run(list(map(str,command)),cwd=root,env=env,capture_output=True,text=True,timeout=240)
    if result.returncode:raise ValueError(str(command[0])+' failed: '+result.stderr[-2000:]+result.stdout[-2000:])
    return result.stdout,result.stderr


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--tools',type=Path,required=True);parser.add_argument('--emit-receipt',action='store_true');parser.add_argument('--emit-evidence',type=Path)
    args=parser.parse_args();tools=args.tools.resolve(strict=True);lock_bytes=(HERE/'lock.json').read_bytes();lock=json.loads(lock_bytes);inputs=snapshot(lock)
    trace_lock=json.loads(inputs['../traces/lock.json']);lean=tools/trace_lock['lean']['executable']
    env={k:os.environ[k] for k in ['HOME','LANG','LC_ALL'] if k in os.environ};env['PATH']=str(Path(sys.executable).parent)+':/usr/bin:/bin'
    with tempfile.TemporaryDirectory(prefix='allowit-refusal-',dir=tools) as temp:
        root=Path(temp);env.update(TMPDIR=str(root),PYTHONPYCACHEPREFIX=str(root/'python-cache'),LEAN_PATH=str(root))
        # Full unchanged runtime checker binds production source, tools and cached libraries.
        trace,err=run([sys.executable,HERE/'../traces/check.py','--tools',tools],root,env)
        if err or trace.encode()!=inputs['../traces/receipt.json']:raise ValueError('Unaccepted trace replay')
        vectors=[json.loads(line) for line in inputs['../traces/vectors.jsonl'].decode().splitlines()]
        source,names=refusals.generate(vectors)
        for data in [source,inputs['../adapter/State.lean'].decode(),inputs['../lean/NativeDaily.lean'].decode(),inputs['../traces/Certificates.lean'].decode()]:
            if re.search(BANNED,data):raise ValueError('Unaccepted proof construct')
        for name,key in [('NativeDaily','../lean/NativeDaily.lean'),('State','../adapter/State.lean'),('Certificates','../traces/Certificates.lean')]:
            (root/(name+'.lean')).write_bytes(inputs[key])
            _,err=run([lean,'-o',name+'.olean',name+'.lean'],root,env)
            if err:raise ValueError('Unexpected dependency compilation diagnostics')
        (root/'Refusals.lean').write_text(source);proof,err=run([lean,'Refusals.lean'],root,env)
        if err:raise ValueError('Unexpected refusal proof diagnostics')
        audit(proof,names)
        # Bind the same physical tools/libraries and current source after proof checking too.
        spec=importlib.util.spec_from_file_location('trace_refusal_dependency',HERE/'../traces/check.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.bindings(trace_lock,tools)
    if snapshot(lock)!=inputs or (HERE/'lock.json').read_bytes()!=lock_bytes:raise ValueError('Refusal inputs changed during execution')
    outputs={'Refusals.lean':source,'proof-check.txt':proof}
    receipt={'evidence':'finite_model_nonpermission_correspondence','lockSha256':digest(lock_bytes),
             'dependencies':lock['files'],'traceReceiptSha256':digest(inputs['../traces/receipt.json']),
             'runtimeReplayed':True,'rejectedCases':refusals.CASES,'arbitraryReadinessAndPostState':True,
             'budgetReadyTrueSuccessfulWitness':True,'certificates':names,
             'outputs':{n:digest(b.encode()) for n,b in outputs.items()},
             'errorCauseOrPrecedenceProved':False,'universalAdapterRefinement':False,'realSignaturesProved':False,'rollbackProved':False,
             'clientExecution':False,'deploymentChecked':False}
    rendered=json.dumps(receipt,indent=2)+'\n'
    if not args.emit_receipt:
        if (HERE/'receipt.json').read_bytes()!=rendered.encode():raise ValueError('Stale refusal receipt')
        for n,b in outputs.items():
            if (HERE/n).read_bytes()!=b.encode():raise ValueError('Changed retained refusal certificate')
    if args.emit_evidence:
        out=args.emit_evidence.resolve()
        if not out.is_relative_to(tools):raise ValueError('Candidate output must stay inside tool root')
        out.mkdir(parents=True,exist_ok=True)
        for n,b in outputs.items():(out/n).write_text(b)
    print(rendered,end='')


if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError,TypeError,subprocess.SubprocessError) as error:
        print(json.dumps({'evidence':'not_accepted','error':str(error)}));raise SystemExit(1)
