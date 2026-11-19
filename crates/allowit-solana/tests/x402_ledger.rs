//! An x402 `exact` payment from a Native wallet on a ledger: the seller's 402 header, the
//! challenge, the wallet's payment to the seller's associated token account, the proof header with
//! the client's signed payment, and the facilitator's signature and submission. LiteSVM runs the
//! SPL Token, Associated Token Account, System and Compute Budget programs.
use allowit_core::vendor::{KeyProvider, paid_service::SellerReply, runtime::Signer};
use allowit_solana::{
    KEYS, KeySigner,
    native::{self, Address, Budget, Seen, TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM, Wallet},
    networks::{DEVNET, USDC_DEVNET},
    x402,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use litesvm::LiteSVM;
use serde_json::{Value, json};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;
use solana_signature::Signature;
use solana_transaction::Transaction;

const TOKEN: u64 = 1_000_000;
const RESOURCE: &str = "https://seller.example/report?id=7";

fn signer(seed: u8) -> KeySigner {
    KeySigner(KEYS.derive(&[seed; 32]).unwrap())
}
fn address(signer: &KeySigner) -> Address {
    signer.identity().parse().unwrap()
}
fn amount_of(svm: &LiteSVM, at: &Address) -> u64 {
    let data = svm.get_account(at).unwrap().data;
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

/// Sends `ixs` paid and signed by `payer`: test fixtures only.
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

#[test]
fn an_exact_payment_from_a_native_wallet_settles_through_a_three_signature_facilitator() {
    let mut svm = LiteSVM::new();
    let (owner, agent, server, facilitator, seller) =
        (signer(1), signer(2), signer(3), signer(4), signer(5));
    for s in [&owner, &facilitator] {
        svm.airdrop(&address(s), 10_000_000_000).unwrap();
    }
    // Fixture: the Devnet USDC mint, with the owner as mint authority for the test.
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

    // The seller's associated token account, created by the ATA program, is where the module
    // derives it.
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
    assert_eq!(
        svm.get_account(&seller_account).unwrap().data[32..64],
        address(&seller).to_bytes()
    );

    // The owner's Native wallet, funded with 10 USDC and an allowance of 5.
    let wallet = Wallet {
        owner: address(&owner),
        mint,
        agent: address(&agent),
        server: address(&server),
    };
    let deposit = svm.minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_LEN as usize);
    let multisig = svm.minimum_balance_for_rent_exemption(native::MULTISIG_LEN as usize);
    let none: Option<Seen<'_>> = None;
    let setup = wallet
        .setup(
            5 * TOKEN,
            6,
            wallet.token_found(none, deposit).unwrap(),
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

    // The seller's 402 with an exact requirement of 2.5 USDC whose facilitator is `facilitator`.
    let accepted = json!({
        "scheme": "exact", "network": DEVNET, "amount": "2500000", "asset": USDC_DEVNET,
        "payTo": address(&seller).to_string(), "maxTimeoutSeconds": 60,
        "extra": {"feePayer": address(&facilitator).to_string()},
    });
    let document = json!({"x402Version": 2, "resource": {"url": RESOURCE}, "accepts": [accepted]});
    let headers = vec![(
        "PAYMENT-REQUIRED".to_owned(),
        STANDARD.encode(serde_json::to_vec(&document).unwrap()),
    )];
    let challenge = x402::challenge(
        DEVNET,
        RESOURCE,
        &SellerReply {
            status: 402,
            headers: &headers,
            body: b"",
        },
    )
    .unwrap();

    // The wallet's payment: the agent and the server sign; the facilitator's place stays empty.
    let prepared =
        x402::payment(&wallet, &challenge, Budget::PAYMENT, svm.latest_blockhash()).unwrap();
    assert_eq!(prepared.signers()[0], address(&facilitator));
    let client = [
        prepared.sign(&agent).unwrap(),
        prepared.sign(&server).unwrap(),
    ];
    let wire = prepared.wire(&client).unwrap();
    assert_eq!(wire.len(), prepared.wire_size());

    // The proof header carries exactly that signed payment.
    let receipt = json!({
        "status": "submitted",
        "network": DEVNET,
        "paidService": serde_json::to_value(challenge.context()).unwrap(),
        x402::AUTHORIZATION_KEY: {"transaction": STANDARD.encode(&wire)},
    });
    let proof = x402::proof(&challenge, &receipt).unwrap();
    assert_eq!(proof.header, "PAYMENT-SIGNATURE");
    let payload: Value = serde_json::from_slice(&STANDARD.decode(&proof.value).unwrap()).unwrap();
    assert_eq!(
        STANDARD
            .decode(payload["payload"]["transaction"].as_str().unwrap())
            .unwrap(),
        wire
    );
    assert_eq!(payload["accepted"], accepted);

    // The facilitator decodes the bytes of the proof, signs its place as fee payer and submits
    // them: 2.5 USDC reach the seller, and the facilitator pays the fee of three signatures.
    let before = svm.get_balance(&address(&facilitator)).unwrap();
    let received = STANDARD
        .decode(payload["payload"]["transaction"].as_str().unwrap())
        .unwrap();
    let mut tx: Transaction = wincode::deserialize(&received).unwrap();
    assert_eq!(tx.signatures[0], Signature::default());
    let message = tx.message.serialize();
    let fee_payer: [u8; 64] = facilitator
        .sign_bytes(&message)
        .unwrap()
        .try_into()
        .unwrap();
    tx.signatures[0] = Signature::from(fee_payer);
    svm.send_transaction(tx).unwrap();
    assert_eq!(amount_of(&svm, &seller_account), 2_500_000);
    assert_eq!(amount_of(&svm, &wallet.token_account()), 7_500_000);
    assert_eq!(
        before - svm.get_balance(&address(&facilitator)).unwrap(),
        native::fee(3, Budget::PAYMENT)
    );

    // A challenge of another asset than the wallet holds is refused before signing.
    let mut other = challenge.clone();
    other.asset = address(&seller).to_string();
    assert!(x402::payment(&wallet, &other, Budget::PAYMENT, svm.latest_blockhash()).is_err());
}
