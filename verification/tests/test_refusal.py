import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

HERE=Path(__file__).resolve().parents[1]/'refusal'
sys.path.insert(0,str(HERE))
spec=importlib.util.spec_from_file_location('refusal_check',HERE/'check.py');check=importlib.util.module_from_spec(spec);spec.loader.exec_module(check)


class RefusalCertificates(unittest.TestCase):
    def vectors(self):return [json.loads(s) for s in (HERE/'../traces/vectors.jsonl').read_text().splitlines()]

    def test_inventory_requires_twelve_program_refusals_and_positive_budget_case(self):
        source,names=check.refusals.generate(self.vectors())
        self.assertEqual(len(check.refusals.CASES),12);self.assertEqual(len(names),14)
        self.assertNotIn('refuses_budget_exhaustion_rollback',names)
        self.assertIn('budget_model_permits',names)
        self.assertEqual(source,(HERE/'Refusals.lean').read_text())
        self.assertIn('(environment : State → Action → Prop) (t : State)',source)
        original=check.refusals.CASES
        try:
            check.refusals.CASES=original+['missing_case']
            with self.assertRaisesRegex(ValueError,'proof inventory'):check.refusals.generate(self.vectors())
        finally:check.refusals.CASES=original

    def test_request_decoding_uses_captured_actor_revision_nonce_and_unsupported_method(self):
        vs=self.vectors()
        self.assertEqual(check.refusals.action(vs[22]),'(.unsupported 19)')
        self.assertIn('false',check.refusals.action(vs[20]))
        for name in ['replay','stale_revision','nonce_overflow','revision_overflow']:
            v=next(v for v in vs if v['name']==name);r=check.refusals.corpus.decode(v['data']);text=check.refusals.action(v)
            self.assertIn(check.refusals.corpus.word(r['revision']),text)
            if r['nonce'] is not None:self.assertIn(check.refusals.corpus.word(r['nonce']),text)
        changed=copy.deepcopy(vs);changed[22]['data']='ff'
        with self.assertRaises(ValueError):check.refusals.generate(changed)

    def test_axiom_audit_requires_complete_ordered_statement_set(self):
        log="'AllowIt.Refusals.a' depends on axioms: [propext, Quot.sound]\n"
        check.audit(log,['a'])
        for invalid in ['',log+log,log.replace('Quot.sound','sorryAx'),log.replace('Quot.sound','Lean.ofReduceBool')]:
            with self.assertRaises(ValueError):check.audit(invalid,['a'])

    def test_freshness_inventory_and_receipt_preserve_old_evidence(self):
        lock=json.loads((HERE/'lock.json').read_text());check.snapshot(lock)
        receipt=json.loads((HERE/'receipt.json').read_text())
        self.assertEqual(receipt['lockSha256'],check.digest((HERE/'lock.json').read_bytes()))
        self.assertEqual(receipt['traceReceiptSha256'],check.digest((HERE/'../traces/receipt.json').read_bytes()))
        ledger=json.loads((HERE/'../obligations.json').read_text())
        self.assertEqual(ledger['refusal_intake']['receipt_sha256'],check.digest((HERE/'receipt.json').read_bytes()))
        self.assertTrue(all(o['status']=='open' for o in ledger['obligations']))
        for n,h in receipt['outputs'].items():self.assertEqual(check.digest((HERE/n).read_bytes()),h)
        self.assertTrue(receipt['runtimeReplayed']);self.assertTrue(receipt['arbitraryReadinessAndPostState'])
        for n in ['errorCauseOrPrecedenceProved','universalAdapterRefinement','realSignaturesProved','rollbackProved','clientExecution','deploymentChecked']:self.assertFalse(receipt[n])
        changed=copy.deepcopy(lock);changed['files'].pop('refusals.py')
        with self.assertRaises(ValueError):check.snapshot(changed)


if __name__=='__main__':unittest.main()
