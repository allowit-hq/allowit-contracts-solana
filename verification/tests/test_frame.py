import hashlib,importlib.util,json,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]/'runtime/frame'
def module(name,file):
 s=importlib.util.spec_from_file_location(name,ROOT/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
c=module('frame_certificates_test','certificates.py');v=module('frame_checker_test','check.py')
def datasets():return {k:[json.loads(l) for l in (ROOT.parent/k/'vectors.jsonl').read_text().splitlines()] for k in ['transaction','failure-boundary']}
class FrameTests(unittest.TestCase):
 def test_regeneration_and_certificate_inventory(self):
  text,names=c.generate(datasets());self.assertEqual(text,(ROOT/'Corpus.lean').read_text());self.assertEqual(len(names),19);self.assertEqual(names,json.loads((ROOT/'receipt.json').read_text())['finiteCertificates'])
 def test_missing_dataset_refused(self):
  d=datasets();d.pop('transaction')
  with self.assertRaisesRegex(ValueError,'dataset inventory'):c.generate(d)
 def test_duplicate_case_refused(self):
  d=datasets();d['transaction'].append(d['transaction'][0])
  with self.assertRaisesRegex(ValueError,'duplicate case'):c.generate(d)
 def test_identity_width_and_alphabet_refused(self):
  for s in ['','0','1'*31,'1'*33]:
   with self.assertRaises(ValueError):c.identity(s)
 def test_numeric_boolean_underflow_and_overflow_refused(self):
  for n in [True,-1,2**64,1.0]:
   with self.assertRaisesRegex(ValueError,'invalid u64'):c.number(n)
 def test_reuse_continuity_refused(self):
  d=datasets();r=next(r for r in d['failure-boundary'] if r['name']=='post_cpi_reuse');key=next(iter(r['beforeStore']));r['beforeStore'][key]['lamports']+=1
  with self.assertRaisesRegex(ValueError,'reuse continuity'):c.generate(d)
 def test_store_creation_refused(self):
  d=datasets();r=next(r for r in d['transaction'] if r['name']=='abort');r['afterStore'].pop(next(iter(r['afterStore'])))
  with self.assertRaisesRegex(ValueError,'store inventory'):c.generate(d)
 def test_underfunded_payer_refused(self):
  d=datasets();r=next(r for r in d['transaction'] if r['name']=='abort');r['beforeStore'][r['message']['accountKeys'][0]]['lamports']=0
  with self.assertRaisesRegex(ValueError,'payer funding'):c.generate(d)
 def test_preexecution_fee_refused(self):
  d=datasets();d['transaction'][0]['fee']=1
  with self.assertRaisesRegex(ValueError,'preexecution fee'):c.generate(d)
 def test_native_axiom_and_incomplete_audit_refused(self):
  for text in ["'N.a' depends on axioms: [sorryAx]", "'N.a' depends on axioms: [foo_native]"]:
   with self.assertRaises(ValueError):v.audit(text,'N',['a'])
  with self.assertRaisesRegex(ValueError,'incomplete'):v.audit("'N.a' does not depend on any axioms",'N',['a','b'])
 def test_lock_files_and_retained_receipt(self):
  lock=json.loads((ROOT/'lock.json').read_text());r=json.loads((ROOT/'receipt.json').read_text());self.assertEqual(hashlib.sha256((ROOT/'lock.json').read_bytes()).hexdigest(),r['lockSha256']);self.assertEqual(lock['files'],r['inputs'])
  for file,h in lock['files'].items():self.assertEqual(hashlib.sha256((ROOT/file).read_bytes()).hexdigest(),h,file)
  self.assertFalse(r['freshVMExecution']);self.assertFalse(r['universalRuntimeRollback']);self.assertEqual(r['releaseObligationsClosed'],[])
 def test_generic_and_finite_proof_logs(self):
  r=json.loads((ROOT/'receipt.json').read_text());logs={k:(ROOT/(k+'-check.txt')).read_text() for k in ['NativeDaily','State','Frame','Corpus']}
  v.audit(logs['Frame'],'AllowIt.Transaction',r['genericTheorems']);v.audit(logs['Corpus'],'AllowIt.TransactionCorpus',r['finiteCertificates'])
  for name,text in logs.items():self.assertEqual(hashlib.sha256(text.encode()).hexdigest(),r['proofLogSha256'][name])
 def test_negative_control_acceptance(self):
  r=json.loads((ROOT/'receipt.json').read_text());self.assertTrue(r['positiveFeeFrameControl']);self.assertEqual(set(r['negativeProofControls']),{'Underfunded','PayerMetadata','ProtectedBalance','CorpusProtectedDigest','CorpusWrongNonce'})
  self.assertTrue(all(x=={'exitCode':1,'falsePropositionRejected':True} for x in r['negativeProofControls'].values()))

 def test_raw_duplicate_refused(self):
  d=datasets();r=d['transaction'][0];r['raw'].append(r['raw'][0])
  with self.assertRaisesRegex(ValueError,'duplicate raw'):c.generate(d)
 def test_raw_fingerprint_mismatch_refused(self):
  d=datasets();r=d['transaction'][0];r['raw'][0]['before']['data']='00'+r['raw'][0]['before']['data'][2:]
  with self.assertRaisesRegex(ValueError,'raw fingerprint'):c.generate(d)
 def test_failed_request_nonce_difference_refused(self):
  d=datasets();r=next(r for r in d['transaction'] if r['name']=='abort');ix=r['message']['instructions'][1];data=bytearray.fromhex(ix['data']);data[9]+=1;ix['data']=data.hex()
  with self.assertRaisesRegex(ValueError,'request reuse'):c.generate(d)
 def test_failure_success_relabel_refused(self):
  d=datasets();d['transaction'][0]['outcome']='None'
  with self.assertRaisesRegex(ValueError,'failure outcome'):c.generate(d)
 def test_json_duplicate_key_refused(self):
  with self.assertRaisesRegex(ValueError,'duplicate JSON'):v.strict_json('{"x":1,"x":2}')
 def test_snapshot_import_screen(self):
  for text in ['import os','from pathlib import PurePath','__import__("os")','eval("1")']:
   with self.assertRaises(ValueError):v.import_check(text)
  v.import_check(b'import struct,hashlib\nfrom pathlib import Path\n')
 def test_artifact_cross_binding_refused(self):
  lock=json.loads((ROOT/'lock.json').read_text());source=lock['sources'][0];bindings=json.loads((ROOT.parent/'transaction/bindings.json').read_text());observation=json.loads((ROOT.parent/'transaction/observation.json').read_text());manifest=json.loads((ROOT.parent/'failure-boundary/manifest.json').read_text());v.dataset_binding(bindings,observation,source,manifest);observation['artifacts']['token.so']['sha256']='0'*64
  with self.assertRaisesRegex(ValueError,'artifact binding'):v.dataset_binding(bindings,observation,source,manifest)
 def test_ready_is_explicit_hypothesis(self):
  text,names=c.generate(datasets());self.assertNotIn('def ready',text);self.assertEqual(text.count('(env : ready '),3);self.assertEqual(len([n for n in names if n.endswith('_same_request')]),3)

 def test_evaluation_commands_refused(self):
  for text in ['#eval 1','#eval! 1','run_elab pure ()','run_meta pure ()']:
   with self.assertRaisesRegex(ValueError,'proof construct'):v.proof_screen(text)
  v.proof_screen('#eval evaluate exampleContext',True)
  with self.assertRaisesRegex(ValueError,'historical evaluation'):v.proof_screen('#eval evaluate otherContext',True)
 def test_transfer_binding_mutations(self):
  for which,error in [('payer','payer binding'),('system','durable nonce'),('role','transfer role binding'),('programdata','ProgramData binding'),('signer','signer position'),('inventory','transfer inventory')]:
   with self.subTest(which=which):
    r=next(x for x in datasets()['failure-boundary'] if x['name']=='post_cpi_reuse');keys=r['message']['accountKeys'];ix=r['message']['instructions'][1]
    if which=='payer':r['beforeStore'][keys[0]]['owner']=keys[7]
    elif which=='system':keys[ix['programIndex']]=c.SYSTEM
    elif which=='role':ix['accounts'][1]=ix['accounts'][3]
    elif which=='programdata':ix['accounts'][7]=ix['accounts'][4]
    elif which=='signer':r['message']['header']['required']=1
    elif which=='inventory':ix['data']='05'
    with self.assertRaisesRegex(ValueError,error):c.transfer(r)

 def test_decoded_state_binding_mutations(self):
  for which,error in [('token','token binding'),('owner','custody owner')]:
   with self.subTest(which=which):
    r=next(x for x in datasets()['failure-boundary'] if x['name']=='post_cpi_reuse');request=c.transfer(r);key=request['custody'] if which=='owner' else next(k for k,b in c.raw(r,'after').items() if len(b)==165 and c.identity(k)==int.from_bytes(c.raw(r,'after')[request['custody']][98:130],'big'));a=next(x for x in r['raw'] if x['key']==key)['after']
    if which=='owner':a['owner']=c.SYSTEM;r['afterStore'][key]['owner']=c.SYSTEM
    else:
     b=bytearray.fromhex(a['data']);b[0]^=1;a['data']=b.hex();r['afterStore'][key]['dataSha256']=hashlib.sha256(b).hexdigest()
    with self.assertRaisesRegex(ValueError,error):c.state(r,'after')
 def test_request_state_nonce_binding_refused(self):
  d=datasets()
  for name in ['abort','reuse']:
   r=next(x for x in d['transaction'] if x['name']==name);ix=r['message']['instructions'][1];data=bytearray.fromhex(ix['data']);data[9]+=1;ix['data']=data.hex()
  with self.assertRaisesRegex(ValueError,'request state binding'):c.generate(d)
