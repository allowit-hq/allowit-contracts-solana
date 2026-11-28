//! The built test vault program in LiteSVM, with the SPL Token and Associated Token programs:
//! initialize, deposit, redeem, the admin's price and the read-only answers. Build the program
//! first (`cargo build-sbf`); the test reads it from `SBF_OUT_DIR`, else from the `deploy` folder
//! of `CARGO_TARGET_DIR`, else from `../target/deploy`.
use allowit_test_vault::{
    asset_account_address, share_mint_address, vault_address, VaultError, VaultInstruction,
    VaultState, SHARE,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use litesvm::{types::TransactionMetadata, LiteSVM};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use solana_sdk_ids::system_program;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_associated_token_account_interface::{
    address::get_associated_token_address, instruction::create_associated_token_account_idempotent,
    program as ata_program,
};
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};
use std::path::PathBuf;

const PROGRAM: Pubkey = Pubkey::new_from_array([10; 32]);
/// Circle's USDC mint on Solana Devnet.
const USDC: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NAME: &[u8] = b"devnet-usdc";
/// The state account that the run writes, which the rail's price read is tested against.
const FIXTURE: &str = "../../../crates/allowit-solana/tests/fixtures/test_vault_state.json";

fn program_file() -> PathBuf {
    let dir = std::env::var_os("SBF_OUT_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CARGO_TARGET_DIR").map(|t| PathBuf::from(t).join("deploy")))
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/deploy"));
    let file = dir.join("allowit_test_vault.so");
    assert!(
        file.exists(),
        "{} is missing: run cargo build-sbf",
        file.display()
    );
    file
}

struct Fixture {
    svm: LiteSVM,
    admin: Keypair,
    user: Keypair,
    mint: Pubkey,
    state: Pubkey,
    shares: Pubkey,
    vault_assets: Pubkey,
    user_assets: Pubkey,
    user_shares: Pubkey,
}

fn name() -> [u8; 32] {
    let mut name = [0; 32];
    name[..NAME.len()].copy_from_slice(NAME);
    name
}

fn send(
    svm: &mut LiteSVM,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> Result<TransactionMetadata, String> {
    let message = Message::new_with_blockhash(
        instructions,
        Some(&signers[0].pubkey()),
        &svm.latest_blockhash(),
    );
    let bytes = message.serialize();
    let tx = Transaction {
        signatures: signers.iter().map(|s| s.sign_message(&bytes)).collect(),
        message,
    };
    let result = svm.send_transaction(tx).map_err(|e| format!("{:?}", e.err));
    svm.expire_blockhash();
    result
}

fn custom(error: VaultError) -> String {
    format!("Custom({})", error as u32)
}

fn amount(svm: &LiteSVM, at: &Pubkey) -> u64 {
    TokenAccount::unpack(&svm.get_account(at).unwrap().data)
        .unwrap()
        .amount
}

fn returned(meta: &TransactionMetadata) -> u64 {
    assert_eq!(meta.return_data.program_id, PROGRAM);
    u64::from_le_bytes(meta.return_data.data.as_slice().try_into().unwrap())
}

impl Fixture {
    /// A vault at one asset a share, and a user with 100 USDC.
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM, program_file()).unwrap();
        let admin = Keypair::new_from_array([7; 32]);
        let user = Keypair::new_from_array([8; 32]);
        for key in [&admin, &user] {
            svm.airdrop(&key.pubkey(), 10_000_000_000).unwrap();
        }
        let mint: Pubkey = USDC.parse().unwrap();
        let mut data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                mint_authority: Some(admin.pubkey()).into(),
                supply: 1_000_000_000,
                decimals: 6,
                is_initialized: true,
                freeze_authority: None.into(),
            },
            &mut data,
        )
        .unwrap();
        svm.set_account(
            mint,
            Account {
                lamports: svm.minimum_balance_for_rent_exemption(Mint::LEN),
                data,
                owner: spl_token_interface::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let user_assets = get_associated_token_address(&user.pubkey(), &mint);
        let mut data = vec![0; TokenAccount::LEN];
        TokenAccount::pack(
            TokenAccount {
                mint,
                owner: user.pubkey(),
                amount: 100_000_000,
                state: AccountState::Initialized,
                ..TokenAccount::default()
            },
            &mut data,
        )
        .unwrap();
        svm.set_account(
            user_assets,
            Account {
                lamports: svm.minimum_balance_for_rent_exemption(TokenAccount::LEN),
                data,
                owner: spl_token_interface::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let (state, _) = vault_address(&PROGRAM, &admin.pubkey(), &name());
        let (shares, _) = share_mint_address(&PROGRAM, &state);
        let mut fixture = Self {
            vault_assets: asset_account_address(&state, &mint),
            user_shares: get_associated_token_address(&user.pubkey(), &shares),
            svm,
            admin,
            user,
            mint,
            state,
            shares,
            user_assets,
        };
        fixture.initialize(SHARE).unwrap();
        let create = create_associated_token_account_idempotent(
            &fixture.user.pubkey(),
            &fixture.user.pubkey(),
            &shares,
            &spl_token_interface::ID,
        );
        let user = fixture.user.insecure_clone();
        send(&mut fixture.svm, &[create], &[&user]).unwrap();
        fixture
    }

    fn initialize(&mut self, share_price: u64) -> Result<TransactionMetadata, String> {
        let instruction = Instruction::new_with_bytes(
            PROGRAM,
            &VaultInstruction::Initialize {
                name: name(),
                share_price,
            }
            .pack(),
            vec![
                AccountMeta::new(self.state, false),
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(self.shares, false),
                AccountMeta::new(self.vault_assets, false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(spl_token_interface::ID, false),
                AccountMeta::new_readonly(ata_program::ID, false),
            ],
        );
        let admin = self.admin.insecure_clone();
        send(&mut self.svm, &[instruction], &[&admin])
    }

    fn set_price(
        &mut self,
        signer: &Keypair,
        share_price: u64,
    ) -> Result<TransactionMetadata, String> {
        let instruction = Instruction::new_with_bytes(
            PROGRAM,
            &VaultInstruction::SetSharePrice { share_price }.pack(),
            vec![
                AccountMeta::new(self.state, false),
                AccountMeta::new_readonly(signer.pubkey(), true),
            ],
        );
        send(&mut self.svm, &[instruction], &[signer])
    }

    /// A deposit or a redeem of the user, from `source` to `receiver`.
    fn movement(
        &mut self,
        instruction: VaultInstruction,
        source: Pubkey,
        receiver: Pubkey,
    ) -> Result<TransactionMetadata, String> {
        let instruction = Instruction::new_with_bytes(
            PROGRAM,
            &instruction.pack(),
            vec![
                AccountMeta::new_readonly(self.state, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(self.shares, false),
                AccountMeta::new(self.vault_assets, false),
                AccountMeta::new(source, false),
                AccountMeta::new_readonly(self.user.pubkey(), true),
                AccountMeta::new(receiver, false),
                AccountMeta::new_readonly(spl_token_interface::ID, false),
            ],
        );
        let user = self.user.insecure_clone();
        send(&mut self.svm, &[instruction], &[&user])
    }

    fn deposit(&mut self, assets: u64) -> Result<TransactionMetadata, String> {
        let (source, receiver) = (self.user_assets, self.user_shares);
        self.movement(VaultInstruction::Deposit { assets }, source, receiver)
    }

    fn redeem(&mut self, shares: u64) -> Result<TransactionMetadata, String> {
        let (source, receiver) = (self.user_shares, self.user_assets);
        self.movement(VaultInstruction::Redeem { shares }, source, receiver)
    }

    fn read(&mut self, instruction: VaultInstruction) -> Result<u64, String> {
        let instruction = Instruction::new_with_bytes(
            PROGRAM,
            &instruction.pack(),
            vec![AccountMeta::new_readonly(self.state, false)],
        );
        let user = self.user.insecure_clone();
        send(&mut self.svm, &[instruction], &[&user]).map(|meta| returned(&meta))
    }

    fn state(&self) -> VaultState {
        VaultState::from_bytes(&self.svm.get_account(&self.state).unwrap().data).unwrap()
    }
}

#[test]
fn a_deposit_and_a_redeem_move_exactly_what_the_previews_name() {
    let mut f = Fixture::new();
    let state = f.state();
    assert_eq!(state.share_price, SHARE);
    assert_eq!(state.asset_mint, f.mint.to_bytes());
    assert_eq!(state.share_mint, f.shares.to_bytes());
    let mint = Mint::unpack(&f.svm.get_account(&f.shares).unwrap().data).unwrap();
    assert_eq!(mint.mint_authority, Some(f.state).into());
    assert_eq!((mint.decimals, mint.supply), (6, 0));
    assert!(mint.freeze_authority.is_none());

    // 10 USDC at one USDC a share.
    assert_eq!(
        f.read(VaultInstruction::PreviewDeposit { assets: 10_000_000 }),
        Ok(10_000_000)
    );
    let deposit = f.deposit(10_000_000).unwrap();
    assert_eq!(returned(&deposit), 10_000_000);
    assert_eq!(amount(&f.svm, &f.user_assets), 90_000_000);
    assert_eq!(amount(&f.svm, &f.vault_assets), 10_000_000);
    assert_eq!(amount(&f.svm, &f.user_shares), 10_000_000);

    // The admin lowers the price to 0.94 USDC a share.
    let admin = f.admin.insecure_clone();
    f.set_price(&admin, 940_000).unwrap();
    assert_eq!(f.read(VaultInstruction::SharePrice), Ok(940_000));
    assert_eq!(
        f.read(VaultInstruction::PreviewDeposit { assets: 1_000_000 }),
        Ok(1_063_829)
    );
    assert_eq!(
        f.read(VaultInstruction::PreviewRedeem { shares: 4_000_000 }),
        Ok(3_760_000)
    );

    let redeem = f.redeem(4_000_000).unwrap();
    assert_eq!(returned(&redeem), 3_760_000);
    assert_eq!(amount(&f.svm, &f.user_shares), 6_000_000);
    assert_eq!(amount(&f.svm, &f.user_assets), 93_760_000);
    assert_eq!(amount(&f.svm, &f.vault_assets), 6_240_000);
    let supply = Mint::unpack(&f.svm.get_account(&f.shares).unwrap().data)
        .unwrap()
        .supply;
    assert_eq!(supply, 6_000_000);

    println!(
        "compute units: deposit {}, redeem {}",
        deposit.compute_units_consumed, redeem.compute_units_consumed
    );

    // The state that the rail's price read is tested against.
    let account = f.svm.get_account(&f.state).unwrap();
    let recorded = serde_json::json!({
        "address": f.state.to_string(),
        "owner": account.owner.to_string(),
        "data": STANDARD.encode(&account.data),
    });
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    let text = serde_json::to_string_pretty(&recorded).unwrap() + "\n";
    if std::env::var_os("RECORD_FIXTURE").is_some() {
        std::fs::write(&path, &text).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(&path)
            .unwrap()
            .replace("\r\n", "\n"),
        text,
        "the recorded state differs; RECORD_FIXTURE=1 writes it again"
    );
}

#[test]
fn the_vault_refuses_what_it_cannot_honor() {
    let mut f = Fixture::new();
    f.deposit(10_000_000).unwrap();

    // Only the admin sets a price, and never zero.
    let user = f.user.insecure_clone();
    let admin = f.admin.insecure_clone();
    assert!(f
        .set_price(&user, 1)
        .unwrap_err()
        .contains(&custom(VaultError::InvalidAdmin)));
    assert!(f
        .set_price(&admin, 0)
        .unwrap_err()
        .contains(&custom(VaultError::NotPositive)));

    // A raised price that the vault cannot pay: the redeem fails and moves nothing.
    f.set_price(&admin, 2 * SHARE).unwrap();
    let error = f.redeem(10_000_000).unwrap_err();
    assert!(
        error.contains(&custom(VaultError::InsufficientAssets)),
        "{error}"
    );
    assert_eq!(amount(&f.svm, &f.user_shares), 10_000_000);
    // More shares than the source holds.
    let error = f.redeem(10_000_001).unwrap_err();
    assert!(
        error.contains(&custom(VaultError::InsufficientShares)),
        "{error}"
    );
    // Zero, and an amount that converts to nothing.
    let error = f.deposit(0).unwrap_err();
    assert!(error.contains(&custom(VaultError::NotPositive)), "{error}");
    let error = f.deposit(1).unwrap_err();
    assert!(error.contains(&custom(VaultError::ZeroResult)), "{error}");

    // A receiver of another mint: the token program refuses the mint of shares to it.
    let (source, receiver) = (f.user_assets, f.user_assets);
    assert!(f
        .movement(
            VaultInstruction::Deposit { assets: 1_000_000 },
            source,
            receiver
        )
        .is_err());
    // The vault's own account is no source of a deposit.
    let (source, receiver) = (f.vault_assets, f.user_shares);
    let error = f
        .movement(
            VaultInstruction::Deposit { assets: 1_000_000 },
            source,
            receiver,
        )
        .unwrap_err();
    assert!(
        error.contains(&custom(VaultError::InvalidInvocation)),
        "{error}"
    );
    // A second initialize of the same vault.
    let error = f.initialize(SHARE).unwrap_err();
    assert!(error.contains(&custom(VaultError::InvalidVault)), "{error}");
    assert_eq!(amount(&f.svm, &f.vault_assets), 10_000_000);
}
