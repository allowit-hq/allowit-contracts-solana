import importlib.util,json,unittest,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]/'runtime/transaction'
spec=importlib.util.spec_from_file_location('transaction_validation',ROOT/'validate.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
def encode(row,m):
 _,sigs,bh=v.wire(row['transaction']);b=bytearray([len(sigs)])
 for sig in sigs:b.extend(sig)
 h=m['header'];b.extend([h['required'],h['readonlySigned'],h['readonlyUnsigned'],len(m['accountKeys'])])
 for key in m['accountKeys']:
  n=0
  for c in key:n=n*58+v.ALPHABET.index(c)
  b.extend(n.to_bytes(32,'big'))
 b.extend(bytes.fromhex(bh));b.append(len(m['instructions']))
 for ix in m['instructions']:
  d=bytes.fromhex(ix['data']);b.extend([ix['programIndex'],len(ix['accounts'])]);b.extend(ix['accounts']);b.append(len(d));b.extend(d)
 row['message']=m;row['transaction']=b.hex()
def mutate_raw(row,key,offset=None,owner=None):
 raw=next(x for x in row['raw'] if x['key']==key)
 for side in ['before','after']:
  if offset is not None:
   b=bytearray.fromhex(raw[side]['data']);b[offset]^=1;raw[side]['data']=b.hex();row[side+'Store'][key]['dataSha256']=hashlib.sha256(b).hexdigest()
  if owner is not None:raw[side]['owner']=owner;row[side+'Store'][key]['owner']=owner
class TransactionTests(unittest.TestCase):
 def rows(self,name='vectors.jsonl'):return [json.loads(l) for l in (ROOT/name).read_text().splitlines()]
 def test_independent_inventory_and_validation(self):self.assertEqual(v.check(self.rows()),json.loads((ROOT/'validation.json').read_text()))
 def test_wire_trailing_bytes_refused(self):
  rows=self.rows();rows[0]['transaction']+='00'
  with self.assertRaisesRegex(ValueError,'wire trailing'):v.check(rows)
 def test_abort_without_cpi_success_refused(self):
  rows=self.rows();rows[3]['logs'].remove('Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success')
  with self.assertRaisesRegex(ValueError,'invocation nesting/order'):v.check(rows)
 def test_protected_store_mutation_refused(self):
  rows=self.rows();r=rows[3];excluded={r['message']['accountKeys'][0]}|{x['key'] for x in r['raw']};key=next(k for k in r['afterStore'] if k not in excluded);r['afterStore'][key]['lamports']+=1
  with self.assertRaisesRegex(ValueError,'refusal protected-store frame'):v.check(rows)
 def test_wrong_outcome_or_inventory_refused(self):
  rows=self.rows();rows[5]['outcome']='None'
  with self.assertRaisesRegex(ValueError,'wrong outcome'):v.check(rows)
  with self.assertRaisesRegex(ValueError,'case inventory'):v.check(self.rows()[:-1])
 def test_reproduction_normalization_preserves_checks(self):
  rows=self.rows();normal=v.normalize(rows);other=self.rows();template=next(k for k,x in other[0]['beforeStore'].items() if x['lamports']==1000000000000000)
  for r in other:
   for side in ['beforeStore','afterStore']:r[side]['anotherUnreferencedRuntimeFundingKey']=r[side].pop(template)
  self.assertEqual(normal,v.normalize(other))
  for r in other:
   for side in ['beforeStore','afterStore']:r[side]['anotherUnreferencedRuntimeFundingKey']['lamports']+=1
  with self.assertRaisesRegex(ValueError,'runtime funding account inventory'):v.normalize(other)
 def test_retained_replay_equivalence(self):self.assertEqual(v.normalize(self.rows()),v.normalize(self.rows('replay.jsonl')))
 def test_wrong_programdata_payload_refused(self):
  for length in [100325,1741]:
   with self.subTest(length=length):
    rows=self.rows();row=next(x for x in rows[0]['raw'] if len(bytes.fromhex(x['before']['data']))==length);mutate_raw(rows[0],row['key'],-1)
    with self.assertRaisesRegex(ValueError,'ProgramData/ELF binding'):v.check(rows)
 def test_substituted_token_elf_refused(self):
  rows=self.rows();mutate_raw(rows[0],'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',-1)
  with self.assertRaisesRegex(ValueError,'token ELF binding'):v.check(rows)
 def test_missing_policy_log_refused(self):
  rows=self.rows();r=rows[1];line=next(l for l in r['logs'] if l.startswith('Program k7Fa') and l.endswith(' success'));r['logs'].remove(line)
  with self.assertRaisesRegex(ValueError,'policy invocation evidence'):v.check(rows)
 def test_state_artifact_or_bump_refused(self):
  for offset,message in [(194,'state artifact binding'),(1,'supplied-bump PDA hash')]:
   with self.subTest(offset=offset):
    rows=self.rows();key=next(x['key'] for x in rows[0]['raw'] if len(bytes.fromhex(x['before']['data']))==320);mutate_raw(rows[0],key,offset)
    with self.assertRaisesRegex(ValueError,message):v.check(rows)
 def test_wrong_clock_owner_refused(self):
  rows=self.rows();mutate_raw(rows[0],'SysvarC1ock11111111111111111111111111111111',owner='11111111111111111111111111111111')
  with self.assertRaisesRegex(ValueError,'clock timestamp'):v.check(rows)
 def test_mint_authority_refused(self):
  rows=self.rows();key=next(x['key'] for x in rows[0]['raw'] if len(bytes.fromhex(x['before']['data']))==82);mutate_raw(rows[0],key,0)
  with self.assertRaisesRegex(ValueError,'^mint$'):v.check(rows)
 def test_token_delegate_refused(self):
  rows=self.rows();key=next(x['key'] for x in rows[0]['raw'] if len(bytes.fromhex(x['before']['data']))==165);mutate_raw(rows[0],key,72)
  with self.assertRaisesRegex(ValueError,'token delegate/native/close authority'):v.check(rows)
 def test_extra_token_owned_account_refused(self):
  rows=self.rows();r=rows[0];account=next(a for a in r['beforeStore'].values() if a['owner']=='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');r['beforeStore']['extra']=account.copy();r['afterStore']['extra']=account.copy()
  with self.assertRaisesRegex(ValueError,'closed token-owned inventory'):v.check(rows)
 def test_owner_in_message_refused(self):
  rows=self.rows();r=rows[0];state=next(bytes.fromhex(x['before']['data']) for x in r['raw'] if len(bytes.fromhex(x['before']['data']))==320);m=r['message'];m['accountKeys'][m['instructions'][1]['accounts'][7]]=v.b58(state[2:34]);encode(r,m)
  with self.assertRaisesRegex(ValueError,'executor signer binding/owner absence'):v.check(rows)
 def test_policy_data_account_substitution_refused(self):
  rows=self.rows();r=rows[0];m=r['message'];m['accountKeys'][m['instructions'][1]['accounts'][7]]='SysvarC1ock11111111111111111111111111111111';encode(r,m)
  with self.assertRaisesRegex(ValueError,'transfer accounts'):v.check(rows)
 def test_nonexecutor_signer_alias_refused(self):
  rows=self.rows();r=rows[0];m=r['message'];index=m['instructions'][1]['accounts'][0];m['accountKeys'][0],m['accountKeys'][index]=m['accountKeys'][index],m['accountKeys'][0];m['instructions'][1]['accounts'][0]=0;encode(r,m)
  with self.assertRaisesRegex(ValueError,'transfer signer bindings'):v.check(rows)
 def test_extra_instruction_refused(self):
  rows=self.rows();r=rows[0];m=r['message'];m['instructions'].append(m['instructions'][0].copy());encode(r,m)
  with self.assertRaisesRegex(ValueError,'instruction inventory'):v.check(rows)
 def test_success_metadata_frame_refused(self):
  rows=self.rows();r=rows[6];raw=next(x for x in r['raw'] if len(bytes.fromhex(x['after']['data']))==320);raw['after']['lamports']+=1;r['afterStore'][raw['key']]['lamports']+=1
  with self.assertRaisesRegex(ValueError,'mutated-account metadata frame'):v.check(rows)
 def test_payer_owner_refused(self):
  rows=self.rows();r=rows[0];payer=r['message']['accountKeys'][0]
  for side in ['beforeStore','afterStore']:r[side][payer]['owner']='wrongOwner'
  with self.assertRaisesRegex(ValueError,'payer system owner'):v.check(rows)
 def test_recipient_authority_refused(self):
  rows=self.rows();mutate_raw(rows[0],v.b58(bytes([17])*32),32)
  with self.assertRaisesRegex(ValueError,'recipient fixture authority'):v.check(rows)
 def test_source_bundle_or_day_refused(self):
  for offset,message in [(162,'fixture source-bundle identity'),(274,'fixture day window')]:
   rows=self.rows();key=next(x['key'] for x in rows[0]['raw'] if len(bytes.fromhex(x['before']['data']))==320);mutate_raw(rows[0],key,offset)
   with self.assertRaisesRegex(ValueError,message):v.check(rows)
 def test_token_native_close_fields_refused(self):
  for offset in [109,113,121,129,133]:
   rows=self.rows();key=next(x['key'] for x in rows[0]['raw'] if len(bytes.fromhex(x['before']['data']))==165);mutate_raw(rows[0],key,offset)
   with self.assertRaisesRegex(ValueError,'token delegate/native/close authority'):v.check(rows)
 def test_mint_freeze_authority_refused(self):
  rows=self.rows();key=next(x['key'] for x in rows[0]['raw'] if len(bytes.fromhex(x['before']['data']))==82);mutate_raw(rows[0],key,46)
  with self.assertRaisesRegex(ValueError,'^mint$'):v.check(rows)
 def test_normalized_digest_record(self):
  data=json.dumps(v.normalize(self.rows()),sort_keys=True,separators=(',',':')).encode();self.assertEqual(hashlib.sha256(data).hexdigest(),json.loads((ROOT/'observation.json').read_text())['normalizedCorpusSha256'])
