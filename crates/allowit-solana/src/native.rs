//! The Native wallet: the owner's token account of one asset for one agent, with an SPL Token
//! multisig of the agent and the server, two of two, as its delegate. No Allowit program runs.
//!
//! - The owner opens both accounts from its own key (`createAccountWithSeed`), so the setup needs
//!   no other key, and approves the multisig for an allowance: one owner transaction. A setup
//!   reuses an account that is already the one it needs, and opens one that someone funded.
//! - A payment moves tokens with `TransferChecked`, authority the multisig: the agent and the server
//!   both sign, and SPL Token checks both signatures and the allowance. The fee payer is the x402
//!   facilitator or the server; the agent holds a key and no account.
//! - The owner alone stops (`Revoke`), recovers (a transfer of its own), refills (a new approval) and
//!   closes (`CloseAccount`, whose deposit returns to the owner). SPL Token closes no multisig, so its
//!   deposit stays, and a later wallet of the same agent and server reuses it.
//!
//! The module builds exactly these transactions, as [`Prepared`] values: each is sized and checked
//! when it is built, and the caller signs and sends it. The encodings follow the SPL Token, System,
//! Compute Budget and Memo programs; the ledger tests run them against those programs.
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
/// The runtime caps a transaction's compute-unit limit here.
pub const MAX_COMPUTE_UNITS: u32 = 1_400_000;
/// The largest serialized transaction.
pub const MAX_TRANSACTION_BYTES: usize = 1_232;
/// The longest payment memo, in bytes of UTF-8.
pub const MAX_MEMO_BYTES: usize = 256;
/// The most owner steps in one transaction.
pub const MAX_OWNER_STEPS: usize = 4;

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
/// signature and the priority fee of the requested units (capped as the runtime caps them),
/// rounded up. It saturates instead of wrapping.
pub fn fee(signatures: u8, budget: Budget) -> u64 {
    let units = budget.units.min(MAX_COMPUTE_UNITS);
    let priority =
        (u128::from(units) * u128::from(budget.micro_lamports_per_unit)).div_ceil(1_000_000);
    (u64::from(signatures) * LAMPORTS_PER_SIGNATURE)
        .saturating_add(u64::try_from(priority).unwrap_or(u64::MAX))
}

/// An account as a setup reads it before building the transaction.
#[derive(Clone, Copy, Debug)]
pub struct Seen<'a> {
    pub lamports: u64,
    pub owner: Address,
    pub data: &'a [u8],
}

/// What a setup finds at one of the wallet's two addresses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Found {
    /// No account: create it with its deposit.
    Nothing { deposit: u64 },
    /// A System account with lamports and no data, such as one that someone funded: add the
    /// missing deposit and allocate it.
    Funded { shortfall: u64 },
    /// The account is already the one that the wallet needs: reuse it.
    Ready,
}

/// One step that the owner takes alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerStep {
    /// Approve `allowance` to the delegate: the refill, which replaces the earlier allowance.
    Approve { allowance: u64, decimals: u8 },
    /// Revoke the delegate: no payment can follow.
    Stop,
    /// Move `amount` to the owner's token account `to`.
    Recover {
        to: Address,
        amount: u64,
        decimals: u8,
    },
    /// Close the empty token account; its deposit returns to the owner.
    Close,
}

/// What `seen` is for an account that needs `deposit`, when `ready` tells whether a token-program
/// account holds the expected content. Anything else at the address is refused.
fn found(
    seen: Option<Seen<'_>>,
    deposit: u64,
    ready: impl Fn(&[u8]) -> bool,
    what: &str,
) -> Result<Found> {
    let Some(seen) = seen.filter(|s| s.lamports > 0 || !s.data.is_empty()) else {
        return Ok(Found::Nothing { deposit });
    };
    if seen.owner == SYSTEM_PROGRAM && seen.data.is_empty() {
        return Ok(Found::Funded {
            shortfall: deposit.saturating_sub(seen.lamports),
        });
    }
    if seen.owner == TOKEN_PROGRAM && ready(seen.data) {
        return Ok(Found::Ready);
    }
    Err(Error::usage(format!(
        "The {what} address holds another account"
    )))
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
    /// The owner, the agent and the server are three keys that can sign. With one key as both
    /// agent and server, one signature would meet the two-of-two delegate; the owner is never the
    /// agent or the server.
    pub fn check(&self) -> Result<()> {
        if self.agent == self.server || self.owner == self.agent || self.owner == self.server {
            return Err(Error::usage(
                "The owner, the agent and the server are three different keys",
            ));
        }
        for key in [&self.owner, &self.agent, &self.server] {
            crate::keys::signer_identity(&key.to_bytes())?;
        }
        Ok(())
    }

    /// The seed of the token account: the same for every server key, so a new server delegate
    /// keeps the account.
    pub fn token_seed(&self) -> String {
        seed("token", &[&self.mint, &self.agent])
    }
    /// The seed of the multisig delegate: it changes with the agent or the server key, and one
    /// delegate serves the agent's wallets of every mint.
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

    /// Whether `data` is this wallet's token account: the mint, the owner, initialized, not
    /// frozen, and closable by the owner (no close authority, or the owner).
    pub fn is_token_account(&self, data: &[u8]) -> bool {
        data.len() == TOKEN_ACCOUNT_LEN as usize
            && data[0..32] == self.mint.to_bytes()
            && data[32..64] == self.owner.to_bytes()
            && data[108] == 1
            && (data[129..133] == [0, 0, 0, 0]
                || (data[129..133] == [1, 0, 0, 0] && data[133..165] == self.owner.to_bytes()))
    }
    /// Whether `data` is this wallet's delegate: an initialized multisig of exactly the agent and
    /// the server, two of two.
    pub fn is_delegate(&self, data: &[u8]) -> bool {
        self.check().is_ok()
            && data.len() == MULTISIG_LEN as usize
            && data[0..3] == [2, 2, 1]
            && data[3..35] == self.agent.to_bytes()
            && data[35..67] == self.server.to_bytes()
    }
    /// What the setup finds at the token account's address.
    pub fn token_found(&self, seen: Option<Seen<'_>>, deposit: u64) -> Result<Found> {
        found(seen, deposit, |d| self.is_token_account(d), "token account")
    }
    /// What the setup finds at the delegate's address: a wallet of another mint for the same agent
    /// and server, or a wallet opened again after a close, finds its delegate ready.
    pub fn delegate_found(&self, seen: Option<Seen<'_>>, deposit: u64) -> Result<Found> {
        found(seen, deposit, |d| self.is_delegate(d), "delegate")
    }

    /// The owner's setup: each account that is not ready, with its deposit, and the approval of
    /// `allowance` to the delegate. Only the owner signs, and the owner pays the fee and the
    /// deposits.
    pub fn setup(
        &self,
        allowance: u64,
        decimals: u8,
        token: Found,
        delegate: Found,
        blockhash: Hash,
    ) -> Result<Prepared> {
        self.check()?;
        let (token_address, delegate_address) = (self.token_account(), self.delegate());
        let mut ixs = open(
            &self.owner,
            &token_address,
            &self.token_seed(),
            TOKEN_ACCOUNT_LEN,
            token,
        );
        if token != Found::Ready {
            ixs.push(token_ix(
                18,
                vec![w(token_address), r(self.mint)],
                &self.owner.to_bytes(),
            ));
        }
        ixs.extend(open(
            &self.owner,
            &delegate_address,
            &self.delegate_seed(),
            MULTISIG_LEN,
            delegate,
        ));
        if delegate != Found::Ready {
            ixs.push(token_ix(
                19,
                vec![w(delegate_address), r(self.agent), r(self.server)],
                &[2],
            ));
        }
        ixs.push(self.approve(allowance, decimals));
        Prepared::new(&ixs, &self.owner, blockhash)
    }

    /// A payment of `amount` to the token account `destination`, with `payer` paying the fee:
    /// compute budget, `TransferChecked` with the delegate as authority and the agent and the
    /// server as its signers, and an optional memo, in the order of the x402 `exact` scheme. A
    /// payment to the wallet's own account is refused: SPL Token would accept it, move nothing and
    /// keep the allowance, and the fee would be paid for nothing.
    #[allow(clippy::too_many_arguments)]
    pub fn payment(
        &self,
        destination: &Address,
        amount: u64,
        decimals: u8,
        budget: Budget,
        memo: Option<&str>,
        payer: &Address,
        blockhash: Hash,
    ) -> Result<Prepared> {
        self.check()?;
        // The fee payer signs too: a key that can sign, and never the agent, which holds no account.
        crate::keys::signer_identity(&payer.to_bytes())?;
        if *payer == self.agent {
            return Err(Error::usage(
                "The agent pays no fee: the facilitator or the server does",
            ));
        }
        if *destination == self.token_account() {
            return Err(Error::usage(
                "A payment goes to another account than the wallet's own",
            ));
        }
        // A zero amount moves nothing and still costs the fee.
        if amount == 0 {
            return Err(Error::usage("A payment moves a positive amount"));
        }
        if memo.is_some_and(|m| m.len() > MAX_MEMO_BYTES) {
            return Err(Error::usage(format!(
                "A payment memo has at most {MAX_MEMO_BYTES} bytes"
            )));
        }
        let mut ixs = vec![
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
            ixs.push(Instruction::new_with_bytes(
                MEMO_PROGRAM,
                memo.as_bytes(),
                vec![],
            ));
        }
        Prepared::new(&ixs, payer, blockhash)
    }

    /// Steps that the owner takes alone, in one transaction that the owner signs and pays.
    pub fn owner_steps(&self, steps: &[OwnerStep], blockhash: Hash) -> Result<Prepared> {
        self.check()?;
        if steps.is_empty() || steps.len() > MAX_OWNER_STEPS {
            return Err(Error::usage(format!(
                "An owner transaction has 1 to {MAX_OWNER_STEPS} steps"
            )));
        }
        let mut ixs = Vec::with_capacity(steps.len());
        for step in steps {
            ixs.push(match *step {
                OwnerStep::Approve {
                    allowance,
                    decimals,
                } => self.approve(allowance, decimals),
                OwnerStep::Stop => token_ix(5, vec![w(self.token_account()), rs(self.owner)], &[]),
                OwnerStep::Recover {
                    to,
                    amount,
                    decimals,
                } => {
                    if to == self.token_account() {
                        return Err(Error::usage(
                            "A recovery goes to another account than the wallet's own",
                        ));
                    }
                    if amount == 0 {
                        return Err(Error::usage("A recovery moves a positive amount"));
                    }
                    token_ix(
                        12,
                        vec![w(self.token_account()), r(self.mint), w(to), rs(self.owner)],
                        &amount_and_decimals(amount, decimals),
                    )
                }
                OwnerStep::Close => token_ix(
                    9,
                    vec![w(self.token_account()), w(self.owner), rs(self.owner)],
                    &[],
                ),
            });
        }
        Prepared::new(&ixs, &self.owner, blockhash)
    }

    fn approve(&self, allowance: u64, decimals: u8) -> Instruction {
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
}

/// A transaction that a [`Wallet`] built: its message, bound to one blockhash, with its serialized
/// bytes. It was sized and checked when it was built; the module builds no other transaction, so
/// every one is small (a few instructions with fixed accounts and a bounded memo). It lapses when
/// the blockhash expires.
#[derive(Clone, Debug)]
pub struct Prepared {
    message: Message,
    bytes: Vec<u8>,
}

impl Prepared {
    fn new(instructions: &[Instruction], payer: &Address, blockhash: Hash) -> Result<Self> {
        let message = Message::new_with_blockhash(instructions, Some(payer), &blockhash);
        let bytes = message.serialize();
        let prepared = Self { message, bytes };
        if prepared.message.account_keys.len() < prepared.signature_count()
            || prepared.wire_size() > MAX_TRANSACTION_BYTES
        {
            return Err(Error::usage(format!(
                "A transaction has at most {MAX_TRANSACTION_BYTES} bytes"
            )));
        }
        Ok(prepared)
    }
    fn signature_count(&self) -> usize {
        usize::from(self.message.header.num_required_signatures)
    }
    pub fn message(&self) -> &Message {
        &self.message
    }
    /// The bytes that every signer signs.
    pub fn message_bytes(&self) -> &[u8] {
        &self.bytes
    }
    /// The signers, in signature order; the first pays the fee.
    pub fn signers(&self) -> &[Address] {
        &self.message.account_keys[..self.signature_count()]
    }
    /// The serialized size of the signed transaction: the signature count, the signatures and the
    /// message.
    pub fn wire_size(&self) -> usize {
        1 + 64 * self.signature_count() + self.bytes.len()
    }
    /// The signature of `signer` over the whole message.
    pub fn sign(&self, signer: &dyn Signer) -> Result<(Address, Signature)> {
        let identity: Address = signer
            .identity()
            .parse()
            .map_err(|_| Error::usage("A Solana signer's identity is a base58 address"))?;
        if !self.signers().contains(&identity) {
            return Err(Error::usage(format!(
                "{identity} does not sign this message"
            )));
        }
        let signature: [u8; 64] = signer
            .sign_bytes(&self.bytes)?
            .try_into()
            .map_err(|_| Error::usage("A Solana signature is 64 bytes"))?;
        Ok((identity, Signature::from(signature)))
    }
    /// The serialized transaction with `signatures` in their places: the bytes that a facilitator
    /// receives and a ledger accepts.
    pub fn wire(&self, signatures: &[(Address, Signature)]) -> Result<Vec<u8>> {
        let transaction = self.transaction(signatures)?;
        let mut out = Vec::with_capacity(self.wire_size());
        out.push(transaction.signatures.len() as u8);
        for signature in &transaction.signatures {
            out.extend_from_slice(signature.as_ref());
        }
        out.extend_from_slice(&self.bytes);
        Ok(out)
    }
    /// The transaction with `signatures` in their places. A signer without a signature keeps an
    /// empty one, as a partly signed x402 payment leaves the facilitator's place.
    pub fn transaction(&self, signatures: &[(Address, Signature)]) -> Result<Transaction> {
        let needed = self.signers();
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
            message: self.message.clone(),
        })
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

/// A seed, as the System program's instructions encode one: its length as a u64, then its bytes.
fn push_seed(data: &mut Vec<u8>, seed: &str) {
    data.extend_from_slice(&(seed.len() as u64).to_le_bytes());
    data.extend_from_slice(seed.as_bytes());
}

/// The System instructions that open a seeded SPL Token account as `found` requires.
fn open(owner: &Address, new: &Address, seed: &str, space: u64, found: Found) -> Vec<Instruction> {
    match found {
        Found::Nothing { deposit } => {
            // CreateAccountWithSeed: base, seed, lamports, space, program; funder and base sign.
            let mut data = 3u32.to_le_bytes().to_vec();
            data.extend_from_slice(owner.as_ref());
            push_seed(&mut data, seed);
            data.extend_from_slice(&deposit.to_le_bytes());
            data.extend_from_slice(&space.to_le_bytes());
            data.extend_from_slice(TOKEN_PROGRAM.as_ref());
            vec![Instruction::new_with_bytes(
                SYSTEM_PROGRAM,
                &data,
                vec![AccountMeta::new(*owner, true), w(*new), rs(*owner)],
            )]
        }
        Found::Funded { shortfall } => {
            let mut out = Vec::new();
            if shortfall > 0 {
                // Transfer of the missing deposit.
                let mut data = 2u32.to_le_bytes().to_vec();
                data.extend_from_slice(&shortfall.to_le_bytes());
                out.push(Instruction::new_with_bytes(
                    SYSTEM_PROGRAM,
                    &data,
                    vec![AccountMeta::new(*owner, true), w(*new)],
                ));
            }
            // AllocateWithSeed: base, seed, space, program; the base signs.
            let mut data = 9u32.to_le_bytes().to_vec();
            data.extend_from_slice(owner.as_ref());
            push_seed(&mut data, seed);
            data.extend_from_slice(&space.to_le_bytes());
            data.extend_from_slice(TOKEN_PROGRAM.as_ref());
            out.push(Instruction::new_with_bytes(
                SYSTEM_PROGRAM,
                &data,
                vec![w(*new), rs(*owner)],
            ));
            out
        }
        Found::Ready => vec![],
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use allowit_core::vendor::KeyProvider;

    fn key(byte: u8) -> Address {
        Address::new_from_array([byte; 32])
    }
    /// The address of a rail key: a point that can sign.
    fn signer_key(seed: u8) -> Address {
        crate::KEYS
            .derive(&[seed; 32])
            .unwrap()
            .address()
            .parse()
            .unwrap()
    }
    fn wallet() -> Wallet {
        Wallet {
            owner: signer_key(1),
            mint: key(2),
            agent: signer_key(3),
            server: signer_key(4),
        }
    }
    const NOTHING: Found = Found::Nothing { deposit: 1 };

    #[test]
    fn seeds_fit_and_bind_their_parts() {
        let w = wallet();
        assert_eq!(w.token_seed().len(), 32);
        assert_eq!(w.delegate_seed().len(), 32);
        assert_ne!(w.token_account(), w.delegate());
        let new_server = Wallet {
            server: signer_key(5),
            ..w
        };
        assert_eq!(new_server.token_account(), w.token_account());
        assert_ne!(new_server.delegate(), w.delegate());
        let new_agent = Wallet {
            agent: signer_key(6),
            ..w
        };
        assert_ne!(new_agent.token_account(), w.token_account());
        let other_mint = Wallet { mint: key(8), ..w };
        assert_ne!(other_mint.token_account(), w.token_account());
        assert_eq!(other_mint.delegate(), w.delegate());
        let other_owner = Wallet {
            owner: signer_key(7),
            ..w
        };
        assert_ne!(other_owner.token_account(), w.token_account());
    }

    #[test]
    fn the_fee_is_known_before_signing_and_capped_as_the_runtime_caps_it() {
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
        assert_eq!(
            fee(
                1,
                Budget {
                    units: 2_000_000,
                    micro_lamports_per_unit: 1_000_000
                }
            ),
            1_405_000
        );
        assert_eq!(
            fee(
                255,
                Budget {
                    units: u32::MAX,
                    micro_lamports_per_unit: u64::MAX
                }
            ),
            u64::MAX
        );
    }

    #[test]
    fn a_payment_needs_payer_agent_and_server_in_x402_order() {
        let w = wallet();
        let payer = signer_key(9);
        let p = w
            .payment(
                &key(8),
                1_000_000,
                6,
                Budget::PAYMENT,
                Some("order-1"),
                &payer,
                Hash::default(),
            )
            .unwrap();
        let m = p.message();
        let programs: Vec<Address> = m
            .instructions
            .iter()
            .map(|i| m.account_keys[usize::from(i.program_id_index)])
            .collect();
        assert_eq!(
            programs,
            [
                COMPUTE_BUDGET_PROGRAM,
                COMPUTE_BUDGET_PROGRAM,
                TOKEN_PROGRAM,
                MEMO_PROGRAM
            ]
        );
        // The fee payer signs first; the message orders the agent and the server among themselves.
        assert_eq!(p.signers().len(), 3);
        assert_eq!(p.signers()[0], payer);
        assert!(p.signers().contains(&w.agent) && p.signers().contains(&w.server));
        let t = p.transaction(&[]).unwrap();
        assert_eq!(t.signatures, vec![Signature::default(); 3]);
        assert_eq!(p.message_bytes(), m.serialize());
        assert!(p.wire_size() <= MAX_TRANSACTION_BYTES);
        assert!(p.transaction(&[(key(10), Signature::default())]).is_err());
    }

    #[test]
    fn payments_and_recoveries_to_the_wallets_own_account_are_refused() {
        let w = wallet();
        let payer = signer_key(9);
        assert!(
            w.payment(
                &key(8),
                0,
                6,
                Budget::PAYMENT,
                None,
                &payer,
                Hash::default()
            )
            .is_err()
        );
        // The agent pays no fee, and a payer must be able to sign; the server may pay.
        let to = key(8);
        assert!(
            w.payment(&to, 1, 6, Budget::PAYMENT, None, &w.agent, Hash::default())
                .is_err()
        );
        assert!(
            w.payment(
                &to,
                1,
                6,
                Budget::PAYMENT,
                None,
                &SYSTEM_PROGRAM,
                Hash::default()
            )
            .is_err()
        );
        assert!(
            w.payment(&to, 1, 6, Budget::PAYMENT, None, &w.server, Hash::default())
                .is_ok()
        );
        assert!(
            w.payment(
                &w.token_account(),
                1,
                6,
                Budget::PAYMENT,
                None,
                &payer,
                Hash::default()
            )
            .is_err()
        );
        let recover = OwnerStep::Recover {
            to: w.token_account(),
            amount: 1,
            decimals: 6,
        };
        assert!(w.owner_steps(&[recover], Hash::default()).is_err());
        let nothing = OwnerStep::Recover {
            to: key(8),
            amount: 0,
            decimals: 6,
        };
        assert!(w.owner_steps(&[nothing], Hash::default()).is_err());
    }

    #[test]
    fn the_owner_signs_setup_and_every_owner_step_alone() {
        let w = wallet();
        let steps = [
            OwnerStep::Stop,
            OwnerStep::Approve {
                allowance: 1,
                decimals: 6,
            },
            OwnerStep::Recover {
                to: key(8),
                amount: 1,
                decimals: 6,
            },
            OwnerStep::Close,
        ];
        for p in [
            w.setup(5_000_000, 6, NOTHING, NOTHING, Hash::default())
                .unwrap(),
            w.setup(
                5_000_000,
                6,
                Found::Funded { shortfall: 1 },
                Found::Ready,
                Hash::default(),
            )
            .unwrap(),
            w.owner_steps(&steps, Hash::default()).unwrap(),
        ] {
            assert_eq!(p.signers(), [w.owner]);
        }
        assert!(w.owner_steps(&[], Hash::default()).is_err());
        assert!(
            w.owner_steps(&[OwnerStep::Stop; MAX_OWNER_STEPS + 1], Hash::default())
                .is_err()
        );
    }

    #[test]
    fn a_setup_reads_what_each_address_holds() {
        let w = wallet();
        let seen = |lamports, owner, data: &'static [u8]| {
            Some(Seen {
                lamports,
                owner,
                data,
            })
        };
        assert_eq!(
            w.token_found(None, 10).unwrap(),
            Found::Nothing { deposit: 10 }
        );
        assert_eq!(
            w.token_found(seen(0, SYSTEM_PROGRAM, &[]), 10).unwrap(),
            Found::Nothing { deposit: 10 }
        );
        assert_eq!(
            w.token_found(seen(4, SYSTEM_PROGRAM, &[]), 10).unwrap(),
            Found::Funded { shortfall: 6 }
        );
        assert_eq!(
            w.token_found(seen(40, SYSTEM_PROGRAM, &[]), 10).unwrap(),
            Found::Funded { shortfall: 0 }
        );
        let mut multisig = vec![0u8; MULTISIG_LEN as usize];
        multisig[0..3].copy_from_slice(&[2, 2, 1]);
        multisig[3..35].copy_from_slice(w.agent.as_ref());
        multisig[35..67].copy_from_slice(w.server.as_ref());
        let multisig: &'static [u8] = Box::leak(multisig.into_boxed_slice());
        assert_eq!(
            w.delegate_found(seen(1, TOKEN_PROGRAM, multisig), 10)
                .unwrap(),
            Found::Ready
        );
        let other_server = Wallet {
            server: signer_key(5),
            ..w
        };
        assert!(
            other_server
                .delegate_found(seen(1, TOKEN_PROGRAM, multisig), 10)
                .is_err()
        );
        assert!(w.token_found(seen(1, key(9), &[1]), 10).is_err());
    }

    #[test]
    fn three_different_signing_keys_or_nothing() {
        let w = wallet();
        let payer = signer_key(9);
        for bad in [
            Wallet {
                server: w.agent,
                ..w
            },
            Wallet {
                owner: w.agent,
                ..w
            },
            Wallet {
                owner: w.server,
                ..w
            },
            Wallet {
                agent: SYSTEM_PROGRAM,
                ..w
            },
            Wallet {
                owner: Address::new_from_array([0; 32]),
                ..w
            },
        ] {
            assert!(bad.setup(1, 6, NOTHING, NOTHING, Hash::default()).is_err());
            assert!(
                bad.owner_steps(&[OwnerStep::Stop], Hash::default())
                    .is_err()
            );
            assert!(
                bad.payment(
                    &key(8),
                    1,
                    6,
                    Budget::PAYMENT,
                    None,
                    &payer,
                    Hash::default()
                )
                .is_err()
            );
        }
        // A multisig whose two signers are one key is no delegate.
        let same = Wallet {
            server: w.agent,
            ..w
        };
        let mut multisig = vec![0u8; MULTISIG_LEN as usize];
        multisig[0..3].copy_from_slice(&[2, 2, 1]);
        multisig[3..35].copy_from_slice(w.agent.as_ref());
        multisig[35..67].copy_from_slice(w.agent.as_ref());
        assert!(!same.is_delegate(&multisig));
    }

    #[test]
    fn a_token_account_with_another_close_authority_is_not_reused() {
        let w = wallet();
        let mut data = vec![0u8; TOKEN_ACCOUNT_LEN as usize];
        data[0..32].copy_from_slice(w.mint.as_ref());
        data[32..64].copy_from_slice(w.owner.as_ref());
        data[108] = 1;
        assert!(w.is_token_account(&data));
        data[129..133].copy_from_slice(&[1, 0, 0, 0]);
        data[133..165].copy_from_slice(w.owner.as_ref());
        assert!(w.is_token_account(&data));
        data[133..165].copy_from_slice(key(9).as_ref());
        assert!(!w.is_token_account(&data));
        let seen = Some(Seen {
            lamports: 1,
            owner: TOKEN_PROGRAM,
            data: &data,
        });
        assert!(w.token_found(seen, 10).is_err());
    }

    #[test]
    fn memos_are_bounded_and_every_built_transaction_fits() {
        let w = wallet();
        let payer = signer_key(9);
        let long = "m".repeat(MAX_MEMO_BYTES + 1);
        assert!(
            w.payment(
                &key(8),
                1,
                6,
                Budget::PAYMENT,
                Some(&long),
                &payer,
                Hash::default()
            )
            .is_err()
        );
        let longest = "m".repeat(MAX_MEMO_BYTES);
        let p = w
            .payment(
                &key(8),
                1,
                6,
                Budget::PAYMENT,
                Some(&longest),
                &payer,
                Hash::default(),
            )
            .unwrap();
        assert!(p.wire_size() <= MAX_TRANSACTION_BYTES);
        // The largest setup: both accounts funded, the shortfall transfers included.
        let funded = Found::Funded { shortfall: 1 };
        let p = w.setup(1, 6, funded, funded, Hash::default()).unwrap();
        assert!(p.wire_size() <= MAX_TRANSACTION_BYTES);
        let steps = [OwnerStep::Recover {
            to: key(8),
            amount: 1,
            decimals: 6,
        }; MAX_OWNER_STEPS];
        assert!(
            w.owner_steps(&steps, Hash::default()).unwrap().wire_size() <= MAX_TRANSACTION_BYTES
        );
    }
}
