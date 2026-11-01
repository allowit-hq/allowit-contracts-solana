import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

DIRECTORY=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(DIRECTORY/'traces'))
spec=importlib.util.spec_from_file_location('trace_check',DIRECTORY/'traces/check.py')
checker=importlib.util.module_from_spec(spec);spec.loader.exec_module(checker)
c=checker.certificates


class TraceEvidenceTests(unittest.TestCase):
    def vectors(self):return [json.loads(s) for s in (DIRECTORY/'traces/vectors.jsonl').read_text().splitlines()]

    def test_decoder_refuses_malformed_boolean_lengths_and_unknown_tags(self):
        self.assertEqual(c.decode('01'+'0100000000000000')['amount'],1)
        for s in ['','ff','01','01'+'00'*9,'0202'+'00'*8,'02'+'00'*8,'0000']:
            with self.assertRaises(ValueError):c.decode(s)

    def test_corpus_requires_all_cases_exact_errors_and_unchanged_rejections(self):
        vs=self.vectors();source,names=c.generate(vs);self.assertEqual(len(names),32)
        cases=[vs[:-1],copy.deepcopy(vs),copy.deepcopy(vs),copy.deepcopy(vs)]
        cases[1][1]['outcome']='Success'
        cases[2][1]['allReturnedAccountsUnchanged']=False
        cases[3][1]['after']['nonce']+=1
        for changed in cases:
            with self.assertRaises(ValueError):c.generate(changed)

    def test_supply_and_metadata_cannot_silently_change_domain(self):
        vs=self.vectors()
        for key,value in [('mintSupply',1),('tokenAccount','00'*32),('abi',True)]:
            changed=copy.deepcopy(vs);changed[0]['after'][key]=value
            with self.assertRaises(ValueError):c.generate(changed)
        changed=copy.deepcopy(vs);changed[-1]['before']['mintSupply']=2**64-1
        changed[-1]['before']['balance']=0;changed[-1]['before']['sourceBalance']=0
        with self.assertRaises(ValueError):c.generate(changed)

    def test_raw_decoder_refuses_shared_projection_mismatch(self):
        changed=self.vectors();changed[0]['after']['nonce']+=1
        with self.assertRaisesRegex(ValueError,'independent raw custody'):c.generate(changed)

    def test_account_frames_and_asset_binding_are_checked(self):
        changed=self.vectors();key=changed[0]['after']['sourceKey']
        row=next(r for r in changed[0]['afterAccounts'] if r['key']==key)
        raw=bytearray.fromhex(row['data']);raw[100]^=1;row['data']=raw.hex()
        with self.assertRaisesRegex(ValueError,'non-amount'):c.generate(changed)
        changed=self.vectors();changed[0]['accounts'][2]['key']=changed[0]['before']['recipientKey']
        with self.assertRaisesRegex(ValueError,'identity mismatch'):c.generate(changed)

    def test_diagnostic_proves_exact_wrap_not_any_bounded_result(self):
        changed=self.vectors();v=changed[-1];v['after']['recipientBalance']=1
        row=next(r for r in v['afterAccounts'] if r['key']==v['after']['recipientKey'])
        raw=bytearray.fromhex(row['data']);raw[64:72]=(1).to_bytes(8,'little');row['data']=raw.hex()
        with self.assertRaisesRegex(ValueError,'exact wrap'):c.generate(changed)

    def test_rejection_witnesses_cannot_collapse_to_shared_errors(self):
        for name in ['replay','stale_revision','wrong_executor','unsigned_executor','nonce_overflow']:
            changed=self.vectors();v=next(v for v in changed if v['name']==name)
            r=c.decode(v['data'])
            if name=='replay':r['nonce']=v['before']['nonce']
            elif name=='stale_revision':r['revision']=v['before']['revision']
            elif name=='wrong_executor':v['accounts'][1]['key']=v['before']['executor']
            elif name=='unsigned_executor':v['accounts'][1]['signed']=True
            else:v['before']['nonce']=0
            with self.assertRaisesRegex(ValueError,'witness precondition'):c.witness(v,r)

    def test_axiom_audit_requires_all_names_and_standard_logic(self):
        log="'AllowIt.CustodyTraces.a' does not depend on any axioms\n"
        checker.audit(log,['a'])
        for changed in ['',log+log,log.replace('does not depend on any axioms','depends on axioms: [Lean.ofReduceBool]')]:
            with self.assertRaises(ValueError):checker.audit(changed,['a'])

    def test_runtime_log_must_show_token_success_before_budget_failure(self):
        log=(DIRECTORY/'traces/events.txt').read_text()
        # Reconstruct the accepted stable logger prefix around retained event text.
        raw='\n'.join(line if line.startswith(('TOKEN_ELF','TRACE_BEGIN','TRACE_END')) else '[fixed DEBUG solana_runtime::message_processor::stable_log] '+line for line in log.splitlines())+'\n'
        self.assertEqual(checker.logs(raw),log)
        invoke='Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]'
        success='Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success'
        for changed in [raw.replace('TOKEN_ELF 108600','TOKEN_ELF 1'),raw.replace('TRACE_END deposit','TRACE_END bad'),raw.replace(success,'removed'),raw.replace(invoke,'TOKEN_SWAP').replace(success,invoke).replace('TOKEN_SWAP',success)]:
            with self.assertRaises(ValueError):checker.logs(changed)

    def test_receipt_and_retained_certificates_bind_exact_dependencies(self):
        here=DIRECTORY/'traces';lock_bytes=(here/'lock.json').read_bytes();lock=json.loads(lock_bytes);receipt=json.loads((here/'receipt.json').read_text())
        self.assertEqual(receipt['lockSha256'],checker.digest(lock_bytes))
        ledger=json.loads((DIRECTORY/'obligations.json').read_text())
        self.assertEqual(ledger['trace_intake']['receipt_sha256'],checker.digest((here/'receipt.json').read_bytes()))
        self.assertEqual(len(ledger['obligations']),24);self.assertTrue(all(o['status']=='open' for o in ledger['obligations']))
        for path,h in lock['files'].items():self.assertEqual(checker.digest((here/path).read_bytes()),h)
        for path,h in receipt['outputs'].items():self.assertEqual(checker.digest((here/path).read_bytes()),h)
        source,names=c.generate(self.vectors());self.assertEqual(source,(here/'Certificates.lean').read_text());self.assertEqual(names,receipt['certificates'])
        self.assertEqual(receipt['ordinaryCases'],26);self.assertEqual(receipt['diagnosticCases'],1)
        self.assertIs(receipt['fixtureThreeAccountSupplyChecked'],True);self.assertNotIn('globalFixtureSupplyChecked',receipt)
        for k in ['readyImplementationProved','signatureCryptographyProved','universalAdapterRefinement','compiledProgramBuildProvenanceProved','clientExecution','deploymentChecked']:self.assertIs(receipt[k],False)


if __name__=='__main__':unittest.main()
