#![allow(dead_code)]
include!("observer.rs");
fn main() {
    eprintln!("TOKEN_ELF {} {}",mollusk_svm_programs_token::token::ELF.len(),hex(solana_program::hash::hash(mollusk_svm_programs_token::token::ELF).as_ref()));
    let mut f=F::new();
    let mut mint=Mint::unpack(&f.accounts[&f.mint].data).unwrap();mint.supply=100_000_000;
    Mint::pack(mint,&mut f.accounts.get_mut(&f.mint).unwrap().data).unwrap();
    let a=vec![rw(f.vault,false),ro(f.owner,true),rw(f.source,false),rw(f.tokens,false),ro(f.mint,false),ro(Pubkey::new_from_array(spl_token::id().to_bytes()),false)];
    record(&mut f,"deposit",V::Deposit{amount:60_000_000},a,"Success");
    control_record(&mut f,"approve",V::Approve{approved:true,expected_revision:0},"Success");
    transfer_record(&mut f,"spend",10_000_000,0,1,"Success");
    let artifact=f.artifact;
    control_record(&mut f,"switch",V::SetPolicy{policy_source:source_hash::SOURCE_HASH,policy_artifact:artifact,expected_revision:1},"Success");
    transfer_record(&mut f,"revoked",1,1,2,"Failure(Custom(104))");
    control_record(&mut f,"reapprove",V::Approve{approved:true,expected_revision:2},"Success");
    transfer_record(&mut f,"valid",1,1,3,"Success");
    let a=metas(&f,f.owner,true,f.recipient);
    record(&mut f,"wrong_executor",V::Transfer{amount:1,nonce:2,expected_revision:3},a,"Failure(Custom(110))");
    let a=metas(&f,f.executor,false,f.recipient);
    record(&mut f,"unsigned_executor",V::Transfer{amount:1,nonce:2,expected_revision:3},a,"Failure(MissingRequiredSignature)");
    transfer_record(&mut f,"stale_revision",1,2,2,"Failure(Custom(101))");
    transfer_record(&mut f,"replay",1,1,3,"Failure(Custom(101))");
    transfer_record(&mut f,"valid_after_refusals",1,2,3,"Success");
}
