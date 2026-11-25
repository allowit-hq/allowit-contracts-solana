//! The Allowit facilitator's settlement service settles a Native wallet's x402 payment to a test
//! seller on a ledger: LiteSVM runs the SPL Token, System, Compute Budget and Memo programs.
mod common;
use allowit_core::vendor::settlement_service::{Limits, Outcome, Settled, SettlementProvider};
use allowit_solana::{
    native::Budget,
    settlement_service::{self as service, SERVICE, Service, SettlementLedger},
    x402,
};
use common::*;
use serde_json::{Value, json};
use solana_hash::Hash;
use std::time::Duration;

const LIMITS: Limits = Limits {
    max_fee: 100_000,
    wait: Duration::ZERO,
};

impl SettlementLedger for Svm {
    fn genesis_hash(&self) -> Result<String> {
        Ok("EtWTRABZaYq6iMfeYKouRu166VU2xqa1xxxxxxxxxxxx".into())
    }
    /// LiteSVM accepts its latest blockhash only; it is valid for 150 blocks from the height.
    fn blockhash_bound(&self, blockhash: &Hash) -> Result<Option<u64>> {
        let state = self.0.lock().unwrap();
        Ok((state.svm.latest_blockhash() == *blockhash).then_some(state.height + 150))
    }
    fn simulate(&self, wire: &[u8]) -> Result<Option<String>> {
        let tx: Transaction = wincode::deserialize(wire).unwrap();
        let mut state = self.0.lock().unwrap();
        let svm = std::mem::take(&mut state.svm).with_sigverify(false);
        let failed = svm.simulate_transaction(tx).is_err();
        state.svm = svm.with_sigverify(true);
        Ok(failed.then(|| "simulation failed".to_owned()))
    }
}

struct Seller {
    f: Fixture,
    facilitator: KeySigner,
    seller: Address,
    ata: Address,
}

/// A wallet that holds 10 tokens with an allowance of 5, a seller with its associated token
/// account, and a facilitator with lamports for fees.
fn seller() -> Seller {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let facilitator = signer(4);
    let seller = address(&signer(5));
    let ata = x402::associated_token_account(&seller, &f.wallet.mint);
    {
        let mut state = f.chain.0.lock().unwrap();
        state
            .svm
            .airdrop(&address(&facilitator), 1_000_000_000)
            .unwrap();
        let mut data = vec![0u8; 165];
        data[0..32].copy_from_slice(f.wallet.mint.as_ref());
        data[32..64].copy_from_slice(seller.as_ref());
        data[108] = 1;
        let lamports = state.svm.minimum_balance_for_rent_exemption(165);
        state
            .svm
            .set_account(
                ata,
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
    Seller {
        f,
        facilitator,
        seller,
        ata,
    }
}

impl Seller {
    fn requirements(&self, units: u64) -> Value {
        json!({
            "scheme": "exact", "network": DEVNET, "amount": units.to_string(), "asset": USDC_DEVNET,
            "payTo": self.seller.to_string(), "maxTimeoutSeconds": 60,
            "extra": {"feePayer": address(&self.facilitator).to_string()},
        })
    }
    /// The seller's request: the client's payment, signed by the agent and the server.
    fn request(&self, units: u64, memo: &str) -> Value {
        let requirements = self.requirements(units);
        let blockhash = self.f.chain.0.lock().unwrap().svm.latest_blockhash();
        let p = self
            .f
            .wallet
            .payment(
                &self.ata,
                units,
                DECIMALS,
                Budget::PAYMENT,
                Some(memo),
                &address(&self.facilitator),
                blockhash,
            )
            .unwrap();
        let wire = p
            .wire(&[
                p.sign(&self.f.agent).unwrap(),
                p.sign(&self.f.server).unwrap(),
            ])
            .unwrap();
        json!({
            "x402Version": 2,
            "paymentPayload": {
                "x402Version": 2, "accepted": requirements,
                "payload": {"transaction": STANDARD.encode(wire)},
            },
            "paymentRequirements": requirements,
        })
    }
    fn settle(&self, service: &Service, request: &Value) -> Settled {
        service
            .settle_on(
                &*self.f.chain,
                DEVNET,
                &self.facilitator,
                request,
                &LIMITS,
                NOW,
                Duration::ZERO,
            )
            .unwrap()
    }
    fn paid(&self) -> u64 {
        self.f.balance(&self.ata)
    }
}

fn reason(settled: &Settled) -> &str {
    settled.reply["errorReason"].as_str().unwrap_or_default()
}

#[test]
fn a_native_payment_settles_once_with_three_signatures() {
    let s = seller();
    let request = s.request(2 * TOKEN, "order 1");
    let identity = address(&s.facilitator).to_string();
    let verified = Service::new(service::HOURLY_FEE_LAMPORTS)
        .verify_on(&*s.f.chain, DEVNET, &identity, &request, &LIMITS, NOW)
        .unwrap();
    assert_eq!(verified.reply["isValid"], true, "{}", verified.reply);
    assert_eq!(verified.fee, 15_001);
    assert_eq!(
        verified.authorization.as_ref().unwrap().payer,
        s.f.wallet.token_account().to_string()
    );

    let service = Service::new(service::HOURLY_FEE_LAMPORTS);
    let settled = s.settle(&service, &request);
    assert_eq!(settled.outcome, Outcome::Settled, "{}", settled.reply);
    assert_eq!(settled.reply["success"], true);
    assert_eq!(settled.fee_paid, Some(15_001));
    assert_eq!(s.paid(), 2 * TOKEN);
    let signature = settled.reply["transaction"].as_str().unwrap().to_owned();
    assert!(s.f.chain.0.lock().unwrap().finalized.contains_key(
        &<[u8; 64]>::try_from(bs58::decode(&signature).into_vec().unwrap()).unwrap()
    ));

    // The same payment again: a duplicate, refused before the ledger is asked.
    let submissions = s.f.chain.0.lock().unwrap().submissions;
    let again = s.settle(&service, &request);
    assert_eq!(
        (again.outcome, reason(&again)),
        (Outcome::Refused, service::DUPLICATE)
    );
    assert!(
        again.reply["errorMessage"]
            .as_str()
            .unwrap()
            .contains(&signature)
    );
    assert_eq!(s.f.chain.0.lock().unwrap().submissions, submissions);
    assert_eq!(s.paid(), 2 * TOKEN);
    // Observing the settled transaction reads the same outcome.
    let observed = service
        .observe_on(&*s.f.chain, DEVNET, &request, &settled.transaction.unwrap())
        .unwrap();
    assert_eq!(observed.outcome, Outcome::Settled);
}

#[test]
fn a_lost_answer_is_read_by_its_signature_and_only_the_same_bytes_are_sent_again() {
    let s = seller();
    let request = s.request(TOKEN, "order 2");
    let service = Service::new(service::HOURLY_FEE_LAMPORTS);
    s.f.chain.0.lock().unwrap().lose = true;
    let pending = s.settle(&service, &request);
    assert_eq!(pending.outcome, Outcome::Pending, "{}", pending.reply);
    assert_eq!(reason(&pending), service::PENDING);
    let id = pending.transaction.unwrap();
    // A retry of the seller is a duplicate: no second transaction is built.
    assert_eq!(reason(&s.settle(&service, &request)), service::DUPLICATE);
    s.f.chain.0.lock().unwrap().lose = false;
    // The first read finds no status and sends the identical bytes again; the next reads them.
    let resent = service
        .observe_on(&*s.f.chain, DEVNET, &request, &id)
        .unwrap();
    assert_eq!(resent.outcome, Outcome::Pending);
    let settled = service
        .observe_on(&*s.f.chain, DEVNET, &request, &id)
        .unwrap();
    assert_eq!(settled.outcome, Outcome::Settled, "{}", settled.reply);
    // The transaction that landed is the one that the first answer named.
    assert_eq!(settled.reply["transaction"], pending.reply["transaction"]);
    assert_eq!(s.paid(), TOKEN);
    // Another request's transaction is not this one's.
    assert!(
        service
            .observe_on(&*s.f.chain, DEVNET, &request, &[0; 32])
            .is_err()
    );
}

#[test]
fn a_lapsed_blockhash_gives_a_lapse_proof_and_returns_the_reserved_fee() {
    let s = seller();
    // A budget of one payment's fee.
    let service = Service::new(15_001);
    let request = s.request(TOKEN, "order 3");
    s.f.chain.0.lock().unwrap().lose = true;
    let pending = s.settle(&service, &request);
    assert_eq!(pending.outcome, Outcome::Pending);
    // The budget holds the reservation while the outcome is unknown.
    let other = s.request(TOKEN, "order 4");
    assert_eq!(
        reason(&s.settle(&service, &other)),
        service::BUDGET_EXHAUSTED
    );
    // Still valid: no lapse yet.
    let still = service
        .observe_on(&*s.f.chain, DEVNET, &request, &pending.transaction.unwrap())
        .unwrap();
    assert_eq!(still.outcome, Outcome::Pending);
    {
        let mut state = s.f.chain.0.lock().unwrap();
        state.height += 151;
        state.lose = false;
    }
    let lapsed = service
        .observe_on(&*s.f.chain, DEVNET, &request, &pending.transaction.unwrap())
        .unwrap();
    assert_eq!(
        (lapsed.outcome, reason(&lapsed)),
        (Outcome::Refused, service::LAPSED)
    );
    assert_eq!(lapsed.reply["lapse"]["lastValidBlockHeight"], 1_150);
    assert_eq!(lapsed.reply["lapse"]["finalizedBlockHeight"], 1_151);
    assert_eq!(s.paid(), 0);
    // The fee came back: the next payment fits the budget.
    let next = s.settle(&service, &s.request(TOKEN, "order 5"));
    assert_eq!(next.outcome, Outcome::Settled, "{}", next.reply);
}

#[test]
fn the_service_refuses_before_it_signs() {
    let s = seller();
    let service = Service::new(service::HOURLY_FEE_LAMPORTS);
    let refused = |request: &Value, limits: &Limits| {
        let settled = service
            .settle_on(
                &*s.f.chain,
                DEVNET,
                &s.facilitator,
                request,
                limits,
                NOW,
                Duration::ZERO,
            )
            .unwrap();
        assert_eq!(settled.outcome, Outcome::Refused, "{}", settled.reply);
        settled.reply["errorReason"].as_str().unwrap().to_owned()
    };
    let request = s.request(TOKEN, "order 6");
    // The host's fee ceiling.
    let low = Limits {
        max_fee: 15_000,
        ..LIMITS
    };
    assert_eq!(refused(&request, &low), service::INVALID_TRANSACTION);
    // Requirements other than the ones that the payload accepted.
    let mut other = request.clone();
    other["paymentRequirements"]["amount"] = json!("1");
    assert_eq!(refused(&other, &LIMITS), service::INVALID_REQUEST);
    // An offer past its expiry.
    let mut expired = request.clone();
    for at in ["/paymentRequirements", "/paymentPayload/accepted"] {
        expired.pointer_mut(at).unwrap()["extra"]["expiresAt"] = json!(NOW);
    }
    assert_eq!(refused(&expired, &LIMITS), service::OFFER_EXPIRED);
    // Another facilitator's payment.
    let mut theirs = request.clone();
    for at in ["/paymentRequirements", "/paymentPayload/accepted"] {
        theirs.pointer_mut(at).unwrap()["extra"]["feePayer"] =
            json!(address(&signer(9)).to_string());
    }
    assert_eq!(refused(&theirs, &LIMITS), service::INVALID_TRANSACTION);
    // More than the delegate's allowance: the simulation fails.
    assert_eq!(
        refused(&s.request(6 * TOKEN, "order 7"), &LIMITS),
        service::SIMULATION_FAILED
    );
    // A blockhash that the ledger no longer accepts.
    s.f.chain.0.lock().unwrap().svm.expire_blockhash();
    assert_eq!(refused(&request, &LIMITS), service::BLOCKHASH_EXPIRED);
    assert_eq!(s.f.chain.0.lock().unwrap().submissions, 0);
    assert_eq!(s.paid(), 0);
}

#[test]
fn the_plugin_serves_devnet_only() {
    let supported = SERVICE.supported(DEVNET).unwrap();
    assert_eq!(supported.kinds[0]["scheme"], "exact");
    assert_eq!(supported.kinds[0]["network"], DEVNET);
    assert!(
        SERVICE
            .supported("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
            .is_err()
    );
}
