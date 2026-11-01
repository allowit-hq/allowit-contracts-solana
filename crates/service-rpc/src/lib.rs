use allowit_sdk::service::rpc::Operation;
use serde_json::{Value, json};
pub fn is_read_method(method: &str) -> bool {
    matches!(
        method,
        "getGenesisHash"
            | "getAccountInfo"
            | "getLatestBlockhash"
            | "getSignatureStatuses"
            | "getBlockHeight"
            | "getSlot"
            | "getBlockTime"
            | "getTransaction"
            | "getBlock"
            | "isBlockhashValid"
            | "simulateTransaction"
            | "getSignaturesForAddress"
    )
}
pub fn diagnostic_method(method: &str) -> &'static str {
    match method {
        "getGenesisHash" => "getGenesisHash",
        "getAccountInfo" => "getAccountInfo",
        "getLatestBlockhash" => "getLatestBlockhash",
        "getSignatureStatuses" => "getSignatureStatuses",
        "getBlockHeight" => "getBlockHeight",
        "getSlot" => "getSlot",
        "getBlockTime" => "getBlockTime",
        "getTransaction" => "getTransaction",
        "getBlock" => "getBlock",
        "isBlockhashValid" => "isBlockhashValid",
        "sendTransaction" => "sendTransaction",
        "simulateTransaction" => "simulateTransaction",
        "getSignaturesForAddress" => "getSignaturesForAddress",
        _ => "unknown",
    }
}
pub fn is_identical_submission(method: &str, params: &Value, wire: Option<&str>) -> bool {
    method == "sendTransaction"
        && params.as_array().is_some_and(|v| v.len() == 2)
        && wire.is_some_and(|wire| params[0].as_str() == Some(wire))
        && params[1]
            == json!({"encoding":"base64","skipPreflight":false,"preflightCommitment":"finalized","maxRetries":0})
}
#[derive(Clone, Copy)]
pub enum Commitment {
    Processed,
    Confirmed,
    Finalized,
}
impl Commitment {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Processed => "processed",
            Self::Confirmed => "confirmed",
            Self::Finalized => "finalized",
        }
    }
}
#[derive(Clone, Copy)]
pub enum Encoding {
    JsonParsed,
    Json,
    Base64,
}
impl Encoding {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::JsonParsed => "jsonParsed",
            Self::Json => "json",
            Self::Base64 => "base64",
        }
    }
}
pub struct Request {
    method: &'static str,
    params: Value,
}
impl Operation for Request {
    fn method(&self) -> &str {
        self.method
    }
    fn params(&self) -> Value {
        self.params.clone()
    }
}
impl Request {
    fn new(method: &'static str, params: Value) -> Self {
        Self { method, params }
    }
    pub fn genesis_hash() -> Self {
        Self::new("getGenesisHash", json!([]))
    }
    pub fn account_info(
        address: &str,
        encoding: Encoding,
        commitment: Commitment,
        min_slot: Option<u64>,
    ) -> Self {
        let mut config = json!({"encoding":encoding.as_str(),"commitment":commitment.as_str()});
        if let Some(slot) = min_slot {
            config["minContextSlot"] = json!(slot);
        }
        Self::new("getAccountInfo", json!([address, config]))
    }
    pub fn latest_blockhash(commitment: Commitment) -> Self {
        Self::new(
            "getLatestBlockhash",
            json!([{"commitment":commitment.as_str()}]),
        )
    }
    pub fn signature_statuses(signatures: &[String], history: bool) -> Self {
        Self::new(
            "getSignatureStatuses",
            json!([signatures,{"searchTransactionHistory":history}]),
        )
    }
    pub fn transaction(
        signature: &str,
        encoding: Encoding,
        commitment: Commitment,
        max_version: Option<u64>,
    ) -> Self {
        let mut config = json!({"encoding":encoding.as_str(),"commitment":commitment.as_str()});
        if let Some(version) = max_version {
            config["maxSupportedTransactionVersion"] = json!(version);
        }
        Self::new("getTransaction", json!([signature, config]))
    }
    pub fn block_time(slot: u64) -> Self {
        Self::new("getBlockTime", json!([slot]))
    }
    pub fn block_height(commitment: Commitment) -> Self {
        Self::new(
            "getBlockHeight",
            json!([{"commitment":commitment.as_str()}]),
        )
    }
    pub fn balance(owner: &str, commitment: Commitment) -> Self {
        Self::new(
            "getBalance",
            json!([owner,{"commitment":commitment.as_str()}]),
        )
    }
    pub fn epoch_info(commitment: Commitment) -> Self {
        Self::new("getEpochInfo", json!([{"commitment":commitment.as_str()}]))
    }
    pub fn blockhash_valid(hash: &str, commitment: Commitment) -> Self {
        Self::new(
            "isBlockhashValid",
            json!([hash,{"commitment":commitment.as_str()}]),
        )
    }
    pub fn signatures_for_address(
        address: &str,
        limit: usize,
        commitment: Commitment,
        before: Option<&str>,
    ) -> Self {
        let mut config = json!({"limit":limit,"commitment":commitment.as_str()});
        if let Some(before) = before {
            config["before"] = json!(before);
        }
        Self::new("getSignaturesForAddress", json!([address, config]))
    }
    pub fn token_accounts_by_owner(
        owner: &str,
        mint: &str,
        encoding: Encoding,
        commitment: Commitment,
    ) -> Self {
        Self::new(
            "getTokenAccountsByOwner",
            json!([owner,{"mint":mint},{"encoding":encoding.as_str(),"commitment":commitment.as_str()}]),
        )
    }
    pub fn send_transaction(wire: &str, preflight: Commitment) -> Self {
        Self::new(
            "sendTransaction",
            json!([wire,{"encoding":"base64","skipPreflight":false,"preflightCommitment":preflight.as_str(),"maxRetries":0}]),
        )
    }
}

/// Preserve the rail's existing temporary-read refusal classification.
pub fn is_temporary_read_refusal(error: &allowit_sdk::transport::rpc::Error) -> bool {
    error.is_well_formed_refusal() && matches!(error.rpc_code, Some(-32002 | -32005))
}
