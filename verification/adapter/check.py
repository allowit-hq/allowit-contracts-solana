#!/usr/bin/env python3
"""Check an independent adapter specification and replay a pinned cached VM test executable."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import check_published

FILES = {'State.lean', 'check.py', 'inventory.json', '../lean/NativeDaily.lean',
         '../published-source-lock.json', '../check_published.py', '../check_native.py'}
THEOREMS = ['maintenance_frame', 'maintenance_trace_frame', 'deposit_control', 'withdraw_control',
            'tuning_frame', 'switch_revokes', 'transfer_authorized', 'transfer_kernel',
            'transfer_effects', 'transfer_complete', 'exhausted_nonce_cannot_transfer',
            'switch_blocks_transfer', 'lowering_below_spent_blocks_same_day',
            'transfer_replay_after_maintenance', 'transfer_day_monotone', 'nonce_step_monotone',
            'trace_nonce_monotone', 'transfer_replay_after_any_trace', 'unsupported_never_succeeds',
            'read_preserves_state', 'exact_limit_witness']
AXIOMS = {'propext', 'Quot.sound'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def tree_identity(directory):
    entries = [(str(p.relative_to(directory)), digest(p.read_bytes()))
               for p in sorted(directory.rglob('*')) if p.is_file()]
    return [digest(json.dumps(entries, separators=(',', ':')).encode()), len(entries)]


def run(args, cwd, environment):
    result = subprocess.run(list(map(str, args)), cwd=cwd, env=environment,
                            capture_output=True, text=True, timeout=180, check=True)
    if result.stderr.strip():
        raise ValueError('Unexpected checker diagnostics: ' + result.stderr[:500])
    return result.stdout


def audit(log):
    audits = re.findall(r"^'AllowIt.Adapter\.(\w+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)$", log, re.M)
    if [name for name, _ in audits] != THEOREMS or re.search(r'\b(error|sorryAx)\b', log):
        raise ValueError('Incomplete or failed state proof audit')
    for name, axioms in audits:
        if not set(filter(None, axioms.replace(' ', '').split(','))) <= AXIOMS:
            raise ValueError('Unaccepted state proof axiom: ' + name)


def vm_audit(log, names):
    actual = re.findall(r'^test (\w+) \.\.\. (\w+)$', log, re.M)
    if actual != [(name, 'ok') for name in sorted(names)] or not re.search(
            rf'^test result: ok\. {len(names)} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in [0-9.]+s$', log, re.M):
        raise ValueError('Incomplete or failed cached VM execution')


def vm_negative(executable, root, environment, names):
    result = subprocess.run([str(executable), '--test-threads=1', '--color=never'],
                            cwd=root, env=environment, capture_output=True, text=True, timeout=180)
    actual = re.findall(r'^test (\w+) \.\.\. (\w+)$', result.stdout, re.M)
    if (result.returncode != 101 or actual != [(n, 'FAILED') for n in sorted(names)]
            or not re.search(rf'^test result: FAILED\. 0 passed; {len(names)} failed; 0 ignored; 0 measured; 0 filtered out;', result.stdout, re.M)):
        raise ValueError('Artifact dependency negative control did not fail all VM tests')
    return {'exitCode': result.returncode, 'failedTests': len(actual)}


def bindings(lock, tools):
    if (set(lock) != {'version', 'files', 'sources', 'lean', 'vm'}
            or type(lock['version']) is not int or lock['version'] != 1 or set(lock['files']) != FILES):
        raise ValueError('Unsupported adapter lock')
    expected_sources = {
        'solana': {'crates/interface/src/lib.rs', 'programs/policy/src/lib.rs',
                   'programs/vault/src/lib.rs', 'sbf-tests/tests/vault.rs',
                   'sbf-tests/Cargo.toml', 'sbf-tests/Cargo.lock'},
        'stellar': {'crates/policy/src/lib.rs', 'crates/vault/src/lib.rs', 'crates/factory/src/lib.rs'}}
    if (set(lock['sources']) != set(expected_sources)
            or any(set(lock['sources'][c]) != paths for c, paths in expected_sources.items())
            or set(lock['lean']) != {'executable', 'sha256', 'libraries', 'library_identity', 'version'}
            or lock['lean']['executable'] != 'lean-4.31.0-darwin_aarch64/bin/lean'
            or lock['lean']['libraries'] != 'lean-4.31.0-darwin_aarch64/lib'
            or set(lock['vm']) != {'executable', 'sha256', 'tests'}
            or lock['vm']['executable'] != 'sbf-tests/target/debug/deps/vault-5321a7b588513c8d'):
        raise ValueError('Incomplete adapter source or tool inventory')
    inventory = json.loads((HERE / 'inventory.json').read_text())
    if lock['vm']['tests'] != inventory['vmTests'] or len(set(lock['vm']['tests'])) != 7:
        raise ValueError('Incomplete VM test inventory')
    declared = re.findall(r'^theorem\s+(\w+)', (HERE / 'State.lean').read_text(), re.M)
    if declared != THEOREMS:
        raise ValueError('Changed state theorem inventory')
    files = {p: digest((HERE / p).read_bytes()) for p in FILES}
    if files != lock['files']:
        raise ValueError('Changed adapter verification input')
    published = json.loads((HERE.parent / 'published-source-lock.json').read_text())
    intake = check_published.intake(published)
    for chain, paths in lock['sources'].items():
        repository = check_published.ROOT / published['targets'][chain]['repository']
        revision = published['targets'][chain]['revision']
        for path, expected in paths.items():
            if digest(check_published.committed(repository, revision, path)) != expected:
                raise ValueError('Changed committed adapter source')
    lean = tools / lock['lean']['executable']
    if digest(lean.read_bytes()) != lock['lean']['sha256'] or tree_identity(tools / lock['lean']['libraries']) != lock['lean']['library_identity']:
        raise ValueError('Changed Lean binary or core libraries')
    vm = check_published.ROOT / published['targets']['solana']['repository'] / lock['vm']['executable']
    if digest(vm.read_bytes()) != lock['vm']['sha256']:
        raise ValueError('Changed cached VM test executable')
    for path in ('State.lean', '../lean/NativeDaily.lean'):
        if re.search(r'\b(sorry|admit|axiom|unsafe|native_decide|implemented_by|extern|elab|macro|initialize|run_cmd)\b|debug\.skip(?:Kernel)?TC', (HERE / path).read_text()):
            raise ValueError('Unaccepted local state proof construct')
    return published, intake, lean, vm


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tools', type=Path, required=True)
    parser.add_argument('--emit-receipt', action='store_true')
    args = parser.parse_args()
    tools = args.tools.resolve(strict=True)
    lock_bytes = (HERE / 'lock.json').read_bytes()
    lock = json.loads(lock_bytes)
    published, intake, lean, vm = bindings(lock, tools)
    snapshots = {p: (HERE / p).read_bytes() for p in FILES}
    if {p: digest(b) for p, b in snapshots.items()} != lock['files']:
        raise ValueError('Changed adapter snapshot')
    vm_bytes = vm.read_bytes()
    if digest(vm_bytes) != lock['vm']['sha256']:
        raise ValueError('Changed VM snapshot')
    env = {k: os.environ[k] for k in ('HOME', 'LANG', 'LC_ALL') if k in os.environ}
    env['PATH'] = str(lean.parent) + ':/usr/bin:/bin'
    env['RUST_LOG'] = 'off'
    with tempfile.TemporaryDirectory(prefix='allowit-adapter-', dir=tools) as temporary:
        root = Path(temporary)
        env.update(LEAN_PATH=str(root), TMPDIR=str(root), SBF_OUT_DIR=str(root))
        version = run([lean, '--version'], root, env).strip()
        if version != lock['lean']['version']:
            raise ValueError('Wrong Lean version')
        (root / 'NativeDaily.lean').write_bytes(snapshots['../lean/NativeDaily.lean'])
        (root / 'State.lean').write_bytes(snapshots['State.lean'])
        run([lean, '-o', 'NativeDaily.olean', 'NativeDaily.lean'], root, env)
        log = run([lean, 'State.lean'], root, env)
        audit(log)
        executable = root / 'cached-vm-tests'
        executable.write_bytes(vm_bytes)
        executable.chmod(0o700)
        manifest = intake['solana']['manifest']
        for entry in manifest['artifacts']:
            path = check_published.ROOT / published['targets']['solana']['repository'] / published['targets']['solana']['artifact_directory'] / entry['name']
            data = path.read_bytes()
            if digest(data) != entry['sha256']:
                raise ValueError('Changed artifact snapshot')
            (root / entry['name']).write_bytes(data)
        listing = run([executable, '--list'], root, env)
        expected_listing = ''.join(name + ': test\n' for name in sorted(lock['vm']['tests'])) + f"\n{len(lock['vm']['tests'])} tests, 0 benchmarks\n"
        if listing != expected_listing:
            raise ValueError('Changed VM test inventory')
        vm_log = run([executable, '--test-threads=1', '--color=never'], root, env)
        vm_audit(vm_log, lock['vm']['tests'])
        negative_controls = {}
        for entry in manifest['artifacts']:
            path = root / entry['name']
            original = path.read_bytes()
            path.unlink()
            missing = vm_negative(executable, root, env, lock['vm']['tests'])
            path.write_bytes(b'\0' + original[1:])
            invalid = vm_negative(executable, root, env, lock['vm']['tests'])
            path.write_bytes(original)
            negative_controls[entry['name']] = {'missing': missing, 'invalidELF': invalid}
        vm_audit(run([executable, '--test-threads=1', '--color=never'], root, env), lock['vm']['tests'])
    if bindings(lock, tools) != (published, intake, lean, vm) or (HERE / 'lock.json').read_bytes() != lock_bytes:
        raise ValueError('Adapter inputs changed during checking')
    receipt = {'evidence': 'model_checked_with_separate_cached_vm_replay',
               'contractRevisions': {k: t['revision'] for k, t in published['targets'].items()},
               'sourceBundle': published['source_bundle'], 'lockSha256': digest(lock_bytes),
               'dependencies': lock['files'], 'sources': lock['sources'], 'lean': lock['lean'],
               'theorems': THEOREMS, 'axiomAllowlist': sorted(AXIOMS), 'proofLogSha256': digest(log.encode()),
               'vmExecutable': lock['vm'], 'vmTestsPassed': len(lock['vm']['tests']),
               'vmArtifacts': intake['solana']['manifest']['artifacts'],
               'vmArtifactDependencyNegativeControls': negative_controls,
               'adapterModelExtracted': False, 'adapterRefinementProved': False,
               'modelToVMCorrespondenceChecked': False, 'cachedVMTestBuildProvenanceProved': False,
               'compiledArtifactBuildProvenanceProved': False, 'clientExecution': False,
               'deploymentChecked': False, 'leanCoreArtifactsTrusted': True,
               'vmExecutableAndSystemRuntimeTrusted': True}
    rendered = json.dumps(receipt, indent=2) + '\n'
    if not args.emit_receipt and (HERE / 'receipt.json').read_bytes() != rendered.encode():
        raise ValueError('Stale retained adapter receipt')
    print(rendered, end='')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({'evidence': 'not_accepted', 'error': str(error)}))
        raise SystemExit(1)
