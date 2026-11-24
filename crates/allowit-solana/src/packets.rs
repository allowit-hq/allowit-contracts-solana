//! The rail's retained documents and what a host may read from them: a request, a prepared and
//! a signed payment, a receipt, an owner step before and after the owner signed, and the
//! evidence of a wallet's state.
//!
//! Every reader validates the document first. A prepared payment is not trusted for what it
//! says: its message is built again from its installation and its request and compared byte for
//! byte, so the transaction is the requested transfer from that wallet and nothing else.
//!
//! A Solana transaction is named by its first signature, 64 bytes, which exists only once the
//! fee payer signed. Where Core names a transaction by 32 bytes, the rail gives the SHA-256 of
//! the message: one message, one hash, and the signature is read from the signed bytes.
use crate::config::{self, WalletConfig, hex32};
use crate::native::{Address, Budget, Prepared as Message, Wallet};
use crate::payment;
use allowit_core::vendor::{
    error::{Error, Result},
    input::asset::units_decimal,
    runtime::{
        Debit, Fee, Kind, OwnerInfo, OwnerPacket, OwnerSigned, OwnerSignedInfo, Packet, PacketInfo,
        PacketProvider, Prepared, PreparedMetadata, Receipt, ReceiptInfo, RequestPacket, Signature,
        Signed, Snapshot, Status,
    },
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The owning provider of every packet of this rail.
pub static PACKETS: Packets = Packets;
pub struct Packets;

/// An amount in base units as canonical decimal text.
pub mod dec {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(units: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(units)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let text = String::deserialize(d)?;
        let units = text.parse::<u64>().map_err(D::Error::custom)?;
        if units.to_string() != text {
            return Err(D::Error::custom("Expected canonical decimal text"));
        }
        Ok(units)
    }
}

/// What the agent asks for: a transfer of `units` to the token account `recipient`, as the
/// operation `nonce` of the installation `policy_instance`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    #[serde(with = "hex32")]
    pub policy_instance: [u8; 32],
    /// The operation id: one request, one transaction.
    #[serde(with = "hex32")]
    pub nonce: [u8; 32],
    pub recipient: String,
    #[serde(with = "dec")]
    pub units: u64,
}

/// A payment that the server built and nobody signed yet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedDoc {
    pub version: u8,
    pub config: WalletConfig,
    pub request: Request,
    #[serde(with = "hex32")]
    pub request_hash: [u8; 32],
    /// The transaction message, base64: the bytes that the agent and the server sign.
    pub message: String,
    #[serde(with = "hex32")]
    pub transaction_hash: [u8; 32],
    pub last_valid_block_height: u64,
    pub observed_height: u64,
    pub created_at: u64,
    pub expires_at: u64,
}

/// A payment with both signatures: the bytes that the ledger accepts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedDoc {
    pub prepared: PreparedDoc,
    pub wire: String,
}

/// What the ledger did with a transaction of this rail.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptDoc {
    pub network: String,
    #[serde(with = "hex32")]
    pub transaction_hash: [u8; 32],
    /// The transaction's first signature, base58: its id on the ledger.
    pub signature: String,
    pub failed: bool,
    pub slot: u64,
    pub block_time: Option<u64>,
    pub observed_height: u64,
    pub fee_lamports: u64,
    /// The transfer that the transaction made, if it was a payment that succeeded.
    pub transfer: Option<Transfer>,
    pub wire: String,
}

/// The effect of a settled payment, as the ledger's token balances show it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transfer {
    pub mint: String,
    pub recipient: String,
    #[serde(with = "dec")]
    pub units: u64,
}

/// An owner step that the server built for the owner's wallet to sign.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerDoc {
    pub network: String,
    pub action: String,
    pub owner: String,
    pub message: String,
    #[serde(with = "hex32")]
    pub transaction_hash: [u8; 32],
    pub last_valid_block_height: u64,
    pub expires_at: u64,
}

/// An owner step with the owner's signature.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerSignedDoc {
    pub original: OwnerDoc,
    pub wire: String,
}

/// The evidence of a snapshot: the wallet's installation and what the ledger held of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotDoc {
    pub config: WalletConfig,
    pub observed_height: u64,
    pub observed_at: Option<u64>,
    /// The delegate of the wallet's token account: `None` while the owner stopped it.
    pub delegate: Option<String>,
    #[serde(with = "dec")]
    pub allowance: u64,
    #[serde(with = "dec")]
    pub balance: u64,
}

fn bad(what: &str) -> Error {
    Error::config(format!("Invalid Solana packet: {what}"))
}

pub(crate) fn decode<T: DeserializeOwned>(packet: &Packet) -> Result<T> {
    serde_json::from_str(packet.document().get()).map_err(|_| bad("not a document of its kind"))
}

pub(crate) fn packet(network: &str, value: &impl Serialize) -> Result<Packet> {
    Packet::new(network, value, &PACKETS)
}

/// The 32-byte name of a transaction message.
pub fn message_hash(message: &[u8]) -> [u8; 32] {
    Sha256::digest(message).into()
}

/// The compute budget of a payment of this module: its transfer and its 72-byte memo, which
/// the deployed Memo program takes about 27,000 units for ([`payment::memo_units`]). The priority
/// fee stays one lamport, so the fee of a payment is the same as with a smaller limit.
pub const PAYMENT_BUDGET: Budget = Budget {
    units: 40_000,
    micro_lamports_per_unit: 1,
};

/// The memo of a payment: its operation id, so that two operations are never one transaction.
fn memo(request: &Request) -> String {
    format!("allowit:{}", hex32::encode(&request.nonce))
}

/// The message of `request` from `config`'s wallet on `blockhash`, paid by the wallet's server.
pub fn payment_message(
    wallet: &Wallet,
    config: &WalletConfig,
    request: &Request,
    blockhash: solana_hash::Hash,
) -> Result<Message> {
    let recipient: Address = request
        .recipient
        .parse()
        .map_err(|_| bad("the recipient is not an address"))?;
    wallet.payment(
        &recipient,
        request.units,
        config.decimals,
        PAYMENT_BUDGET,
        Some(&memo(request)),
        &wallet.server,
        blockhash,
    )
}

/// The canonical hash of a request: what both signers and the receipt are bound to.
pub fn request_hash(request: &Request) -> Result<[u8; 32]> {
    Ok(Sha256::digest(serde_json::to_vec(request).map_err(|_| bad("the request"))?).into())
}

impl PreparedDoc {
    /// Check the document by itself and return its wallet and message bytes.
    pub fn validate(&self) -> Result<(Wallet, Vec<u8>)> {
        let wallet = self.config.validate()?;
        if self.version != 1 || self.request.policy_instance != self.config.policy_instance {
            return Err(bad("the payment belongs to another installation"));
        }
        if self.request_hash != request_hash(&self.request)?
            || self.created_at > self.expires_at
            || self.last_valid_block_height == 0
        {
            return Err(bad("the payment's own bindings"));
        }
        let message = STANDARD
            .decode(&self.message)
            .map_err(|_| bad("the message"))?;
        if message_hash(&message) != self.transaction_hash {
            return Err(bad("the message is not the one that the hash names"));
        }
        let expected = payment_message(
            &wallet,
            &self.config,
            &self.request,
            payment::blockhash(&message)?,
        )?;
        if expected.message_bytes() != message {
            return Err(bad("the message is not the requested payment"));
        }
        Ok((wallet, message))
    }
}

impl SignedDoc {
    /// Check the prepared payment and that `wire` is its message with the server's and the
    /// agent's valid signatures. Returns the transaction's signature, the server's.
    pub fn validate(&self) -> Result<[u8; 64]> {
        let (wallet, message) = self.prepared.validate()?;
        let wire = STANDARD.decode(&self.wire).map_err(|_| bad("the wire"))?;
        let (server, agent, signed) = payment::parts(&wire)?;
        if signed != message {
            return Err(bad("the signed bytes are not the prepared message"));
        }
        payment::verify(&wallet.server, signed, server)?;
        payment::verify(&wallet.agent, signed, agent)?;
        Ok(server.try_into().expect("64 bytes"))
    }
}

impl OwnerDoc {
    /// Check the step by itself and return its message bytes.
    pub fn validate(&self) -> Result<Vec<u8>> {
        crate::networks::network(&self.network)?;
        let message = STANDARD
            .decode(&self.message)
            .map_err(|_| bad("the message"))?;
        if message_hash(&message) != self.transaction_hash
            || self.action.is_empty()
            || self.action.len() > 64
            || self.last_valid_block_height == 0
        {
            return Err(bad("the owner step's own bindings"));
        }
        // The owner pays the fee: the first account key of the message.
        let keys = payment::account_keys(&message)?;
        if keys.first().map(|key| key.to_string()) != Some(self.owner.clone()) || message[0] != 1 {
            return Err(bad("the owner step is not signed by its owner alone"));
        }
        Ok(message)
    }
}

impl OwnerSignedDoc {
    /// Check the step and the owner's signature over it. Returns the signature.
    pub fn validate(&self) -> Result<[u8; 64]> {
        let message = self.original.validate()?;
        let wire = STANDARD.decode(&self.wire).map_err(|_| bad("the wire"))?;
        if wire.len() != 65 + message.len() || wire[0] != 1 || wire[65..] != message[..] {
            return Err(bad("the signed bytes are not the owner step"));
        }
        let owner: Address = self
            .original
            .owner
            .parse()
            .map_err(|_| bad("the owner is not an address"))?;
        payment::verify(&owner, &message, &wire[1..65])?;
        Ok(wire[1..65].try_into().expect("64 bytes"))
    }
}

impl ReceiptDoc {
    pub fn validate(&self) -> Result<[u8; 64]> {
        crate::networks::network(&self.network)?;
        let wire = STANDARD.decode(&self.wire).map_err(|_| bad("the wire"))?;
        let signatures = usize::from(*wire.first().ok_or_else(|| bad("the wire"))?);
        let at = 1 + 64 * signatures;
        if signatures == 0 || wire.len() <= at || message_hash(&wire[at..]) != self.transaction_hash
        {
            return Err(bad("the receipt's transaction"));
        }
        let signature: [u8; 64] = wire[1..65].try_into().expect("64 bytes");
        if bs58::encode(signature).into_string() != self.signature
            || (self.failed && self.transfer.is_some())
        {
            return Err(bad("the receipt's own bindings"));
        }
        Ok(signature)
    }
}

fn debit(config: &WalletConfig, recipient: &str, units: u64) -> Debit {
    Debit {
        units: i128::from(units),
        token: config.mint.clone(),
        recipient: recipient.into(),
        kind: "transfer".into(),
        display_amount: units_decimal(u128::from(units), config.decimals),
        display_token: config.asset_symbol.clone(),
    }
}

fn snapshot(s: &Snapshot) -> Result<SnapshotDoc> {
    let doc: SnapshotDoc = decode(&s.evidence)?;
    doc.config.validate()?;
    Ok(doc)
}

impl PacketProvider for Packets {
    fn request_id(&self, p: &Packet) -> Result<[u8; 32]> {
        Ok(decode::<Request>(p)?.nonce)
    }

    /// The owner signs the message: the payload is its base64 text.
    fn owner_info(&self, p: &Packet) -> Result<OwnerInfo> {
        let step: OwnerDoc = decode(p)?;
        step.validate()?;
        Ok(OwnerInfo {
            action: step.action,
            signing_payload: step.message.into_bytes(),
            transaction_hash: step.transaction_hash,
            expires_at: step.expires_at,
        })
    }

    fn prepared_metadata(&self, p: &Packet) -> Result<PreparedMetadata> {
        let prepared: PreparedDoc = decode(p)?;
        prepared.validate()?;
        Ok(PreparedMetadata {
            configuration: config::encode(&prepared.config)?,
            request: RequestPacket(packet(p.network(), &prepared.request)?),
            operation_id: prepared.request.nonce,
            created_at: prepared.created_at,
            expires_at: prepared.expires_at,
            transaction_hash: prepared.transaction_hash,
            debit_units: i128::from(prepared.request.units),
            request_hash: prepared.request_hash,
            debit: debit(
                &prepared.config,
                &prepared.request.recipient,
                prepared.request.units,
            ),
            seller_settles: false,
        })
    }

    fn info(&self, p: &Packet, k: Kind) -> Result<PacketInfo> {
        let prepared = match k {
            Kind::Prepared => decode::<PreparedDoc>(p)?,
            Kind::Signed => decode::<SignedDoc>(p)?.prepared,
            _ => return Err(bad("only a payment has an operation")),
        };
        prepared.validate()?;
        Ok(PacketInfo {
            operation_id: prepared.request.nonce,
            transaction_hash: prepared.transaction_hash,
            wallet: prepared.config.wallet,
            expires_at: prepared.expires_at,
        })
    }

    fn validate_signed(&self, p: &Packet) -> Result<()> {
        decode::<SignedDoc>(p)?.validate().map(|_| ())
    }

    fn signed_preparation(&self, p: &Packet) -> Result<Prepared> {
        let signed: SignedDoc = decode(p)?;
        signed.validate()?;
        Ok(Prepared(packet(p.network(), &signed.prepared)?))
    }

    /// The owner's consent: a signature of the wallet's owner over the exact text, as a Solana
    /// wallet signs a message.
    fn verify_consent(&self, s: &Snapshot, message: &str, signatures: &[Signature]) -> Result<()> {
        let doc = snapshot(s)?;
        let owner: Address = doc
            .config
            .owner
            .parse()
            .map_err(|_| bad("the owner is not an address"))?;
        signatures
            .iter()
            .filter(|signature| signature.identity == doc.config.owner)
            .find_map(|signature| {
                payment::verify(&owner, message.as_bytes(), &signature.bytes).ok()
            })
            .ok_or_else(|| Error::usage("The wallet's owner did not sign this consent"))
    }

    /// The owner alone decides about the wallet; the agent and the server each hold half of a
    /// payment. The weights say that in the terms of a three-of-three-or-two account.
    fn signer_weight(&self, s: &Snapshot, identity: &str) -> Result<u32> {
        let config = snapshot(s)?.config;
        Ok(if identity == config.owner {
            3
        } else if identity == config.agent || identity == config.server {
            1
        } else {
            0
        })
    }

    fn authority_document(&self, s: &Snapshot) -> Result<Value> {
        let doc = snapshot(s)?;
        let wallet = doc.config.roles()?;
        Ok(json!({
            "wallet": doc.config.wallet,
            "owner": doc.config.owner,
            "agent": doc.config.agent,
            "server": doc.config.server,
            "expectedDelegate": wallet.delegate().to_string(),
            "delegate": doc.delegate,
            "payment": {"signers": [doc.config.agent, doc.config.server], "threshold": 2},
        }))
    }

    /// The same authority: the same installation with the same delegate on the account.
    fn same_snapshot(&self, a: &Snapshot, b: &Snapshot) -> Result<bool> {
        let (a, b) = (snapshot(a)?, snapshot(b)?);
        Ok(a.config == b.config && a.delegate == b.delegate)
    }

    /// `r` is the receipt of the transaction of `p`: a payment, signed or not, or an owner step.
    fn verify_receipt(&self, r: &Packet, p: &Packet) -> Result<()> {
        let receipt: ReceiptDoc = decode(r)?;
        let signature = receipt.validate()?;
        let other = || bad("the receipt belongs to another transaction");
        if let Ok(signed) = decode::<SignedDoc>(p) {
            if signed.validate()? != signature
                || signed.prepared.transaction_hash != receipt.transaction_hash
            {
                return Err(other());
            }
            let request = &signed.prepared.request;
            let moved = receipt.transfer.as_ref().is_some_and(|transfer| {
                transfer.mint == signed.prepared.config.mint
                    && transfer.recipient == request.recipient
                    && transfer.units == request.units
            });
            if !receipt.failed && !moved {
                return Err(bad("the ledger moved another amount than the payment"));
            }
            return Ok(());
        }
        if let Ok(step) = decode::<OwnerSignedDoc>(p) {
            if step.validate()? != signature
                || step.original.transaction_hash != receipt.transaction_hash
            {
                return Err(other());
            }
            return Ok(());
        }
        Err(bad("a receipt is verified against signed bytes"))
    }

    fn receipt_info(&self, p: &Packet) -> Result<ReceiptInfo> {
        let receipt: ReceiptDoc = decode(p)?;
        receipt.validate()?;
        Ok(ReceiptInfo {
            transaction_hash: receipt.transaction_hash,
            status: if receipt.failed {
                Status::Failed
            } else {
                Status::Confirmed
            },
            observed_height: receipt.observed_height,
            fee: Fee {
                native_units: u128::from(receipt.fee_lamports),
                ..Fee::default()
            },
            debits: receipt
                .transfer
                .iter()
                .map(|transfer| Debit {
                    units: i128::from(transfer.units),
                    token: transfer.mint.clone(),
                    recipient: transfer.recipient.clone(),
                    kind: "transfer".into(),
                    display_amount: transfer.units.to_string(),
                    display_token: transfer.mint.clone(),
                })
                .collect(),
            settlement_hash: None,
        })
    }

    fn receipt_settled_at(&self, p: &Packet) -> Result<Option<u64>> {
        let receipt: ReceiptDoc = decode(p)?;
        receipt.validate()?;
        Ok(receipt.block_time)
    }

    fn snapshot_observed_at(&self, s: &Snapshot) -> Result<Option<u64>> {
        Ok(snapshot(s)?.observed_at)
    }

    /// A signed owner step is named by its signature: the transaction's id on the ledger.
    fn owner_signed_info(&self, p: &Packet) -> Result<OwnerSignedInfo> {
        let step: OwnerSignedDoc = decode(p)?;
        let signature = step.validate()?;
        Ok(OwnerSignedInfo {
            action: step.original.action,
            identity: signature.to_vec(),
            expires_at: step.original.expires_at,
        })
    }
}

/// Restore a retained packet of `kind`: decode it, validate it and keep its literal bytes. A
/// request is restored through its installation, which says what it may ask.
pub fn restore(kind: Kind, raw: Box<serde_json::value::RawValue>) -> Result<Packet> {
    let text = raw.get();
    let read = |what: &str| bad(&format!("the retained {what}"));
    let network = match kind {
        Kind::Prepared => {
            let doc: PreparedDoc = serde_json::from_str(text).map_err(|_| read("payment"))?;
            doc.validate()?;
            doc.config.network
        }
        Kind::Signed => {
            let doc: SignedDoc = serde_json::from_str(text).map_err(|_| read("signed payment"))?;
            doc.validate()?;
            doc.prepared.config.network
        }
        Kind::Receipt => {
            let doc: ReceiptDoc = serde_json::from_str(text).map_err(|_| read("receipt"))?;
            doc.validate()?;
            doc.network
        }
        Kind::Owner => {
            let doc: OwnerDoc = serde_json::from_str(text).map_err(|_| read("owner step"))?;
            doc.validate()?;
            doc.network
        }
        Kind::OwnerSigned => {
            let doc: OwnerSignedDoc =
                serde_json::from_str(text).map_err(|_| read("signed owner step"))?;
            doc.validate()?;
            doc.original.network
        }
        Kind::Request => {
            return Err(Error::usage(
                "Restore a request through its selected installation",
            ));
        }
    };
    Ok(Packet::from_raw(&network, raw, &PACKETS))
}

/// The carriers of a validated owner step.
pub fn owner_packet(step: &OwnerDoc) -> Result<OwnerPacket> {
    step.validate()?;
    Ok(OwnerPacket(packet(&step.network, step)?))
}
pub fn owner_signed(step: &OwnerSignedDoc) -> Result<OwnerSigned> {
    step.validate()?;
    Ok(OwnerSigned(packet(&step.original.network, step)?))
}
pub fn receipt(doc: &ReceiptDoc) -> Result<Receipt> {
    doc.validate()?;
    Ok(Receipt(packet(&doc.network, doc)?))
}
pub fn signed(doc: &SignedDoc) -> Result<Signed> {
    doc.validate()?;
    Ok(Signed(packet(&doc.prepared.config.network, doc)?))
}
pub fn prepared(doc: &PreparedDoc) -> Result<Prepared> {
    doc.validate()?;
    Ok(Prepared(packet(&doc.config.network, doc)?))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::config::tests::sample;
    use crate::{KEYS, KeySigner};
    use allowit_core::vendor::{KeyProvider as _, runtime::Signer as _};
    use serde_json::value::RawValue;
    use solana_hash::Hash;

    pub(crate) fn key(seed: u8) -> KeySigner {
        KeySigner(KEYS.derive(&[seed; 32]).unwrap())
    }
    pub(crate) fn request(config: &WalletConfig, units: u64) -> Request {
        Request {
            policy_instance: config.policy_instance,
            nonce: [4; 32],
            recipient: Address::new_from_array([8; 32]).to_string(),
            units,
        }
    }
    /// A prepared payment of `units` from the sample wallet, and its message.
    pub(crate) fn prepared_doc(units: u64) -> (PreparedDoc, Message) {
        let config = sample();
        let request = request(&config, units);
        let wallet = config.roles().unwrap();
        let message =
            payment_message(&wallet, &config, &request, Hash::new_from_array([3; 32])).unwrap();
        let doc = PreparedDoc {
            version: 1,
            request_hash: request_hash(&request).unwrap(),
            message: STANDARD.encode(message.message_bytes()),
            transaction_hash: message_hash(message.message_bytes()),
            last_valid_block_height: 250,
            observed_height: 100,
            created_at: 1_800_000_000,
            expires_at: 1_800_000_060,
            config,
            request,
        };
        (doc, message)
    }
    pub(crate) fn signed_doc(units: u64) -> SignedDoc {
        let (prepared, message) = prepared_doc(units);
        let wire = message
            .wire(&[
                message.sign(&key(3)).unwrap(),
                message.sign(&key(2)).unwrap(),
            ])
            .unwrap();
        SignedDoc {
            prepared,
            wire: STANDARD.encode(wire),
        }
    }
    fn raw(value: &impl Serialize) -> Box<RawValue> {
        RawValue::from_string(serde_json::to_string(value).unwrap()).unwrap()
    }
    fn receipt_of(signed: &SignedDoc, units: Option<u64>) -> ReceiptDoc {
        let wire = STANDARD.decode(&signed.wire).unwrap();
        ReceiptDoc {
            network: signed.prepared.config.network.clone(),
            transaction_hash: signed.prepared.transaction_hash,
            signature: bs58::encode(&wire[1..65]).into_string(),
            failed: units.is_none(),
            slot: 42,
            block_time: Some(1_800_000_030),
            observed_height: 120,
            fee_lamports: 10_001,
            transfer: units.map(|units| Transfer {
                mint: signed.prepared.config.mint.clone(),
                recipient: signed.prepared.request.recipient.clone(),
                units,
            }),
            wire: signed.wire.clone(),
        }
    }

    #[test]
    fn the_payment_budget_covers_the_memo_that_the_deployed_program_meters() {
        let memo = memo(&request(&sample(), 1));
        assert_eq!(memo.len(), 72);
        assert!(PAYMENT_BUDGET.units >= payment::min_units(memo.len()));
        // The measured costs on Devnet stay under the bound for each measured length.
        for (len, measured) in [
            (8, 4_273),
            (32, 12_775),
            (72, 27_043),
            (78, 29_269),
            (100, 36_890),
        ] {
            assert!(payment::memo_units(len) >= measured, "{len}");
        }
        // A larger limit at one micro-lamport a unit still rounds to one lamport of priority fee.
        assert_eq!(crate::native::fee(2, PAYMENT_BUDGET), 10_001);
    }

    #[test]
    fn a_prepared_payment_is_its_request_and_nothing_else() {
        let (doc, _) = prepared_doc(2_000_000);
        let packet = prepared(&doc).unwrap();
        let metadata = packet.0.provider().prepared_metadata(&packet.0).unwrap();
        assert_eq!(metadata.operation_id, [4; 32]);
        assert_eq!(metadata.debit_units, 2_000_000);
        assert_eq!(
            (
                metadata.debit.display_amount.as_str(),
                metadata.debit.display_token.as_str()
            ),
            ("2", "USDC")
        );
        assert_eq!(metadata.request.operation_id().unwrap(), [4; 32]);
        assert_eq!(metadata.configuration.wallet, doc.config.wallet);
        // Every field that the message binds: a change of one without the message is refused.
        let refused = |edit: &dyn Fn(&mut PreparedDoc)| {
            let mut changed = doc.clone();
            edit(&mut changed);
            changed.request_hash = request_hash(&changed.request).unwrap();
            changed.validate().is_err()
        };
        assert!(refused(&|d| d.request.units += 1));
        assert!(refused(
            &|d| d.request.recipient = Address::new_from_array([7; 32]).to_string()
        ));
        assert!(refused(&|d| d.request.nonce = [5; 32]));
        assert!(refused(&|d| d.request.policy_instance = [9; 32]));
        assert!(refused(&|d| d.version = 2));
        assert!(refused(&|d| d.transaction_hash = [1; 32]));
        assert!(refused(&|d| d.expires_at = d.created_at - 1));
        // Another server is another fee payer and another delegate signer: another message.
        assert!(refused(
            &|d| d.config.server = crate::config::tests::address(9)
        ));
        // A message of another payment under the right hash.
        assert!(refused(&|d| {
            let other = prepared_doc(1).0;
            d.message = other.message;
            d.transaction_hash = other.transaction_hash;
        }));
        let mut stale = doc.clone();
        stale.request_hash = [0; 32];
        assert!(stale.validate().is_err());
    }

    #[test]
    fn a_signed_payment_holds_both_signatures_of_its_own_message() {
        let doc = signed_doc(2_000_000);
        let packet = signed(&doc).unwrap();
        let provider = packet.0.provider();
        provider.validate_signed(&packet.0).unwrap();
        let info = provider.info(&packet.0, Kind::Signed).unwrap();
        assert_eq!(info.wallet, doc.prepared.config.wallet);
        assert_eq!(info.transaction_hash, doc.prepared.transaction_hash);
        let again = provider.signed_preparation(&packet.0).unwrap();
        assert_eq!(decode::<PreparedDoc>(&again.0).unwrap(), doc.prepared);
        let wire = STANDARD.decode(&doc.wire).unwrap();
        let with = |edit: &dyn Fn(&mut Vec<u8>)| {
            let mut wire = wire.clone();
            edit(&mut wire);
            SignedDoc {
                prepared: doc.prepared.clone(),
                wire: STANDARD.encode(wire),
            }
            .validate()
            .is_err()
        };
        assert!(with(&|w| w[1] ^= 1));
        assert!(with(&|w| w[65] ^= 1));
        assert!(with(&|w| w[65..129].fill(0)));
        assert!(with(&|w| {
            let last = w.len() - 1;
            w[last] ^= 1
        }));
        // The two signatures in each other's place.
        assert!(with(&|w| {
            let (server, agent) = (w[1..65].to_vec(), w[65..129].to_vec());
            w[1..65].copy_from_slice(&agent);
            w[65..129].copy_from_slice(&server);
        }));
    }

    #[test]
    fn a_receipt_is_verified_against_the_signed_bytes_and_what_moved() {
        let doc = signed_doc(2_000_000);
        let packet = signed(&doc).unwrap();
        let provider = packet.0.provider();
        let verify = |receipt: &ReceiptDoc| {
            provider.verify_receipt(
                &super::packet(&receipt.network, receipt).unwrap(),
                &packet.0,
            )
        };
        let settled = receipt_of(&doc, Some(2_000_000));
        verify(&settled).unwrap();
        let info = provider
            .receipt_info(&receipt(&settled).unwrap().0)
            .unwrap();
        assert_eq!(info.status, Status::Confirmed);
        assert_eq!(info.fee.native_units, 10_001);
        assert_eq!(info.debits[0].units, 2_000_000);
        assert_eq!(
            provider
                .receipt_settled_at(&receipt(&settled).unwrap().0)
                .unwrap(),
            Some(1_800_000_030)
        );
        // A failed transaction moved nothing and is still this payment's receipt.
        let failed = receipt_of(&doc, None);
        verify(&failed).unwrap();
        assert_eq!(
            provider
                .receipt_info(&receipt(&failed).unwrap().0)
                .unwrap()
                .status,
            Status::Failed
        );
        // Another amount, recipient or mint moved; or the receipt of another payment.
        assert!(verify(&receipt_of(&doc, Some(1_999_999))).is_err());
        let mut other = settled.clone();
        other.transfer.as_mut().unwrap().recipient = Address::new_from_array([7; 32]).to_string();
        assert!(verify(&other).is_err());
        let mut other = settled.clone();
        other.transfer.as_mut().unwrap().mint = Address::new_from_array([7; 32]).to_string();
        assert!(verify(&other).is_err());
        let mut silent = settled.clone();
        silent.transfer = None;
        assert!(verify(&silent).is_err());
        assert!(verify(&receipt_of(&signed_doc(1), Some(1))).is_err());
        let mut forged = settled.clone();
        forged.signature = bs58::encode([1u8; 64]).into_string();
        assert!(verify(&forged).is_err());
        let mut both = failed.clone();
        both.transfer = settled.transfer.clone();
        assert!(both.validate().is_err());
    }

    fn owner_step() -> (OwnerDoc, Message) {
        let config = sample();
        let wallet = config.roles().unwrap();
        let message = wallet
            .owner_steps_tagged(
                &[crate::native::OwnerStep::Stop],
                "allowit:stop-1",
                Hash::new_from_array([3; 32]),
            )
            .unwrap();
        let doc = OwnerDoc {
            network: config.network,
            action: "pause".into(),
            owner: config.owner,
            message: STANDARD.encode(message.message_bytes()),
            transaction_hash: message_hash(message.message_bytes()),
            last_valid_block_height: 250,
            expires_at: 1_800_000_060,
        };
        (doc, message)
    }

    #[test]
    fn an_owner_step_is_signed_by_its_owner_and_named_by_that_signature() {
        let (step, message) = owner_step();
        let unsigned = owner_packet(&step).unwrap();
        let info = unsigned.0.provider().owner_info(&unsigned.0).unwrap();
        assert_eq!(info.signing_payload, step.message.as_bytes());
        assert_eq!(info.transaction_hash, step.transaction_hash);
        let wire = message.wire(&[message.sign(&key(1)).unwrap()]).unwrap();
        let done = OwnerSignedDoc {
            original: step.clone(),
            wire: STANDARD.encode(&wire),
        };
        let packet = owner_signed(&done).unwrap();
        let named = packet.0.provider().owner_signed_info(&packet.0).unwrap();
        assert_eq!(named.identity, wire[1..65].to_vec());
        assert_eq!(named.action, "pause");
        // Another key's signature, changed bytes, or a step that names another owner.
        let mut forged = wire.clone();
        forged[1] ^= 1;
        assert!(
            OwnerSignedDoc {
                original: step.clone(),
                wire: STANDARD.encode(&forged)
            }
            .validate()
            .is_err()
        );
        let mut other = step.clone();
        other.owner = crate::config::tests::address(9);
        assert!(other.validate().is_err());
        let mut renamed = step.clone();
        renamed.transaction_hash = [1; 32];
        assert!(renamed.validate().is_err());
    }

    #[test]
    fn a_retained_packet_is_restored_only_as_what_it_is() {
        let doc = signed_doc(2_000_000);
        let restored = restore(Kind::Signed, raw(&doc)).unwrap();
        assert_eq!(restored.network(), doc.prepared.config.network);
        restore(Kind::Prepared, raw(&doc.prepared)).unwrap();
        restore(Kind::Receipt, raw(&receipt_of(&doc, Some(2_000_000)))).unwrap();
        restore(Kind::Owner, raw(&owner_step().0)).unwrap();
        assert!(restore(Kind::Prepared, raw(&doc)).is_err());
        assert!(restore(Kind::Signed, raw(&doc.prepared)).is_err());
        assert!(restore(Kind::Request, raw(&doc.prepared.request)).is_err());
        let mut tampered = doc.clone();
        tampered.prepared.request.units += 1;
        assert!(restore(Kind::Signed, raw(&tampered)).is_err());
    }

    #[test]
    fn a_snapshots_evidence_names_who_may_do_what() {
        let config = sample();
        let evidence = SnapshotDoc {
            config: config.clone(),
            observed_height: 100,
            observed_at: Some(1_800_000_000),
            delegate: Some(config.roles().unwrap().delegate().to_string()),
            allowance: 5_000_000,
            balance: 10_000_000,
        };
        let snapshot = |doc: &SnapshotDoc| Snapshot {
            accounting: Default::default(),
            observed_height: doc.observed_height,
            paused: doc.delegate.is_none(),
            params: Default::default(),
            state: Default::default(),
            evidence: packet(&doc.config.network, doc).unwrap(),
        };
        let s = snapshot(&evidence);
        assert_eq!(PACKETS.signer_weight(&s, &config.owner).unwrap(), 3);
        assert_eq!(PACKETS.signer_weight(&s, &config.agent).unwrap(), 1);
        assert_eq!(PACKETS.signer_weight(&s, &config.server).unwrap(), 1);
        assert_eq!(PACKETS.signer_weight(&s, &config.wallet).unwrap(), 0);
        assert_eq!(
            PACKETS.snapshot_observed_at(&s).unwrap(),
            Some(1_800_000_000)
        );
        let authority = PACKETS.authority_document(&s).unwrap();
        assert_eq!(authority["delegate"], authority["expectedDelegate"]);
        assert_eq!(authority["payment"]["threshold"], 2);
        let mut stopped = evidence.clone();
        stopped.delegate = None;
        assert!(!PACKETS.same_snapshot(&s, &snapshot(&stopped)).unwrap());
        let mut later = evidence.clone();
        later.observed_height = 200;
        later.balance = 1;
        assert!(PACKETS.same_snapshot(&s, &snapshot(&later)).unwrap());
        // The owner's consent is the owner's signature over the exact text.
        let consent = |seed: u8, text: &str| Signature {
            identity: key(seed).identity().to_owned(),
            bytes: key(seed).sign_bytes(text.as_bytes()).unwrap(),
        };
        PACKETS
            .verify_consent(
                &s,
                "I approve",
                &[consent(2, "I approve"), consent(1, "I approve")],
            )
            .unwrap();
        assert!(
            PACKETS
                .verify_consent(&s, "I approve", &[consent(2, "I approve")])
                .is_err()
        );
        assert!(
            PACKETS
                .verify_consent(&s, "I approve", &[consent(1, "I refuse")])
                .is_err()
        );
        let mut forged = consent(2, "I approve");
        forged.identity = config.owner.clone();
        assert!(PACKETS.verify_consent(&s, "I approve", &[forged]).is_err());
    }
}
