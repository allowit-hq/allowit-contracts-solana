//! The Native wallet: the owner's token account of one asset for one agent, with an SPL Token
//! multisig of the agent and the server, two of two, as its delegate. No Allowit program runs.
//!
//! - The owner creates both accounts from its own key (`createAccountWithSeed`), so the setup needs
//!   no other key, and approves the multisig for an allowance: one owner transaction.
//! - A payment moves tokens with `TransferChecked`, authority the multisig: the agent and the server
//!   both sign, and SPL Token checks both signatures and the allowance. The fee payer is the x402
//!   facilitator or the server; the agent holds a key and no account.
//! - The owner alone stops (`Revoke`), recovers (a transfer of its own), refills (a new approval) and
//!   closes (`CloseAccount`, whose deposit returns to the owner). SPL Token closes no multisig, so its
//!   deposit stays.
//!
//! Everything here builds instructions and messages; the caller sends them. The encodings follow the
//! SPL Token, System, Compute Budget and Memo programs; the ledger tests run them against those
//! programs.
use allowit_core::vendor::{
    error::{Error, Result},
    runtime::Signer,
};
use sha2::{Digest, Sha256};
pub use solana_address::Address;
use solana_address::address;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;
use solana_signature::Signature;
use solana_transaction::Transaction;

/// SPL Token, the classic token program.
pub const TOKEN_PROGRAM: Address = address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SYSTEM_PROGRAM: Address = address!("11111111111111111111111111111111");
pub const COMPUTE_BUDGET_PROGRAM: Address = address!("ComputeBudget111111111111111111111111111111");
/// SPL Memo, the version that x402 facilitators accept.
pub const MEMO_PROGRAM: Address = address!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/// The size of an SPL Token account and of an SPL Token multisig.
pub const TOKEN_ACCOUNT_LEN: u64 = 165;
pub const MULTISIG_LEN: u64 = 355;
/// The base fee of one signature, in lamports.
pub const LAMPORTS_PER_SIGNATURE: u64 = 5_000;
/// The largest serialized transaction.
pub const MAX_TRANSACTION_BYTES: usize = 1_232;

/// One Native wallet: the owner's account of `mint` for `agent`, with the delegate of `agent` and
/// `server`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Wallet {
    pub owner: Address,
    pub mint: Address,
    pub agent: Address,
    pub server: Address,
}

/// The compute budget of a transaction: its compute-unit limit and its price in micro-lamports a
/// unit. The fee is known before anyone signs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    pub units: u32,
    pub micro_lamports_per_unit: u64,
}

impl Budget {
    /// The budget of a payment: 20,000 units at one micro-lamport. A `TransferChecked` with a
    /// two-signer multisig uses about 6,000.
    pub const PAYMENT: Budget = Budget {
        units: 20_000,
        micro_lamports_per_unit: 1,
    };
}

/// The fee of a transaction with `signatures` signatures and `budget`: the base fee of each
/// signature and the priority fee of the requested units, rounded up.
pub fn fee(signatures: u8, budget: Budget) -> u64 {
    let priority =
        (u128::from(budget.units) * u128::from(budget.micro_lamports_per_unit)).div_ceil(1_000_000);
    u64::from(signatures) * LAMPORTS_PER_SIGNATURE + priority as u64
}

/// A `createAccountWithSeed` seed: 32 characters, from a domain tag and the parts it binds.
fn seed(tag: &str, parts: &[&Address]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"allowit-native-v1\0");
    hash.update(tag.as_bytes());
    for part in parts {
        hash.update(part.as_ref());
    }
    let digest = hash.finalize();
    let hex: String = digest[..15].iter().map(|b| format!("{b:02x}")).collect();
    format!("{}:{hex}", &tag[..1])
}

impl Wallet {
    /// The seed of the token account: the same for every server key, so a new server delegate
    /// keeps the account.
    pub fn token_seed(&self) -> String {
        seed("token", &[&self.mint, &self.agent])
    }
    /// The seed of the multisig delegate: it changes with the agent or the server key.
    pub fn delegate_seed(&self) -> String {
        seed("delegate", &[&self.agent, &self.server])
    }
    /// The owner's token account of this wallet.
    pub fn token_account(&self) -> Address {
        Address::create_with_seed(&self.owner, &self.token_seed(), &TOKEN_PROGRAM)
            .expect("a 32-character seed and the token program are valid")
    }
    /// The multisig of the agent and the server, two of two: the delegate of the token account.
    pub fn delegate(&self) -> Address {
        Address::create_with_seed(&self.owner, &self.delegate_seed(), &TOKEN_PROGRAM)
            .expect("a 32-character seed and the token program are valid")
    }

    /// The owner's setup: both accounts with their deposits, and the approval of `allowance` to the
    /// delegate. Only the owner signs, and the owner pays the fee and the deposits.
    pub fn setup(
        &self,
        allowance: u64,
        decimals: u8,
        token_deposit: u64,
        delegate_deposit: u64,
    ) -> Vec<Instruction> {
        let token = self.token_account();
        let delegate = self.delegate();
        vec![
            create_with_seed(
                &self.owner,
                &token,
                &self.token_seed(),
                token_deposit,
                TOKEN_ACCOUNT_LEN,
            ),
            token_ix(18, vec![w(token), r(self.mint)], &self.owner.to_bytes()),
            create_with_seed(
                &self.owner,
                &delegate,
                &self.delegate_seed(),
                delegate_deposit,
                MULTISIG_LEN,
            ),
            token_ix(19, vec![w(delegate), r(self.agent), r(self.server)], &[2]),
            self.approve(allowance, decimals),
        ]
    }

    /// The owner's approval of `allowance` to the delegate: the refill after a payment or a stop,
    /// and the first approval of setup. It replaces the earlier allowance.
    pub fn approve(&self, allowance: u64, decimals: u8) -> Instruction {
        token_ix(
            13,
            vec![
                w(self.token_account()),
                r(self.mint),
                r(self.delegate()),
                rs(self.owner),
            ],
            &amount_and_decimals(allowance, decimals),
        )
    }

    /// A payment of `amount` to the token account `destination`: compute budget, `TransferChecked`
    /// with the delegate as authority and the agent and the server as its signers, and an optional
    /// memo, in the order of the x402 `exact` scheme.
    pub fn payment(
        &self,
        destination: &Address,
        amount: u64,
        decimals: u8,
        budget: Budget,
        memo: Option<&[u8]>,
    ) -> Vec<Instruction> {
        let mut out = vec![
            compute_unit_limit(budget.units),
            compute_unit_price(budget.micro_lamports_per_unit),
            token_ix(
                12,
                vec![
                    w(self.token_account()),
                    r(self.mint),
                    w(*destination),
                    r(self.delegate()),
                    rs(self.agent),
                    rs(self.server),
                ],
                &amount_and_decimals(amount, decimals),
            ),
        ];
        if let Some(memo) = memo {
            out.push(Instruction::new_with_bytes(MEMO_PROGRAM, memo, vec![]));
        }
        out
    }

    /// The owner's stop: the delegate loses its allowance. No payment can follow.
    pub fn stop(&self) -> Instruction {
        token_ix(5, vec![w(self.token_account()), rs(self.owner)], &[])
    }

    /// The owner's recovery of `amount` to its token account `to`.
    pub fn recover(&self, to: &Address, amount: u64, decimals: u8) -> Instruction {
        token_ix(
            12,
            vec![
                w(self.token_account()),
                r(self.mint),
                w(*to),
                rs(self.owner),
            ],
            &amount_and_decimals(amount, decimals),
        )
    }

    /// The owner's close of the empty token account; its deposit returns to the owner.
    pub fn close(&self) -> Instruction {
        token_ix(
            9,
            vec![w(self.token_account()), w(self.owner), rs(self.owner)],
            &[],
        )
    }
}

fn w(address: Address) -> AccountMeta {
    AccountMeta::new(address, false)
}
fn r(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, false)
}
fn rs(address: Address) -> AccountMeta {
    AccountMeta::new_readonly(address, true)
}

fn token_ix(tag: u8, accounts: Vec<AccountMeta>, rest: &[u8]) -> Instruction {
    let mut data = Vec::with_capacity(1 + rest.len());
    data.push(tag);
    data.extend_from_slice(rest);
    Instruction::new_with_bytes(TOKEN_PROGRAM, &data, accounts)
}

fn amount_and_decimals(amount: u64, decimals: u8) -> Vec<u8> {
    let mut out = amount.to_le_bytes().to_vec();
    out.push(decimals);
    out
}

/// System `CreateAccountWithSeed` with `owner` as funder and base, for an SPL Token account.
fn create_with_seed(
    owner: &Address,
    new: &Address,
    seed: &str,
    lamports: u64,
    space: u64,
) -> Instruction {
    let mut data = 3u32.to_le_bytes().to_vec();
    data.extend_from_slice(owner.as_ref());
    data.extend_from_slice(&(seed.len() as u64).to_le_bytes());
    data.extend_from_slice(seed.as_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(TOKEN_PROGRAM.as_ref());
    Instruction::new_with_bytes(
        SYSTEM_PROGRAM,
        &data,
        vec![AccountMeta::new(*owner, true), w(*new), rs(*owner)],
    )
}

fn compute_unit_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET_PROGRAM, &data, vec![])
}

fn compute_unit_price(micro_lamports: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET_PROGRAM, &data, vec![])
}

/// The message of `instructions` with `payer` paying the fee, bound to `blockhash`. It lapses when
/// the blockhash expires.
pub fn message(instructions: &[Instruction], payer: &Address, blockhash: Hash) -> Message {
    Message::new_with_blockhash(instructions, Some(payer), &blockhash)
}

/// The signers that `message` needs, in signature order; the first pays the fee.
pub fn signers(message: &Message) -> &[Address] {
    &message.account_keys[..usize::from(message.header.num_required_signatures)]
}

/// The signature of `signer` over the whole serialized `message`.
pub fn sign(message: &Message, signer: &dyn Signer) -> Result<(Address, Signature)> {
    let identity: Address = signer
        .identity()
        .parse()
        .map_err(|_| Error::usage("A Solana signer's identity is a base58 address"))?;
    if !signers(message).contains(&identity) {
        return Err(Error::usage(format!(
            "{identity} does not sign this message"
        )));
    }
    let bytes = signer.sign_bytes(&message.serialize())?;
    let signature: [u8; 64] = bytes
        .try_into()
        .map_err(|_| Error::usage("A Solana signature is 64 bytes"))?;
    Ok((identity, Signature::from(signature)))
}

/// The transaction of `message` with `signatures` in their places. A signer without a signature
/// keeps an empty one, as a partly signed x402 payment leaves the facilitator's place.
pub fn transaction(message: Message, signatures: &[(Address, Signature)]) -> Result<Transaction> {
    let needed = signers(&message).to_vec();
    let mut out = vec![Signature::default(); needed.len()];
    for (signer, signature) in signatures {
        let at = needed
            .iter()
            .position(|s| s == signer)
            .ok_or_else(|| Error::usage(format!("{signer} does not sign this message")))?;
        out[at] = *signature;
    }
    Ok(Transaction {
        signatures: out,
        message,
    })
}

/// The serialized size of `transaction`: the signature count, the signatures and the message.
pub fn size(transaction: &Transaction) -> usize {
    let count = transaction.signatures.len();
    let prefix = if count < 0x80 {
        1
    } else if count < 0x4000 {
        2
    } else {
        3
    };
    prefix + 64 * count + transaction.message.serialize().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> Address {
        Address::new_from_array([byte; 32])
    }
    fn wallet() -> Wallet {
        Wallet {
            owner: key(1),
            mint: key(2),
            agent: key(3),
            server: key(4),
        }
    }

    #[test]
    fn seeds_fit_and_bind_their_parts() {
        let w = wallet();
        assert_eq!(w.token_seed().len(), 32);
        assert_eq!(w.delegate_seed().len(), 32);
        assert_ne!(w.token_account(), w.delegate());
        let new_server = Wallet {
            server: key(5),
            ..w
        };
        assert_eq!(new_server.token_account(), w.token_account());
        assert_ne!(new_server.delegate(), w.delegate());
        let new_agent = Wallet { agent: key(6), ..w };
        assert_ne!(new_agent.token_account(), w.token_account());
        let other_owner = Wallet { owner: key(7), ..w };
        assert_ne!(other_owner.token_account(), w.token_account());
    }

    #[test]
    fn the_fee_is_known_before_signing() {
        assert_eq!(fee(3, Budget::PAYMENT), 15_001);
        assert_eq!(fee(2, Budget::PAYMENT), 10_001);
        assert_eq!(
            fee(
                1,
                Budget {
                    units: 200_000,
                    micro_lamports_per_unit: 10
                }
            ),
            5_002
        );
        assert_eq!(
            fee(
                1,
                Budget {
                    units: 0,
                    micro_lamports_per_unit: 0
                }
            ),
            5_000
        );
    }

    #[test]
    fn a_payment_needs_payer_agent_and_server_in_x402_order() {
        let w = wallet();
        let payer = key(9);
        let ixs = w.payment(&key(8), 1_000_000, 6, Budget::PAYMENT, Some(b"order-1"));
        let programs: Vec<Address> = ixs.iter().map(|i| i.program_id).collect();
        assert_eq!(
            programs,
            [
                COMPUTE_BUDGET_PROGRAM,
                COMPUTE_BUDGET_PROGRAM,
                TOKEN_PROGRAM,
                MEMO_PROGRAM
            ]
        );
        let m = message(&ixs, &payer, Hash::default());
        assert_eq!(signers(&m), [payer, w.agent, w.server]);
        let t = transaction(m, &[]).unwrap();
        assert_eq!(t.signatures, vec![Signature::default(); 3]);
        assert!(size(&t) <= MAX_TRANSACTION_BYTES);
        assert!(transaction(t.message.clone(), &[(key(10), Signature::default())]).is_err());
    }

    #[test]
    fn the_owner_signs_setup_and_every_owner_step_alone() {
        let w = wallet();
        for ixs in [
            w.setup(5_000_000, 6, 1, 1),
            vec![w.stop()],
            vec![w.recover(&key(8), 1, 6)],
            vec![w.close()],
            vec![w.approve(1, 6)],
        ] {
            let m = message(&ixs, &w.owner, Hash::default());
            assert_eq!(signers(&m), [w.owner]);
        }
    }
}
