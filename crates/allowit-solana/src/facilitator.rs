//! The Allowit facilitator for x402 `exact` payments on Solana Devnet.
//!
//! A seller that names the Allowit facilitator sends it the client's partly signed payment and the
//! accepted requirement. The facilitator checks the transaction against the requirement
//! ([`x402::check_payment`]: the layout of an `exact` payment, exactly the required transfer, the
//! fee payer's place empty, every client signature valid and the network fee within the host's
//! bound), applies its own bounds, checks that the ledger's block heights of the signed blockhash
//! expire within the seller's settlement time ([`x402::check_expiry`]), simulates
//! it, signs it as fee payer and submits it. It holds no customer funds: its key only pays the
//! network fee, within the host's fee bound.
//!
//! A Native wallet's transfer authority is a multisig of the agent and the server, so its payment
//! has three signatures. The Allowit facilitator accepts three, where a facilitator on the
//! reference default of two refuses it.
use crate::{
    native::Address,
    x402::{self, PaymentCheck, Recent},
};
use allowit_core::vendor::{
    error::{Error, Result},
    runtime::Signer,
};
use serde_json::Value;

/// What the facilitator accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    /// The facilitator's fee-payer key.
    pub fee_payer: Address,
    /// The most required signatures, the fee payer's included. A Native payment needs 3.
    pub max_signatures: usize,
    /// The largest compute-unit limit.
    pub max_compute_units: u32,
    /// The highest compute-unit price, in micro-lamports.
    pub max_micro_lamports_per_unit: u64,
}

impl Policy {
    /// The policy of the Allowit facilitator: three signatures, 200,000 units, 1,000,000
    /// micro-lamports a unit.
    pub fn allowit(fee_payer: Address) -> Self {
        Self {
            fee_payer,
            max_signatures: 3,
            max_compute_units: 200_000,
            max_micro_lamports_per_unit: 1_000_000,
        }
    }
}

/// The ledger that the facilitator reads and writes.
pub trait Ledger {
    /// The block heights of `blockhash` as the ledger reports them now: the last block height at
    /// which it is valid, and the current block height.
    fn heights(&self, blockhash: &solana_hash::Hash) -> Result<Recent>;
    /// Simulate `wire` without signature checks: the fee payer's place may be empty.
    fn simulate(&self, wire: &[u8]) -> Result<()>;
    /// Submit the fully signed `wire`.
    fn submit(&self, wire: &[u8]) -> Result<()>;
}

/// Check `wire`, a client's partly signed payment, against `accepted` under `policy`. `max_fee`
/// bounds the network fee of its settlement, in lamports.
pub fn check(wire: &[u8], accepted: &Value, policy: &Policy, max_fee: u64) -> Result<PaymentCheck> {
    if accepted["extra"]["feePayer"].as_str() != Some(policy.fee_payer.to_string().as_str()) {
        return Err(Error::usage(
            "The requirement names another fee payer than this facilitator.",
        ));
    }
    let payment = x402::check_payment(wire, accepted, max_fee)?;
    if payment.signatures > policy.max_signatures {
        return Err(Error::usage(format!(
            "The payment needs {} signatures; this facilitator accepts {}.",
            payment.signatures, policy.max_signatures
        )));
    }
    if payment.compute_units > policy.max_compute_units {
        return Err(Error::usage(
            "The payment's compute-unit limit is above this facilitator's bound.",
        ));
    }
    if payment.micro_lamports_per_unit > policy.max_micro_lamports_per_unit {
        return Err(Error::usage(
            "The payment's compute-unit price is above this facilitator's bound.",
        ));
    }
    Ok(payment)
}

/// Check `wire` and simulate it on `ledger`, without submitting anything.
pub fn verify(
    wire: &[u8],
    accepted: &Value,
    policy: &Policy,
    max_fee: u64,
    ledger: &dyn Ledger,
) -> Result<PaymentCheck> {
    let checked = check(wire, accepted, policy, max_fee)?;
    let recent = ledger.heights(&checked.blockhash)?;
    if recent.blockhash != checked.blockhash {
        return Err(Error::config(
            "The ledger reported the heights of another blockhash.",
        ));
    }
    x402::check_expiry(x402::settle_within(accepted)?, &recent)?;
    ledger.simulate(wire)?;
    Ok(checked)
}

/// Check `wire` again, sign it with the facilitator's key as fee payer and submit it. Returns the
/// check and the fee payer's signature, which is the transaction's id.
pub fn settle(
    wire: &[u8],
    accepted: &Value,
    policy: &Policy,
    max_fee: u64,
    signer: &dyn Signer,
    ledger: &dyn Ledger,
) -> Result<(PaymentCheck, [u8; 64])> {
    if signer.identity() != policy.fee_payer.to_string() {
        return Err(Error::config(
            "The facilitator's signer is not its fee-payer key.",
        ));
    }
    let checked = verify(wire, accepted, policy, max_fee, ledger)?;
    // A checked payment has one to three signatures: a one-byte count, then the fee payer's place.
    let message = &wire[1 + 64 * checked.signatures..];
    let signature: [u8; 64] = signer
        .sign_bytes(message)?
        .try_into()
        .map_err(|_| Error::config("The facilitator's signature is not 64 bytes."))?;
    let mut signed = wire.to_vec();
    signed[1..65].copy_from_slice(&signature);
    ledger.submit(&signed)?;
    Ok((checked, signature))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        KeySigner,
        native::{Budget, Wallet},
        networks::{DEVNET, USDC_DEVNET},
    };
    use allowit_core::vendor::KeyProvider;
    use serde_json::json;
    use solana_hash::Hash;

    fn signer(seed: u8) -> KeySigner {
        KeySigner(crate::KEYS.derive(&[seed; 32]).unwrap())
    }
    fn address(s: &KeySigner) -> Address {
        s.identity().parse().unwrap()
    }
    struct Fixture {
        accepted: Value,
        policy: Policy,
        wire: Vec<u8>,
    }
    fn fixture(budget: Budget) -> Fixture {
        let (owner, agent, server, facilitator, seller) =
            (signer(1), signer(2), signer(3), signer(4), signer(5));
        let accepted = json!({
            "scheme": "exact", "network": DEVNET, "amount": "2500000", "asset": USDC_DEVNET,
            "payTo": address(&seller).to_string(), "extra": {"feePayer": address(&facilitator).to_string()},
        });
        let wallet = Wallet {
            owner: address(&owner),
            mint: USDC_DEVNET.parse().unwrap(),
            agent: address(&agent),
            server: address(&server),
        };
        let destination = x402::associated_token_account(&address(&seller), &wallet.mint);
        let p = wallet
            .payment(
                &destination,
                2_500_000,
                6,
                budget,
                Some("order 1"),
                &address(&facilitator),
                Hash::default(),
            )
            .unwrap();
        let wire = p
            .wire(&[p.sign(&agent).unwrap(), p.sign(&server).unwrap()])
            .unwrap();
        Fixture {
            accepted,
            policy: Policy::allowit(address(&facilitator)),
            wire,
        }
    }
    const MAX_FEE: u64 = 100_000;

    #[test]
    fn a_native_payment_passes_with_three_signatures_and_not_with_two() {
        let f = fixture(Budget::PAYMENT);
        let checked = check(&f.wire, &f.accepted, &f.policy, MAX_FEE).unwrap();
        assert_eq!((checked.units, checked.fee), (2_500_000, 15_001));
        let two = Policy {
            max_signatures: 2,
            ..f.policy
        };
        assert!(
            check(&f.wire, &f.accepted, &two, MAX_FEE)
                .unwrap_err()
                .message
                .contains("accepts 2")
        );
    }

    #[test]
    fn the_facilitator_settles_only_for_its_own_key_and_within_its_bounds() {
        let f = fixture(Budget::PAYMENT);
        let other = Policy::allowit(address(&signer(6)));
        assert!(check(&f.wire, &f.accepted, &other, MAX_FEE).is_err());
        assert!(check(&f.wire, &f.accepted, &f.policy, 15_000).is_err());
        let pricey = fixture(Budget {
            units: 20_000,
            micro_lamports_per_unit: 2_000_000,
        });
        assert!(check(&pricey.wire, &pricey.accepted, &pricey.policy, u64::MAX).is_err());
        let heavy = fixture(Budget {
            units: 300_000,
            micro_lamports_per_unit: 1,
        });
        assert!(check(&heavy.wire, &heavy.accepted, &heavy.policy, u64::MAX).is_err());
    }
}
