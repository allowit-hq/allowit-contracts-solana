//! The owner's transactions on a ledger: LiteSVM runs the SPL Token and System programs in
//! process, behind the `owner::Ledger` that the workflow reads and writes. The ledger here
//! finalizes at once; the test moves its block height and loses its submissions.
use allowit_core::vendor::{
    KeyProvider,
    error::{Error, Result},
    runtime::Signer,
};
use allowit_solana::{
    KEYS, KeySigner,
    native::{Address, OwnerStep, TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM, Wallet},
    owner::{self, Journal, Ledger, Observation, Outcome, Recent, Request, Retained, Status},
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_signature::Signature;
use solana_transaction::Transaction;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

const DECIMALS: u8 = 6;

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

/// LiteSVM as the owner's ledger. `height` is the finalized block height that it reports;
/// `lose` drops submissions before they reach the programs.
struct Svm {
    svm: RefCell<LiteSVM>,
    height: Cell<u64>,
    lose: Cell<bool>,
    submissions: Cell<usize>,
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
        self.svm
            .borrow_mut()
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| Error::usage(format!("{:?}", e.err)))
    }
    fn observe(&self, signature: &[u8; 64]) -> Result<Observation> {
        let svm = self.svm.borrow();
        let status = match svm.get_transaction(&Signature::from(*signature)) {
            None => Status::Unknown,
            Some(result) => Status::Finalized {
                failed: result.is_err(),
            },
        };
        Ok(Observation {
            status,
            finalized_height: self.height.get(),
        })
    }
}

struct Fixture {
    ledger: Svm,
    book: Book,
    owner: KeySigner,
    wallet: Wallet,
}
fn fixture() -> Fixture {
    let mut svm = LiteSVM::new();
    let owner = signer(1);
    svm.airdrop(&address(&owner), 10_000_000_000).unwrap();
    let mint = Address::new_from_array([9; 32]);
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(address(&owner).as_ref());
    data[44] = DECIMALS;
    data[45] = 1;
    let lamports = svm.minimum_balance_for_rent_exemption(82);
    svm.set_account(
        mint,
        Account {
            lamports,
            data,
            owner: TOKEN_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    let wallet = Wallet {
        owner: address(&owner),
        mint,
        agent: address(&signer(2)),
        server: address(&signer(3)),
    };
    Fixture {
        ledger: Svm {
            svm: RefCell::new(svm),
            height: Cell::new(1_000),
            lose: Cell::new(false),
            submissions: Cell::new(0),
        },
        book: Book::default(),
        owner,
        wallet,
    }
}
impl Fixture {
    fn send(&self, id: &str, request: &Request) -> Outcome {
        owner::send(
            &self.ledger,
            &self.book,
            &self.owner,
            &self.wallet,
            id,
            request,
        )
        .unwrap()
    }
    /// The delegate and the allowance of the wallet's token account, if it exists.
    fn approval(&self) -> Option<(Option<Address>, u64)> {
        let data = self
            .ledger
            .svm
            .borrow()
            .get_account(&self.wallet.token_account())?
            .data;
        if data.len() != TOKEN_ACCOUNT_LEN as usize {
            return None;
        }
        let delegate = (data[72..76] == [1, 0, 0, 0])
            .then(|| Address::new_from_array(data[76..108].try_into().unwrap()));
        Some((
            delegate,
            u64::from_le_bytes(data[121..129].try_into().unwrap()),
        ))
    }
}
const SETUP: Request = Request::Setup {
    allowance: 5_000_000,
    decimals: DECIMALS,
};

#[test]
fn a_setup_settles_once_and_its_repeat_signs_nothing() {
    let f = fixture();
    let Outcome::Pending { signature } = f.send("setup", &SETUP) else {
        panic!("a new setup is pending");
    };
    assert_eq!(
        f.approval(),
        Some((Some(f.wallet.delegate()), 5_000_000)),
        "the setup opened the account and approved the delegate"
    );
    // The repeat reads the ledger's result; a newer blockhash and height change nothing.
    f.ledger.svm.borrow_mut().expire_blockhash();
    f.ledger.height.set(5_000);
    assert_eq!(f.send("setup", &SETUP), Outcome::Settled { signature });
    assert_eq!(f.ledger.submissions.get(), 1);
}

#[test]
fn a_lost_setup_goes_again_as_the_same_bytes_and_settles() {
    let f = fixture();
    f.ledger.lose.set(true);
    // The RPC did not accept it: unconfirmed, never pending.
    let Outcome::Unconfirmed { signature } = f.send("setup", &SETUP) else {
        panic!("a lost setup is unconfirmed");
    };
    assert_eq!(f.approval(), None);
    f.ledger.lose.set(false);
    assert_eq!(f.send("setup", &SETUP), Outcome::Pending { signature });
    assert_eq!(f.send("setup", &SETUP), Outcome::Settled { signature });
    assert_eq!(f.approval(), Some((Some(f.wallet.delegate()), 5_000_000)));
    assert_eq!(f.ledger.submissions.get(), 2);
}

#[test]
fn a_lapsed_setup_is_prepared_again_and_the_old_bytes_cannot_run() {
    let f = fixture();
    f.ledger.lose.set(true);
    let Outcome::Unconfirmed { signature: first } = f.send("setup", &SETUP) else {
        panic!("a lost setup is unconfirmed");
    };
    let old = f.book.load("setup").unwrap().unwrap().wire;
    // The blockhash expires and the finalized height passes its last valid height.
    f.ledger.lose.set(false);
    f.ledger.svm.borrow_mut().expire_blockhash();
    f.ledger.height.set(1_151);
    let Outcome::Pending { signature: second } = f.send("setup", &SETUP) else {
        panic!("the replacement is pending");
    };
    assert_ne!(first, second);
    assert_eq!(
        f.send("setup", &SETUP),
        Outcome::Settled { signature: second }
    );
    assert_eq!(f.approval(), Some((Some(f.wallet.delegate()), 5_000_000)));
    // The ledger refuses the lapsed bytes.
    assert!(f.ledger.submit(&old).is_err());
}

#[test]
fn a_refill_adds_to_what_is_left_and_its_repeat_adds_nothing_more() {
    let f = fixture();
    f.send("setup", &SETUP);
    let refill = Request::Refill {
        units: 2_000_000,
        decimals: DECIMALS,
    };
    let Outcome::Pending { signature } = f.send("refill", &refill) else {
        panic!("a new refill is pending");
    };
    assert_eq!(f.approval(), Some((Some(f.wallet.delegate()), 7_000_000)));
    // The repeat is the same request although the ledger's allowance has changed since.
    let submissions = f.ledger.submissions.get();
    assert_eq!(f.send("refill", &refill), Outcome::Settled { signature });
    assert_eq!(f.approval(), Some((Some(f.wallet.delegate()), 7_000_000)));
    assert_eq!(f.ledger.submissions.get(), submissions);
    // Another amount under the id is another request, and a refill of nothing is none.
    let other = Request::Refill {
        units: 2_000_001,
        decimals: DECIMALS,
    };
    assert!(owner::send(&f.ledger, &f.book, &f.owner, &f.wallet, "refill", &other).is_err());
    let nothing = Request::Refill {
        units: 0,
        decimals: DECIMALS,
    };
    assert!(owner::send(&f.ledger, &f.book, &f.owner, &f.wallet, "nothing", &nothing).is_err());
    // A stopped wallet has nothing left: the refill approves its own amount and resumes it.
    f.send("stop", &Request::Steps(vec![OwnerStep::Stop]));
    assert_eq!(f.approval(), Some((None, 0)));
    f.send("resume", &refill);
    assert_eq!(f.approval(), Some((Some(f.wallet.delegate()), 2_000_000)));
}

#[test]
fn a_refill_of_a_wallet_that_was_never_set_up_signs_nothing() {
    let f = fixture();
    let refill = Request::Refill {
        units: 1,
        decimals: DECIMALS,
    };
    assert!(owner::send(&f.ledger, &f.book, &f.owner, &f.wallet, "refill", &refill).is_err());
    assert!(f.book.load("refill").unwrap().is_none());
    assert_eq!(f.ledger.submissions.get(), 0);
}

#[test]
fn the_owner_stops_and_a_failed_step_is_final() {
    let f = fixture();
    f.send("setup", &SETUP);
    let stop = Request::Steps(vec![OwnerStep::Stop]);
    let Outcome::Pending { signature } = f.send("stop", &stop) else {
        panic!("a new stop is pending");
    };
    assert_eq!(f.send("stop", &stop), Outcome::Settled { signature });
    assert_eq!(f.approval(), Some((None, 0)));
    // Recovering more than the account holds fails on the ledger: the id keeps that result.
    let recover = Request::Steps(vec![OwnerStep::Recover {
        to: f.wallet.token_account(),
        amount: 1,
        decimals: DECIMALS,
    }]);
    assert!(
        owner::send(&f.ledger, &f.book, &f.owner, &f.wallet, "recover", &recover).is_err(),
        "a recovery into the wallet's own account is refused before signing"
    );
    let submissions = f.ledger.submissions.get();
    let close_twice = Request::Steps(vec![OwnerStep::Close, OwnerStep::Close]);
    // This ledger answers the submission of a failing transaction with an error and records it
    // as failed: the submission is unconfirmed, and the ledger's record then decides.
    let Outcome::Unconfirmed { signature } = f.send("close", &close_twice) else {
        panic!("a refused close is unconfirmed");
    };
    assert_eq!(f.send("close", &close_twice), Outcome::Failed { signature });
    assert_eq!(f.ledger.submissions.get(), submissions + 1);
    assert!(
        f.approval().is_some(),
        "a failed transaction closed nothing"
    );
}
