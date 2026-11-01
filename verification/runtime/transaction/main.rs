use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_hash::Hash;
use solana_instruction::{Instruction,account_meta::AccountMeta};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::BTreeMap,str::FromStr};
fn hex(b:&[u8])->String { b.iter().map(|x|format!("{x:02x}")).collect() }
fn unhex(s:&str)->Vec<u8> {(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn key(b:u8)->Address {Address::new_from_array([b;32])}
fn u64at(b:&[u8],i:usize)->u64 {u64::from_le_bytes(b[i..i+8].try_into().unwrap())}
fn account(owner:Address,data:Vec<u8>)->Account {Account{owner,data,lamports:10_000_000_000,executable:false,rent_epoch:u64::MAX}}
fn token(mint:Address,owner:Address,amount:u64)->Vec<u8>{let mut b=vec![0;165];b[..32].copy_from_slice(mint.as_ref());b[32..64].copy_from_slice(owner.as_ref());b[64..72].copy_from_slice(&amount.to_le_bytes());b[108]=1;b}
fn store(vm:&LiteSVM)->BTreeMap<Address,Account>{vm.accounts_db().inner.keys().map(|k|(*k,vm.get_account(k).unwrap())).collect()}
fn image(a:Option<&Account>)->Value{match a{None=>Value::Null,Some(a)=>json!({"owner":a.owner.to_string(),"lamports":a.lamports,"executable":a.executable,"rentEpoch":a.rent_epoch,"data":hex(&a.data)})}}
fn fingerprints(s:&BTreeMap<Address,Account>)->Value{Value::Object(s.iter().map(|(k,a)|(k.to_string(),json!({"owner":a.owner.to_string(),"lamports":a.lamports,"executable":a.executable,"rentEpoch":a.rent_epoch,"dataSha256":hex(&Sha256::digest(&a.data))}))).collect())}
struct F {vm:LiteSVM,payer:Keypair,exec:Keypair,program:Address,policy:Address,vault:Address,tokens:Address,recipient:Address,mint:Address,policy_data:Address}
impl F {
 fn transfer(&self,nonce:u64)->Instruction{let mut d=vec![4];for v in [1_000_000u64,nonce,0]{d.extend(v.to_le_bytes());}Instruction{program_id:self.program,data:d,accounts:vec![AccountMeta::new(self.vault,false),AccountMeta::new_readonly(self.exec.pubkey(),true),AccountMeta::new(self.tokens,false),AccountMeta::new(self.recipient,false),AccountMeta::new_readonly(self.mint,false),AccountMeta::new_readonly(Address::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap(),false),AccountMeta::new_readonly(self.policy,false),AccountMeta::new_readonly(self.policy_data,false)]}}
 fn tx(&self,mut ixs:Vec<Instruction>,bh:Hash)->Transaction{let mut d=vec![2];d.extend(1_400_000u32.to_le_bytes());ixs.insert(0,Instruction{program_id:Address::from_str("ComputeBudget111111111111111111111111111111").unwrap(),accounts:vec![],data:d});Transaction::new(&[&self.payer,&self.exec],Message::new(&ixs,Some(&self.payer.pubkey())),bh)}
 fn run(&mut self,name:&str,tx:Transaction,kind:&str,spent:u64,nonce:u64){
  let before=store(&self.vm);let bh=self.vm.latest_blockhash();let clock_before=self.vm.get_sysvar::<Clock>();let bytes=wincode::serialize(&tx).unwrap();let id=tx.signatures[0];let keys=tx.message.account_keys.clone();
  let wire=json!({"header":{"required":tx.message.header.num_required_signatures,"readonlySigned":tx.message.header.num_readonly_signed_accounts,"readonlyUnsigned":tx.message.header.num_readonly_unsigned_accounts},"accountKeys":keys.iter().map(ToString::to_string).collect::<Vec<_>>(),"instructions":tx.message.instructions.iter().map(|i|json!({"programIndex":i.program_id_index,"accounts":i.accounts,"data":hex(&i.data)})).collect::<Vec<_>>()});
  let result=self.vm.send_transaction(tx);let after=store(&self.vm);assert_eq!(bh,self.vm.latest_blockhash());assert_eq!(clock_before,self.vm.get_sysvar::<Clock>());
  let (error,meta)=match &result{Ok(m)=>(None,m),Err(e)=>(Some(&e.err),&e.meta)};
  if kind=="success"{assert!(error.is_none(),"{name}: {error:?}");let a=&after[&self.vault].data;assert_eq!(u64at(a,266),spent);assert_eq!(u64at(a,282),nonce);assert_eq!(u64at(a,274),1);assert_eq!(u64at(&after[&self.tokens].data,64),60_000_000-spent);assert_eq!(u64at(&after[&self.recipient].data,64),spent);}
  else {let mut b=before.clone();let mut a=after.clone();b.remove(&self.payer.pubkey());a.remove(&self.payer.pubkey());assert_eq!(b,a,"protected full store changed: {name}");match kind{"abort"=>assert_eq!(format!("{:?}",error.unwrap()),"InstructionError(2, Custom(100))"),"signature"=>assert_eq!(error,Some(&TransactionError::SignatureFailure)),"blockhash"=>assert_eq!(error,Some(&TransactionError::BlockhashNotFound)),_=>panic!()};if kind!="abort"{assert_eq!(before,after);assert!(meta.logs.is_empty());}}
  let fee=before[&self.payer.pubkey()].lamports-after[&self.payer.pubkey()].lamports;assert_eq!(fee,meta.fee);if kind=="abort"{let success=format!("Program {} success",self.program);let token="Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success";assert!(meta.logs.contains(&success)&&meta.logs.iter().any(|l|l==token));assert!(self.vm.get_transaction(&id).is_some());}
  let mut rawkeys=vec![self.vault,self.tokens,self.recipient,self.mint,key(15),Address::from_str("SysvarC1ock11111111111111111111111111111111").unwrap()];
  if name=="invalid_blockhash" {let loader=Address::from_str("BPFLoaderUpgradeab1e11111111111111111111111").unwrap();let vault_data=Address::find_program_address(&[self.program.as_ref()],&loader).0;rawkeys.extend([self.program,self.policy,self.policy_data,vault_data,Address::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()]);}
  println!("{}",json!({"name":name,"transaction":hex(&bytes),"message":wire,"transactionId":id.to_string(),"runtimeBlockhash":hex(bh.as_ref()),"historyRecorded":self.vm.get_transaction(&id).is_some(),"outcome":format!("{error:?}"),"logs":meta.logs,"fee":meta.fee,"units":meta.compute_units_consumed,"beforeStore":fingerprints(&before),"afterStore":fingerprints(&after),"raw":rawkeys.iter().map(|k|json!({"key":k.to_string(),"before":image(before.get(k)),"after":image(after.get(k))})).collect::<Vec<_>>() }));
 }
}
fn main(){let root=std::env::args().nth(1).unwrap();let mut vm=LiteSVM::new().with_log_bytes_limit(None);assert!(vm.get_sigverify());let program=key(10);let policy=key(11);let token_id=Address::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
 let policy_elf=std::fs::read(format!("{root}/allowit_policy.so")).unwrap();let vault_elf=std::fs::read(format!("{root}/allowit_vault.so")).unwrap();let token_elf=std::fs::read(format!("{root}/token.so")).unwrap();vm.add_program(program,&vault_elf).unwrap();vm.add_program(policy,&policy_elf).unwrap();vm.add_program_with_loader(token_id,&token_elf,Address::from_str("BPFLoader2111111111111111111111111111111111").unwrap()).unwrap();for (k,b)in[(program,&vault_elf),(policy,&policy_elf),(token_id,&token_elf)]{assert_eq!(vm.accounts_db().try_program_elf_bytes(&k).unwrap(),b);}
 let owner=Keypair::new_from_array([12;32]);let exec=Keypair::new_from_array([13;32]);let payer=Keypair::new_from_array([20;32]);let mint=key(14);let tokens=key(16);let recipient=key(17);let loader=Address::from_str("BPFLoaderUpgradeab1e11111111111111111111111").unwrap();let(policy_data,_)=Address::find_program_address(&[policy.as_ref()],&loader);let(vault,bump)=Address::find_program_address(&[b"allowit-vault-v1",owner.pubkey().as_ref(),&[18;32]],&program);
 let mut state=vec![1,bump];for bytes in [owner.pubkey().to_bytes(),exec.pubkey().to_bytes(),mint.to_bytes(),tokens.to_bytes(),policy.to_bytes(),unhex("c445348186c8d7ee9132539528c82a3c6a718718993db879cd9ceaf28e1d7cfa").try_into().unwrap(),Sha256::digest(&policy_elf).into(),[18;32]]{state.extend(bytes);}for v in [25_000_000u64,0,1,0,0]{state.extend(v.to_le_bytes());}state.push(1);state.resize(320,0);vm.set_account(vault,account(program,state)).unwrap();for k in [owner.pubkey(),exec.pubkey(),payer.pubkey()]{vm.set_account(k,account(Address::default(),vec![])).unwrap();}
 let mut mb=vec![0;82];mb[36..44].copy_from_slice(&100_000_000u64.to_le_bytes());mb[44]=6;mb[45]=1;vm.set_account(mint,account(token_id,mb)).unwrap();for(k,a,n)in[(key(15),owner.pubkey(),40_000_000u64),(tokens,vault,60_000_000),(recipient,key(19),0)]{vm.set_account(k,account(token_id,token(mint,a,n))).unwrap();}let mut clock=vm.get_sysvar::<Clock>();clock.unix_timestamp=86_401;vm.set_sysvar(&clock);
 let mut f=F{vm,payer,exec,program,policy,vault,tokens,recipient,mint,policy_data};let tx=f.tx(vec![f.transfer(0)],Hash::new_from_array([42;32]));f.run("invalid_blockhash",tx,"blockhash",0,0);let tx=f.tx(vec![f.transfer(0)],f.vm.latest_blockhash());f.run("single",tx,"success",1_000_000,1);let tx=f.tx(vec![f.transfer(1),f.transfer(2)],f.vm.latest_blockhash());f.run("double",tx,"success",3_000_000,3);
 let mut d=vec![7];d.extend(19u32.to_le_bytes());let unsupported=Instruction{program_id:program,accounts:vec![],data:d};let tx=f.tx(vec![f.transfer(3),unsupported],f.vm.latest_blockhash());f.run("abort",tx,"abort",3_000_000,3);let tx=f.tx(vec![f.transfer(3)],f.vm.latest_blockhash());f.run("reuse",tx,"success",4_000_000,4);let original=f.tx(vec![f.transfer(4)],f.vm.latest_blockhash());let mut bad=original.clone();let i=bad.message.account_keys.iter().position(|k|*k==f.exec.pubkey()).unwrap();assert!(i>0&&i<bad.signatures.len());let mut b:[u8;64]=bad.signatures[i].as_ref().try_into().unwrap();b[0]^=1;bad.signatures[i]=Signature::from(b);f.run("invalid_signature",bad,"signature",4_000_000,4);f.run("original",original,"success",5_000_000,5);
}
