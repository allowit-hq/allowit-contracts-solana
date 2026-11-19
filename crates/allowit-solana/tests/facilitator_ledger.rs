//! The Allowit facilitator settles a Native wallet's x402 payment on a ledger: it checks the
//! client's partly signed transaction, simulates it, signs it as fee payer and submits it. LiteSVM
//! runs the SPL Token, Associated Token Account, System and Compute Budget programs.
use allowit_core::vendor::{
    KeyProvider,
    error::{Error, Result},
    runtime::Signer,
};
use allowit_solana::{
    KEYS, KeySigner,
    facilitator::{self, Ledger, Policy},
    native::{self, Address, Budget, TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM, Wallet},
    networks::{DEVNET, USDC_DEVNET},
    x402,
};
use litesvm::LiteSVM;
use serde_json::json;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;
use solana_signature::Signature;
use solana_transaction::Transaction;
use std::cell::RefCell;

const TOKEN: u64 = 1_000_000;

fn signer(seed: u8) -> KeySigner {
    KeySigner(KEYS.derive(&[seed; 32]).unwrap())
}
fn address(signer: &KeySigner) -> Address {
    signer.identity().parse().unwrap()
}

/// LiteSVM as the facilitator's ledger.
/// LiteSVM keeps no block height: the ledger reports `remaining` blocks to go for any blockhash.
struct Svm(RefCell<Option<LiteSVM>>, std::cell::Cell<u64>);
impl Svm {
    fn with<T>(&self, f: impl FnOnce(&mut LiteSVM) -> T) -> T {
        f(self.0.borrow_mut().as_mut().unwrap())
    }
}
fn decode(wire: &[u8]) -> Result<Transaction> {
    wincode::deserialize::<Transaction>(wire).map_err(|_| Error::usage("undecodable"))
}
impl Ledger for Svm {
    fn heights(&self, blockhash: &solana_hash::Hash) -> Result<x402::Recent> {
        Ok(x402::Recent {
            blockhash: *blockhash,
            last_valid_block_height: 1_000 + self.1.get(),
            block_height: 1_000,
        })
    }
    fn simulate(&self, wire: &[u8]) -> Result<()> {
        let tx = decode(wire)?;
        let mut slot = self.0.borrow_mut();
        let svm = slot.take().unwrap().with_sigverify(false);
        let result = svm
            .simulate_transaction(tx)
            .map(|_| ())
            .map_err(|e| Error::usage(format!("{:?}", e.err)));
        *slot = Some(svm.with_sigverify(true));
        result
    }
    fn submit(&self, wire: &[u8]) -> Result<()> {
        let tx = decode(wire)?;
        self.with(|svm| {
            svm.send_transaction(tx)
                .map(|_| ())
                .map_err(|e| Error::usage(format!("{:?}", e.err)))
        })
    }
}

fn fixture_send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &KeySigner) {
    let key = address(payer);
    let message = Message::new_with_blockhash(ixs, Some(&key), &svm.latest_blockhash());
    let signature: [u8; 64] = payer
        .sign_bytes(&message.serialize())
        .unwrap()
        .try_into()
        .unwrap();
    svm.send_transaction(Transaction {
        signatures: vec![Signature::from(signature)],
        message,
    })
    .unwrap();
}
fn amount_of(svm: &LiteSVM, at: &Address) -> u64 {
    u64::from_le_bytes(
        svm.get_account(at).unwrap().data[64..72]
            .try_into()
            .unwrap(),
    )
}

#[test]
fn the_facilitator_checks_signs_and_submits_a_native_payment_once() {
    let mut svm = LiteSVM::new();
    let (owner, agent, server, fac, seller) =
        (signer(1), signer(2), signer(3), signer(4), signer(5));
    for s in [&owner, &fac] {
        svm.airdrop(&address(s), 10_000_000_000).unwrap();
    }
    let mint: Address = USDC_DEVNET.parse().unwrap();
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(address(&owner).as_ref());
    data[44] = 6;
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
    let seller_account = x402::associated_token_account(&address(&seller), &mint);
    let create = Instruction::new_with_bytes(
        x402::ASSOCIATED_TOKEN_PROGRAM,
        &[1],
        vec![
            AccountMeta::new(address(&owner), true),
            AccountMeta::new(seller_account, false),
            AccountMeta::new_readonly(address(&seller), false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(native::SYSTEM_PROGRAM, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
    );
    fixture_send(&mut svm, &[create], &owner);
    let wallet = Wallet {
        owner: address(&owner),
        mint,
        agent: address(&agent),
        server: address(&server),
    };
    let deposit = svm.minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_LEN as usize);
    let multisig = svm.minimum_balance_for_rent_exemption(native::MULTISIG_LEN as usize);
    let setup = wallet
        .setup(
            5 * TOKEN,
            6,
            wallet.token_found(None, deposit).unwrap(),
            wallet.delegate_found(None, multisig).unwrap(),
            svm.latest_blockhash(),
        )
        .unwrap();
    let signature = setup.sign(&owner).unwrap();
    svm.send_transaction(setup.transaction(&[signature]).unwrap())
        .unwrap();
    let mut mint_to = vec![7u8];
    mint_to.extend_from_slice(&(10 * TOKEN).to_le_bytes());
    let mint_to = Instruction::new_with_bytes(
        TOKEN_PROGRAM,
        &mint_to,
        vec![
            AccountMeta::new(mint, false),
            AccountMeta::new(wallet.token_account(), false),
            AccountMeta::new_readonly(address(&owner), true),
        ],
    );
    fixture_send(&mut svm, &[mint_to], &owner);

    // The client's payment for the seller's requirement, signed by the agent and the server.
    let accepted = json!({
        "scheme": "exact", "network": DEVNET, "amount": "2500000", "asset": USDC_DEVNET,
        "payTo": address(&seller).to_string(), "maxTimeoutSeconds": 60,
        "extra": {"feePayer": address(&fac).to_string()},
    });
    let destination = x402::associated_token_account(&address(&seller), &mint);
    let prepared = wallet
        .payment(
            &destination,
            2_500_000,
            6,
            Budget::PAYMENT,
            None,
            &address(&fac),
            svm.latest_blockhash(),
        )
        .unwrap();
    let wire = prepared
        .wire(&[
            prepared.sign(&agent).unwrap(),
            prepared.sign(&server).unwrap(),
        ])
        .unwrap();

    let ledger = Svm(RefCell::new(Some(svm)), std::cell::Cell::new(120));
    let policy = Policy::allowit(address(&fac));
    let before = ledger.with(|svm| svm.get_balance(&address(&fac)).unwrap());
    // A blockhash with more blocks to go than the seller's 60 seconds admit is refused.
    ledger.1.set(150);
    assert!(facilitator::verify(&wire, &accepted, &policy, 100_000, &ledger).is_err());
    ledger.1.set(120);
    let checked = facilitator::verify(&wire, &accepted, &policy, 100_000, &ledger).unwrap();
    assert_eq!(
        (checked.units, checked.fee, checked.destination),
        (2_500_000, 15_001, seller_account)
    );
    let (_, id) = facilitator::settle(&wire, &accepted, &policy, 100_000, &fac, &ledger).unwrap();
    assert_eq!(
        ledger.with(|svm| amount_of(svm, &seller_account)),
        2_500_000
    );
    assert_eq!(
        before - ledger.with(|svm| svm.get_balance(&address(&fac)).unwrap()),
        15_001
    );
    assert!(ledger.with(|svm| svm.get_transaction(&Signature::from(id)).is_some()));

    // The same payment cannot settle twice, and a facilitator on two signatures refuses it.
    assert!(facilitator::settle(&wire, &accepted, &policy, 100_000, &fac, &ledger).is_err());
    let two = Policy {
        max_signatures: 2,
        ..policy
    };
    assert!(facilitator::verify(&wire, &accepted, &two, 100_000, &ledger).is_err());
    // A signer that is not the facilitator's key is refused before anything is submitted.
    let fresh = wallet
        .payment(
            &destination,
            TOKEN,
            6,
            Budget::PAYMENT,
            None,
            &address(&fac),
            ledger.with(|svm| svm.latest_blockhash()),
        )
        .unwrap();
    let fresh_wire = fresh
        .wire(&[fresh.sign(&agent).unwrap(), fresh.sign(&server).unwrap()])
        .unwrap();
    let mut one = accepted.clone();
    one["amount"] = json!("1000000");
    assert!(facilitator::settle(&fresh_wire, &one, &policy, 100_000, &agent, &ledger).is_err());
    assert_eq!(
        ledger.with(|svm| amount_of(svm, &seller_account)),
        2_500_000
    );
}
