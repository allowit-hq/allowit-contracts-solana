//! A server-paid payment from a Native wallet on a ledger: LiteSVM runs the SPL Token, System,
//! Compute Budget and Memo programs in process. The ledger here finalizes at once; the test moves
//! its block height, loses its submissions and reads token balances around each transaction.
use allowit_core::vendor::{
    KeyProvider,
    error::{Error, Result},
    runtime::Signer,
};
use allowit_solana::{
    KEYS, KeySigner,
    native::{Address, Budget, TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM, Wallet},
    owner::{self, Journal, Ledger, Observation, Recent, Request, Retained, Status},
    payment::{self, Finalized, Outcome, Payment, Receipts, TokenBalance},
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;
use solana_signature::Signature;
use solana_transaction::Transaction;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

const DECIMALS: u8 = 6;
const TOKEN: u64 = 1_000_000;

fn signer(seed: u8) -> KeySigner {
    KeySigner(KEYS.derive(&[seed; 32]).unwrap())
}
fn address(signer: &KeySigner) -> Address {
    signer.identity().parse().unwrap()
}

#[derive(Default)]
struct Book(RefCell<BTreeMap<String, Retained>>);
impl Journal for Book {
    fn load(&self, id: &str) -> Result<Option<Retained>> {
        Ok(self.0.borrow().get(id).cloned())
    }
    fn save(&self, id: &str, retained: &Retained) -> Result<()> {
        self.0.borrow_mut().insert(id.into(), retained.clone());
        Ok(())
    }
}

fn amount_of(svm: &LiteSVM, at: &Address) -> Option<(Address, u64)> {
    let account = svm.get_account(at)?;
    if account.owner != TOKEN_PROGRAM || account.data.len() != TOKEN_ACCOUNT_LEN as usize {
        return None;
    }
    Some((
        Address::new_from_array(account.data[0..32].try_into().unwrap()),
        u64::from_le_bytes(account.data[64..72].try_into().unwrap()),
    ))
}

struct Svm {
    svm: RefCell<LiteSVM>,
    height: Cell<u64>,
    lose: Cell<bool>,
    submissions: Cell<usize>,
    finalized: RefCell<BTreeMap<[u8; 64], Finalized>>,
}
impl Ledger for Svm {
    fn account(&self, at: &Address) -> Result<Option<owner::Account>> {
        Ok(self.svm.borrow().get_account(at).map(|a| owner::Account {
            lamports: a.lamports,
            owner: a.owner,
            data: a.data,
        }))
    }
    fn deposit(&self, len: u64) -> Result<u64> {
        Ok(self
            .svm
            .borrow()
            .minimum_balance_for_rent_exemption(len as usize))
    }
    fn recent(&self) -> Result<Recent> {
        Ok(Recent {
            blockhash: self.svm.borrow().latest_blockhash(),
            last_valid_height: self.height.get() + 150,
        })
    }
    fn submit(&self, wire: &[u8]) -> Result<()> {
        self.submissions.set(self.submissions.get() + 1);
        if self.lose.get() {
            return Err(Error::usage("lost"));
        }
        let tx =
            wincode::deserialize::<Transaction>(wire).map_err(|_| Error::usage("undecodable"))?;
        let id: [u8; 64] = tx.signatures[0].into();
        let keys = tx.message.account_keys.clone();
        let mut svm = self.svm.borrow_mut();
        let before: Vec<_> = keys.iter().map(|key| amount_of(&svm, key)).collect();
        let result = svm.send_transaction(tx);
        // A transaction that never ran (a bad signature, an expired blockhash) leaves no record.
        if svm.get_transaction(&Signature::from(id)).is_none() {
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
                let (mint, after) = amount_of(&svm, key)?;
                Some(TokenBalance {
                    index,
                    mint,
                    before: before[index].map_or(0, |(_, amount)| amount),
                    after,
                })
            })
            .collect();
        self.finalized.borrow_mut().insert(
            id,
            Finalized {
                wire: wire.to_vec(),
                failed,
                fee,
                slot: 42,
                block_time: Some(1_800_000_000),
                balances,
            },
        );
        Ok(())
    }
    fn observe(&self, signature: &[u8; 64]) -> Result<Observation> {
        let status = match self.finalized.borrow().get(signature) {
            None => Status::Unknown,
            Some(finalized) => Status::Finalized {
                failed: finalized.failed,
            },
        };
        Ok(Observation {
            status,
            finalized_height: self.height.get(),
        })
    }
}
impl Receipts for Svm {
    fn transaction(&self, signature: &[u8; 64]) -> Result<Option<Finalized>> {
        Ok(self.finalized.borrow().get(signature).cloned())
    }
}

struct Fixture {
    ledger: Svm,
    book: Book,
    agent: KeySigner,
    server: KeySigner,
    wallet: Wallet,
    payee: Address,
}
/// A wallet that its owner set up with `allowance` and that holds `balance`.
fn fixture(allowance: u64, balance: u64) -> Fixture {
    let mut svm = LiteSVM::new();
    let (owner, agent, server) = (signer(1), signer(2), signer(3));
    for s in [&owner, &server] {
        svm.airdrop(&address(s), 10_000_000_000).unwrap();
    }
    let mint = Address::new_from_array([9; 32]);
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
    let f = Fixture {
        ledger: Svm {
            svm: RefCell::new(svm),
            height: Cell::new(1_000),
            lose: Cell::new(false),
            submissions: Cell::new(0),
            finalized: RefCell::default(),
        },
        book: Book::default(),
        agent,
        server,
        wallet,
        payee,
    };
    let setup = Request::Setup {
        allowance,
        decimals: DECIMALS,
    };
    owner::send(&f.ledger, &f.book, &owner, &f.wallet, "setup", &setup).unwrap();
    // Fixture: the mint authority mints the balance, in a test-built transaction.
    let mut data = vec![7u8];
    data.extend_from_slice(&balance.to_le_bytes());
    let ix = Instruction::new_with_bytes(
        TOKEN_PROGRAM,
        &data,
        vec![
            AccountMeta::new(mint, false),
            AccountMeta::new(f.wallet.token_account(), false),
            AccountMeta::new_readonly(address(&owner), true),
        ],
    );
    let mut svm = f.ledger.svm.borrow_mut();
    let message =
        Message::new_with_blockhash(&[ix], Some(&address(&owner)), &svm.latest_blockhash());
    let signature: [u8; 64] = owner
        .sign_bytes(&message.serialize())
        .unwrap()
        .try_into()
        .unwrap();
    svm.send_transaction(Transaction {
        signatures: vec![Signature::from(signature)],
        message,
    })
    .unwrap();
    drop(svm);
    f.ledger.submissions.set(0);
    f
}
impl Fixture {
    fn pay(&self, amount: u64) -> Payment<'static> {
        Payment {
            destination: self.payee,
            amount,
            decimals: DECIMALS,
            memo: Some("report 7"),
            budget: Budget::PAYMENT,
        }
    }
    fn authorize(&self, id: &str, payment: &Payment<'_>) -> Vec<u8> {
        payment::authorize(
            &self.ledger,
            &self.book,
            &self.server,
            &self.wallet,
            id,
            payment,
        )
        .unwrap()
    }
    fn countersign(&self, id: &str, wire: &[u8], payment: &Payment<'_>) -> Result<Vec<u8>> {
        payment::countersign(wire, &self.agent, &self.wallet, id, payment)
    }
    fn submit(&self, id: &str, wire: &[u8]) -> Result<Outcome> {
        payment::submit(&self.ledger, &self.book, &self.wallet, id, wire)
    }
    fn status(&self, id: &str) -> Outcome {
        payment::status(&self.ledger, &self.book, id).unwrap()
    }
    fn balance(&self, at: &Address) -> u64 {
        amount_of(&self.ledger.svm.borrow(), at).unwrap().1
    }
}

#[test]
fn a_payment_needs_both_signatures_on_the_same_bytes_and_its_receipt_is_what_moved() {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let payment = f.pay(2 * TOKEN);
    let authorized = f.authorize("p1", &payment);
    let Outcome::Unsigned { signature } = f.status("p1") else {
        panic!("the agent has not signed yet");
    };
    // The server's signature alone moves nothing.
    assert!(f.ledger.submit(&authorized).is_err());
    assert!(f.submit("p1", &authorized).is_err());
    assert_eq!(f.ledger.submissions.get(), 1);

    let complete = f.countersign("p1", &authorized, &payment).unwrap();
    assert_eq!(
        f.submit("p1", &complete).unwrap(),
        Outcome::Pending { signature }
    );
    assert_eq!(f.status("p1"), Outcome::Settled { signature });
    assert_eq!(f.balance(&f.payee), 2 * TOKEN);
    assert_eq!(f.balance(&f.wallet.token_account()), 8 * TOKEN);

    let receipt = payment::receipt(&f.ledger, &f.book, &f.wallet, &payment, "p1")
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            receipt.debit,
            receipt.credit,
            receipt.failed,
            receipt.signature
        ),
        (2 * TOKEN, 2 * TOKEN, false, signature)
    );
    // Two signatures at 5,000 lamports and the payment's priority fee, paid by the server.
    assert_eq!(receipt.fee, 10_001);
    assert_eq!(receipt.block_time, Some(1_800_000_000));

    // A limit below what the transfer and the memo take is refused before anything is signed.
    let starved = Payment {
        budget: Budget {
            units: payment::min_units("allowit:p9\nreport 7".len()) - 1,
            micro_lamports_per_unit: 1,
        },
        ..payment
    };
    assert!(payment::authorize(&f.ledger, &f.book, &f.server, &f.wallet, "p9", &starved).is_err());
    assert!(f.book.load("p9").unwrap().is_none());

    // The id is spent: a repeat authorizes nothing new and sends nothing.
    let sent = f.ledger.submissions.get();
    assert_eq!(f.authorize("p1", &payment), complete);
    assert_eq!(
        f.submit("p1", &complete).unwrap(),
        Outcome::Settled { signature }
    );
    assert_eq!(f.ledger.submissions.get(), sent);
    assert_eq!(f.balance(&f.payee), 2 * TOKEN);
    assert!(
        payment::authorize(
            &f.ledger,
            &f.book,
            &f.server,
            &f.wallet,
            "p1",
            &f.pay(3 * TOKEN)
        )
        .is_err()
    );
}

#[test]
fn the_agent_signs_only_its_own_request_from_its_own_server() {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let payment = f.pay(2 * TOKEN);
    let authorized = f.authorize("p1", &payment);
    // The server built another amount, memo or destination than the agent asked for.
    for other in [
        f.pay(2 * TOKEN + 1),
        Payment {
            memo: Some("report 8"),
            ..payment
        },
        Payment {
            memo: None,
            ..payment
        },
        Payment {
            destination: Address::new_from_array([6; 32]),
            ..payment
        },
    ] {
        assert!(f.countersign("p1", &authorized, &other).is_err());
    }
    // The bytes of one request id are not signed as another's.
    assert!(f.countersign("p2", &authorized, &payment).is_err());
    assert!(f.countersign("p 1", &authorized, &payment).is_err());
    // A signature of another key in the server's place, and a tampered message.
    let mut forged = authorized.clone();
    forged[1] ^= 1;
    assert!(f.countersign("p1", &forged, &payment).is_err());
    let mut tampered = authorized.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    assert!(f.countersign("p1", &tampered, &payment).is_err());
    // Another key is not the wallet's agent, and a complete payment is not signed twice.
    assert!(payment::countersign(&authorized, &signer(4), &f.wallet, "p1", &payment).is_err());
    let complete = f.countersign("p1", &authorized, &payment).unwrap();
    assert!(f.countersign("p1", &complete, &payment).is_err());
    // The server accepts only the agent's signature on the bytes that it retained.
    let mut wrong = complete.clone();
    wrong[65] ^= 1;
    assert!(f.submit("p1", &wrong).is_err());
    assert!(f.submit("p2", &complete).is_err());
    assert_eq!(f.ledger.submissions.get(), 0);
    assert_eq!(f.balance(&f.payee), 0);
}

#[test]
fn a_lost_payment_goes_again_as_the_same_bytes_and_a_lapsed_one_ends() {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let payment = f.pay(TOKEN);
    let complete = f
        .countersign("lost", &f.authorize("lost", &payment), &payment)
        .unwrap();
    f.ledger.lose.set(true);
    let Outcome::Pending { signature } = f.submit("lost", &complete).unwrap() else {
        panic!("a lost payment is pending");
    };
    assert_eq!(f.balance(&f.payee), 0);
    assert_eq!(
        payment::receipt(&f.ledger, &f.book, &f.wallet, &payment, "lost").unwrap(),
        None
    );
    f.ledger.lose.set(false);
    assert_eq!(f.status("lost"), Outcome::Pending { signature });
    assert_eq!(f.status("lost"), Outcome::Settled { signature });
    assert_eq!(f.balance(&f.payee), TOKEN);

    // A second payment is lost until its blockhash expires: it lapses and never runs.
    let complete = f
        .countersign("late", &f.authorize("late", &payment), &payment)
        .unwrap();
    f.ledger.lose.set(true);
    let Outcome::Pending { signature } = f.submit("late", &complete).unwrap() else {
        panic!("a lost payment is pending");
    };
    f.ledger.lose.set(false);
    f.ledger.svm.borrow_mut().expire_blockhash();
    f.ledger.height.set(1_150);
    // At the last valid height the bytes go once more; the ledger refuses the expired blockhash.
    assert_eq!(f.status("late"), Outcome::Pending { signature });
    f.ledger.height.set(1_151);
    let sent = f.ledger.submissions.get();
    assert_eq!(f.status("late"), Outcome::Lapsed { signature });
    assert_eq!(f.ledger.submissions.get(), sent);
    assert_eq!(f.balance(&f.payee), TOKEN);
    // The id keeps its lapsed bytes: a new payment is a new request.
    assert_eq!(f.authorize("late", &payment), complete);
}

#[test]
fn a_payment_above_the_allowance_fails_on_the_ledger_and_moves_nothing() {
    let f = fixture(TOKEN, 10 * TOKEN);
    let payment = f.pay(TOKEN + 1);
    let complete = f
        .countersign("over", &f.authorize("over", &payment), &payment)
        .unwrap();
    let Outcome::Pending { signature } = f.submit("over", &complete).unwrap() else {
        panic!("a new payment is pending");
    };
    assert_eq!(f.status("over"), Outcome::Failed { signature });
    let receipt = payment::receipt(&f.ledger, &f.book, &f.wallet, &payment, "over")
        .unwrap()
        .unwrap();
    assert_eq!(
        (receipt.failed, receipt.debit, receipt.credit, receipt.fee),
        (true, 0, 0, 10_001)
    );
    assert_eq!(f.balance(&f.payee), 0);
}

#[test]
fn a_receipt_is_refused_when_the_ledger_shows_another_effect() {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let payment = f.pay(2 * TOKEN);
    let complete = f
        .countersign("p1", &f.authorize("p1", &payment), &payment)
        .unwrap();
    let Outcome::Pending { signature } = f.submit("p1", &complete).unwrap() else {
        panic!("a new payment is pending");
    };
    let read = || payment::receipt(&f.ledger, &f.book, &f.wallet, &payment, "p1");
    read().unwrap().unwrap();
    let original = f.ledger.finalized.borrow()[&signature].clone();
    let with = |change: &dyn Fn(&mut Finalized)| {
        let mut changed = original.clone();
        change(&mut changed);
        f.ledger.finalized.borrow_mut().insert(signature, changed);
        let refused = read().is_err();
        f.ledger
            .finalized
            .borrow_mut()
            .insert(signature, original.clone());
        refused
    };
    // Another amount left the wallet, another amount arrived, or another mint moved.
    assert!(with(&|t| t
        .balances
        .iter_mut()
        .for_each(|b| b.after = b.before)));
    assert!(with(&|t| {
        let last = t.balances.len() - 1;
        t.balances[last].after += 1;
    }));
    assert!(with(&|t| t
        .balances
        .iter_mut()
        .for_each(|b| b.mint = Address::new_from_array([1; 32]))));
    assert!(with(&|t| t.balances.clear()));
    // The ledger's bytes are not the retained ones.
    assert!(with(&|t| {
        let last = t.wire.len() - 1;
        t.wire[last] ^= 1;
    }));
    assert!(with(&|t| t.wire[1] ^= 1));
    // The receipt belongs to the request that the id retained.
    assert!(payment::receipt(&f.ledger, &f.book, &f.wallet, &f.pay(TOKEN), "p1").is_err());
    read().unwrap().unwrap();
}
