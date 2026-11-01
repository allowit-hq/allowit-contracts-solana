import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from copy import deepcopy

DIRECTORY = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('refinement_check', DIRECTORY / 'refinement/check.py')
refinement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refinement)


class RefinementGuards(unittest.TestCase):
    def test_axiom_audit_requires_all_statements_and_rejects_admissions(self):
        log = (DIRECTORY / 'refinement/proof-check.txt').read_text()
        refinement.audit(log)
        with self.assertRaises(ValueError):
            refinement.audit(log.replace('AllowIt.Refinement.evaluate_exact', 'omitted'))
        with self.assertRaises(ValueError):
            refinement.audit(log.replace('[propext, Classical.choice, Quot.sound]', '[sorryAx]', 1))

    def test_retained_receipt_freshness(self):
        base = DIRECTORY / 'refinement'
        lock_bytes = (base / 'lock.json').read_bytes()
        lock = json.loads(lock_bytes)
        receipt = json.loads((base / 'receipt.json').read_text())
        refinement.check_receipt(receipt, lock_bytes, lock)
        for field in ('lockSha256', 'dependencies', 'theorems', 'toolchainLibraries'):
            changed = deepcopy(receipt)
            changed[field] = 'stale'
            with self.assertRaises(ValueError):
                refinement.check_receipt(changed, lock_bytes, lock)
        ledger = json.loads((DIRECTORY / 'obligations.json').read_text())
        self.assertEqual(ledger['refinement_intake']['receipt_sha256'],
                         refinement.digest((base / 'receipt.json').read_bytes()))
        self.assertEqual(receipt['translationFaithfulnessAssumed'], True)
        for field in ('adapterExecution', 'compiledArtifactRefinement', 'clientExecution', 'deploymentChecked'):
            self.assertEqual(receipt[field], False)

    def test_tool_binding_rejects_binary_source_cache_and_core_library_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            tools = Path(temporary)
            binary = tools / 'binary'
            binary.write_bytes(b'accepted')
            lock = {'binaries': {'binary': refinement.digest(binary.read_bytes())},
                    'tool_sources': {'source': 'revision'}, 'library_artifacts': ['cache', 1],
                    'toolchain_libraries': {'lib': ['core', 1]}}
            def git(command, directory, environment):
                return 'revision' if command[1] == 'rev-parse' else ''
            # No package entries are needed to exercise the independent tool/cache guards.
            manifest = {'packages': []}
            with patch.object(refinement, 'run', side_effect=git), \
                 patch.object(refinement.json, 'loads', return_value=manifest), \
                 patch.object(refinement, 'library_identity', return_value=('cache', 1)), \
                 patch.object(refinement, 'tree_identity', return_value=('core', 1)):
                refinement.tool_bindings(tools, lock, {})
                binary.write_bytes(b'modified')
                with self.assertRaisesRegex(ValueError, 'binary'):
                    refinement.tool_bindings(tools, lock, {})
                binary.write_bytes(b'accepted')
                with patch.object(refinement, 'run', return_value='dirty'):
                    with self.assertRaisesRegex(ValueError, 'translator source'):
                        refinement.tool_bindings(tools, lock, {})
                with patch.object(refinement, 'library_identity', return_value=('changed', 1)):
                    with self.assertRaisesRegex(ValueError, 'cached Lean'):
                        refinement.tool_bindings(tools, lock, {})
                with patch.object(refinement, 'tree_identity', return_value=('changed', 1)):
                    with self.assertRaisesRegex(ValueError, 'toolchain libraries'):
                        refinement.tool_bindings(tools, lock, {})

    def test_changed_cached_library_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / 'library/.lake/build/lib/lean/Fake.olean'
            file.parent.mkdir(parents=True)
            file.write_bytes(b'first')
            before = refinement.library_identity(root)
            file.write_bytes(b'second')
            self.assertNotEqual(before, refinement.library_identity(root))

    def test_source_generated_and_extraction_completeness_guards(self):
        original = DIRECTORY / 'refinement'
        lock = json.loads((original / 'lock.json').read_text())
        sources = {'solana': {'policy': (original / 'kernel/src/policy.rs').read_bytes(),
                              'api': (original / 'kernel/src/policy_api.rs').read_bytes()}}
        with tempfile.TemporaryDirectory() as temporary:
            here = Path(temporary) / 'refinement'
            here.mkdir()
            for name in lock['files']:
                target = here / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(original / name, target)
            with patch.object(refinement, 'HERE', here), patch.object(refinement.check_published, 'intake', return_value=sources):
                refinement.bindings(lock)
                for name in ('kernel/src/policy.rs', 'lean/AllowitKernel.lean'):
                    path = here / name
                    before = path.read_bytes()
                    path.write_bytes(before + b'\n')
                    with self.assertRaises(ValueError):
                        refinement.bindings(lock)
                    path.write_bytes(before)
                proof = here / 'lean/Refinement.lean'
                before = proof.read_bytes()
                for construct in (b'\nsorry\n', b'\nset_option debug.skipKernelTC true\n', b'\nmacro \"bypass\" : tactic => `(tactic| skip)\n'):
                    proof.write_bytes(before + construct)
                    lock['files']['lean/Refinement.lean'] = refinement.digest(proof.read_bytes())
                    with self.assertRaisesRegex(ValueError, 'local proof construct'):
                        refinement.bindings(lock)
                proof.write_bytes(before)
                lock['files']['lean/Refinement.lean'] = refinement.digest(before)
                # Even if a new digest is supplied, an extraction error is not accepted.
                path = here / 'kernel/allowit_kernel.llbc'
                data = json.loads(path.read_text())
                data['has_errors'] = True
                path.write_text(json.dumps(data))
                lock['files']['kernel/allowit_kernel.llbc'] = refinement.digest(path.read_bytes())
                with self.assertRaisesRegex(ValueError, 'Incomplete'):
                    refinement.bindings(lock)
                path.write_bytes((original / 'kernel/allowit_kernel.llbc').read_bytes())
                lock['files']['kernel/allowit_kernel.llbc'] = refinement.digest(path.read_bytes())
                path = here / 'lean/translation.json'
                data = json.loads(path.read_text())
                next(f for f in data['functions'] if f['rust_name'] == 'allowit_kernel::policy::evaluate')['is_opaque'] = True
                path.write_text(json.dumps(data))
                lock['files']['lean/translation.json'] = refinement.digest(path.read_bytes())
                with self.assertRaisesRegex(ValueError, 'not extracted'):
                    refinement.bindings(lock)

    def test_missing_dependency_and_unknown_lock_schema_rejected(self):
        lock = json.loads((DIRECTORY / 'refinement/lock.json').read_text())
        del lock['files']['lean/Refinement.lean']
        with self.assertRaises(ValueError):
            refinement.bindings(lock)
        lock = json.loads((DIRECTORY / 'refinement/lock.json').read_text())
        lock['version'] = True
        with self.assertRaises(ValueError):
            refinement.bindings(lock)


if __name__ == '__main__':
    unittest.main()
