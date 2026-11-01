//! Finite loader preparation only. No instruction/transaction is executed.
use litesvm::LiteSVM;
use solana_address::Address;
fn main() {
    let root=std::env::args().nth(1).expect("artifact directory");
    let mut vm=LiteSVM::new();
    assert!(vm.get_sigverify());
    let mut features: Vec<_> = LiteSVM::mainnet_feature_set().active().iter().map(|(id,slot)|(id.to_string(),*slot)).collect();
    features.sort();
    println!("PINNED_MAINNET_FEATURES {features:?}");
    for (name,byte) in [("allowit_policy.so",11u8),("allowit_vault.so",10u8)] {
        let bytes=std::fs::read(std::path::Path::new(&root).join(name)).unwrap();
        let id=Address::new_from_array([byte;32]);
        match vm.add_program(id,&bytes) {
            Ok(()) => {
                assert_eq!(vm.accounts_db().try_program_elf_bytes(&id).unwrap(),bytes);
                println!("{name}: add_program returned Ok for {} bytes; stored ELF equals input",bytes.len());
            },
            Err(e) => panic!("unsupported unchanged {name}: {e:?}"),
        }
        let mut invalid=bytes.clone();invalid[0]=0;
        let mut control=LiteSVM::new();
        let error=control.add_program(id,&invalid).expect_err("invalid ELF accepted");
        println!("{name}: invalid ELF magic refused: {error:?}");
    }
}
