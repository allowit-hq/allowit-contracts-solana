//! The rail's runtime on a ledger: LiteSVM runs the SPL Token, System, Compute Budget and Memo
//! programs in process behind the runtime's `Chain`. A server and an agent take a payment through
//! every step of `RuntimeProvider`, and the owner stops and closes the wallet.
mod common;
use allowit_core::vendor::error::Error;
use allowit_solana::native::{Address, SYSTEM_PROGRAM, TOKEN_PROGRAM};
use common::*;

/// A refusal of the rail with its catalogue code and the rule that it names.
fn refused_for(error: Error, reason: &str) {
    assert_eq!(
        error.api_code.as_deref(),
        Some("operation_refused"),
        "{}",
        error.message
    );
    assert_eq!(
        error.details.as_ref().expect("details")["reason"],
        reason,
        "{}",
        error.message
    );
}

#[test]
fn a_payment_to_an_account_that_cannot_receive_the_token_is_refused_before_signing() {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let i = f.installed();
    let accounting = Accounting::default();
    let mint: Address = USDC_DEVNET.parse().unwrap();
    let token = |mint: &Address, state: u8| {
        let mut data = vec![0u8; 165];
        data[0..32].copy_from_slice(mint.as_ref());
        data[32..64].copy_from_slice(&[7; 32]);
        data[108] = state;
        data
    };
    let set = |seed: u8, owner: Address, data: Vec<u8>| {
        let at = Address::new_from_array([seed; 32]);
        let account = Account {
            lamports: 2_039_280,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        };
        f.chain
            .0
            .lock()
            .unwrap()
            .svm
            .set_account(at, account)
            .unwrap();
        at
    };
    let cases = [
        ("no account", Address::new_from_array([21; 32])),
        (
            "another mint",
            set(
                22,
                TOKEN_PROGRAM,
                token(&Address::new_from_array([6; 32]), 1),
            ),
        ),
        ("a system account", set(23, SYSTEM_PROGRAM, vec![])),
        ("a frozen account", set(24, TOKEN_PROGRAM, token(&mint, 2))),
        (
            "an uninitialized account",
            set(25, TOKEN_PROGRAM, token(&mint, 0)),
        ),
        ("a wallet key", address(&signer(9))),
    ];
    for (what, recipient) in cases {
        let request = f
            .runtime
            .request(
                &i,
                [31; 32],
                Action::Transfer {
                    recipient: recipient.to_string(),
                    units: i128::from(TOKEN),
                },
                Some(&accounting),
            )
            .unwrap();
        let refused = f
            .runtime
            .prepare(
                &i,
                &request,
                &Terms::default(),
                Some(&accounting),
                f.validity(),
            )
            .expect_err(what);
        assert!(refused.message.contains("Nothing was signed"), "{what}");
        refused_for(refused, "recipient_token_account");
    }
    assert_eq!(f.chain.0.lock().unwrap().submissions, 0);

    // A recipient whose account goes between the preparation and the signatures is refused too.
    let request = f
        .runtime
        .request(&i, [32; 32], f.transfer(TOKEN), Some(&accounting))
        .unwrap();
    let prepared = f
        .runtime
        .prepare(
            &i,
            &request,
            &Terms::default(),
            Some(&accounting),
            f.validity(),
        )
        .unwrap();
    f.runtime.revalidate(&i, &prepared, NOW).unwrap();
    let payee = f.payee;
    f.chain
        .0
        .lock()
        .unwrap()
        .svm
        .set_account(payee, Account::default())
        .unwrap();
    refused_for(
        f.runtime.revalidate(&i, &prepared, NOW).unwrap_err(),
        "recipient_token_account",
    );
}

#[test]
fn no_payment_is_prepared_admitted_or_signed_in_the_last_two_minutes_of_a_utc_day() {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let i = f.installed();
    let accounting = Accounting::default();
    let midnight = NOW - NOW % 86_400 + 86_400;
    // 23:57:59 UTC passes; 23:58:00 is the first refused second.
    let (before, at) = (midnight - 121, midnight - 120);
    let validity = |now| Validity {
        now,
        expires_at: now + 600,
    };
    let request = f
        .runtime
        .request(&i, [33; 32], f.transfer(TOKEN), Some(&accounting))
        .unwrap();
    let prepare = |now| {
        f.runtime.prepare(
            &i,
            &request,
            &Terms::default(),
            Some(&accounting),
            validity(now),
        )
    };
    refused_for(prepare(at).unwrap_err(), "utc_day_end");
    let prepared = prepare(before).unwrap();
    f.runtime
        .authorize_preparation(&i, &prepared, &f.server, None, before)
        .unwrap();
    refused_for(
        f.runtime
            .authorize_preparation(&i, &prepared, &f.server, None, at)
            .unwrap_err(),
        "utc_day_end",
    );
    f.runtime.revalidate(&i, &prepared, before).unwrap();
    refused_for(
        f.runtime.revalidate(&i, &prepared, at).unwrap_err(),
        "utc_day_end",
    );
    f.runtime.sign(&i, &prepared, &f.agent, before).unwrap();
    for signer in [&f.agent, &f.server] {
        refused_for(
            f.runtime.sign(&i, &prepared, signer, at).unwrap_err(),
            "utc_day_end",
        );
    }
    // The refusal says when to ask again, and the next day starts at once.
    let left = allowit_solana::runtime::day_end(midnight - 1).unwrap_err();
    assert_eq!(left.details.unwrap()["retryAfterSecs"], 1);
    allowit_solana::runtime::day_end(midnight).unwrap();
    assert_eq!(f.chain.0.lock().unwrap().submissions, 0);
}

#[test]
fn an_installation_is_imported_only_with_its_owners_consent_and_its_own_server() {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let i = f.installed();
    assert_eq!(i.description.wallet, f.config.wallet);
    assert_eq!(i.description.policy_id, "policy-1");
    assert_eq!(i.description.asset_symbol, "USDC");
    // The agent's or the server's signature is no consent of the owner.
    assert!(f.runtime.import(&f.authority, &f.bundle(&f.agent)).is_err());
    assert!(
        f.runtime
            .import(&f.authority, &f.bundle(&f.server))
            .is_err()
    );
    // Another server's authority does not import this wallet.
    let other = ServerAuthority::validated(DEVNET, "https://allowit.example", signer(9).identity())
        .unwrap();
    assert!(f.runtime.import(&other, &f.bundle(&f.owner)).is_err());
    // A consent for another installation: the same signature under a changed fee bound.
    let mut bundle: Bundle = serde_json::from_slice(&f.bundle(&f.owner)).unwrap();
    bundle.config.max_fee_lamports += 1;
    assert!(
        f.runtime
            .import(&f.authority, &serde_json::to_vec(&bundle).unwrap())
            .is_err()
    );
    let snapshot = f
        .runtime
        .snapshot(&i, Some(&Accounting::default()))
        .unwrap();
    assert!(!snapshot.paused);
    assert_eq!(snapshot.observed_height, 1_000);
    assert!(f.runtime.snapshot(&i, None).is_err());
    let resources = f.runtime.resources(&i).unwrap();
    assert!(resources.wallet_present && resources.lifetime.is_none());
}

#[test]
fn a_payment_passes_every_step_and_settles_what_the_ledger_moved() {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let i = f.installed();
    let accounting = Accounting::default();
    let request = f
        .runtime
        .request(&i, [4; 32], f.transfer(2 * TOKEN), Some(&accounting))
        .unwrap();
    assert_eq!(request.operation_id().unwrap(), [4; 32]);
    let read = f.runtime.read_request(&i, request.bytes()).unwrap();
    assert!(read == request);
    let Action::Transfer { units, .. } = f.runtime.action(&i, &read).unwrap() else {
        panic!("a transfer");
    };
    assert_eq!(units, i128::from(2 * TOKEN));

    let prepared = f
        .runtime
        .prepare(
            &i,
            &read,
            &Terms::default(),
            Some(&accounting),
            f.validity(),
        )
        .unwrap();
    let metadata = prepared
        .0
        .provider()
        .prepared_metadata(&prepared.0)
        .unwrap();
    assert_eq!(
        metadata.expires_at,
        NOW + 60,
        "one blockhash, not ten minutes"
    );
    assert_eq!(metadata.debit_units, i128::from(2 * TOKEN));
    f.runtime
        .authorize_preparation(&i, &prepared, &f.server, None, NOW)
        .unwrap();
    assert!(
        f.runtime
            .authorize_preparation(&i, &prepared, &f.agent, None, NOW)
            .is_err()
    );
    f.runtime.revalidate(&i, &prepared, NOW).unwrap();

    let by_agent = f.runtime.sign(&i, &prepared, &f.agent, NOW).unwrap();
    let by_server = f.runtime.sign(&i, &prepared, &f.server, NOW).unwrap();
    assert!(f.runtime.sign(&i, &prepared, &f.owner, NOW).is_err());
    // One signature, two of the same key, or a signature of another payment is no quorum.
    let authorize = |signatures: &[_]| f.runtime.authorize(&i, &prepared, signatures, NOW);
    assert!(authorize(std::slice::from_ref(&by_agent)).is_err());
    assert!(authorize(&[by_agent.clone(), by_agent.clone()]).is_err());
    let mut forged = by_server.clone();
    forged.bytes[0] ^= 1;
    assert!(authorize(&[by_agent.clone(), forged]).is_err());
    let signed = authorize(&[by_agent, by_server]).unwrap();
    f.runtime.validate_signed(&signed, NOW).unwrap();
    assert!(f.runtime.validate_signed(&signed, NOW + 60).is_err());

    assert_eq!(
        f.runtime.status(&signed).unwrap(),
        Status::SubmissionUnknown
    );
    assert_eq!(f.runtime.observe(&signed).unwrap().map(|_| ()), None);
    assert_eq!(
        f.runtime.broadcast(&signed, NOW).unwrap(),
        Status::Submitted
    );
    assert_eq!(f.runtime.status(&signed).unwrap(), Status::Confirmed);
    assert_eq!(f.balance(&f.payee), 2 * TOKEN);

    let receipt = f.runtime.observe(&signed).unwrap().unwrap();
    let provider = receipt.0.provider();
    provider.verify_receipt(&receipt.0, &signed.0).unwrap();
    let info = provider.receipt_info(&receipt.0).unwrap();
    assert_eq!(info.status, Status::Confirmed);
    assert_eq!(info.fee.native_units, 10_001);
    assert_eq!(info.debits[0].units, i128::from(2 * TOKEN));
    assert_eq!(
        provider.receipt_settled_at(&receipt.0).unwrap(),
        Some(NOW + 5)
    );
    let settlement = f
        .runtime
        .settle_receipt(&prepared, &signed, &receipt, Some(&accounting), 0)
        .unwrap();
    assert_eq!(settlement.outcome, OperationOutcome::Executed);
    assert_eq!(settlement.next_nonce, Some(1));
    assert_eq!(settlement.fee_units, 10_001);
    assert!(
        f.runtime
            .settle_receipt(&prepared, &signed, &receipt, None, 0)
            .is_err()
    );
    // A payment that the ledger holds never lapses, however old its blockhash becomes.
    f.chain.0.lock().unwrap().height = 9_000;
    assert!(!f.runtime.lapsed(&prepared).unwrap());
    assert_eq!(f.runtime.status(&signed).unwrap(), Status::Confirmed);
    // The same bytes again move nothing more.
    assert_eq!(
        f.runtime.broadcast(&signed, NOW).unwrap(),
        Status::Submitted
    );
    assert_eq!(f.balance(&f.payee), 2 * TOKEN);
}

#[test]
fn a_lost_payment_stays_unknown_until_its_blockhash_lapses() {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let i = f.installed();
    let accounting = Accounting::default();
    let request = f
        .runtime
        .request(&i, [6; 32], f.transfer(TOKEN), Some(&accounting))
        .unwrap();
    let prepared = f
        .runtime
        .prepare(
            &i,
            &request,
            &Terms::default(),
            Some(&accounting),
            f.validity(),
        )
        .unwrap();
    let signed = f
        .runtime
        .authorize(
            &i,
            &prepared,
            &[
                f.runtime.sign(&i, &prepared, &f.agent, NOW).unwrap(),
                f.runtime.sign(&i, &prepared, &f.server, NOW).unwrap(),
            ],
            NOW,
        )
        .unwrap();
    f.chain.0.lock().unwrap().lose = true;
    assert!(
        !f.runtime.lapsed(&prepared).unwrap(),
        "its blockhash is live"
    );
    assert_eq!(
        f.runtime.broadcast(&signed, NOW).unwrap(),
        Status::SubmissionUnknown
    );
    assert_eq!(
        f.runtime.status(&signed).unwrap(),
        Status::SubmissionUnknown
    );
    // The last valid height is not past it; one more is the lapse.
    f.chain.0.lock().unwrap().height = 1_150;
    assert_eq!(
        f.runtime.status(&signed).unwrap(),
        Status::SubmissionUnknown
    );
    f.chain.0.lock().unwrap().height = 1_151;
    assert_eq!(f.runtime.status(&signed).unwrap(), Status::Prepared);
    assert!(f.runtime.lapsed(&prepared).unwrap());
    assert_eq!(f.balance(&f.payee), 0);
    // A payment that the wallet can no longer cover is refused before anyone signs.
    assert!(f.runtime.revalidate(&i, &prepared, NOW).is_err());
    let over = f
        .runtime
        .request(&i, [7; 32], f.transfer(6 * TOKEN), Some(&accounting))
        .unwrap();
    f.chain.0.lock().unwrap().lose = false;
    let prepared = f
        .runtime
        .prepare(
            &i,
            &over,
            &Terms::default(),
            Some(&accounting),
            f.validity(),
        )
        .unwrap();
    assert!(
        f.runtime.revalidate(&i, &prepared, NOW).is_err(),
        "above the allowance"
    );
}

#[test]
fn the_owner_stops_returns_and_closes_the_wallet_alone() {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let i = f.installed();
    let accounting = Accounting::default();
    // The owner's wallet signs the step's message and returns the signed transaction.
    let sign = |step: &allowit_core::vendor::runtime::OwnerPacket, key: &KeySigner| {
        let info = step.0.provider().owner_info(&step.0).unwrap();
        let message = STANDARD.decode(&info.signing_payload).unwrap();
        let mut wire = vec![1u8];
        wire.extend(key.sign_bytes(&message).unwrap());
        wire.extend(message);
        STANDARD.encode(wire)
    };
    let run = |action: OwnerAction, now: u64| {
        let step = f.runtime.prepare_owner(&i, action, 5_000, now)?;
        let signed = f
            .runtime
            .read_owner_signed(&step, sign(&step, &f.owner).as_bytes())?;
        f.runtime.validate_owner_signed(&signed, Some(&i), now)?;
        assert_eq!(f.runtime.owner_status(&signed)?, Status::SubmissionUnknown);
        assert_eq!(
            f.runtime.broadcast_owner(&signed, Some(&i), now)?,
            Status::Submitted
        );
        let receipt = f.runtime.observe_owner(&signed)?.unwrap();
        receipt.0.provider().verify_receipt(&receipt.0, &signed.0)?;
        assert!(!f.runtime.owner_step_lapsed(&signed, 0)?);
        Ok::<_, Error>(receipt.0.provider().receipt_info(&receipt.0)?.status)
    };
    // Another key's signature is not the owner's step.
    let step = f
        .runtime
        .prepare_owner(&i, OwnerAction::SetPause { paused: true }, 5_000, NOW)
        .unwrap();
    assert!(
        f.runtime
            .read_owner_signed(&step, sign(&step, &f.agent).as_bytes())
            .is_err()
    );
    assert!(
        f.runtime
            .prepare_owner(&i, OwnerAction::SetPause { paused: true }, 4_999, NOW)
            .is_err()
    );

    assert_eq!(
        run(OwnerAction::SetPause { paused: true }, NOW).unwrap(),
        Status::Confirmed
    );
    assert!(f.runtime.snapshot(&i, Some(&accounting)).unwrap().paused);
    assert!(
        f.runtime
            .request(&i, [4; 32], f.transfer(TOKEN), Some(&accounting))
            .is_err(),
        "a stopped wallet takes no request"
    );
    // A refill approves the wallet's own delegate again: it resumes the wallet with exactly
    // that allowance, and a second refill adds to what is left.
    assert!(
        f.runtime
            .prepare_owner(&i, OwnerAction::SetPause { paused: false }, 5_000, NOW)
            .is_err(),
        "a resume states no allowance"
    );
    let allowance = |f: &Fixture| {
        let state = f.chain.0.lock().unwrap();
        let data = state
            .svm
            .get_account(&f.wallet.token_account())
            .unwrap()
            .data;
        u64::from_le_bytes(data[121..129].try_into().unwrap())
    };
    assert_eq!(allowance(&f), 0);
    assert_eq!(
        run(
            OwnerAction::Fund {
                units: 3 * TOKEN as i128
            },
            NOW + 4
        )
        .unwrap(),
        Status::Confirmed
    );
    assert!(!f.runtime.snapshot(&i, Some(&accounting)).unwrap().paused);
    assert_eq!(allowance(&f), 3 * TOKEN);
    assert_eq!(
        run(
            OwnerAction::Fund {
                units: 2 * TOKEN as i128
            },
            NOW + 5
        )
        .unwrap(),
        Status::Confirmed
    );
    assert_eq!(allowance(&f), 5 * TOKEN);
    assert!(
        f.runtime
            .prepare_owner(&i, OwnerAction::Fund { units: 0 }, 5_000, NOW)
            .is_err()
    );
    f.runtime
        .request(&i, [4; 32], f.transfer(TOKEN), Some(&accounting))
        .unwrap();
    assert_eq!(
        run(OwnerAction::SetPause { paused: true }, NOW + 6).unwrap(),
        Status::Confirmed
    );
    // A close with a balance is refused; the owner returns it first.
    assert!(f.runtime.prepare_close(&i, 5_000, NOW + 1).is_err());
    let home = f.payee.to_string();
    assert_eq!(
        run(
            OwnerAction::Recover {
                units: Some(4 * TOKEN as i128),
                recipient: Some(home.clone())
            },
            NOW + 1
        )
        .unwrap(),
        Status::Confirmed
    );
    assert_eq!(
        run(
            OwnerAction::Recover {
                units: None,
                recipient: Some(home)
            },
            NOW + 2
        )
        .unwrap(),
        Status::Confirmed
    );
    assert_eq!(f.balance(&f.payee), 10 * TOKEN);
    assert!(!f.runtime.wallet_closed(&i).unwrap());
    let close = f.runtime.prepare_close(&i, 5_000, NOW + 3).unwrap();
    let signed = f
        .runtime
        .read_owner_signed(&close, sign(&close, &f.owner).as_bytes())
        .unwrap();
    assert!(
        f.runtime
            .validate_owner_signed(&signed, Some(&i), NOW + 63)
            .is_err(),
        "past its send cutoff"
    );
    assert_eq!(
        f.runtime
            .broadcast_owner(&signed, Some(&i), NOW + 3)
            .unwrap(),
        Status::Submitted
    );
    assert!(f.runtime.wallet_closed(&i).unwrap());
    assert!(!f.runtime.resources(&i).unwrap().wallet_present);
    // A closed wallet takes no step, and a Native wallet has nothing to extend.
    for action in [OwnerAction::Fund { units: 1 }, OwnerAction::Extend] {
        assert!(f.runtime.prepare_owner(&i, action, 5_000, NOW).is_err());
    }
    let _ = &f.wallet;
}
