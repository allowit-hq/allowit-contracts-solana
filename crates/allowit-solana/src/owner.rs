//! The owner's transactions of a Native wallet, sent so that a lost answer costs nothing: the
//! setup, and the steps that the owner takes alone (refill, stop, recover, close).
//!
//! - The signed bytes are retained under the request id before they are sent. A repeat of the
//!   request finds them and signs nothing while they can still settle.
//! - An unknown result sends the identical bytes again while their blockhash is valid.
//! - A replacement is prepared only after a lapse: a finalized block height past the blockhash's
//!   last valid block height, with no status for the signature at that height or later. A
//!   timeout, a refused submission or a missing status alone proves nothing.
//! - A finalized result is final, a failure too: the request id then names that transaction.
//!
//! The [`Ledger`] and the [`Journal`] keep RPC and storage out of this layer; the rail plugin
//! wires them to its transport and to the caller's store.
use crate::native::{Found, MULTISIG_LEN, OwnerStep, Prepared, Seen, TOKEN_ACCOUNT_LEN, Wallet};
use allowit_core::vendor::{
    error::{Error, Result},
    runtime::Signer,
};
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_hash::Hash;

/// An account as the ledger holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub lamports: u64,
    pub owner: Address,
    pub data: Vec<u8>,
}

/// A recent blockhash and the last block height at which a transaction that names it is valid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recent {
    pub blockhash: Hash,
    pub last_valid_height: u64,
}

/// What the ledger knows of a signature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// No status at the finalized bank, with the transaction history searched.
    Unknown,
    /// Processed or confirmed, not finalized: it may still settle or be dropped.
    Pending,
    /// Finalized. A failed transaction is final too: its signature cannot run again.
    Finalized { failed: bool },
}

/// One coherent read of a signature: its status, and the block height of a finalized bank that
/// is no newer than the bank that answered the status. With that order, a height past the last
/// valid block height and an unknown status together prove the lapse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Observation {
    pub status: Status,
    pub finalized_height: u64,
}

/// The ledger that the owner's transactions read and write.
pub trait Ledger {
    /// The account at `address`, if any.
    fn account(&self, address: &Address) -> Result<Option<Account>>;
    /// The deposit that keeps an account of `len` bytes: its rent-exempt minimum, in lamports.
    fn deposit(&self, len: u64) -> Result<u64>;
    /// A recent blockhash for a new transaction.
    fn recent(&self) -> Result<Recent>;
    /// Submit the signed `wire`. An error means that the result is unknown, not that nothing
    /// was sent.
    fn submit(&self, wire: &[u8]) -> Result<()>;
    /// The status of the 64-byte `signature`, read as [`Observation`] states.
    fn observe(&self, signature: &[u8; 64]) -> Result<Observation>;
}

/// The signed transaction that a request id retains.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Retained {
    /// The identity of the request: the wallet and the step, not the blockhash.
    pub request: [u8; 32],
    /// The exact signed bytes that were, or are about to be, sent.
    pub wire: Vec<u8>,
    pub signature: [u8; 64],
    pub last_valid_height: u64,
}

/// The caller's journal of owner transactions, by request id.
pub trait Journal {
    fn load(&self, request_id: &str) -> Result<Option<Retained>>;
    /// Retain `retained` durably before this returns: the transaction is sent only afterwards.
    fn save(&self, request_id: &str, retained: &Retained) -> Result<()>;
}

/// What the owner asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    /// Open whatever the wallet lacks and approve `allowance` to the delegate.
    Setup { allowance: u64, decimals: u8 },
    /// Steps that the owner takes alone, in one transaction.
    Steps(Vec<OwnerStep>),
    /// Add `units` to what the wallet's own delegate may still spend. The request is the
    /// addition: the transaction approves the allowance that the ledger shows when it is
    /// prepared plus `units`, and a replacement after a lapse reads the ledger again. A payment
    /// that settles between that read and the approval is not subtracted: the owner's
    /// transaction states the allowance that it approves, and no more than it can be spent.
    Refill { units: u64, decimals: u8 },
}

/// Where the request stands. Each carries the signature of the transaction that it names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Finalized without an error.
    Settled { signature: [u8; 64] },
    /// Finalized with an error: nothing of the request took effect, and the fee was paid.
    Failed { signature: [u8; 64] },
    /// The ledger holds it, or the RPC accepted its submission, and it is not finalized yet. Ask
    /// again with the same request id.
    Pending { signature: [u8; 64] },
    /// Sent, or sent again, and neither the ledger shows it nor did the RPC accept it: it can
    /// still settle, and nothing proves that it was submitted. Ask again with the same request id.
    Unconfirmed { signature: [u8; 64] },
}

/// The outcome of a submission of `signature`: pending once the RPC accepted it, unconfirmed
/// otherwise. A refusal proves nothing: the retained bytes may still settle.
fn submitted(ledger: &dyn Ledger, wire: &[u8], signature: [u8; 64]) -> Outcome {
    match ledger.submit(wire) {
        Ok(()) => Outcome::Pending { signature },
        Err(_) => Outcome::Unconfirmed { signature },
    }
}

/// The identity of a request: a repeat of `request_id` must ask for the same thing.
fn identity(wallet: &Wallet, request: &Request) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"allowit-solana-owner-request-v1\0");
    for key in [&wallet.owner, &wallet.mint, &wallet.agent, &wallet.server] {
        hash.update(key.as_ref());
    }
    match request {
        Request::Setup {
            allowance,
            decimals,
        } => {
            hash.update([0]);
            hash.update(allowance.to_le_bytes());
            hash.update([*decimals]);
        }
        Request::Refill { units, decimals } => {
            hash.update([2]);
            hash.update(units.to_le_bytes());
            hash.update([*decimals]);
        }
        Request::Steps(steps) => {
            hash.update([1, steps.len() as u8]);
            for step in steps {
                match step {
                    OwnerStep::Approve {
                        allowance,
                        decimals,
                    } => {
                        hash.update([0]);
                        hash.update(allowance.to_le_bytes());
                        hash.update([*decimals]);
                    }
                    OwnerStep::Stop => hash.update([1]),
                    OwnerStep::Recover {
                        to,
                        amount,
                        decimals,
                    } => {
                        hash.update([2]);
                        hash.update(to.as_ref());
                        hash.update(amount.to_le_bytes());
                        hash.update([*decimals]);
                    }
                    OwnerStep::Close => hash.update([3]),
                }
            }
        }
    }
    hash.finalize().into()
}

/// What the wallet's own delegate may still spend, as the ledger shows it now. Another
/// delegate's allowance is not this wallet's: a refill replaces it and adds nothing to it.
pub fn remaining(ledger: &dyn Ledger, wallet: &Wallet) -> Result<u64> {
    let account = ledger
        .account(&wallet.token_account())?
        .ok_or_else(|| Error::usage("The wallet's token account is closed"))?;
    let data = &account.data;
    if !wallet.is_token_account(data) {
        return Err(Error::config(
            "The wallet's address holds another account than its token account",
        ));
    }
    let delegated = data[72..76] == [1, 0, 0, 0] && data[76..108] == wallet.delegate().to_bytes();
    Ok(if delegated {
        u64::from_le_bytes(data[121..129].try_into().expect("8 bytes"))
    } else {
        0
    })
}

/// What the setup finds at `address`, for an account of `len` bytes.
fn find(
    ledger: &dyn Ledger,
    address: &Address,
    len: u64,
    found: impl Fn(Option<Seen<'_>>, u64) -> Result<Found>,
) -> Result<Found> {
    let deposit = ledger.deposit(len)?;
    let account = ledger.account(address)?;
    found(
        account.as_ref().map(|account| Seen {
            lamports: account.lamports,
            owner: account.owner,
            data: &account.data,
        }),
        deposit,
    )
}

fn prepare(
    ledger: &dyn Ledger,
    wallet: &Wallet,
    request_id: &str,
    request: &Request,
    blockhash: Hash,
) -> Result<Prepared> {
    // The request id is the transaction's memo: two requests for the same step on one
    // blockhash would otherwise be one transaction, and one execution would settle both.
    let tag = format!("allowit:{request_id}");
    match request {
        Request::Setup {
            allowance,
            decimals,
        } => {
            let token = find(
                ledger,
                &wallet.token_account(),
                TOKEN_ACCOUNT_LEN,
                |s, d| wallet.token_found(s, d),
            )?;
            let delegate = find(ledger, &wallet.delegate(), MULTISIG_LEN, |s, d| {
                wallet.delegate_found(s, d)
            })?;
            wallet.setup_tagged(*allowance, *decimals, token, delegate, &tag, blockhash)
        }
        Request::Steps(steps) => wallet.owner_steps_tagged(steps, &tag, blockhash),
        Request::Refill { units, decimals } => {
            if *units == 0 {
                return Err(Error::usage("A refill adds a positive amount"));
            }
            let allowance = remaining(ledger, wallet)?
                .checked_add(*units)
                .ok_or_else(|| Error::usage("The allowance is out of range"))?;
            let step = OwnerStep::Approve {
                allowance,
                decimals: *decimals,
            };
            wallet.owner_steps_tagged(&[step], &tag, blockhash)
        }
    }
}

/// The network fee of every owner transaction: one signature, the owner's, and no
/// compute-budget price. The owner's transactions name no compute-budget instruction, so the fee
/// is known before the owner signs, and a replacement after a lapse costs the same.
pub const OWNER_FEE_LAMPORTS: u64 = crate::native::LAMPORTS_PER_SIGNATURE;

/// Refuse an owner transaction whose fee is above `limit`, in lamports, before anything is signed.
pub fn check_fee_limit(limit: &str) -> Result<()> {
    let limit: u64 = limit
        .parse()
        .map_err(|_| Error::usage("The fee limit is a whole number of lamports"))?;
    if OWNER_FEE_LAMPORTS > limit {
        return Err(Error::usage(format!(
            "The owner's transaction costs {OWNER_FEE_LAMPORTS} lamports in network fees, above the fee limit of {limit}: nothing was signed. Raise the fee limit to at least {OWNER_FEE_LAMPORTS}."
        )));
    }
    Ok(())
}

/// Where a retained transaction stands on the ledger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// Finalized without an error.
    Settled,
    /// Finalized with an error.
    Failed,
    /// Known to the ledger and not finalized.
    Pending,
    /// No status while the blockhash is still valid: the identical bytes may be sent again.
    Unsent,
    /// No status at a finalized height past the last valid block height: the bytes never ran
    /// and can no longer run.
    Lapsed,
}

/// Resolve `retained` by one coherent read of the ledger.
pub fn resolve(ledger: &dyn Ledger, retained: &Retained) -> Result<Resolution> {
    let seen = ledger.observe(&retained.signature)?;
    Ok(match seen.status {
        Status::Finalized { failed: false } => Resolution::Settled,
        Status::Finalized { failed: true } => Resolution::Failed,
        Status::Pending => Resolution::Pending,
        Status::Unknown if seen.finalized_height <= retained.last_valid_height => {
            Resolution::Unsent
        }
        Status::Unknown => Resolution::Lapsed,
    })
}

/// Send the owner's `request` for `wallet` under `request_id`, or resolve the transaction that
/// the id already names. The owner's `signer` signs only when no retained transaction can still
/// settle.
pub fn send(
    ledger: &dyn Ledger,
    journal: &dyn Journal,
    signer: &dyn Signer,
    wallet: &Wallet,
    request_id: &str,
    request: &Request,
) -> Result<Outcome> {
    wallet.check()?;
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(Error::usage(
            "A request id has 1 to 128 visible ASCII characters",
        ));
    }
    if signer.identity() != wallet.owner.to_string() {
        return Err(Error::usage("Only the wallet's owner signs an owner step"));
    }
    let identity = identity(wallet, request);
    if let Some(retained) = journal.load(request_id)? {
        if retained.request != identity {
            return Err(Error::usage(
                "This request id names another owner step; use a new id for a new step",
            ));
        }
        let signature = retained.signature;
        match resolve(ledger, &retained)? {
            Resolution::Settled => return Ok(Outcome::Settled { signature }),
            Resolution::Failed => return Ok(Outcome::Failed { signature }),
            Resolution::Pending => return Ok(Outcome::Pending { signature }),
            // The identical bytes may still settle. A refusal here proves nothing.
            Resolution::Unsent => return Ok(submitted(ledger, &retained.wire, signature)),
            // The retained bytes never ran and can no longer run.
            Resolution::Lapsed => {}
        }
    }
    let recent = ledger.recent()?;
    let prepared = prepare(ledger, wallet, request_id, request, recent.blockhash)?;
    let (address, signed) = prepared.sign(signer)?;
    let wire = prepared.wire(&[(address, signed)])?;
    let signature: [u8; 64] = signed.into();
    journal.save(
        request_id,
        &Retained {
            request: identity,
            wire: wire.clone(),
            signature,
            last_valid_height: recent.last_valid_height,
        },
    )?;
    // The bytes are retained: whatever the submission answers, the id resolves them later.
    Ok(submitted(ledger, &wire, signature))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{KEYS, KeySigner};
    use allowit_core::vendor::KeyProvider as _;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;

    fn signer(seed: u8) -> KeySigner {
        KeySigner(KEYS.derive(&[seed; 32]).unwrap())
    }
    fn address(signer: &KeySigner) -> Address {
        signer.identity().parse().unwrap()
    }
    fn wallet(owner: &KeySigner) -> Wallet {
        Wallet {
            owner: address(owner),
            mint: Address::new_from_array([9; 32]),
            agent: address(&signer(2)),
            server: address(&signer(3)),
        }
    }
    const SETUP: Request = Request::Setup {
        allowance: 5_000_000,
        decimals: 6,
    };

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

    /// A ledger whose answers the test sets. It records each submission with what the journal
    /// held at that moment.
    struct Chain<'a> {
        book: &'a Book,
        blockhash: Cell<u8>,
        height: Cell<u64>,
        status: Cell<Status>,
        refuse: Cell<bool>,
        sent: RefCell<Vec<(Vec<u8>, bool)>>,
    }
    impl<'a> Chain<'a> {
        fn new(book: &'a Book) -> Self {
            Self {
                book,
                blockhash: Cell::new(1),
                height: Cell::new(100),
                status: Cell::new(Status::Unknown),
                refuse: Cell::new(false),
                sent: RefCell::default(),
            }
        }
    }
    impl Ledger for Chain<'_> {
        fn account(&self, _: &Address) -> Result<Option<Account>> {
            Ok(None)
        }
        fn deposit(&self, len: u64) -> Result<u64> {
            Ok(890_880 + len * 6_960)
        }
        fn recent(&self) -> Result<Recent> {
            Ok(Recent {
                blockhash: Hash::new_from_array([self.blockhash.get(); 32]),
                last_valid_height: self.height.get() + 150,
            })
        }
        fn submit(&self, wire: &[u8]) -> Result<()> {
            let retained = self
                .book
                .0
                .borrow()
                .values()
                .any(|retained| retained.wire == wire);
            self.sent.borrow_mut().push((wire.to_vec(), retained));
            if self.refuse.get() {
                return Err(Error::usage("The node refused the transaction"));
            }
            Ok(())
        }
        fn observe(&self, _: &[u8; 64]) -> Result<Observation> {
            Ok(Observation {
                status: self.status.get(),
                finalized_height: self.height.get(),
            })
        }
    }
    fn pending(outcome: Outcome) -> [u8; 64] {
        match outcome {
            Outcome::Pending { signature } => signature,
            other => panic!("not pending: {other:?}"),
        }
    }
    fn unconfirmed(outcome: Outcome) -> [u8; 64] {
        match outcome {
            Outcome::Unconfirmed { signature } => signature,
            other => panic!("not unconfirmed: {other:?}"),
        }
    }

    #[test]
    fn the_signed_bytes_are_retained_before_they_are_sent() {
        let (book, owner) = (Book::default(), signer(1));
        let chain = Chain::new(&book);
        let signature = pending(send(&chain, &book, &owner, &wallet(&owner), "a", &SETUP).unwrap());
        let sent = chain.sent.borrow();
        assert_eq!(sent.len(), 1);
        assert!(sent[0].1, "the journal held the bytes when they were sent");
        let retained = book.load("a").unwrap().unwrap();
        assert_eq!(retained.wire, sent[0].0);
        assert_eq!(retained.signature, signature);
        assert_eq!(retained.last_valid_height, 250);
        // One signature, the owner's, in front of the message.
        assert_eq!(retained.wire[0], 1);
        assert_eq!(retained.wire[1..65], signature);
    }

    /// Each owner transaction costs what the fee limit is checked against: the owner's one
    /// signature, with no compute-budget instruction that would add a priority fee.
    #[test]
    fn an_owner_transaction_costs_one_signature_and_no_priority_fee() {
        let budget: Address = "ComputeBudget111111111111111111111111111111"
            .parse()
            .unwrap();
        // A refill is the transaction of one `Approve` step, which this ledger needs no account
        // to build.
        let refill = Request::Steps(vec![OwnerStep::Approve {
            allowance: 1,
            decimals: 6,
        }]);
        let steps = Request::Steps(vec![OwnerStep::Stop]);
        for (id, request) in [("setup", &SETUP), ("refill", &refill), ("stop", &steps)] {
            let (book, owner) = (Book::default(), signer(1));
            let chain = Chain::new(&book);
            pending(send(&chain, &book, &owner, &wallet(&owner), id, request).unwrap());
            let wire = book.load(id).unwrap().unwrap().wire;
            assert_eq!(wire[0], 1, "{id}: one signature");
            assert!(
                !wire.windows(32).any(|w| w == budget.to_bytes()),
                "{id}: no compute-budget instruction"
            );
        }
        assert_eq!(OWNER_FEE_LAMPORTS, 5_000);
        check_fee_limit("5000").unwrap();
        assert!(check_fee_limit("4999").is_err());
        assert!(check_fee_limit("-1").is_err());
        assert!(check_fee_limit("1.5").is_err());
    }

    #[test]
    fn a_refused_submission_keeps_the_bytes_and_the_identical_bytes_go_again() {
        let (book, owner) = (Book::default(), signer(1));
        let chain = Chain::new(&book);
        chain.refuse.set(true);
        // The RPC refused it and the ledger does not show it: unconfirmed, never pending.
        let first = unconfirmed(send(&chain, &book, &owner, &wallet(&owner), "a", &SETUP).unwrap());
        // A newer blockhash is on offer; the retained bytes are still valid, so it is not used.
        chain.blockhash.set(2);
        chain.height.set(250);
        let again = unconfirmed(send(&chain, &book, &owner, &wallet(&owner), "a", &SETUP).unwrap());
        assert_eq!(first, again);
        // Once the RPC accepts the identical bytes, they are pending.
        chain.refuse.set(false);
        assert_eq!(
            pending(send(&chain, &book, &owner, &wallet(&owner), "a", &SETUP).unwrap()),
            first
        );
        // Three submissions of the identical bytes.
        let sent = chain.sent.borrow();
        assert_eq!(sent.len(), 3);
        assert!(sent.iter().all(|(wire, _)| *wire == sent[0].0));
    }

    #[test]
    fn a_result_on_the_ledger_is_final_and_sends_nothing() {
        for (status, settled) in [
            (Status::Finalized { failed: false }, Some(true)),
            (Status::Finalized { failed: true }, Some(false)),
            (Status::Pending, None),
        ] {
            let (book, owner) = (Book::default(), signer(1));
            let chain = Chain::new(&book);
            let signature =
                pending(send(&chain, &book, &owner, &wallet(&owner), "a", &SETUP).unwrap());
            // Even past the last valid height, a known signature is never replaced.
            chain.status.set(status);
            chain.height.set(10_000);
            chain.blockhash.set(2);
            let outcome = send(&chain, &book, &owner, &wallet(&owner), "a", &SETUP).unwrap();
            assert_eq!(
                outcome,
                match settled {
                    Some(true) => Outcome::Settled { signature },
                    Some(false) => Outcome::Failed { signature },
                    None => Outcome::Pending { signature },
                }
            );
            assert_eq!(chain.sent.borrow().len(), 1);
            assert_eq!(book.load("a").unwrap().unwrap().signature, signature);
        }
    }

    #[test]
    fn only_a_lapse_prepares_a_replacement() {
        let (book, owner) = (Book::default(), signer(1));
        let chain = Chain::new(&book);
        let first = pending(send(&chain, &book, &owner, &wallet(&owner), "a", &SETUP).unwrap());
        chain.blockhash.set(2);
        // The last valid height itself is not past it.
        chain.height.set(250);
        assert_eq!(
            pending(send(&chain, &book, &owner, &wallet(&owner), "a", &SETUP).unwrap()),
            first
        );
        chain.height.set(251);
        let second = pending(send(&chain, &book, &owner, &wallet(&owner), "a", &SETUP).unwrap());
        assert_ne!(first, second);
        let retained = book.load("a").unwrap().unwrap();
        assert_eq!(retained.signature, second);
        assert_eq!(retained.last_valid_height, 401);
        let sent = chain.sent.borrow();
        assert_eq!(sent.len(), 3);
        assert_ne!(sent[2].0, sent[0].0);
        assert!(sent[2].1);
    }

    #[test]
    fn a_request_id_names_one_step_of_one_owner() {
        let (book, owner) = (Book::default(), signer(1));
        let chain = Chain::new(&book);
        send(&chain, &book, &owner, &wallet(&owner), "a", &SETUP).unwrap();
        let other = Request::Setup {
            allowance: 5_000_001,
            decimals: 6,
        };
        assert!(send(&chain, &book, &owner, &wallet(&owner), "a", &other).is_err());
        let stop = Request::Steps(vec![OwnerStep::Stop]);
        assert!(send(&chain, &book, &owner, &wallet(&owner), "a", &stop).is_err());
        let stopped = pending(send(&chain, &book, &owner, &wallet(&owner), "b", &stop).unwrap());
        // The same step under another id is another transaction, on the same blockhash too.
        let again = pending(send(&chain, &book, &owner, &wallet(&owner), "b2", &stop).unwrap());
        assert_ne!(stopped, again);
        assert!(send(&chain, &book, &owner, &wallet(&owner), "b 3", &stop).is_err());
        // Another key signs no step of this wallet, and an id is bounded.
        assert!(send(&chain, &book, &signer(4), &wallet(&owner), "c", &SETUP).is_err());
        assert!(send(&chain, &book, &owner, &wallet(&owner), "", &SETUP).is_err());
        assert!(
            send(
                &chain,
                &book,
                &owner,
                &wallet(&owner),
                &"x".repeat(129),
                &SETUP
            )
            .is_err()
        );
        assert_eq!(chain.sent.borrow().len(), 3);
    }
}
