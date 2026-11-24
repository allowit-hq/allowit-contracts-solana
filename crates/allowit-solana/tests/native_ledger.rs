//! The Native wallet on a ledger: LiteSVM runs the SPL Token, System, Compute Budget and Memo
//! programs in process. Every wallet transaction here is built by `allowit_solana::native` and
//! signed by the rail's own keys; only test fixtures (a mint, token accounts, minting) are not.
use allowit_core::vendor::{KeyProvider, runtime::Signer};
use allowit_solana::{
    KEYS, KeySigner,
    native::{
        self, Address, Budget, Found, OwnerStep, Prepared, Seen, TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM,
        Wallet,
    },
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;
use solana_signature::Signature;
use solana_transaction::Transaction;

const DECIMALS: u8 = 6;
const TOKEN: u64 = 1_000_000;

fn signer(seed: u8) -> KeySigner {
    KeySigner(KEYS.derive(&[seed; 32]).unwrap())
}
fn address(signer: &KeySigner) -> Address {
    signer.identity().parse().unwrap()
}

/// SPL Token account fields at their offsets in the 165-byte layout.
struct TokenAccount {
    amount: u64,
    delegate: Option<Address>,
    delegated: u64,
}
fn token_account(svm: &LiteSVM, at: &Address) -> Option<TokenAccount> {
    let data = svm.get_account(at)?.data;
    if data.len() != TOKEN_ACCOUNT_LEN as usize {
        return None;
    }
    let u64_at = |i: usize| u64::from_le_bytes(data[i..i + 8].try_into().unwrap());
    let delegate = (data[72..76] == [1, 0, 0, 0])
        .then(|| Address::new_from_array(data[76..108].try_into().unwrap()));
    Some(TokenAccount {
        amount: u64_at(64),
        delegate,
        delegated: u64_at(121),
    })
}

/// Fixture: a test mint whose authority is `authority`.
fn mint(svm: &mut LiteSVM, at: Address, authority: &Address) {
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(authority.as_ref());
    data[44] = DECIMALS;
    data[45] = 1;
    let lamports = svm.minimum_balance_for_rent_exemption(82);
    svm.set_account(
        at,
        Account {
            lamports,
            data,
            owner: TOKEN_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}
/// Fixture: a plain token account of `mint` for `owner`.
fn plain_token_account(svm: &mut LiteSVM, at: Address, mint: &Address, owner: &Address) {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[108] = 1;
    let lamports = svm.minimum_balance_for_rent_exemption(165);
    svm.set_account(
        at,
        Account {
            lamports,
            data,
            owner: TOKEN_PROGRAM,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}
/// Fixture: the mint authority mints `amount` to `to`, in a test-built transaction.
fn mint_to(svm: &mut LiteSVM, mint: &Address, to: &Address, authority: &KeySigner, amount: u64) {
    let mut data = vec![7u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let payer = address(authority);
    let ix = Instruction::new_with_bytes(
        TOKEN_PROGRAM,
        &data,
        vec![
            AccountMeta::new(*mint, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(payer, true),
        ],
    );
    let message = Message::new_with_blockhash(&[ix], Some(&payer), &svm.latest_blockhash());
    let signature: [u8; 64] = authority
        .sign_bytes(&message.serialize())
        .unwrap()
        .try_into()
        .unwrap();
    let tx = Transaction {
        signatures: vec![Signature::from(signature)],
        message,
    };
    svm.send_transaction(tx).unwrap();
}

/// Signs `prepared` with `signers` and sends it; the error as text.
fn send(svm: &mut LiteSVM, prepared: &Prepared, signers: &[&KeySigner]) -> Result<(), String> {
    let signatures: Vec<(Address, Signature)> =
        signers.iter().map(|s| prepared.sign(*s).unwrap()).collect();
    let tx = prepared.transaction(&signatures).map_err(|e| e.message)?;
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}", e.err))
}

struct Fixture {
    svm: LiteSVM,
    owner: KeySigner,
    agent: KeySigner,
    server: KeySigner,
    facilitator: KeySigner,
    wallet: Wallet,
    payee_account: Address,
}

fn fixture() -> Fixture {
    let mut svm = LiteSVM::new();
    let (owner, agent, server, facilitator) = (signer(1), signer(2), signer(3), signer(4));
    for s in [&owner, &server, &facilitator] {
        svm.airdrop(&address(s), 10_000_000_000).unwrap();
    }
    let mint_address = Address::new_from_array([9; 32]);
    mint(&mut svm, mint_address, &address(&owner));
    let payee_account = Address::new_from_array([8; 32]);
    plain_token_account(
        &mut svm,
        payee_account,
        &mint_address,
        &Address::new_from_array([7; 32]),
    );
    let wallet = Wallet {
        owner: address(&owner),
        mint: mint_address,
        agent: address(&agent),
        server: address(&server),
    };
    Fixture {
        svm,
        owner,
        agent,
        server,
        facilitator,
        wallet,
        payee_account,
    }
}

fn view(account: &Option<Account>) -> Option<Seen<'_>> {
    account.as_ref().map(|a| Seen {
        lamports: a.lamports,
        owner: a.owner,
        data: &a.data,
    })
}

/// The owner's setup, reading both addresses first, then a test refill of `balance`.
fn set_up(f: &mut Fixture, allowance: u64, balance: u64) {
    let deposit = f
        .svm
        .minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_LEN as usize);
    let multisig = f
        .svm
        .minimum_balance_for_rent_exemption(native::MULTISIG_LEN as usize);
    let token = f.svm.get_account(&f.wallet.token_account());
    let delegate = f.svm.get_account(&f.wallet.delegate());
    let setup = f
        .wallet
        .setup(
            allowance,
            DECIMALS,
            f.wallet.token_found(view(&token), deposit).unwrap(),
            f.wallet.delegate_found(view(&delegate), multisig).unwrap(),
            f.svm.latest_blockhash(),
        )
        .unwrap();
    send(&mut f.svm, &setup, &[&f.owner]).unwrap();
    if balance > 0 {
        let (mint_address, account) = (f.wallet.mint, f.wallet.token_account());
        mint_to(&mut f.svm, &mint_address, &account, &f.owner, balance);
    }
}

fn payment(
    f: &Fixture,
    to: &Address,
    amount: u64,
    memo: Option<&str>,
    payer: &Address,
) -> Result<Prepared, String> {
    f.wallet
        .payment(
            to,
            amount,
            DECIMALS,
            Budget::PAYMENT,
            memo,
            payer,
            f.svm.latest_blockhash(),
        )
        .map_err(|e| e.message)
}

fn steps(f: &Fixture, steps: &[OwnerStep]) -> Prepared {
    f.wallet
        .owner_steps(steps, f.svm.latest_blockhash())
        .unwrap()
}

#[test]
fn the_owner_sets_up_alone_and_the_agent_holds_no_account() {
    let mut f = fixture();
    let before = f.svm.get_balance(&f.wallet.owner).unwrap();
    set_up(&mut f, 5 * TOKEN, 10 * TOKEN);
    let account = token_account(&f.svm, &f.wallet.token_account()).unwrap();
    assert_eq!(account.amount, 10 * TOKEN);
    assert_eq!(account.delegate, Some(f.wallet.delegate()));
    assert_eq!(account.delegated, 5 * TOKEN);
    let deposits = f.svm.minimum_balance_for_rent_exemption(165)
        + f.svm.minimum_balance_for_rent_exemption(355);
    // Two owner transactions of one signature each: setup and the test refill.
    assert_eq!(
        before - f.svm.get_balance(&f.wallet.owner).unwrap(),
        deposits + 2 * native::LAMPORTS_PER_SIGNATURE
    );
    assert!(
        f.svm
            .get_account(&f.wallet.agent)
            .is_none_or(|a| a.lamports == 0)
    );
}

#[test]
fn an_x402_payment_needs_agent_server_and_facilitator_and_costs_the_known_fee() {
    let mut f = fixture();
    set_up(&mut f, 5 * TOKEN, 10 * TOKEN);
    let payer = address(&f.facilitator);
    let prepared = payment(&f, &f.payee_account, TOKEN, Some("x402 order 1"), &payer).unwrap();
    let needed = prepared.signers();
    assert_eq!(needed.len(), 3);
    assert_eq!(needed[0], payer);
    assert!(needed.contains(&f.wallet.agent) && needed.contains(&f.wallet.server));
    // The client signs first and leaves the facilitator's place empty.
    let agent = prepared.sign(&f.agent).unwrap();
    let server = prepared.sign(&f.server).unwrap();
    let partial = prepared.transaction(&[agent, server]).unwrap();
    assert_eq!(partial.signatures[0], Signature::default());
    assert!(prepared.wire_size() <= native::MAX_TRANSACTION_BYTES);
    // Without the facilitator the ledger refuses it.
    assert_eq!(
        format!("{:?}", f.svm.send_transaction(partial).unwrap_err().err),
        "SignatureFailure"
    );
    let full = prepared
        .transaction(&[prepared.sign(&f.facilitator).unwrap(), agent, server])
        .unwrap();
    let before = f.svm.get_balance(&payer).unwrap();
    f.svm.send_transaction(full).unwrap();
    assert_eq!(
        before - f.svm.get_balance(&payer).unwrap(),
        native::fee(3, Budget::PAYMENT)
    );
    assert_eq!(
        token_account(&f.svm, &f.payee_account).unwrap().amount,
        TOKEN
    );
    let wallet = token_account(&f.svm, &f.wallet.token_account()).unwrap();
    assert_eq!((wallet.amount, wallet.delegated), (9 * TOKEN, 4 * TOKEN));
}

#[test]
fn the_server_pays_a_payment_that_allowit_submits() {
    let mut f = fixture();
    set_up(&mut f, 5 * TOKEN, 10 * TOKEN);
    let payer = address(&f.server);
    let prepared = payment(&f, &f.payee_account, 2 * TOKEN, None, &payer).unwrap();
    let before = f.svm.get_balance(&payer).unwrap();
    send(&mut f.svm, &prepared, &[&f.server, &f.agent]).unwrap();
    assert_eq!(
        before - f.svm.get_balance(&payer).unwrap(),
        native::fee(2, Budget::PAYMENT)
    );
    assert_eq!(
        token_account(&f.svm, &f.payee_account).unwrap().amount,
        2 * TOKEN
    );
}

#[test]
fn the_ledger_refuses_what_the_policy_does_not_allow() {
    let mut f = fixture();
    set_up(&mut f, 5 * TOKEN, 10 * TOKEN);
    let payer = address(&f.server);
    // SPL Token error 1: insufficient funds (the delegated amount), in instruction 2.
    let over = payment(&f, &f.payee_account, 5 * TOKEN + 1, None, &payer).unwrap();
    assert_eq!(
        send(&mut f.svm, &over, &[&f.server, &f.agent]).unwrap_err(),
        "InstructionError(2, Custom(1))"
    );
    // An agent signature over another payment does not authorize this one.
    let this = payment(&f, &f.payee_account, TOKEN, Some("a"), &payer).unwrap();
    let other = payment(&f, &f.payee_account, TOKEN, Some("b"), &payer).unwrap();
    let foreign = other.sign(&f.agent).unwrap();
    let tx = this
        .transaction(&[this.sign(&f.server).unwrap(), foreign])
        .unwrap();
    assert_eq!(
        format!("{:?}", f.svm.send_transaction(tx).unwrap_err().err),
        "SignatureFailure"
    );
    // A signer that the message does not name is refused before any signature.
    assert!(this.sign(&f.owner).is_err());
    assert_eq!(token_account(&f.svm, &f.payee_account).unwrap().amount, 0);
}

#[test]
fn the_owner_alone_stops_recovers_refills_and_closes() {
    let mut f = fixture();
    set_up(&mut f, 5 * TOKEN, 10 * TOKEN);
    let server = address(&f.server);
    let pay = |f: &mut Fixture, memo: &str| {
        let prepared = payment(f, &f.payee_account, TOKEN, Some(memo), &server).unwrap();
        send(&mut f.svm, &prepared, &[&f.server, &f.agent])
    };
    // Stop: no payment follows. SPL Token error 4: owner mismatch, as the multisig is no longer
    // the delegate.
    let stop = steps(&f, &[OwnerStep::Stop]);
    send(&mut f.svm, &stop, &[&f.owner]).unwrap();
    assert_eq!(
        token_account(&f.svm, &f.wallet.token_account())
            .unwrap()
            .delegate,
        None
    );
    assert_eq!(
        pay(&mut f, "after stop").unwrap_err(),
        "InstructionError(2, Custom(4))"
    );
    // Refill: a new approval, and payments resume.
    let refill = steps(
        &f,
        &[OwnerStep::Approve {
            allowance: 3 * TOKEN,
            decimals: DECIMALS,
        }],
    );
    send(&mut f.svm, &refill, &[&f.owner]).unwrap();
    pay(&mut f, "after refill").unwrap();
    // Recover the whole balance to an account of the owner, then close: the deposit returns.
    let owner_account = Address::new_from_array([6; 32]);
    let (mint_address, owner_address) = (f.wallet.mint, f.wallet.owner);
    plain_token_account(&mut f.svm, owner_account, &mint_address, &owner_address);
    let left = token_account(&f.svm, &f.wallet.token_account())
        .unwrap()
        .amount;
    let deposit = f
        .svm
        .get_account(&f.wallet.token_account())
        .unwrap()
        .lamports;
    let before = f.svm.get_balance(&f.wallet.owner).unwrap();
    let close = steps(
        &f,
        &[
            OwnerStep::Recover {
                to: owner_account,
                amount: left,
                decimals: DECIMALS,
            },
            OwnerStep::Close,
        ],
    );
    send(&mut f.svm, &close, &[&f.owner]).unwrap();
    assert_eq!(token_account(&f.svm, &owner_account).unwrap().amount, left);
    assert!(
        f.svm
            .get_account(&f.wallet.token_account())
            .is_none_or(|a| a.lamports == 0)
    );
    assert_eq!(
        f.svm.get_balance(&f.wallet.owner).unwrap(),
        before + deposit - native::LAMPORTS_PER_SIGNATURE
    );
}

#[test]
fn a_payment_lapses_with_its_blockhash() {
    let mut f = fixture();
    set_up(&mut f, 5 * TOKEN, 10 * TOKEN);
    let payer = address(&f.server);
    let prepared = payment(&f, &f.payee_account, TOKEN, None, &payer).unwrap();
    let signatures = [
        prepared.sign(&f.server).unwrap(),
        prepared.sign(&f.agent).unwrap(),
    ];
    let tx = prepared.transaction(&signatures).unwrap();
    f.svm.expire_blockhash();
    let error = f.svm.send_transaction(tx).unwrap_err();
    assert_eq!(format!("{:?}", error.err), "BlockhashNotFound");
    assert_eq!(token_account(&f.svm, &f.payee_account).unwrap().amount, 0);
}

#[test]
fn a_setup_reuses_the_delegate_and_opens_funded_addresses() {
    let mut f = fixture();
    set_up(&mut f, 5 * TOKEN, 10 * TOKEN);
    // A second wallet of the same agent and server, for another mint: the delegate is reused.
    let second_mint = Address::new_from_array([5; 32]);
    let owner_address = f.wallet.owner;
    mint(&mut f.svm, second_mint, &owner_address);
    f.wallet = Wallet {
        mint: second_mint,
        ..f.wallet
    };
    // Someone funded the new token account's address before the setup, with less than its deposit,
    // so the setup adds the shortfall.
    f.svm.airdrop(&f.wallet.token_account(), 1_000_000).unwrap();
    let funded = f.svm.get_account(&f.wallet.token_account());
    let deposit = f
        .svm
        .minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_LEN as usize);
    assert_eq!(
        f.wallet.token_found(view(&funded), deposit).unwrap(),
        Found::Funded {
            shortfall: deposit - 1_000_000
        }
    );
    set_up(&mut f, 2 * TOKEN, 3 * TOKEN);
    let account = token_account(&f.svm, &f.wallet.token_account()).unwrap();
    assert_eq!((account.amount, account.delegated), (3 * TOKEN, 2 * TOKEN));
    assert_eq!(account.delegate, Some(f.wallet.delegate()));
    let payee = Address::new_from_array([4; 32]);
    plain_token_account(
        &mut f.svm,
        payee,
        &second_mint,
        &Address::new_from_array([3; 32]),
    );
    let server = address(&f.server);
    let prepared = payment(&f, &payee, TOKEN, None, &server).unwrap();
    send(&mut f.svm, &prepared, &[&f.server, &f.agent]).unwrap();
    assert_eq!(token_account(&f.svm, &payee).unwrap().amount, TOKEN);
}

#[test]
fn a_closed_wallet_opens_again() {
    let mut f = fixture();
    set_up(&mut f, 5 * TOKEN, 0);
    let close = steps(&f, &[OwnerStep::Close]);
    send(&mut f.svm, &close, &[&f.owner]).unwrap();
    assert!(token_account(&f.svm, &f.wallet.token_account()).is_none());
    // The multisig stays; the setup reuses it and opens the token account again.
    set_up(&mut f, TOKEN, 2 * TOKEN);
    let account = token_account(&f.svm, &f.wallet.token_account()).unwrap();
    assert_eq!((account.amount, account.delegated), (2 * TOKEN, TOKEN));
}
