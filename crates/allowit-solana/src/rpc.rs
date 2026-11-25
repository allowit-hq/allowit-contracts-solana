//! The Solana JSON-RPC behind the rail's ledger traits, over the caller's bounded transport, and
//! the owner's journal in the caller's store.
//!
//! Reads are of the finalized bank. A signature's status and the block height that proves a
//! lapse come from two calls, so [`Rpc::observe`] refuses a status answered by a node that is
//! behind the bank whose height it read: an older node cannot report "no status" for a
//! transaction that the newer bank holds.
use crate::owner::{Account, Journal, Ledger, Observation, Recent, Retained, Status};
use crate::payment::{Finalized, Receipts, TokenBalance};
use crate::runtime::{Bank, Chain};
use allowit_core::{
    client::store::Store,
    vendor::{
        error::{Error, Result},
        runtime::Transport,
    },
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use solana_address::Address;
use solana_hash::Hash;
use std::sync::Arc;

/// The largest account that the rail reads: a multisig is 355 bytes, a token account 165.
const MAX_ACCOUNT_BYTES: usize = 1_024;

/// A Solana RPC endpoint as the rail's ledger.
pub struct Rpc(pub Arc<dyn Transport>);

fn malformed(method: &str) -> Error {
    Error::config(format!(
        "The Solana RPC answered {method} in a form that the rail does not read"
    ))
}

impl Rpc {
    fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.0.call(method, params)
    }
}

impl Ledger for Rpc {
    fn account(&self, address: &Address) -> Result<Option<Account>> {
        let bad = || malformed("getAccountInfo");
        let reply = self.call(
            "getAccountInfo",
            json!([address.to_string(), {"encoding":"base64","commitment":"finalized"}]),
        )?;
        let value = reply.get("value").ok_or_else(bad)?;
        if value.is_null() {
            return Ok(None);
        }
        let data = value["data"].as_array().ok_or_else(bad)?;
        let encoded = data
            .first()
            .and_then(Value::as_str)
            .filter(|text| text.len() <= MAX_ACCOUNT_BYTES.div_ceil(3) * 4)
            .ok_or_else(bad)?;
        if data.get(1).and_then(Value::as_str) != Some("base64") {
            return Err(bad());
        }
        Ok(Some(Account {
            lamports: value["lamports"].as_u64().ok_or_else(bad)?,
            owner: value["owner"]
                .as_str()
                .and_then(|owner| owner.parse().ok())
                .ok_or_else(bad)?,
            data: STANDARD.decode(encoded).map_err(|_| bad())?,
        }))
    }

    fn deposit(&self, len: u64) -> Result<u64> {
        self.call(
            "getMinimumBalanceForRentExemption",
            json!([len, {"commitment":"finalized"}]),
        )?
        .as_u64()
        .ok_or_else(|| malformed("getMinimumBalanceForRentExemption"))
    }

    fn recent(&self) -> Result<Recent> {
        let bad = || malformed("getLatestBlockhash");
        let reply = self.call("getLatestBlockhash", json!([{"commitment":"finalized"}]))?;
        let value = &reply["value"];
        let bytes: [u8; 32] = value["blockhash"]
            .as_str()
            .filter(|text| text.len() <= 44)
            .and_then(|text| bs58::decode(text).into_vec().ok())
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(bad)?;
        Ok(Recent {
            blockhash: Hash::new_from_array(bytes),
            last_valid_height: value["lastValidBlockHeight"].as_u64().ok_or_else(bad)?,
        })
    }

    /// The node checks the transaction against its finalized bank and does not send it again by
    /// itself: the rail sends the identical bytes again while they are valid.
    fn submit(&self, wire: &[u8]) -> Result<()> {
        self.call(
            "sendTransaction",
            json!([STANDARD.encode(wire), {"encoding":"base64","skipPreflight":false,
                "preflightCommitment":"finalized","maxRetries":0}]),
        )
        .map(|_| ())
    }

    fn observe(&self, signature: &[u8; 64]) -> Result<Observation> {
        let bank = self.call("getEpochInfo", json!([{"commitment":"finalized"}]))?;
        let bad = || malformed("getEpochInfo");
        let finalized_height = bank["blockHeight"].as_u64().ok_or_else(bad)?;
        let slot = bank["absoluteSlot"].as_u64().ok_or_else(bad)?;
        let bad = || malformed("getSignatureStatuses");
        let reply = self.call(
            "getSignatureStatuses",
            json!([[bs58::encode(signature).into_string()], {"searchTransactionHistory":true}]),
        )?;
        if reply["context"]["slot"].as_u64().ok_or_else(bad)? < slot {
            return Err(Error::config(
                "The Solana RPC answered a signature status from a node behind its finalized bank; ask again",
            ));
        }
        let row = reply["value"]
            .as_array()
            .filter(|rows| rows.len() == 1)
            .map(|rows| &rows[0])
            .ok_or_else(bad)?;
        let status = if row.is_null() {
            Status::Unknown
        } else if row["confirmationStatus"] == "finalized" {
            Status::Finalized {
                failed: !row.get("err").ok_or_else(bad)?.is_null(),
            }
        } else if row["confirmationStatus"].is_string() {
            Status::Pending
        } else {
            return Err(bad());
        };
        Ok(Observation {
            status,
            finalized_height,
        })
    }
}

/// The token balances of a finalized transaction: every account that `before` or `after` lists,
/// with zero where one of them does not list it (an account that the transaction opened or
/// closed).
fn balances(before: &Value, after: &Value) -> Result<Vec<TokenBalance>> {
    let bad = || malformed("getTransaction");
    let rows = |list: &Value| -> Result<Vec<(usize, Address, u64)>> {
        list.as_array()
            .ok_or_else(bad)?
            .iter()
            .map(|row| {
                Ok((
                    row["accountIndex"]
                        .as_u64()
                        .and_then(|index| usize::try_from(index).ok())
                        .ok_or_else(bad)?,
                    row["mint"]
                        .as_str()
                        .and_then(|mint| mint.parse().ok())
                        .ok_or_else(bad)?,
                    row["uiTokenAmount"]["amount"]
                        .as_str()
                        .and_then(|amount| amount.parse().ok())
                        .ok_or_else(bad)?,
                ))
            })
            .collect()
    };
    let (before, after) = (rows(before)?, rows(after)?);
    let mut out: Vec<TokenBalance> = after
        .iter()
        .map(|&(index, mint, amount)| TokenBalance {
            index,
            mint,
            before: before
                .iter()
                .find(|row| row.0 == index && row.1 == mint)
                .map_or(0, |row| row.2),
            after: amount,
        })
        .collect();
    for &(index, mint, amount) in &before {
        if !out.iter().any(|b| b.index == index && b.mint == mint) {
            out.push(TokenBalance {
                index,
                mint,
                before: amount,
                after: 0,
            });
        }
    }
    Ok(out)
}

impl Receipts for Rpc {
    fn transaction(&self, signature: &[u8; 64]) -> Result<Option<Finalized>> {
        let bad = || malformed("getTransaction");
        let reply = self.call(
            "getTransaction",
            json!([bs58::encode(signature).into_string(), {"encoding":"base64",
                "commitment":"finalized","maxSupportedTransactionVersion":0}]),
        )?;
        if reply.is_null() {
            return Ok(None);
        }
        let meta = reply["meta"].as_object().ok_or_else(bad)?;
        let wire = reply["transaction"][0]
            .as_str()
            .filter(|text| text.len() <= 1_644 && reply["transaction"][1] == "base64")
            .and_then(|text| STANDARD.decode(text).ok())
            .ok_or_else(bad)?;
        Ok(Some(Finalized {
            wire,
            failed: !meta.get("err").ok_or_else(bad)?.is_null(),
            fee: meta.get("fee").and_then(Value::as_u64).ok_or_else(bad)?,
            slot: reply["slot"].as_u64().ok_or_else(bad)?,
            block_time: reply["blockTime"].as_u64(),
            balances: balances(
                meta.get("preTokenBalances").ok_or_else(bad)?,
                meta.get("postTokenBalances").ok_or_else(bad)?,
            )?,
        }))
    }
}

impl Chain for Rpc {
    /// The finalized bank's block height, and the time of its slot's block where the node
    /// states one. A node that cannot say the time still gives the height.
    fn bank(&self) -> Result<Bank> {
        let bad = || malformed("getEpochInfo");
        let bank = self.call("getEpochInfo", json!([{"commitment":"finalized"}]))?;
        let height = bank["blockHeight"].as_u64().ok_or_else(bad)?;
        let slot = bank["absoluteSlot"].as_u64().ok_or_else(bad)?;
        let time = self
            .call("getBlockTime", json!([slot]))
            .ok()
            .and_then(|time| time.as_u64());
        Ok(Bank { height, time })
    }

    /// Pages of `getSignaturesForAddress`, newest first, from a node that has finalized the slot
    /// of the bank read just before. The read ends at the first row older than `since`, or at a
    /// short page; more pages than `HISTORY_PAGES` are an error, not a partial answer.
    fn history(&self, address: &Address, since: u64) -> Result<Vec<[u8; 64]>> {
        let bad = || malformed("getSignaturesForAddress");
        let slot = self.call("getEpochInfo", json!([{"commitment":"finalized"}]))?["absoluteSlot"]
            .as_u64()
            .ok_or_else(|| malformed("getEpochInfo"))?;
        let mut found = Vec::new();
        let mut before: Option<String> = None;
        for _ in 0..HISTORY_PAGES {
            let mut config =
                json!({"limit":HISTORY_PAGE,"commitment":"finalized","minContextSlot":slot});
            if let Some(before) = &before {
                config["before"] = json!(before);
            }
            let reply = self.call(
                "getSignaturesForAddress",
                json!([address.to_string(), config]),
            )?;
            let rows = reply.as_array().ok_or_else(bad)?;
            for row in rows {
                let text = row["signature"].as_str().ok_or_else(bad)?;
                if row["blockTime"].as_u64().is_some_and(|time| time < since) {
                    return Ok(found);
                }
                let signature: [u8; 64] = Some(text)
                    .filter(|text| text.len() <= 88)
                    .and_then(|text| bs58::decode(text).into_vec().ok())
                    .and_then(|bytes| bytes.try_into().ok())
                    .ok_or_else(bad)?;
                found.push(signature);
                before = Some(text.into());
            }
            if rows.len() < HISTORY_PAGE {
                return Ok(found);
            }
        }
        Err(Error::uncertain(
            "The wallet's history is longer than the rail reads; the absence of a transaction is not proven",
        ))
    }
}

/// The rows of one page of an address's history, and the most pages that one read takes.
const HISTORY_PAGE: usize = 1_000;
const HISTORY_PAGES: usize = 4;

/// The retained transaction as its journal record.
fn record(retained: &Retained) -> Value {
    json!({
        "version": 1,
        "request": bs58::encode(retained.request).into_string(),
        "wire": STANDARD.encode(&retained.wire),
        "signature": bs58::encode(retained.signature).into_string(),
        "lastValidBlockHeight": retained.last_valid_height,
    })
}

/// A journal record as the retained transaction. A record that the rail did not write, or whose
/// signature is not the first signature of its bytes, is refused: nothing is sent from it.
fn retained(record: &Value) -> Result<Retained> {
    let bad =
        || Error::config("The owner journal holds a record that the Solana rail did not write");
    let object = record
        .as_object()
        .filter(|o| o.len() == 5)
        .ok_or_else(bad)?;
    if object.get("version") != Some(&json!(1)) {
        return Err(bad());
    }
    let text = |key: &str, max: usize| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| text.len() <= max)
            .ok_or_else(bad)
    };
    let request: [u8; 32] = bs58::decode(text("request", 44)?)
        .into_vec()
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(bad)?;
    let signature: [u8; 64] = bs58::decode(text("signature", 88)?)
        .into_vec()
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(bad)?;
    let wire = STANDARD.decode(text("wire", 1_644)?).map_err(|_| bad())?;
    if wire.len() < 65 || wire[1..65] != signature {
        return Err(bad());
    }
    Ok(Retained {
        request,
        wire,
        signature,
        last_valid_height: object
            .get("lastValidBlockHeight")
            .and_then(Value::as_u64)
            .ok_or_else(bad)?,
    })
}

/// The caller's store as the owner's journal: one record for each request id.
impl Journal for Store {
    fn load(&self, request_id: &str) -> Result<Option<Retained>> {
        Store::load::<Value>(self, request_id)?
            .as_ref()
            .map(retained)
            .transpose()
    }
    fn save(&self, request_id: &str, value: &Retained) -> Result<()> {
        Store::save(self, request_id, &record(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A transport that answers each method from a table and records what it was asked.
    struct Node {
        replies: Vec<(&'static str, Value)>,
        asked: Mutex<Vec<(String, Value)>>,
    }
    impl Transport for Node {
        fn call(&self, method: &str, params: Value) -> Result<Value> {
            self.asked.lock().unwrap().push((method.into(), params));
            self.replies
                .iter()
                .find(|(name, _)| *name == method)
                .map(|(_, reply)| reply.clone())
                .ok_or_else(|| Error::config("refused"))
        }
    }
    fn rpc(replies: Vec<(&'static str, Value)>) -> (Rpc, Arc<Node>) {
        let node = Arc::new(Node {
            replies,
            asked: Mutex::default(),
        });
        (Rpc(node.clone()), node)
    }
    fn observed(height: u64, slot: u64, context: u64, row: Value) -> Result<Observation> {
        rpc(vec![
            (
                "getEpochInfo",
                json!({"blockHeight":height,"absoluteSlot":slot}),
            ),
            (
                "getSignatureStatuses",
                json!({"context":{"slot":context},"value":[row]}),
            ),
        ])
        .0
        .observe(&[7; 64])
    }

    #[test]
    fn an_account_is_read_from_the_finalized_bank() {
        let address = Address::new_from_array([4; 32]);
        let owner = Address::new_from_array([5; 32]);
        let (ledger, node) = rpc(vec![(
            "getAccountInfo",
            json!({"context":{"slot":9},"value":{"lamports":2_039_280,"owner":owner.to_string(),
                "data":[STANDARD.encode([1u8;165]),"base64"],"executable":false}}),
        )]);
        let account = ledger.account(&address).unwrap().unwrap();
        assert_eq!(
            (account.lamports, account.owner, account.data),
            (2_039_280, owner, vec![1u8; 165])
        );
        assert_eq!(
            node.asked.lock().unwrap()[0],
            (
                "getAccountInfo".into(),
                json!([address.to_string(), {"encoding":"base64","commitment":"finalized"}])
            )
        );
        let absent = rpc(vec![("getAccountInfo", json!({"value":null}))]).0;
        assert_eq!(absent.account(&address).unwrap(), None);
        for bad in [
            json!({}),
            json!({"value":{"lamports":1,"owner":owner.to_string(),"data":["AA==","base58"]}}),
            json!({"value":{"lamports":1,"owner":"not an address","data":["AA==","base64"]}}),
            json!({"value":{"lamports":"1","owner":owner.to_string(),"data":["AA==","base64"]}}),
            json!({"value":{"lamports":1,"owner":owner.to_string(),
                "data":[STANDARD.encode(vec![0u8;4_096]),"base64"]}}),
        ] {
            let ledger = rpc(vec![("getAccountInfo", bad.clone())]).0;
            assert!(ledger.account(&address).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_blockhash_comes_with_its_last_valid_height_and_a_deposit_is_the_nodes() {
        let hash = Hash::new_from_array([3; 32]);
        let (ledger, _) = rpc(vec![
            (
                "getLatestBlockhash",
                json!({"value":{"blockhash":hash.to_string(),"lastValidBlockHeight":250}}),
            ),
            ("getMinimumBalanceForRentExemption", json!(2_039_280)),
        ]);
        assert_eq!(
            ledger.recent().unwrap(),
            Recent {
                blockhash: hash,
                last_valid_height: 250
            }
        );
        assert_eq!(ledger.deposit(165).unwrap(), 2_039_280);
        let bad = rpc(vec![(
            "getLatestBlockhash",
            json!({"value":{"blockhash":"short","lastValidBlockHeight":250}}),
        )])
        .0;
        assert!(bad.recent().is_err());
        assert!(bad.deposit(165).is_err());
    }

    #[test]
    fn a_submission_sends_the_exact_bytes_once() {
        let (ledger, node) = rpc(vec![("sendTransaction", json!("signature"))]);
        ledger.submit(&[1, 2, 3]).unwrap();
        let asked = node.asked.lock().unwrap();
        assert_eq!(asked[0].1[0], STANDARD.encode([1, 2, 3]));
        assert_eq!(asked[0].1[1]["maxRetries"], 0);
        assert_eq!(asked[0].1[1]["skipPreflight"], false);
        assert!(rpc(vec![]).0.submit(&[1]).is_err());
    }

    #[test]
    fn a_status_is_believed_only_from_a_node_at_the_finalized_bank() {
        let finalized = |err: Value| json!({"slot":18,"confirmationStatus":"finalized","err":err});
        assert_eq!(
            observed(300, 20, 20, Value::Null).unwrap(),
            Observation {
                status: Status::Unknown,
                finalized_height: 300
            }
        );
        assert_eq!(
            observed(300, 20, 25, finalized(Value::Null))
                .unwrap()
                .status,
            Status::Finalized { failed: false }
        );
        assert_eq!(
            observed(
                300,
                20,
                20,
                finalized(json!({"InstructionError":[0,"Custom"]}))
            )
            .unwrap()
            .status,
            Status::Finalized { failed: true }
        );
        assert_eq!(
            observed(
                300,
                20,
                20,
                json!({"confirmationStatus":"confirmed","err":null})
            )
            .unwrap()
            .status,
            Status::Pending
        );
        // A node behind the bank of the height proves no absence.
        assert!(observed(300, 20, 19, Value::Null).is_err());
        assert!(observed(300, 20, 20, json!({"slot":18})).is_err());
        assert!(observed(300, 20, 20, json!({"confirmationStatus":"finalized"})).is_err());
    }

    #[test]
    fn a_finalized_transaction_is_read_with_its_fee_time_and_token_balances() {
        let mint = Address::new_from_array([9; 32]);
        let row = |index: u64, amount: &str| {
            json!({"accountIndex":index,"mint":mint.to_string(),
                "uiTokenAmount":{"amount":amount,"decimals":6}})
        };
        let reply = json!({"slot":42,"blockTime":1_800_000_000u64,
            "transaction":[STANDARD.encode([5u8;300]),"base64"],
            "meta":{"err":null,"fee":10_001,
                "preTokenBalances":[row(1,"10000000"),row(4,"7")],
                "postTokenBalances":[row(1,"8000000"),row(2,"2000000")]}});
        let (ledger, node) = rpc(vec![("getTransaction", reply.clone())]);
        let read = ledger.transaction(&[7; 64]).unwrap().unwrap();
        assert_eq!(
            (read.failed, read.fee, read.slot, read.block_time),
            (false, 10_001, 42, Some(1_800_000_000))
        );
        assert_eq!(read.wire, vec![5u8; 300]);
        let balance = |index, before, after| TokenBalance {
            index,
            mint,
            before,
            after,
        };
        // An account that the transaction opened starts at zero; one that it closed ends there.
        assert_eq!(
            read.balances,
            [
                balance(1, 10_000_000, 8_000_000),
                balance(2, 0, 2_000_000),
                balance(4, 7, 0)
            ]
        );
        {
            let asked = node.asked.lock().unwrap();
            assert_eq!(asked[0].1[0], bs58::encode([7u8; 64]).into_string());
            assert_eq!(asked[0].1[1]["commitment"], "finalized");
        }
        let absent = rpc(vec![("getTransaction", Value::Null)]).0;
        assert_eq!(absent.transaction(&[7; 64]).unwrap(), None);
        let change = |path: &[&str], value: Value| {
            let mut reply = reply.clone();
            let mut at = &mut reply;
            for key in path {
                at = &mut at[*key];
            }
            *at = value;
            reply
        };
        let failed = change(
            &["meta", "err"],
            json!({"InstructionError":[2,{"Custom":1}]}),
        );
        assert!(
            rpc(vec![("getTransaction", failed)])
                .0
                .transaction(&[7; 64])
                .unwrap()
                .unwrap()
                .failed
        );
        for bad in [
            change(&["meta"], json!(null)),
            change(&["meta", "fee"], json!("10001")),
            change(&["slot"], json!(null)),
            change(&["transaction"], json!(["AAAA", "base58"])),
            change(&["meta", "preTokenBalances"], json!(null)),
            change(&["meta", "postTokenBalances"], json!([{"accountIndex":1}])),
            change(
                &["meta", "postTokenBalances"],
                json!([{"accountIndex":1,"mint":mint.to_string(),"uiTokenAmount":{"amount":8}}]),
            ),
        ] {
            let ledger = rpc(vec![("getTransaction", bad.clone())]).0;
            assert!(ledger.transaction(&[7; 64]).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_bank_is_the_finalized_height_with_its_blocks_time() {
        let epoch = json!({"blockHeight":300,"absoluteSlot":320});
        let (ledger, node) = rpc(vec![
            ("getEpochInfo", epoch.clone()),
            ("getBlockTime", json!(1_800_000_000u64)),
        ]);
        assert_eq!(
            ledger.bank().unwrap(),
            Bank {
                height: 300,
                time: Some(1_800_000_000)
            }
        );
        assert_eq!(node.asked.lock().unwrap()[1].1, json!([320]));
        // A node without the block's time still gives the height.
        let (ledger, _) = rpc(vec![("getEpochInfo", epoch)]);
        assert_eq!(
            ledger.bank().unwrap(),
            Bank {
                height: 300,
                time: None
            }
        );
        assert!(
            rpc(vec![("getEpochInfo", json!({"absoluteSlot":320}))])
                .0
                .bank()
                .is_err()
        );
    }

    #[test]
    fn a_history_is_complete_back_to_its_floor_or_it_is_an_error() {
        let address = Address::new_from_array([4; 32]);
        let row = |byte: u8, time: Value| {
            json!({"signature":bs58::encode([byte; 64]).into_string(),"slot":10,"err":null,
                "blockTime":time})
        };
        let epoch = (
            "getEpochInfo",
            json!({"blockHeight":300,"absoluteSlot":320}),
        );
        let (ledger, node) = rpc(vec![
            epoch.clone(),
            (
                "getSignaturesForAddress",
                json!([
                    row(1, json!(2_000)),
                    row(2, Value::Null),
                    row(3, json!(999)),
                    row(4, json!(2_000))
                ]),
            ),
        ]);
        // The read ends at the first row older than the floor; a row without a time is kept.
        assert_eq!(
            ledger.history(&address, 1_000).unwrap(),
            vec![[1u8; 64], [2u8; 64]]
        );
        let asked = node.asked.lock().unwrap()[1].1.clone();
        assert_eq!(asked[0], address.to_string());
        assert_eq!(asked[1]["minContextSlot"], 320);
        assert_eq!(asked[1]["commitment"], "finalized");
        drop(asked);
        // Full pages without an end are not an absence.
        let full: Vec<Value> = (0..HISTORY_PAGE).map(|_| row(1, json!(2_000))).collect();
        let (ledger, node) = rpc(vec![
            epoch.clone(),
            ("getSignaturesForAddress", json!(full)),
        ]);
        assert!(ledger.history(&address, 1_000).is_err());
        assert_eq!(node.asked.lock().unwrap().len(), 1 + HISTORY_PAGES);
        assert!(node.asked.lock().unwrap()[2].1[1]["before"].is_string());
        for bad in [
            json!(null),
            json!([{"slot":1}]),
            json!([{"signature":"short"}]),
        ] {
            let (ledger, _) = rpc(vec![epoch.clone(), ("getSignaturesForAddress", bad)]);
            assert!(ledger.history(&address, 1_000).is_err());
        }
    }

    #[test]
    fn a_journal_record_keeps_the_bytes_and_refuses_what_the_rail_did_not_write() {
        let mut wire = vec![1u8];
        wire.extend([7u8; 64]);
        wire.extend([9u8; 100]);
        let kept = Retained {
            request: [3; 32],
            wire,
            signature: [7; 64],
            last_valid_height: 250,
        };
        let written = record(&kept);
        assert_eq!(retained(&written).unwrap(), kept);
        let change = |key: &str, value: Value| {
            let mut record = written.clone();
            record[key] = value;
            record
        };
        for bad in [
            json!(null),
            change("version", json!(2)),
            change("extra", json!(1)),
            change("request", json!("short")),
            change("signature", json!(bs58::encode([8u8; 64]).into_string())),
            change("wire", json!("not base64!")),
            change("wire", json!(STANDARD.encode([1u8; 10]))),
            change("lastValidBlockHeight", json!("250")),
        ] {
            assert!(retained(&bad).is_err(), "{bad}");
        }
    }
}
