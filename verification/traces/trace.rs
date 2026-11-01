#![allow(dead_code)]
include!("fixture.rs");
use serde_json::{json, Value};

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn snapshot(f: &F, accounts: &BTreeMap<Pubkey, Account>) -> Value {
    let s = VaultState::deserialize(&mut &accounts[&f.vault].data[..]).unwrap();
    json!({"custody":hex(f.vault.as_ref()), "owner":hex(&s.owner), "executor":hex(&s.executor),
        "asset":hex(&s.mint), "policy":hex(&s.policy), "source":hex(&s.policy_source),
        "artifact":hex(&s.policy_artifact), "limit":s.daily_limit, "spent":s.spent,
        "spentDay":s.spent_day, "nonce":s.nonce, "revision":s.revision, "approved":s.approved,
        "balance":Token::unpack(&accounts[&f.tokens].data).unwrap().amount, "sourceBalance":Token::unpack(&accounts[&f.source].data).unwrap().amount,
        "recipientBalance":Token::unpack(&accounts[&f.recipient].data).unwrap().amount, "abi":s.abi, "bump":s.bump,
        "tokenAccount":hex(&s.token_account), "vaultId":hex(&s.vault_id),
        "sourceKey":hex(f.source.as_ref()),"recipientKey":hex(f.recipient.as_ref()),
        "mintSupply":Mint::unpack(&accounts[&f.mint].data).unwrap().supply})
}
fn images(accounts: &BTreeMap<Pubkey, Account>) -> Value {
    let rows: Vec<_> = accounts.iter().map(|(k,a)| json!({"key":hex(k.as_ref()),"owner":hex(a.owner.as_ref()),"lamports":a.lamports,"executable":a.executable,"data":hex(&a.data)})).collect();
    json!(rows)
}
fn metas(f: &F, actor: Pubkey, signed: bool, destination: Pubkey) -> Vec<AccountMeta> {
    vec![rw(f.vault,false),ro(actor,signed),rw(f.tokens,false),rw(destination,false),
        ro(f.mint,false),ro(Pubkey::new_from_array(spl_token::id().to_bytes()),false),
        ro(f.policy,false),ro(f.policy_data,false)]
}
fn record(f: &mut F, name: &str, instruction: V, accounts: Vec<AccountMeta>, expected: &str) {
    let before = snapshot(f, &f.accounts);
    let previous = f.accounts.clone();
    let ix = Instruction { program_id:f.program, accounts, data:borsh::to_vec(&instruction).unwrap() };
    let data = ix.data.clone();
    let actors: Vec<_> = ix.accounts.iter().map(|a| json!({"key":hex(a.pubkey.as_ref()),
        "signed":a.is_signer,"writable":a.is_writable})).collect();
    let now = f.svm.sysvars.clock.unix_timestamp;
    eprintln!("TRACE_BEGIN {name}");
    let supplied: Vec<_> = previous.iter().map(|(k,a)| (*k,a.clone())).collect();
    let result = f.svm.process_instruction(&ix, &supplied);
    if result.program_result.is_ok() {
        for (k,a) in &result.resulting_accounts { f.accounts.insert(*k,a.clone()); }
    }
    eprintln!("TRACE_END {name}");
    let outcome = format!("{:?}", result.program_result);
    assert_eq!(outcome, expected, "unexpected outcome for {name}");
    if name == "budget_exhaustion_rollback" {
        let intermediate: VaultState = borsh::from_slice(&result.return_data).unwrap();
        assert_eq!(intermediate.nonce, f.state().nonce + 1);
        assert_eq!(intermediate.spent, f.state().spent + 1);
    }
    let returned: BTreeMap<_,_> = result.resulting_accounts.iter().cloned().collect();
    let unchanged = returned == previous;
    if !result.program_result.is_ok() { assert!(unchanged, "rejected instruction changed an input account: {name}"); }
    println!("{}",json!({"name":name,"before":before,"after":snapshot(f, &returned),"beforeAccounts":images(&previous),"afterAccounts":images(&returned),
        "data":hex(&data),"accounts":actors,"now":now,"outcome":outcome,
        "allReturnedAccountsUnchanged":unchanged,"returnData":hex(&result.return_data)}));
}
fn control_record(f: &mut F, name: &str, instruction: V, expected: &str) {
    let accounts=vec![rw(f.vault,false),ro(f.owner,true),ro(f.policy,false),ro(f.policy_data,false)];
    record(f,name,instruction,accounts,expected);
}
fn transfer_record(f: &mut F, name: &str, amount: u64, nonce: u64, revision: u64, expected: &str) {
    let accounts=metas(f,f.executor,true,f.recipient);
    record(f,name,V::Transfer{amount,nonce,expected_revision:revision},accounts,expected);
}
fn state_record(f: &mut F, state: &VaultState) {
    let mut bytes=borsh::to_vec(state).unwrap();bytes.resize(STATE_BYTES,0);
    f.accounts.get_mut(&f.vault).unwrap().data=bytes;
}
fn main() {
    eprintln!("TOKEN_ELF {} {}",mollusk_svm_programs_token::token::ELF.len(),hex(solana_program::hash::hash(mollusk_svm_programs_token::token::ELF).as_ref()));
    let mut f=F::new();
    let mut mint=Mint::unpack(&f.accounts[&f.mint].data).unwrap();
    mint.supply=100_000_000;
    Mint::pack(mint,&mut f.accounts.get_mut(&f.mint).unwrap().data).unwrap();
    let deposit_accounts=vec![rw(f.vault,false),ro(f.owner,true),rw(f.source,false),rw(f.tokens,false),
        ro(f.mint,false),ro(Pubkey::new_from_array(spl_token::id().to_bytes()),false)];
    record(&mut f,"deposit",V::Deposit{amount:60_000_000},deposit_accounts,"Success");
    transfer_record(&mut f,"unapproved",1,0,0,"Failure(Custom(104))");
    control_record(&mut f,"approve",V::Approve{approved:true,expected_revision:0},"Success");
    transfer_record(&mut f,"spend",20_000_000,0,1,"Success");
    transfer_record(&mut f,"replay",1,0,1,"Failure(Custom(101))");
    control_record(&mut f,"lower_below_spent",V::SetDailyLimit{value:10_000_000,expected_revision:1},"Success");
    transfer_record(&mut f,"lowered_denial",1,1,2,"Failure(Custom(1006))");
    control_record(&mut f,"pause",V::SetDailyLimit{value:0,expected_revision:2},"Success");
    transfer_record(&mut f,"paused_denial",1,1,3,"Failure(Custom(1006))");
    let accounts=vec![rw(f.vault,false),ro(f.owner,true),rw(f.source,false),rw(f.tokens,false),
        ro(f.mint,false),ro(Pubkey::new_from_array(spl_token::id().to_bytes()),false)];
    record(&mut f,"top_up",V::Deposit{amount:5_000_000},accounts,"Success");
    let accounts=metas(&f,f.owner,true,f.source);
    record(&mut f,"withdraw",V::Withdraw{amount:1_000_000},accounts,"Success");
    f.svm.sysvars.clock.unix_timestamp=172_800;
    transfer_record(&mut f,"pause_new_day",1,1,3,"Failure(Custom(1006))");
    control_record(&mut f,"resume_limit",V::SetDailyLimit{value:25_000_000,expected_revision:3},"Success");
    transfer_record(&mut f,"next_day_exact_limit",25_000_000,1,4,"Success");
    let artifact=f.artifact;
    control_record(&mut f,"switch",V::SetPolicy{policy_source:source_hash::SOURCE_HASH,policy_artifact:artifact,expected_revision:4},"Success");
    transfer_record(&mut f,"switch_revoked",1,2,5,"Failure(Custom(104))");
    control_record(&mut f,"revoke",V::Approve{approved:false,expected_revision:5},"Success");
    control_record(&mut f,"reapprove",V::Approve{approved:true,expected_revision:6},"Success");
    control_record(&mut f,"raise_limit",V::SetDailyLimit{value:50_000_000,expected_revision:7},"Success");
    let accounts=metas(&f,f.owner,true,f.recipient);
    record(&mut f,"wrong_executor",V::Transfer{amount:1,nonce:2,expected_revision:8},accounts,"Failure(Custom(110))");
    let accounts=metas(&f,f.executor,false,f.recipient);
    record(&mut f,"unsigned_executor",V::Transfer{amount:1,nonce:2,expected_revision:8},accounts,"Failure(MissingRequiredSignature)");
    transfer_record(&mut f,"stale_revision",1,2,7,"Failure(Custom(101))");
    record(&mut f,"unsupported",V::Unsupported{method:19},vec![],"Failure(Custom(100))");
    let original=f.state();
    let mut changed=original.clone();changed.nonce=u64::MAX;state_record(&mut f,&changed);
    transfer_record(&mut f,"nonce_overflow",1,u64::MAX,8,"Failure(Custom(102))");
    state_record(&mut f,&original);
    let mut changed=original.clone();changed.revision=u64::MAX;state_record(&mut f,&changed);
    control_record(&mut f,"revision_overflow",V::SetDailyLimit{value:1,expected_revision:u64::MAX},"Failure(Custom(102))");
    state_record(&mut f,&original);
    f.svm.compute_budget.compute_unit_limit=13300;
    transfer_record(&mut f,"budget_exhaustion_rollback",1,2,8,"UnknownError(ProgramFailedToComplete)");
    f.svm.compute_budget.compute_unit_limit=1_400_000;
    let mut destination=Token::unpack(&f.accounts[&f.recipient].data).unwrap();
    destination.amount=u64::MAX;
    Token::pack(destination,&mut f.accounts.get_mut(&f.recipient).unwrap().data).unwrap();
    transfer_record(&mut f,"injected_supply_violation",1,2,8,"Success");
}
