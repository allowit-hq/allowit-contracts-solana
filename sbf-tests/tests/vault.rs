use allowit_vault::{
    Figures, Param, VaultError, VaultInstruction, VaultState, ABI, DECIMALS, SIMPLE, STANDARD,
    VAULT_SEED,
};
use borsh::BorshDeserialize;
use mollusk_svm::{
    result::{InstructionResult, ProgramResult as MolluskResult},
    Mollusk,
};
use mollusk_svm_programs_token::{associated_token, token};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use solana_sdk_ids::{native_loader, system_program};
use spl_associated_token_account_interface::address::get_associated_token_address_with_program_id;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};
use std::collections::BTreeMap;

#[path = "vault/stage2.rs"]
mod stage2;

const PROGRAM: Pubkey = Pubkey::new_from_array([10; 32]);
const CHECK_PROGRAM: Pubkey = Pubkey::new_from_array([23; 32]);
const OWNER: Pubkey = Pubkey::new_from_array([11; 32]);
const AGENT: Pubkey = Pubkey::new_from_array([12; 32]);
const SERVER: Pubkey = Pubkey::new_from_array([13; 32]);
const MINT: Pubkey = Pubkey::new_from_array([14; 32]);
const DESTINATION: Pubkey = Pubkey::new_from_array([15; 32]);
const RECIPIENT: Pubkey = Pubkey::new_from_array([16; 32]);
const OWNER_DESTINATION: Pubkey = Pubkey::new_from_array([17; 32]);
const INSTANCE: [u8; 32] = [18; 32];
const SOURCE_HASH: [u8; 32] = [19; 32];
const OWNER_LAMPORTS: u64 = 10_000_000_000;
const SLOT: u64 = 100;
const NOW: i64 = 86_401;
const USDC: u64 = 1_000_000;
const DEPOSIT: u64 = 20 * USDC;

struct Fixture {
    svm: Mollusk,
    accounts: BTreeMap<Pubkey, Account>,
    state: Pubkey,
    bump: u8,
    ata: Pubkey,
    mint: Pubkey,
}

impl Fixture {
    fn new() -> Self {
        Self::with_mint(MINT)
    }

    fn with_mint(mint: Pubkey) -> Self {
        assert!(
            std::env::var_os("SBF_OUT_DIR").is_some(),
            "SBF_OUT_DIR must name the actual SBF output directory"
        );
        let mut svm = Mollusk::new(&PROGRAM, "allowit_vault");
        token::add_program(&mut svm);
        associated_token::add_program(&mut svm);
        svm.sysvars.clock.unix_timestamp = NOW;
        svm.sysvars.clock.slot = SLOT;
        let (state, bump) =
            Pubkey::find_program_address(&[VAULT_SEED, OWNER.as_ref(), &INSTANCE], &PROGRAM);
        let ata = get_associated_token_address_with_program_id(&state, &mint, &token::ID);
        let accounts = BTreeMap::from([
            (
                OWNER,
                Account {
                    lamports: OWNER_LAMPORTS,
                    ..Account::default()
                },
            ),
            (AGENT, Account::default()),
            (SERVER, Account::default()),
            (state, Account::default()),
            (ata, Account::default()),
            (DESTINATION, token_destination(RECIPIENT, mint)),
            (OWNER_DESTINATION, token_destination(OWNER, mint)),
            (
                mint,
                token::create_account_for_mint(Mint {
                    mint_authority: COption::Some(OWNER),
                    supply: 0,
                    decimals: DECIMALS,
                    is_initialized: true,
                    freeze_authority: COption::None,
                }),
            ),
            (
                system_program::ID,
                Account {
                    executable: true,
                    owner: native_loader::ID,
                    ..Account::default()
                },
            ),
            token::keyed_account(),
            associated_token::keyed_account(),
        ]);
        Self {
            svm,
            accounts,
            state,
            bump,
            ata,
            mint,
        }
    }

    fn initialize_instruction(&self, kind: u8, rules: Vec<u8>, params: Vec<Param>) -> Instruction {
        self.instruction(
            VaultInstruction::Initialize {
                instance_id: INSTANCE,
                kind,
                agent: AGENT.to_bytes(),
                server: SERVER.to_bytes(),
                source_hash: SOURCE_HASH,
                check_program: if kind == allowit_vault::CUSTOM {
                    CHECK_PROGRAM.to_bytes()
                } else {
                    [0; 32]
                },
                rules,
                params,
            },
            vec![
                rw(self.state, false),
                rw(OWNER, true),
                ro(self.mint, false),
                rw(self.ata, false),
                ro(system_program::ID, false),
                ro(token::ID, false),
                ro(associated_token::ID, false),
            ],
        )
    }

    fn initialize(&mut self, kind: u8, rules: Vec<u8>, params: Vec<Param>) {
        let ix = self.initialize_instruction(kind, rules, params);
        self.run("initialize", &ix, Ok(()));
    }

    fn funded(kind: u8, rules: Vec<u8>, params: Vec<Param>) -> Self {
        let mut fixture = Self::new();
        fixture.initialize(kind, rules, params);
        fixture.fund();
        fixture
    }

    fn fund(&mut self) {
        let mint = spl_token_interface::instruction::mint_to(
            &token::ID,
            &self.mint,
            &self.ata,
            &OWNER,
            &[],
            DEPOSIT,
        )
        .unwrap();
        self.run("fund via SPL MintTo", &mint, Ok(()));
    }

    fn simple() -> Self {
        Self::funded(SIMPLE, vec![], vec![])
    }

    fn instruction(&self, data: VaultInstruction, accounts: Vec<AccountMeta>) -> Instruction {
        Instruction::new_with_bytes(PROGRAM, &borsh::to_vec(&data).unwrap(), accounts)
    }

    fn execute(&self, amount: u64, nonce: u64, version: u32, expires_at: i64) -> Instruction {
        self.instruction(
            VaultInstruction::Execute {
                amount,
                nonce,
                version,
                created_slot: SLOT,
                expires_at,
            },
            vec![
                rw(self.state, false),
                ro(AGENT, true),
                ro(SERVER, true),
                ro(self.mint, false),
                rw(self.ata, false),
                rw(DESTINATION, false),
                ro(token::ID, false),
            ],
        )
    }

    fn set_pause(&self, paused: bool, version: u32) -> Instruction {
        self.instruction(
            VaultInstruction::SetPause { paused, version },
            vec![rw(self.state, false), ro(OWNER, true)],
        )
    }

    fn close(&self, version: u32) -> Instruction {
        self.owner_transfer(VaultInstruction::Close { version }, OWNER_DESTINATION)
    }

    fn owner_transfer(&self, instruction: VaultInstruction, destination: Pubkey) -> Instruction {
        self.instruction(
            instruction,
            vec![
                rw(self.state, false),
                rw(OWNER, true),
                ro(self.mint, false),
                rw(self.ata, false),
                rw(destination, false),
                ro(token::ID, false),
            ],
        )
    }

    fn update(&self, version: u32, rules: Vec<u8>, params: Vec<Param>) -> Instruction {
        self.instruction(
            VaultInstruction::UpdatePolicy {
                version,
                agent: AGENT.to_bytes(),
                server: SERVER.to_bytes(),
                source_hash: [22; 32],
                check_program: [0; 32],
                rules,
                params,
            },
            vec![
                rw(self.state, false),
                rw(OWNER, true),
                ro(system_program::ID, false),
            ],
        )
    }

    fn payment(&mut self, label: &str, amount: u64, expected: Result<(), ProgramError>) {
        let state = self.vault();
        let now = self.svm.sysvars.clock.unix_timestamp;
        let ix = self.execute(amount, state.nonce, state.version, now + 1);
        self.run(label, &ix, expected);
    }

    fn add_check(&mut self) {
        let dir = std::env::var_os("SBF_OUT_DIR").unwrap();
        let file = std::path::Path::new(&dir).join("allowit_vault_test_check.so");
        let elf = std::fs::read(file).expect("build the test-check SBF program first");
        self.svm.add_program_with_loader_and_elf(
            &CHECK_PROGRAM,
            &mollusk_svm::program::loader_keys::LOADER_V2,
            &elf,
        );
        self.accounts.insert(
            CHECK_PROGRAM,
            mollusk_svm::program::create_program_account_loader_v2(&elf),
        );
    }

    fn run(&mut self, label: &str, ix: &Instruction, expected: Result<(), ProgramError>) {
        let accounts = self
            .accounts
            .iter()
            .map(|(key, account)| (*key, account.clone()))
            .collect::<Vec<_>>();
        let InstructionResult {
            compute_units_consumed,
            program_result,
            resulting_accounts,
            ..
        } = self.svm.process_instruction(ix, &accounts);
        println!(
            "{label}: compute_units_consumed={compute_units_consumed} result={program_result:?}"
        );
        let expected = match expected {
            Ok(()) => MolluskResult::Success,
            Err(error) => MolluskResult::Failure(error),
        };
        assert_eq!(program_result, expected, "{label}");
        if program_result.is_ok() {
            self.accounts.extend(resulting_accounts);
        } else {
            for (key, account) in resulting_accounts {
                assert_eq!(self.accounts[&key], account, "{label} changed {key}");
            }
        }
    }

    fn vault(&self) -> VaultState {
        VaultState::try_from_slice(&self.accounts[&self.state].data).unwrap()
    }

    fn balance(&self, key: Pubkey) -> u64 {
        TokenAccount::unpack(&self.accounts[&key].data)
            .unwrap()
            .amount
    }
}

fn ro(key: Pubkey, signer: bool) -> AccountMeta {
    AccountMeta::new_readonly(key, signer)
}

fn rw(key: Pubkey, signer: bool) -> AccountMeta {
    AccountMeta::new(key, signer)
}

fn token_destination(owner: Pubkey, mint: Pubkey) -> Account {
    token::create_account_for_token_account(TokenAccount {
        mint,
        owner,
        amount: 0,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    })
}

fn denied(error: VaultError) -> Result<(), ProgramError> {
    Err(ProgramError::Custom(error as u32))
}

#[test]
fn a_initialize_simple() {
    let mut f = Fixture::new();
    f.initialize(SIMPLE, vec![], vec![]);
    let state = &f.accounts[&f.state];
    let ata = &f.accounts[&f.ata];
    assert_eq!(state.owner, PROGRAM);
    assert_eq!(ata.owner, token::ID);
    assert_eq!(
        f.accounts[&OWNER].lamports + state.lamports + ata.lamports,
        OWNER_LAMPORTS
    );
    assert_eq!(
        f.vault(),
        VaultState {
            abi: ABI,
            bump: f.bump,
            kind: SIMPLE,
            paused: false,
            version: 0,
            owner: OWNER.to_bytes(),
            agent: AGENT.to_bytes(),
            server: SERVER.to_bytes(),
            mint: MINT.to_bytes(),
            instance_id: INSTANCE,
            created_slot: SLOT,
            source_hash: SOURCE_HASH,
            check_program: [0; 32],
            nonce: 0,
            figures: Figures {
                day: 1,
                ..Figures::default()
            },
            rules: vec![],
            params: vec![],
        }
    );
    let token = TokenAccount::unpack(&ata.data).unwrap();
    assert_eq!(token.owner, f.state);
    assert_eq!(token.mint, MINT);
    assert_eq!(token.amount, 0);
}

#[test]
fn b_execute_simple() {
    let mut f = Fixture::simple();
    let ix = f.execute(2 * USDC, 0, 0, NOW + 1);
    f.run("execute both signatures", &ix, Ok(()));
    assert_eq!(f.balance(DESTINATION), 2 * USDC);
    assert_eq!(f.balance(f.ata), DEPOSIT - 2 * USDC);
    assert_eq!(f.vault().nonce, 1);
}

#[test]
fn c_execute_requires_both_signatures() {
    let mut f = Fixture::simple();
    let mut ix = f.execute(USDC, 0, 0, NOW + 1);
    ix.accounts[2].is_signer = false;
    f.run(
        "execute without server",
        &ix,
        Err(ProgramError::MissingRequiredSignature),
    );
    ix.accounts[2].is_signer = true;
    ix.accounts[1].is_signer = false;
    f.run(
        "execute without agent",
        &ix,
        Err(ProgramError::MissingRequiredSignature),
    );
    assert_eq!(f.vault().nonce, 0);
    assert_eq!(f.balance(DESTINATION), 0);
}

#[test]
fn d_execute_rejects_replay_version_and_expiry() {
    let mut f = Fixture::simple();
    let ix = f.execute(USDC, 0, 0, NOW + 1);
    f.run("execute first nonce", &ix, Ok(()));
    f.run("execute replay", &ix, denied(VaultError::StaleRequest));
    let ix = f.execute(USDC, 1, 1, NOW + 1);
    f.run(
        "execute wrong version",
        &ix,
        denied(VaultError::StaleRequest),
    );
    let ix = f.execute(USDC, 1, 0, NOW);
    f.run("execute expired", &ix, denied(VaultError::Expired));
    assert_eq!(f.vault().nonce, 1);
    assert_eq!(f.balance(DESTINATION), USDC);
}

#[test]
fn e_standard_payment_limit() {
    let mut f = Fixture::funded(STANDARD, vec![0], vec![Param::Amount(i128::from(5 * USDC))]);
    let ix = f.execute(5 * USDC, 0, 0, NOW + 1);
    f.run("standard execute at limit", &ix, Ok(()));
    let ix = f.execute(5 * USDC + 1, 1, 0, NOW + 1);
    f.run(
        "standard execute above limit",
        &ix,
        denied(VaultError::PolicyDenied),
    );
    assert_eq!(f.balance(DESTINATION), 5 * USDC);
    let vault = f.vault();
    assert_eq!(vault.nonce, 1);
    assert_eq!(
        vault.figures,
        Figures {
            calls: 1,
            spent: i128::from(5 * USDC),
            day: 1,
            day_spent: i128::from(5 * USDC),
            day_total: i128::from(5 * USDC),
        }
    );
}

#[test]
fn f_set_pause_requires_next_version() {
    let mut f = Fixture::simple();
    let ix = f.set_pause(true, 1);
    f.run("pause version 1", &ix, Ok(()));
    let ix = f.execute(USDC, 0, 1, NOW + 1);
    f.run("execute paused", &ix, denied(VaultError::Paused));
    let ix = f.set_pause(false, 2);
    f.run("unpause version 2", &ix, Ok(()));
    let ix = f.execute(USDC, 0, 2, NOW + 1);
    f.run("execute after unpause", &ix, Ok(()));
    let ix = f.set_pause(true, 5);
    f.run("pause wrong version", &ix, denied(VaultError::StaleRequest));
    assert_eq!(f.vault().version, 2);
    assert!(!f.vault().paused);
    assert_eq!(f.vault().nonce, 1);
    assert_eq!(f.balance(DESTINATION), USDC);
}

#[test]
fn g_close_returns_tokens_and_all_lamports() {
    let mut f = Fixture::simple();
    // A wallet closes from the slot after its creation.
    f.svm.sysvars.clock.slot = SLOT + 1;
    let ix = f.close(1);
    f.run("close", &ix, Ok(()));
    assert_eq!(f.balance(OWNER_DESTINATION), DEPOSIT);
    assert_eq!(f.accounts[&OWNER].lamports, OWNER_LAMPORTS);
    for key in [f.state, f.ata] {
        let closed = &f.accounts[&key];
        assert_eq!(closed.lamports, 0);
        assert!(closed.data.is_empty());
        assert_eq!(closed.owner, system_program::ID);
    }
}
