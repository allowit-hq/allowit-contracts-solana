use super::*;
use allowit_vault::{Operations, CUSTOM};

const DAY_SECONDS: i64 = 86_400;
const ALT_MINT: Pubkey = Pubkey::new_from_array([20; 32]);
const FOREIGN_PROGRAM: Pubkey = Pubkey::new_from_array([21; 32]);

fn standard(index: u8, value: Param) -> Fixture {
    Fixture::funded(STANDARD, vec![index], vec![value])
}

fn addresses(keys: &[Pubkey]) -> Param {
    Param::Addresses(keys.iter().map(Pubkey::to_bytes).collect())
}

fn core_denied(code: u32) -> Result<(), ProgramError> {
    Err(ProgramError::Custom(1000 + code))
}

#[test]
fn standard_lifetime_spending_limit() {
    let mut f = standard(1, Param::Amount(i128::from(5 * USDC)));
    f.payment("lifetime first spend", 2 * USDC, Ok(()));
    f.payment("lifetime reaches ceiling", 3 * USDC, Ok(()));
    f.payment("lifetime over ceiling", 1, core_denied(103));
    assert_eq!(f.vault().figures.spent, i128::from(5 * USDC));
    assert_eq!(f.vault().nonce, 2);
}

fn check_daily_limit(index: u8, error: u32) {
    let mut f = standard(index, Param::Amount(i128::from(5 * USDC)));
    f.payment("daily first spend", 3 * USDC, Ok(()));
    f.payment("daily reaches ceiling", 2 * USDC, Ok(()));
    f.payment("daily over ceiling", 1, core_denied(error));

    f.svm.sysvars.clock.unix_timestamp += DAY_SECONDS;
    f.payment("daily rollover allows spending", 3 * USDC, Ok(()));
    let figures = f.vault().figures;
    assert_eq!(figures.calls, 3);
    assert_eq!(figures.spent, i128::from(8 * USDC));
    assert_eq!(figures.day, 2);
    assert_eq!(figures.day_spent, i128::from(3 * USDC));
    assert_eq!(figures.day_total, i128::from(3 * USDC));
}

#[test]
fn standard_daily_spending_limit() {
    check_daily_limit(2, 104);
}

#[test]
fn standard_daily_volume_limit() {
    check_daily_limit(3, 105);
}

#[test]
fn standard_call_limit() {
    let mut f = standard(4, Param::Count(2));
    f.payment("call number one", USDC, Ok(()));
    f.payment("call number two", USDC, Ok(()));
    f.payment("call number three", USDC, core_denied(106));
    assert_eq!(f.vault().figures.calls, 2);
}

#[test]
fn standard_destinations() {
    let mut f = standard(5, addresses(&[RECIPIENT]));
    f.payment("destination owner listed", USDC, Ok(()));
    let mut ix = f.execute(USDC, 1, 0, NOW + 1);
    ix.accounts[5] = rw(OWNER_DESTINATION, false);
    f.run("destination owner absent", &ix, core_denied(107));
}

#[test]
fn standard_tokens_listed_mint() {
    let mut f = standard(6, addresses(&[MINT]));
    f.payment("mint listed", USDC, Ok(()));
}

#[test]
fn standard_tokens_rejects_unlisted_vault_mint() {
    let mut f = Fixture::with_mint(ALT_MINT);
    f.initialize(STANDARD, vec![6], vec![addresses(&[MINT])]);
    f.fund();
    f.payment("vault mint absent", USDC, core_denied(108));
    assert_eq!(f.balance(f.ata), DEPOSIT);
}

#[test]
fn standard_expires_at() {
    let end = NOW + 30;
    let mut f = standard(7, Param::Expiry(end));
    f.payment("policy unexpired", USDC, Ok(()));
    f.svm.sysvars.clock.unix_timestamp = end;
    f.payment(
        "policy expired with a fresh request",
        USDC,
        core_denied(109),
    );
}

#[test]
fn standard_operations() {
    let mut f = standard(8, Param::Operations(Operations::Any));
    f.payment("transfer allowed by wildcard", USDC, Ok(()));
    let ix = f.update(
        1,
        vec![8],
        vec![Param::Operations(Operations::Names(vec!["deposit".into()]))],
    );
    f.run("install operations list", &ix, Ok(()));
    f.payment("transfer absent from operations", USDC, core_denied(115));
}

#[test]
fn standard_all_nine_rules() {
    let mut f = Fixture::funded(
        STANDARD,
        (0..9).collect(),
        vec![
            Param::Amount(i128::from(2 * USDC)),
            Param::Amount(i128::from(10 * USDC)),
            Param::Amount(i128::from(5 * USDC)),
            Param::Amount(i128::from(5 * USDC)),
            Param::Count(5),
            addresses(&[RECIPIENT]),
            addresses(&[MINT]),
            Param::Expiry(NOW + 30),
            Param::Operations(Operations::Names(vec!["transfer".into()])),
        ],
    );
    f.payment("execute all nine rules", USDC, Ok(()));
    assert_eq!(f.balance(DESTINATION), USDC);
    assert_eq!(f.vault().nonce, 1);
}

#[test]
fn owner_stop_pauses_and_recovers_full_balance() {
    let mut f = Fixture::simple();
    let ix = f.owner_transfer(VaultInstruction::Stop { version: 1 }, OWNER_DESTINATION);
    f.run("stop and transfer full balance", &ix, Ok(()));
    assert!(f.vault().paused);
    assert_eq!(f.vault().version, 1);
    assert_eq!(f.balance(f.ata), 0);
    assert_eq!(f.balance(OWNER_DESTINATION), DEPOSIT);
    f.payment("execute after stop", 1, denied(VaultError::Paused));
}

#[test]
fn owner_recover_rejects_foreign_destination() {
    let mut f = Fixture::simple();
    let ix = f.owner_transfer(VaultInstruction::Recover { amount: USDC }, DESTINATION);
    f.run(
        "recover to a foreign owner",
        &ix,
        denied(VaultError::InvalidRecipient),
    );
    assert_eq!(f.balance(f.ata), DEPOSIT);
}

#[test]
fn owner_update_policy_grows_and_refunds_rent() {
    let mut f = standard(5, addresses(&[RECIPIENT]));
    f.payment("execute before updating", USDC, Ok(()));
    let pause = f.set_pause(true, 1);
    f.run("pause before updating", &pause, Ok(()));
    let previous = f.vault();
    let old_lamports = f.accounts[&f.state].lamports;
    let old_bytes = f.accounts[&f.state].data.len();
    let owner_lamports = f.accounts[&OWNER].lamports;
    let five = [RECIPIENT, OWNER, AGENT, SERVER, CHECK_PROGRAM];

    let grow = f.update(2, vec![5], vec![addresses(&five)]);
    f.run("update destinations one to five", &grow, Ok(()));
    let account = &f.accounts[&f.state];
    assert_eq!(account.data.len(), old_bytes + 4 * 32);
    assert_eq!(
        account.lamports,
        f.svm.sysvars.rent.minimum_balance(account.data.len())
    );
    assert!(account.lamports > old_lamports);
    assert_eq!(
        f.accounts[&OWNER].lamports + account.lamports,
        owner_lamports + old_lamports
    );
    assert_eq!(f.vault().version, 2);
    assert_eq!(f.vault().params, vec![addresses(&five)]);
    assert_eq!(f.vault().source_hash, [22; 32]);

    let skip = f.update(5, vec![5], vec![addresses(&[RECIPIENT])]);
    f.run(
        "update rejects skipped version",
        &skip,
        denied(VaultError::StaleRequest),
    );
    let invalid = f.update(3, vec![0], vec![Param::Amount(-1)]);
    f.run("update rejects negative limit", &invalid, core_denied(111));

    let shrink = f.update(3, vec![5], vec![addresses(&[RECIPIENT])]);
    f.run("update destinations five to one", &shrink, Ok(()));
    let after = f.vault();
    assert_eq!(f.accounts[&f.state].data.len(), old_bytes);
    assert_eq!(f.accounts[&f.state].lamports, old_lamports);
    assert_eq!(f.accounts[&OWNER].lamports, owner_lamports);
    assert_eq!(after.version, 3);
    assert_eq!(after.paused, previous.paused);
    assert_eq!(after.nonce, previous.nonce);
    assert_eq!(after.figures, previous.figures);
    assert_eq!(after.params, previous.params);
}

#[test]
fn custom_check_and_owner_steps() {
    let mut f = Fixture::new();
    f.initialize(CUSTOM, vec![], vec![]);
    f.fund();
    f.add_check();
    let check_state = Pubkey::find_program_address(&[f.state.as_ref()], &CHECK_PROGRAM).0;
    f.accounts.insert(
        check_state,
        Account {
            lamports: 2_000_000,
            owner: CHECK_PROGRAM,
            ..Account::default()
        },
    );

    let mut ok = f.execute(3 * USDC, 0, 0, NOW + 1);
    ok.accounts.push(ro(CHECK_PROGRAM, false));
    ok.accounts.push(rw(check_state, false));
    f.run(
        "custom check accepts three USDC with check state",
        &ok,
        Ok(()),
    );
    let mut denied = f.execute(3 * USDC + 1, 1, 0, NOW + 1);
    denied.accounts.push(ro(CHECK_PROGRAM, false));
    f.run(
        "custom check refuses above three USDC",
        &denied,
        Err(ProgramError::Custom(3001)),
    );
    assert_eq!(f.balance(DESTINATION), 3 * USDC);
    assert_eq!(f.vault().nonce, 1);

    let pause = f.set_pause(true, 1);
    f.run("custom owner pauses without check program", &pause, Ok(()));
    let recover = f.owner_transfer(
        VaultInstruction::Recover { amount: USDC },
        OWNER_DESTINATION,
    );
    f.run(
        "custom owner recovers without check program",
        &recover,
        Ok(()),
    );
    assert_eq!(f.balance(OWNER_DESTINATION), USDC);
    assert!(f.vault().paused);
    assert_eq!(f.vault().version, 1);
    assert_eq!(f.vault().nonce, 1);
}

#[test]
fn security_agent_cannot_authorize_owner_instruction() {
    let mut f = Fixture::simple();
    let mut pause = f.set_pause(true, 1);
    pause.accounts[1] = ro(AGENT, true);
    f.run(
        "agent attempts owner pause",
        &pause,
        denied(VaultError::InvalidActor),
    );
}

#[test]
fn security_initialize_rejects_same_signers_and_same_instance() {
    let mut f = Fixture::new();
    let mut invalid = f.initialize_instruction(SIMPLE, vec![], vec![]);
    let mut data = VaultInstruction::try_from_slice(&invalid.data).unwrap();
    let VaultInstruction::Initialize { server, .. } = &mut data else {
        unreachable!()
    };
    *server = AGENT.to_bytes();
    invalid.data = borsh::to_vec(&data).unwrap();
    f.run(
        "initialize agent equals server",
        &invalid,
        denied(VaultError::InvalidActor),
    );

    f.initialize(SIMPLE, vec![], vec![]);
    let repeated = f.initialize_instruction(SIMPLE, vec![], vec![]);
    f.run(
        "initialize same instance again",
        &repeated,
        denied(VaultError::InvalidState),
    );
}

#[test]
fn security_execute_rejects_state_owned_by_another_program() {
    let mut f = Fixture::simple();
    let mut forged = f.accounts[&f.state].clone();
    forged.owner = FOREIGN_PROGRAM;
    f.accounts.insert(f.state, forged);
    let ix = f.execute(USDC, 0, 0, NOW + 1);
    f.run(
        "execute forged state owner",
        &ix,
        denied(VaultError::InvalidState),
    );
}

#[test]
fn security_execute_rejects_non_ata_source() {
    let mut f = Fixture::simple();
    let mut ix = f.execute(USDC, 0, 0, NOW + 1);
    let non_ata = Pubkey::new_from_array([24; 32]);
    let source = f.accounts[&f.ata].clone();
    f.accounts.insert(non_ata, source);
    ix.accounts[4] = rw(non_ata, false);
    f.run(
        "execute non-ATA source",
        &ix,
        denied(VaultError::InvalidState),
    );
}

#[test]
fn security_execute_rejects_destination_for_another_mint() {
    let mut f = Fixture::simple();
    f.accounts
        .insert(DESTINATION, token_destination(RECIPIENT, ALT_MINT));
    f.payment(
        "execute recipient mint differs",
        USDC,
        denied(VaultError::InvalidRecipient),
    );
}

#[test]
fn security_execute_rejects_vault_ata_as_destination() {
    let mut f = Fixture::simple();
    let mut ix = f.execute(USDC, 0, 0, NOW + 1);
    ix.accounts[5] = rw(f.ata, false);
    f.run(
        "execute to vault ATA",
        &ix,
        denied(VaultError::InvalidRecipient),
    );
}

#[test]
fn security_initialize_rejects_invalid_standard_params() {
    let mut f = Fixture::new();
    let cases = [
        (
            "initialize missing value",
            vec![0],
            vec![],
            core_denied(101),
        ),
        (
            "initialize wrong value type",
            vec![0],
            vec![Param::Count(1)],
            core_denied(111),
        ),
        (
            "initialize negative amount",
            vec![0],
            vec![Param::Amount(-1)],
            core_denied(111),
        ),
        (
            "initialize duplicate rule",
            vec![0, 0],
            vec![Param::Amount(1), Param::Amount(1)],
            denied(VaultError::InvalidParam),
        ),
        (
            "initialize invalid index",
            vec![9],
            vec![Param::Amount(1)],
            denied(VaultError::InvalidParam),
        ),
    ];
    for (label, rules, params, expected) in cases {
        let ix = f.initialize_instruction(STANDARD, rules, params);
        f.run(label, &ix, expected);
    }
}
