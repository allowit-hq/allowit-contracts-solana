import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

HERE=Path(__file__).resolve().parents[1]/'isolation';sys.path.insert(0,str(HERE))
spec=importlib.util.spec_from_file_location('isolation_check',HERE/'check.py');checker=importlib.util.module_from_spec(spec);spec.loader.exec_module(checker)


class SingleFaultEvidence(unittest.TestCase):
    def vectors(self):return [json.loads(s) for s in (HERE/'vectors.jsonl').read_text().splitlines()]

    def test_five_single_fault_vectors_and_positive_counterfactuals(self):
        vectors=self.vectors();source,names=checker.witnesses.generate(vectors)
        self.assertEqual(len(names),28);self.assertEqual(source,(HERE/'Isolation.lean').read_text())
        for v in vectors:
            if v['name'] in checker.witnesses.FAULTS:
                self.assertEqual([k for k,x in checker.witnesses.conditions(v).items() if not x],[checker.witnesses.FAULTS[v['name']]])
        self.assertEqual(sum(n.startswith('repair_permits_') for n in names),5)
        self.assertEqual(names[:2],['checks_spec','checks_complete'])

    def test_multiple_faults_and_missing_cases_fail_closed(self):
        vs=self.vectors();changed=copy.deepcopy(vs);changed[4]['accounts'][1]['signed']=False
        with self.assertRaisesRegex(ValueError,'single-fault'):checker.witnesses.generate(changed)
        with self.assertRaisesRegex(ValueError,'inventory'):checker.witnesses.generate(vs[:-1])

    def test_continuity_and_exact_outcome_are_checked(self):
        changed=self.vectors();changed[4]['outcome']='Success'
        with self.assertRaises(ValueError):checker.witnesses.generate(changed)
        changed=self.vectors()
        for rows in [changed[4]['beforeAccounts'],changed[4]['afterAccounts']]:
            next(row for row in rows if row['key']==changed[4]['before']['asset'])['lamports']+=1
        with self.assertRaisesRegex(ValueError,'continuity'):checker.witnesses.generate(changed)

    def test_certificate_audit_refuses_missing_duplicate_or_untrusted_axioms(self):
        log="'AllowIt.Isolation.a' depends on axioms: [propext, Quot.sound]\n";checker.audit(log,['a'])
        for invalid in ['',log+log,log.replace('Quot.sound','sorryAx'),log.replace('Quot.sound','Lean.ofReduceBool')]:
            with self.assertRaises(ValueError):checker.audit(invalid,['a'])

    def test_vm_logs_require_no_token_cpi_on_refusals_and_ordered_success(self):
        normalized=(HERE/'events.txt').read_text()
        prefix='[fixed DEBUG solana_runtime::message_processor::stable_log] '
        raw='\n'.join(line if line.startswith(('TOKEN_ELF','TRACE_BEGIN','TRACE_END')) else prefix+line for line in normalized.splitlines())+'\n'
        self.assertEqual(checker.logs(raw),normalized)
        vault='gBxS1f6uyyGPuW5MzGBukidSb71jdsCb5fZaoSzULE5'
        token='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
        anchor='TRACE_BEGIN revoked\n'+prefix+'Program '+vault+' invoke [1]'
        changed=raw.replace(anchor,anchor+'\n'+prefix+'Program '+token+' invoke [2]')
        with self.assertRaisesRegex(ValueError,'Refusal invoked token'):checker.logs(changed)
        with self.assertRaises(ValueError):checker.logs(raw.replace('Program '+token+' success','removed'))

    def test_retained_receipt_is_bound_and_limits_are_explicit(self):
        lock=json.loads((HERE/'lock.json').read_text());checker.snapshot(lock);receipt=json.loads((HERE/'receipt.json').read_text())
        self.assertEqual(receipt['lockSha256'],checker.digest((HERE/'lock.json').read_bytes()))
        for n,h in receipt['outputs'].items():self.assertEqual(checker.digest((HERE/n).read_bytes()),h)
        self.assertEqual(receipt['faults'],checker.witnesses.FAULTS)
        ledger=json.loads((HERE/'../obligations.json').read_text())
        self.assertEqual(ledger['isolation_intake']['receipt_sha256'],checker.digest((HERE/'receipt.json').read_bytes()))
        self.assertTrue(all(o['status']=='open' for o in ledger['obligations']))
        for n in ['realSignaturesProved','platformReadinessProved','rollbackProved','universalAdapterRefinement','errorCauseOrPrecedenceProved','compiledProgramBuildProvenanceProved','clientExecution','deploymentChecked']:self.assertIs(receipt[n],False)


if __name__=='__main__':unittest.main()
