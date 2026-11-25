//! The fixture of the ledger tests: LiteSVM behind the runtime's `Chain`, a wallet that its
//! owner set up, and the wallet's public profile.
#![allow(dead_code, unused_imports)]
pub use allowit_core::vendor::{
    KeyProvider, RuntimeProvider,
    config::ServerAuthority,
    error::{Error, Result},
    runtime::{
        Accounting, Action, Installation, OperationOutcome, OwnerAction, Signer, Status, Terms,
        Validity,
    },
};
pub use allowit_solana::{
    DEVNET, KEYS, KeySigner, USDC_DEVNET,
    config::{Route, WalletConfig, source_hash},
    native::{Address, TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM, Wallet},
    owner::{self, Journal, Ledger, Observation, Recent, Request, Retained},
    payment::{Finalized, Receipts, TokenBalance},
    runtime::{Bank, Bundle, Chain, Consent, Runtime, consent_message, consent_payload},
};
pub use base64::{Engine as _, engine::general_purpose::STANDARD};
pub use litesvm::LiteSVM;
pub use solana_account::Account;
pub use solana_instruction::{AccountMeta, Instruction};
pub use solana_message::Message;
pub use solana_signature::Signature;
pub use solana_transaction::Transaction;
pub use std::collections::BTreeMap;
pub use std::sync::{Arc, Mutex};

pub const DECIMALS: u8 = 6;
pub const TOKEN: u64 = 1_000_000;
pub const NOW: u64 = 1_800_000_000;

pub fn signer(seed: u8) -> KeySigner {
    KeySigner(KEYS.derive(&[seed; 32]).unwrap())
}
pub fn address(signer: &KeySigner) -> Address {
    signer.identity().parse().unwrap()
}

#[derive(Default)]
pub struct Book(pub Mutex<BTreeMap<String, Retained>>);
impl Journal for Book {
    fn load(&self, id: &str) -> Result<Option<Retained>> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    fn save(&self, id: &str, retained: &Retained) -> Result<()> {
        self.0.lock().unwrap().insert(id.into(), retained.clone());
        Ok(())
    }
}

pub fn amount_of(svm: &LiteSVM, at: &Address) -> Option<(Address, u64)> {
    let account = svm.get_account(at)?;
    if account.owner != TOKEN_PROGRAM || account.data.len() != TOKEN_ACCOUNT_LEN as usize {
        return None;
    }
    Some((
        Address::new_from_array(account.data[0..32].try_into().unwrap()),
        u64::from_le_bytes(account.data[64..72].try_into().unwrap()),
    ))
}

pub struct State {
    pub svm: LiteSVM,
    pub height: u64,
    pub lose: bool,
    pub submissions: usize,
    pub finalized: BTreeMap<[u8; 64], Finalized>,
    /// Each account's finalized transactions, in the order the ledger took them.
    pub named: BTreeMap<Address, Vec<[u8; 64]>>,
}
pub struct Svm(pub Mutex<State>);
impl Ledger for Svm {
    fn account(&self, at: &Address) -> Result<Option<owner::Account>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .svm
            .get_account(at)
            .filter(|a| a.lamports > 0)
            .map(|a| owner::Account {
                lamports: a.lamports,
                owner: a.owner,
                data: a.data,
            }))
    }
    fn deposit(&self, len: u64) -> Result<u64> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .svm
            .minimum_balance_for_rent_exemption(len as usize))
    }
    fn recent(&self) -> Result<Recent> {
        let state = self.0.lock().unwrap();
        Ok(Recent {
            blockhash: state.svm.latest_blockhash(),
            last_valid_height: state.height + 150,
        })
    }
    fn submit(&self, wire: &[u8]) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        state.submissions += 1;
        if state.lose {
            return Err(Error::usage("lost"));
        }
        let tx =
            wincode::deserialize::<Transaction>(wire).map_err(|_| Error::usage("undecodable"))?;
        let id: [u8; 64] = tx.signatures[0].into();
        let keys = tx.message.account_keys.clone();
        let before: Vec<_> = keys.iter().map(|key| amount_of(&state.svm, key)).collect();
        let result = state.svm.send_transaction(tx);
        if state.svm.get_transaction(&Signature::from(id)).is_none() {
            return Err(Error::usage("refused"));
        }
        let (failed, fee) = match &result {
            Ok(meta) => (false, meta.fee),
            Err(failure) => (true, failure.meta.fee),
        };
        let balances = keys
            .iter()
            .enumerate()
            .filter_map(|(index, key)| {
                let (mint, after) = amount_of(&state.svm, key)?;
                Some(TokenBalance {
                    index,
                    mint,
                    before: before[index].map_or(0, |(_, amount)| amount),
                    after,
                })
            })
            .collect();
        for key in &keys {
            state.named.entry(*key).or_default().push(id);
        }
        state.finalized.insert(
            id,
            Finalized {
                wire: wire.to_vec(),
                failed,
                fee,
                slot: 42,
                block_time: Some(NOW + 5),
                balances,
            },
        );
        Ok(())
    }
    fn observe(&self, signature: &[u8; 64]) -> Result<Observation> {
        let state = self.0.lock().unwrap();
        Ok(Observation {
            status: match state.finalized.get(signature) {
                None => owner::Status::Unknown,
                Some(finalized) => owner::Status::Finalized {
                    failed: finalized.failed,
                },
            },
            finalized_height: state.height,
        })
    }
}
impl Receipts for Svm {
    fn transaction(&self, signature: &[u8; 64]) -> Result<Option<Finalized>> {
        Ok(self.0.lock().unwrap().finalized.get(signature).cloned())
    }
}
impl Chain for Svm {
    fn bank(&self) -> Result<Bank> {
        Ok(Bank {
            height: self.0.lock().unwrap().height,
            time: Some(NOW),
        })
    }
    fn history(&self, address: &Address, _: u64) -> Result<Vec<[u8; 64]>> {
        let state = self.0.lock().unwrap();
        Ok(state
            .named
            .get(address)
            .map(|ids| ids.iter().rev().copied().collect())
            .unwrap_or_default())
    }
}

pub struct Fixture {
    pub chain: Arc<Svm>,
    pub runtime: Runtime,
    pub owner: KeySigner,
    pub agent: KeySigner,
    pub server: KeySigner,
    pub wallet: Wallet,
    pub config: WalletConfig,
    pub authority: ServerAuthority,
    pub payee: Address,
}

/// A Devnet USDC wallet that its owner set up with `allowance` and that holds `balance`.
pub fn fixture(allowance: u64, balance: u64) -> Fixture {
    let mut svm = LiteSVM::new();
    let (owner, agent, server) = (signer(1), signer(2), signer(3));
    for s in [&owner, &server] {
        svm.airdrop(&address(s), 10_000_000_000).unwrap();
    }
    let mint: Address = USDC_DEVNET.parse().unwrap();
    let token_program_account = |data: Vec<u8>, svm: &LiteSVM| Account {
        lamports: svm.minimum_balance_for_rent_exemption(data.len()),
        data,
        owner: TOKEN_PROGRAM,
        executable: false,
        rent_epoch: 0,
    };
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(address(&owner).as_ref());
    data[44] = DECIMALS;
    data[45] = 1;
    let account = token_program_account(data, &svm);
    svm.set_account(mint, account).unwrap();
    let payee = Address::new_from_array([8; 32]);
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(&[7; 32]);
    data[108] = 1;
    let account = token_program_account(data, &svm);
    svm.set_account(payee, account).unwrap();
    let wallet = Wallet {
        owner: address(&owner),
        mint,
        agent: address(&agent),
        server: address(&server),
    };
    let chain = Arc::new(Svm(Mutex::new(State {
        svm,
        height: 1_000,
        lose: false,
        submissions: 0,
        finalized: BTreeMap::new(),
        named: BTreeMap::new(),
    })));
    let setup = Request::Setup {
        allowance,
        decimals: DECIMALS,
    };
    owner::send(&*chain, &Book::default(), &owner, &wallet, "setup", &setup).unwrap();
    // Fixture: the mint authority mints the balance, in a test-built transaction.
    {
        let mut state = chain.0.lock().unwrap();
        let mut data = vec![7u8];
        data.extend_from_slice(&balance.to_le_bytes());
        let ix = Instruction::new_with_bytes(
            TOKEN_PROGRAM,
            &data,
            vec![
                AccountMeta::new(mint, false),
                AccountMeta::new(wallet.token_account(), false),
                AccountMeta::new_readonly(address(&owner), true),
            ],
        );
        let message = Message::new_with_blockhash(
            &[ix],
            Some(&address(&owner)),
            &state.svm.latest_blockhash(),
        );
        let signature: [u8; 64] = owner
            .sign_bytes(&message.serialize())
            .unwrap()
            .try_into()
            .unwrap();
        state
            .svm
            .send_transaction(Transaction {
                signatures: vec![Signature::from(signature)],
                message,
            })
            .unwrap();
        state.submissions = 0;
    }
    let source = "pub async fn evaluate(ctx:&Context)->PolicyResult{Ok(())}";
    let config = WalletConfig {
        network: DEVNET.into(),
        policy_instance: [5; 32],
        wallet: wallet.token_account().to_string(),
        owner: wallet.owner.to_string(),
        agent: wallet.agent.to_string(),
        server: wallet.server.to_string(),
        route: Route::Native,
        mint: USDC_DEVNET.into(),
        asset_symbol: "USDC".into(),
        decimals: DECIMALS,
        policy_source: source.into(),
        source_hash: source_hash(source),
        module_digest: [0; 32],
        params: BTreeMap::new(),
        max_fee_lamports: 20_000,
    };
    let authority =
        ServerAuthority::validated(DEVNET, "https://allowit.example", &config.server).unwrap();
    Fixture {
        runtime: Runtime::new(DEVNET, chain.clone()).unwrap(),
        chain,
        owner,
        agent,
        server,
        wallet,
        config,
        authority,
        payee,
    }
}

impl Fixture {
    pub fn bundle(&self, consenting: &KeySigner) -> Vec<u8> {
        let payload = consent_payload(
            &self.config,
            "policy-1",
            1,
            "ir",
            "portable",
            &[],
            &serde_json::json!({}),
            "params",
        );
        let signature = consenting
            .sign_bytes(consent_message(&payload).unwrap().as_bytes())
            .unwrap();
        serde_json::to_vec(&Bundle {
            version: 1,
            policy_id: "policy-1".into(),
            config: self.config.clone(),
            consent: Consent {
                payload,
                signature: bs58::encode(signature).into_string(),
            },
        })
        .unwrap()
    }
    pub fn installed(&self) -> Installation {
        self.runtime
            .import(&self.authority, &self.bundle(&self.owner))
            .unwrap()
    }
    pub fn transfer(&self, units: u64) -> Action {
        Action::Transfer {
            recipient: self.payee.to_string(),
            units: i128::from(units),
        }
    }
    pub fn balance(&self, at: &Address) -> u64 {
        amount_of(&self.chain.0.lock().unwrap().svm, at).unwrap().1
    }
    pub fn validity(&self) -> Validity {
        Validity {
            now: NOW,
            expires_at: NOW + 600,
        }
    }
}
