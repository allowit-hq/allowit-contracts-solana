#!/usr/bin/env python3
"""Re-extract the unchanged kernel and check its conditional Lean refinement."""
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

THEOREMS = ['validate_refines', 'arithmetic_refines', 'evaluate_refines', 'scalar_word',
            'word_scalar', 'native_outcome_roundtrip', 'observe_returns', 'evaluate_exact',
            'context_roundtrip', 'evaluate_all_inputs', 'extracted_exact_limit_witness',
            'outcome_native_roundtrip', 'extracted_permission_iff']
AXIOMS = {'propext', 'Classical.choice', 'Quot.sound'}
FILES = {'check.py', 'kernel/Cargo.toml', 'kernel/Cargo.lock', 'kernel/src/lib.rs',
         'kernel/src/policy.rs', 'kernel/src/policy_api.rs', 'kernel/allowit_kernel.llbc',
         'lean/AllowitKernel.lean', 'lean/translation.json', 'lean/NativeDaily.lean',
         'lean/Refinement.lean', 'lean/lakefile.toml', 'lean/lake-manifest.json',
         'lean/lean-toolchain', 'proof-check.txt', '../check_published.py',
         '../check_native.py', '../published-source-lock.json', '../lean/NativeDaily.lean'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(args, cwd, env):
    result = subprocess.run(list(map(str, args)), cwd=cwd, env=env, capture_output=True,
                            text=True, timeout=180, check=True)
    return result.stdout


def library_identity(directory):
    entries = []
    for package in sorted(directory.iterdir()):
        build = package / ('backends/lean/.lake/build' if package.name == 'aeneas' else '.lake/build')
        if build.exists():
            for path in sorted(build.rglob('*')):
                if path.is_file() and ('.olean' in path.name or path.suffix in {'.so', '.dylib'}):
                    entries.append((str(path.relative_to(directory)), digest(path.read_bytes())))
    return digest(json.dumps(entries, separators=(',', ':')).encode()), len(entries)


def audit(log):
    for theorem in THEOREMS:
        match = re.search(r"'AllowIt.Refinement\." + theorem + r"' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)", log)
        if not match:
            raise ValueError('Missing axiom audit: ' + theorem)
        actual = set(filter(None, (match[1] or '').replace(' ', '').split(',')))
        if not actual <= AXIOMS:
            raise ValueError('Unaccepted proof axiom: ' + theorem)
    if re.search(r'\b(error|sorryAx)\b', log):
        raise ValueError('Proof log contains an error or admission')


def bindings(lock):
    if (set(lock) != {'version', 'files', 'tool_sources', 'versions', 'binaries',
                      'library_artifacts', 'toolchain_libraries', 'charon_options', 'aeneas_options', 'downloads'}
            or type(lock.get('version')) is not int or lock['version'] != 1
            or set(lock['files']) != FILES):
        raise ValueError('Unsupported refinement lock')
    result = {name: digest((HERE / name).read_bytes()) for name in lock['files']}
    if result != lock['files']:
        raise ValueError('Changed refinement dependency')
    published = json.loads((HERE.parent / 'published-source-lock.json').read_text())
    intake = check_published.intake(published)
    for source in intake.values():
        if (HERE / 'kernel/src/policy.rs').read_bytes() != source['policy'] or (HERE / 'kernel/src/policy_api.rs').read_bytes() != source['api']:
            raise ValueError('Extraction crate is not the committed literal kernel')
    if (HERE / 'lean/NativeDaily.lean').read_bytes() != (HERE.parent / 'lean/NativeDaily.lean').read_bytes():
        raise ValueError('Independent specification copy changed')
    for name in ('lean/Refinement.lean', 'lean/AllowitKernel.lean', 'lean/NativeDaily.lean'):
        # This is a local acceptance guard, not a hostile Lean sandbox.
        if re.search(r'\b(sorry|admit|axiom|unsafe|native_decide|implemented_by|extern|elab|macro|initialize|run_cmd)\b|debug\.skip(?:Kernel)?TC', (HERE / name).read_text()):
            raise ValueError('Unaccepted local proof construct: ' + name)
    llbc = json.loads((HERE / 'kernel/allowit_kernel.llbc').read_text())
    if llbc['has_errors'] or llbc['charon_version'] != '0.1.279':
        raise ValueError('Incomplete or incompatible LLBC')
    translation = json.loads((HERE / 'lean/translation.json').read_text())
    for name in ('allowit_kernel::policy::evaluate', 'allowit_kernel::policy::validate_daily_limit'):
        matches = [f for f in translation['functions'] if f['rust_name'] == name]
        if len(matches) != 1 or not matches[0]['is_local'] or matches[0]['is_opaque']:
            raise ValueError('Kernel function was not extracted: ' + name)
    return published


def tree_identity(directory):
    entries = [(str(path.relative_to(directory)), digest(path.read_bytes()))
               for path in sorted(directory.rglob('*')) if path.is_file()]
    return digest(json.dumps(entries, separators=(',', ':')).encode()), len(entries)


def check_receipt(receipt, lock_bytes, lock):
    if (receipt['evidence'] != 'extracted_model_refinement'
            or receipt['lockSha256'] != digest(lock_bytes)
            or receipt['dependencies'] != lock['files']
            or receipt['binaries'] != lock['binaries']
            or receipt['versions'] != lock['versions']
            or receipt['libraryArtifacts'] != lock['library_artifacts']
            or receipt['toolchainLibraries'] != lock['toolchain_libraries']
            or receipt['theorems'] != THEOREMS):
        raise ValueError('Stale retained refinement receipt')


def tool_bindings(tools, lock, environment):
    actual = {name: digest((tools / name).read_bytes()) for name in lock['binaries']}
    if actual != lock['binaries']:
        raise ValueError('Changed extraction/proof tool binary')
    for path, revision in lock['tool_sources'].items():
        directory = tools / path
        if run(['git', 'rev-parse', 'HEAD'], directory, environment).strip() != revision or run(['git', 'status', '--porcelain', '--untracked-files=all'], directory, environment).strip():
            raise ValueError('Changed translator source: ' + path)
    for package in json.loads((HERE / 'lean/lake-manifest.json').read_text())['packages']:
        directory = HERE / 'lean/.lake/packages' / package['name']
        if run(['git', 'rev-parse', 'HEAD'], directory, environment).strip() != package['rev'] or run(['git', 'status', '--porcelain', '--untracked-files=all'], directory, environment).strip():
            raise ValueError('Changed Lean library source: ' + package['name'])
    libraries = library_identity(HERE / 'lean/.lake/packages')
    if list(libraries) != lock['library_artifacts']:
        raise ValueError('Changed cached Lean library artifacts')
    for relative, expected in lock['toolchain_libraries'].items():
        if list(tree_identity(tools / relative)) != expected:
            raise ValueError('Changed toolchain libraries: ' + relative)
    return actual


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tools', type=Path, required=True,
                        help='isolated root containing aeneas/, release/, rustup/ and Lean 4.31')
    parser.add_argument('--emit-receipt', action='store_true',
                        help='print a candidate receipt for explicit reviewed refresh')
    args = parser.parse_args()
    tools = args.tools.resolve(strict=True)
    lock_bytes = (HERE / 'lock.json').read_bytes()
    lock = json.loads(lock_bytes)
    environment = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL') if k in os.environ}
    rust = tools / 'rustup/toolchains/nightly-2026-09-17-aarch64-apple-darwin'
    lean = tools / 'lean-4.31.0-darwin_aarch64/bin'
    environment.update(PATH=str(rust / 'bin') + os.pathsep + str(lean) + os.pathsep + environment['PATH'],
                       DYLD_LIBRARY_PATH=str(rust / 'lib'), CHARON_TOOLCHAIN_IS_IN_PATH='1',
                       CARGO_HOME=str(tools / 'cargo'), RUSTUP_HOME=str(tools / 'rustup'),
                       CARGO_NET_OFFLINE='true', XDG_CACHE_HOME=str(tools / 'cache'))

    published = bindings(lock)
    binary_inputs = tool_bindings(tools, lock, environment)
    snapshot = {name: (HERE / name).read_bytes() for name in lock['files']}
    if {name: digest(data) for name, data in snapshot.items()} != lock['files']:
        raise ValueError('Changed snapshot dependency')
    charon = tools / 'aeneas/charon/charon/target/release/charon'
    aeneas = tools / 'release/aeneas'
    versions = {'charon': run([charon, 'version'], HERE, environment).strip(),
                'aeneas': run([aeneas, '-version'], HERE, environment).strip(),
                'rustc': run([rust / 'bin/rustc', '-vV'], HERE, environment).strip(),
                'lean': run([lean / 'lean', '--version'], HERE, environment).strip()}
    if versions != lock['versions']:
        raise ValueError('Extraction/proof tool version mismatch')
    with tempfile.TemporaryDirectory(prefix='allowit-refinement-', dir=tools) as temporary:
        workspace = Path(temporary)
        kernel = workspace / 'kernel'
        generated = workspace / 'lean'
        for name, data in snapshot.items():
            if name.startswith(('kernel/', 'lean/')) and name not in ('kernel/allowit_kernel.llbc', 'lean/AllowitKernel.lean', 'lean/translation.json'):
                target = workspace / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        run([charon, 'cargo', *lock['charon_options']], kernel, environment)
        llbc = kernel / 'allowit_kernel.llbc'
        if llbc.read_bytes() != snapshot['kernel/allowit_kernel.llbc']:
            raise ValueError('LLBC regeneration differs')
        run([aeneas, *lock['aeneas_options'], '-dest', generated, llbc], kernel, environment)
        for name in ('AllowitKernel.lean', 'translation.json'):
            if (generated / name).read_bytes() != snapshot['lean/' + name]:
                raise ValueError('Lean regeneration differs: ' + name)
        # Compile the regenerated source and frozen proof/specification snapshots.
        # Only the explicitly trusted, pre/post-checked upstream library cache is shared.
        (generated / '.lake').mkdir()
        (generated / '.lake/packages').symlink_to(HERE / 'lean/.lake/packages', target_is_directory=True)
        build = generated / '.lake/build/lib/lean'
        build.mkdir(parents=True)
        for module in ('AllowitKernel', 'NativeDaily'):
            run([lean / 'lake', 'env', 'lean', '-o', build / (module + '.olean'), module + '.lean'], generated, environment)
        log = run([lean / 'lake', 'env', 'lean', 'Refinement.lean'], generated, environment)
        audit(log)
        if log.encode() != snapshot['proof-check.txt']:
            raise ValueError('Proof audit differs from retained log')
    if (bindings(lock) != published or tool_bindings(tools, lock, environment) != binary_inputs
            or (HERE / 'lock.json').read_bytes() != lock_bytes):
        raise ValueError('Inputs changed during refinement checking')
    receipt = {'evidence': 'extracted_model_refinement', 'sourceBundle': published['source_bundle'],
                      'contractRevisions': {c: t['revision'] for c, t in published['targets'].items()},
                      'lockSha256': digest((HERE / 'lock.json').read_bytes()),
                      'dependencies': lock['files'], 'binaries': binary_inputs, 'versions': versions,
                      'libraryArtifacts': lock['library_artifacts'], 'toolchainLibraries': lock['toolchain_libraries'],
                      'axiomAllowlist': sorted(AXIOMS), 'theorems': THEOREMS,
                      'generatedBytesReproduced': True, 'allInputEqualityChecked': True,
                      'permissionEquivalenceChecked': True, 'successfulWitnessChecked': True,
                      'translationFaithfulnessAssumed': True, 'cachedLibraryArtifactsTrusted': True,
                      'rustCompilerVerified': False, 'adapterExecution': False,
                      'compiledArtifactRefinement': False, 'clientExecution': False, 'deploymentChecked': False}
    rendered = json.dumps(receipt, indent=2) + '\n'
    if not args.emit_receipt:
        retained = (HERE / 'receipt.json').read_bytes()
        check_receipt(json.loads(retained), lock_bytes, lock)
        if retained != rendered.encode():
            raise ValueError('Retained receipt differs from checked result')
    print(rendered, end='')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({'evidence': 'not_accepted', 'error': str(error)}))
        raise SystemExit(1)
