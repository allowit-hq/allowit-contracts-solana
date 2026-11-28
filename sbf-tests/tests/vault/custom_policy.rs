use super::*;
use solana_loader_v3_interface::{
    instruction::{deploy_with_max_program_len, set_upgrade_authority},
    state::UpgradeableLoaderState,
};
use solana_message::legacy::Message;

#[test]
#[ignore = "build the three S2 programs first"]
fn custom_policy_creation_packet_fits() {
    let fixture = Fixture::new();
    let buffer = Pubkey::new_from_array([25; 32]);
    let initialize = fixture.initialize_instruction(allowit_vault::CUSTOM, vec![], vec![]);
    for name in ["paper_sample", "destination_list", "daily_limits"] {
        let elf_len = std::fs::metadata(program(&format!("{name}.so")))
            .unwrap()
            .len() as usize;
        let rent = &fixture.svm.sysvars.rent;
        let mut instructions = deploy_with_max_program_len(
            &OWNER,
            &CHECK_PROGRAM,
            &buffer,
            &SERVER,
            rent.minimum_balance(UpgradeableLoaderState::size_of_program()),
            elf_len,
        )
        .unwrap();
        instructions.push(set_upgrade_authority(&CHECK_PROGRAM, &SERVER, None));
        instructions.push(initialize.clone());
        instructions.push(
            spl_token_interface::instruction::transfer_checked(
                &token::ID,
                &OWNER_DESTINATION,
                &MINT,
                &fixture.ata,
                &OWNER,
                &[],
                5 * USDC,
                DECIMALS,
            )
            .unwrap(),
        );

        let message = Message::new(&instructions, Some(&OWNER));
        let required = usize::from(message.header.num_required_signatures);
        assert_eq!(
            &message.account_keys[..required],
            &[OWNER, CHECK_PROGRAM, SERVER]
        );
        let bytes = 1 + required * 64 + message.serialize().len();
        assert!(
            bytes <= 1_232,
            "{name}: creation transaction is {bytes} bytes"
        );
        println!(
            "{name}: {bytes} creation bytes; query Devnet rent for {} ProgramData bytes",
            UpgradeableLoaderState::size_of_programdata(elf_len)
        );
    }
}

#[test]
#[ignore = "build the three S2 programs first"]
fn custom_policy_spike() {
    for name in ["paper_sample", "destination_list", "daily_limits"] {
        let mut fixture = Fixture::funded(allowit_vault::CUSTOM, vec![], vec![]);
        let file = program(&format!("{name}.so"));
        let elf = std::fs::read(file).unwrap();
        fixture.svm.add_program_with_loader_and_elf(
            &CHECK_PROGRAM,
            &mollusk_svm::program::loader_keys::LOADER_V2,
            &elf,
        );
        fixture.accounts.insert(
            CHECK_PROGRAM,
            mollusk_svm::program::create_program_account_loader_v2(&elf),
        );

        let invoke = |fixture: &mut Fixture, amount, nonce, expected| {
            let mut ix = fixture.execute(amount, nonce, 0, NOW + 5);
            ix.accounts.push(ro(CHECK_PROGRAM, false));
            fixture.run(name, &ix, expected)
        };
        let allowed = invoke(&mut fixture, 3 * USDC, 0, Ok(()));
        if name == "destination_list" {
            fixture.accounts.insert(
                DESTINATION,
                token_destination(Pubkey::new_from_array([24; 32]), MINT),
            );
        }
        let denied_amount = if name == "paper_sample" {
            3 * USDC + 1
        } else {
            3 * USDC
        };
        let denied = invoke(
            &mut fixture,
            denied_amount,
            1,
            Err(ProgramError::Custom(3001)),
        );
        assert_eq!(
            fixture.balance(DESTINATION),
            if name == "destination_list" {
                0
            } else {
                3 * USDC
            }
        );
        assert_eq!(fixture.vault().nonce, 1);
        println!(
            "{name}: {} ELF bytes, {allowed} CU allow, {denied} CU deny",
            elf.len()
        );
    }
}
