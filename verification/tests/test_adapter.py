import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
from unittest.mock import patch
import unittest

DIRECTORY = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('adapter_check', DIRECTORY / 'adapter/check.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterEvidenceTests(unittest.TestCase):
    def test_proof_audit_requires_exact_statements_and_no_admission(self):
        log = ''.join("'AllowIt.Adapter." + n + "' depends on axioms: [propext]\n" for n in adapter.THEOREMS)
        adapter.audit(log)
        for broken in (log.replace('propext', 'sorryAx', 1),
                       log.replace('propext', 'Classical.choice', 1),
                       log.replace('propext', 'Lean.ofReduceBool', 1), log.splitlines()[0], log + log):
            with self.assertRaises(ValueError):
                adapter.audit(broken)

    def test_vm_audit_rejects_ignored_missing_duplicate_or_failed_tests(self):
        log = 'test first ... ok\ntest second ... ok\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n'
        adapter.vm_audit(log, ['first', 'second'])
        for broken in (log.replace('second ... ok', 'second ... FAILED'),
                       log.replace('0 ignored', '1 ignored'), log.replace('test first ... ok\n', ''),
                       'test first ... ok\n' + log):
            with self.assertRaises(ValueError):
                adapter.vm_audit(broken, ['first', 'second'])

    def test_negative_controls_require_all_tests_to_fail(self):
        log = 'test first ... FAILED\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n'
        result = subprocess.CompletedProcess([], 101, log, 'expected invalid artifact panic')
        with patch.object(adapter.subprocess, 'run', return_value=result):
            self.assertEqual(adapter.vm_negative(Path('/test'), Path('/tmp'), {}, ['first']),
                             {'exitCode': 101, 'failedTests': 1})
        for code, output in [(0, log), (101, log.replace('first ... FAILED', 'first ... ok')),
                             (101, log.replace('0 ignored', '1 ignored'))]:
            with patch.object(adapter.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, output, '')):
                with self.assertRaises(ValueError):
                    adapter.vm_negative(Path('/test'), Path('/tmp'), {}, ['first'])

    def test_binding_inventory_cannot_omit_sources_or_tools(self):
        lock = json.loads((DIRECTORY / 'adapter/lock.json').read_text())
        mutations = []
        wrong = copy.deepcopy(lock); wrong['version'] = True; mutations.append(wrong)
        wrong = copy.deepcopy(lock); wrong['sources']['solana'].pop('programs/vault/src/lib.rs'); mutations.append(wrong)
        wrong = copy.deepcopy(lock); wrong['sources'].pop('stellar'); mutations.append(wrong)
        wrong = copy.deepcopy(lock); wrong['lean'].pop('sha256'); mutations.append(wrong)
        wrong = copy.deepcopy(lock); wrong['vm']['executable'] = '../unreviewed'; mutations.append(wrong)
        for altered in mutations:
            with self.assertRaises(ValueError):
                adapter.bindings(altered, Path('/unused'))

    def test_core_library_identity_detects_changes_and_new_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'library.olean').write_bytes(b'first')
            original = adapter.tree_identity(root)
            (root / 'library.olean').write_bytes(b'changed')
            self.assertNotEqual(original, adapter.tree_identity(root))
            (root / 'library.olean').write_bytes(b'first')
            (root / 'extra.dylib').write_bytes(b'plugin')
            self.assertNotEqual(original, adapter.tree_identity(root))

    def test_retained_receipt_binds_proof_inventory_and_explicit_scope(self):
        here = DIRECTORY / 'adapter'
        lock_bytes = (here / 'lock.json').read_bytes()
        lock = json.loads(lock_bytes)
        receipt = json.loads((here / 'receipt.json').read_text())
        self.assertEqual(set(lock['files']), adapter.FILES)
        self.assertEqual(receipt['lockSha256'], adapter.digest(lock_bytes))
        self.assertEqual(receipt['dependencies'], lock['files'])
        self.assertEqual(receipt['theorems'], adapter.THEOREMS)
        self.assertEqual(receipt['vmExecutable'], lock['vm'])
        inventory = json.loads((here / 'inventory.json').read_text())
        self.assertEqual(lock['vm']['tests'], inventory['vmTests'])
        for p, expected in lock['files'].items():
            self.assertEqual(adapter.digest((here / p).read_bytes()), expected)
        for name in ('adapterModelExtracted', 'adapterRefinementProved',
                     'modelToVMCorrespondenceChecked', 'cachedVMTestBuildProvenanceProved',
                     'compiledArtifactBuildProvenanceProved', 'clientExecution', 'deploymentChecked'):
            self.assertIs(receipt[name], False)
        ledger = json.loads((DIRECTORY / 'obligations.json').read_text())
        self.assertEqual([v['status'] for v in ledger['obligations']], ['open'] * 24)
        self.assertEqual(ledger['adapter_preparation']['receipt_sha256'], adapter.digest((here / 'receipt.json').read_bytes()))


if __name__ == '__main__':
    unittest.main()
