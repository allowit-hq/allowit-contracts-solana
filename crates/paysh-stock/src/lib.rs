//! Solana PaySH stock MPP challenge, funding, packet and HTTP protocol.
//! Merchant secrets and durable execution decisions remain with the caller.
use allowit_native::{
    client::{ATA_PROGRAM, TOKEN_PROGRAM},
    crypto::Key,
    rpc::{Rpc as NativeRpc, account},
    transaction::{Instruction, Meta},
};
use allowit_sdk::service::{Error, Result, fault};
use allowit_sdk::transport::{
    http::{HttpClient, Method, Request},
    rpc::Options,
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
pub const SERVICE_ID: &str = "google-airquality-current";
pub const AMOUNT_USDC: u64 = 1_000;
const ENDPOINT: &str = "https://airquality.google.gateway-402.com/v1/currentConditions:lookup";
const MEMO: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const COMPUTE: &str = "ComputeBudget111111111111111111111111111111";
pub const MAINNET_GENESIS: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
pub const MAINNET_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
fn denied() -> Error {
    fault(
        502,
        "Stock PaySH challenge or merchant configuration is incompatible.",
    )
}
fn pending() -> Error {
    fault(
        503,
        "Stock PaySH outcome is pending; retain the original operation. Do not submit another credential.",
    )
}
fn key(s: &str) -> Result<Key> {
    Key::parse(s).map_err(|_| denied())
}
fn ata(owner: Key) -> Result<Key> {
    let token = key(TOKEN_PROGRAM)?;
    let mint = key(MAINNET_MINT)?;
    Key::find_program_address(&[&owner.0, &token.0, &mint.0], key(ATA_PROGRAM)?)
        .map(|p| p.0)
        .map_err(|_| denied())
}
pub fn associated_token_account(owner: [u8; 32]) -> Result<[u8; 32]> {
    ata(Key(owner)).map(|key| key.0)
}
/// Public keys only. The caller owns merchant configuration admission.
pub struct MerchantConfig {
    pub approved_recipients: Vec<[u8; 32]>,
    pub approved_fee_payers: Vec<[u8; 32]>,
}
struct InternalConfig {
    approved_recipients: Vec<Key>,
    approved_fee_payers: Vec<Key>,
}
pub trait Signer {
    fn public_key(&self) -> [u8; 32];
    fn sign(&self, message: &[u8]) -> [u8; 64];
}
/// Forward one library-selected RPC operation through the caller's bounded rail.
pub trait Rpc: Send + Sync {
    fn call(&self, method: &str, params: Value) -> Result<Value>;
}
struct RpcAdapter<'a>(&'a dyn Rpc);
impl NativeRpc for RpcAdapter<'_> {
    fn call(&self, method: &str, params: Value) -> allowit_native::error::Result<Value> {
        self.0
            .call(method, params)
            .map_err(|_| allowit_native::error::Error::uncertain("Stock funding read failed."))
    }
}
pub fn validate_charge(
    selected: &Selected,
    config: &MerchantConfig,
    paid: u64,
    now: i64,
) -> Result<Charge> {
    let config = InternalConfig {
        approved_recipients: config
            .approved_recipients
            .iter()
            .copied()
            .map(Key)
            .collect(),
        approved_fee_payers: config
            .approved_fee_payers
            .iter()
            .copied()
            .map(Key)
            .collect(),
    };
    validate_charge_inner(selected, &config, paid, now)
}
pub fn validate_funding(rpc: &dyn Rpc, merchant: [u8; 32], charge: &Charge) -> Result<()> {
    validate_funding_inner(&RpcAdapter(rpc), Key(merchant), charge)
}

pub trait StockTransport: Send + Sync {
    fn challenge(&self, body: &str) -> Result<String>;
    fn submit(&self, body: &str, credential: &str) -> Result<(Value, Option<String>)>;
}
pub fn challenge_status(status: u16, headers: usize) -> Result<()> {
    if status == 402 {
        if headers == 1 { Ok(()) } else { Err(denied()) }
    } else if status == 408 || status == 429 || status >= 500 || !(400..500).contains(&status) {
        Err(pending())
    } else {
        Err(denied())
    }
}
pub struct HttpStock {
    client: HttpClient,
    endpoint: String,
}
impl HttpStock {
    pub fn new() -> Result<Self> {
        Ok(Self {
            endpoint: ENDPOINT.into(),
            client: HttpClient::without_connection_reuse(Options {
                timeout: Duration::from_secs(20),
                no_proxy: true,
                max_response_bytes: 65536,
                connect_timeout: None,
            })
            .map_err(|_| denied())?,
        })
    }
}
impl StockTransport for HttpStock {
    fn challenge(&self, body: &str) -> Result<String> {
        let headers = [
            ("Content-Type".into(), "application/json".into()),
            ("Connection".into(), "close".into()),
        ];
        let reply = self
            .client
            .send_headers(
                Request {
                    method: Method::Post,
                    url: &self.endpoint,
                    headers: &headers,
                    body: Some(body.as_bytes()),
                },
                None,
            )
            .map_err(|_| pending())?;
        challenge_status(
            reply.status,
            reply.header_values("www-authenticate").count(),
        )?;
        Ok(reply
            .header("www-authenticate")
            .ok_or_else(denied)?
            .to_owned())
    }
    fn submit(&self, body: &str, credential: &str) -> Result<(Value, Option<String>)> {
        let headers = [
            ("Content-Type".into(), "application/json".into()),
            ("Connection".into(), "close".into()),
            ("Authorization".into(), credential.into()),
        ];
        let reply = self
            .client
            .send_success_body(
                Request {
                    method: Method::Post,
                    url: &self.endpoint,
                    headers: &headers,
                    body: Some(body.as_bytes()),
                },
                None,
            )
            .map_err(|_| pending())?;
        if !(200..300).contains(&reply.status) {
            return Err(pending());
        }
        let receipt = reply
            .header("payment-receipt")
            .filter(|value| value.len() <= 8192)
            .map(str::to_owned);
        let value = serde_json::from_slice(&reply.body).map_err(|_| pending())?;
        Ok((value, receipt))
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Selected {
    id: String,
    realm: String,
    method: String,
    intent: String,
    request: String,
    expires: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    opaque: Option<String>,
}
impl Selected {
    pub fn expires_at(&self) -> Result<i64> {
        chrono::DateTime::parse_from_rfc3339(&self.expires)
            .map(|v| v.timestamp())
            .map_err(|_| denied())
    }
}
// Quoted HTTP authentication parameters, duplicates and trailing data rejected.
// The selected encoded request is preserved byte-for-byte for the credential.
pub fn parse_challenge(header: &str, now: i64) -> Result<Selected> {
    if header.len() > 16384 || !header.starts_with("Payment ") {
        return Err(denied());
    }
    let mut s = &header[8..];
    let mut fields = BTreeMap::new();
    loop {
        s = s.trim_start_matches(' ');
        let (name, rest) = s.split_once('=').ok_or_else(denied)?;
        if name.is_empty()
            || !name.bytes().all(|b| b.is_ascii_alphanumeric())
            || !rest.starts_with('"')
        {
            return Err(denied());
        }
        let mut v = String::new();
        let mut escaped = false;
        let mut end = None;
        for (i, ch) in rest[1..].char_indices() {
            if escaped {
                if !matches!(ch, '"' | '\\') {
                    return Err(denied());
                }
                v.push(ch);
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                end = Some(i + 2);
                break;
            } else if ch.is_control() {
                return Err(denied());
            } else {
                v.push(ch);
            }
        }
        s = &rest[end.ok_or_else(denied)?..];
        if fields.insert(name.to_owned(), v).is_some() {
            return Err(denied());
        }
        if s.is_empty() {
            break;
        }
        s = s.strip_prefix(',').ok_or_else(denied)?;
    }
    if fields.keys().any(|k| {
        !matches!(
            k.as_str(),
            "id" | "realm"
                | "method"
                | "intent"
                | "request"
                | "expires"
                | "description"
                | "digest"
                | "opaque"
        )
    }) {
        return Err(denied());
    }
    let selected: Selected = serde_json::from_value(json!(fields)).map_err(|_| denied())?;
    if selected.method != "solana"
        || selected.intent != "charge"
        || selected.id.is_empty()
        || selected.id.len() > 128
        || selected.realm.is_empty()
        || selected.realm.len() > 128
        || selected.expires_at()? <= now
        || selected.expires_at()? > now + 600
    {
        return Err(denied());
    }
    Ok(selected)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Charge {
    amount: String,
    currency: String,
    recipient: Key,
    method_details: Details,
    description: Option<String>,
    external_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Details {
    decimals: u8,
    fee_payer: bool,
    fee_payer_key: Key,
    network: String,
    recent_blockhash: Key,
    splits: Vec<Split>,
    token_program: Key,
    transaction_versions: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Split {
    amount: String,
    recipient: Key,
    memo: Option<String>,
    label: Option<String>,
    ata_creation_required: Option<bool>,
}
fn units(s: &str) -> Result<u64> {
    if s.is_empty()
        || s.len() > 20
        || !s.bytes().all(|b| b.is_ascii_digit())
        || (s.len() > 1 && s.starts_with('0'))
    {
        return Err(denied());
    }
    s.parse().map_err(|_| denied())
}
fn memo(s: &Option<String>) -> Result<()> {
    if s.as_ref()
        .is_some_and(|v| v.len() > 128 || v.chars().any(char::is_control))
    {
        Err(denied())
    } else {
        Ok(())
    }
}
fn validate_charge_inner(
    selected: &Selected,
    config: &InternalConfig,
    paid: u64,
    now: i64,
) -> Result<Charge> {
    if selected.expires_at()? <= now {
        return Err(denied());
    }
    let raw = URL_SAFE_NO_PAD
        .decode(&selected.request)
        .map_err(|_| denied())?;
    if raw.len() > 8192 || URL_SAFE_NO_PAD.encode(&raw) != selected.request {
        return Err(denied());
    }
    let c: Charge = serde_json::from_slice(&raw).map_err(|_| denied())?;
    let amount = units(&c.amount)?;
    if amount == 0
        || amount > AMOUNT_USDC
        || amount > paid
        || c.currency != MAINNET_MINT
        || c.method_details.network != "mainnet"
        || c.method_details.decimals != 6
        || c.method_details.token_program != key(TOKEN_PROGRAM)?
        || !c.method_details.fee_payer
        || !config
            .approved_fee_payers
            .contains(&c.method_details.fee_payer_key)
        || !config.approved_recipients.contains(&c.recipient)
        || !c.method_details.transaction_versions.contains(&0)
        || c.method_details.transaction_versions.len() > 2
        || c.method_details.splits.len() > 4
        || c.description.as_ref().is_some_and(|s| s.len() > 1024)
    {
        return Err(denied());
    }
    memo(&c.external_id)?;
    let mut sum = 0u64;
    for split in &c.method_details.splits {
        if !config.approved_recipients.contains(&split.recipient)
            || split.ata_creation_required == Some(true)
            || split.label.as_ref().is_some_and(|s| s.len() > 128)
        {
            return Err(denied());
        }
        memo(&split.memo)?;
        sum = sum.checked_add(units(&split.amount)?).ok_or_else(denied)?;
    }
    if sum >= amount {
        return Err(denied());
    }
    Ok(c)
}
fn validate_funding_inner(rpc: &dyn NativeRpc, merchant: Key, c: &Charge) -> Result<()> {
    if rpc
        .call("getGenesisHash", json!([]))
        .map_err(|_| pending())?
        != MAINNET_GENESIS
    {
        return Err(denied());
    }
    if rpc
        .call(
            "isBlockhashValid",
            json!([c.method_details.recent_blockhash,{"commitment":"confirmed"}]),
        )
        .map_err(|_| pending())?["value"]
        != true
    {
        return Err(pending());
    }
    let mint = account(rpc, key(MAINNET_MINT)?, None)
        .map_err(|_| pending())?
        .ok_or_else(denied)?;
    let source = account(rpc, ata(merchant)?, None)
        .map_err(|_| pending())?
        .ok_or_else(denied)?;
    if mint.owner != key(TOKEN_PROGRAM)?
        || mint.executable
        || mint.data.len() != 82
        || mint.data[44] != 6
        || mint.data[45] != 1
        || source.owner != key(TOKEN_PROGRAM)?
        || source.executable
        || source.data.len() != 165
        || source.data[108] != 1
        || source.data[..32] != key(MAINNET_MINT)?.0
        || source.data[32..64] != merchant.0
    {
        return Err(denied());
    }
    if u64::from_le_bytes(source.data[64..72].try_into().unwrap()) < units(&c.amount)? {
        return Err(pending());
    }
    Ok(())
}
fn ro(k: Key) -> Meta {
    Meta {
        key: k,
        writable: false,
        signer: false,
    }
}
fn instructions(c: &Charge, merchant: Key) -> Result<Vec<Instruction>> {
    let mut price = vec![3];
    price.extend(1u64.to_le_bytes());
    let mut limit = vec![2];
    limit.extend(200_000u32.to_le_bytes());
    let mut ix = vec![
        Instruction {
            program: key(COMPUTE)?,
            accounts: vec![],
            data: price,
        },
        Instruction {
            program: key(COMPUTE)?,
            accounts: vec![],
            data: limit,
        },
    ];
    let total = units(&c.amount)?;
    let splits = c
        .method_details
        .splits
        .iter()
        .map(|s| units(&s.amount))
        .collect::<Result<Vec<_>>>()?;
    let sum = splits
        .iter()
        .try_fold(0u64, |sum, value| sum.checked_add(*value))
        .ok_or_else(denied)?;
    let primary = total
        .checked_sub(sum)
        .filter(|v| *v > 0)
        .ok_or_else(denied)?;
    let mut add = |dest: Key, amount: u64, m: &Option<String>| -> Result<()> {
        let mut data = vec![12];
        data.extend(amount.to_le_bytes());
        data.push(6);
        ix.push(Instruction {
            program: key(TOKEN_PROGRAM)?,
            accounts: vec![
                Meta {
                    key: ata(merchant)?,
                    writable: true,
                    signer: false,
                },
                ro(key(MAINNET_MINT)?),
                Meta {
                    key: ata(dest)?,
                    writable: true,
                    signer: false,
                },
                Meta {
                    key: merchant,
                    writable: false,
                    signer: true,
                },
            ],
            data,
        });
        if let Some(m) = m.as_ref().filter(|m| !m.is_empty()) {
            ix.push(Instruction {
                program: key(MEMO)?,
                accounts: vec![],
                data: m.as_bytes().to_vec(),
            });
        }
        Ok(())
    };
    add(c.recipient, primary, &c.external_id)?;
    for (s, amount) in c.method_details.splits.iter().zip(splits) {
        add(s.recipient, amount, &s.memo)?;
    }
    Ok(ix)
}
fn short(out: &mut Vec<u8>, mut n: usize) {
    loop {
        let b = (n & 127) as u8;
        n >>= 7;
        out.push(b | if n > 0 { 128 } else { 0 });
        if n == 0 {
            break;
        }
    }
}
// Official MPP client uses v0 without ALT and a zero provider fee-payer
// signature plus the merchant transfer-authority signature. Account order is
// deterministic; only exact local instructions participate in signer roles.
pub fn build_charge(c: &Charge, merchant: &dyn Signer) -> Result<String> {
    let payer = c.method_details.fee_payer_key;
    let signer = Key(merchant.public_key());
    if payer == signer {
        return Err(denied());
    }
    let ix = instructions(c, signer)?;
    let mut roles = BTreeMap::from([(payer, (true, true))]);
    for i in &ix {
        roles.entry(i.program).or_insert((false, false));
        for a in &i.accounts {
            let v = roles.entry(a.key).or_default();
            v.0 |= a.signer;
            v.1 |= a.writable;
        }
    }
    let mut keys: Vec<_> = roles.iter().map(|(k, (s, w))| (*k, *s, *w)).collect();
    keys.sort_by_key(|(k, s, w)| (*k != payer, !*s, !*w, *k));
    if keys.len() > 32
        || keys.iter().filter(|k| k.1).count() != 2
        || keys[1].0 != signer
        || keys[1].2
    {
        return Err(denied());
    }
    let readonly = keys.iter().filter(|k| !k.1 && !k.2).count() as u8;
    let mut message = vec![128, 2, 1, readonly];
    short(&mut message, keys.len());
    for (k, _, _) in &keys {
        message.extend(k.0);
    }
    message.extend(c.method_details.recent_blockhash.0);
    short(&mut message, ix.len());
    let index = |k: Key| keys.iter().position(|x| x.0 == k).unwrap() as u8;
    for i in &ix {
        message.push(index(i.program));
        short(&mut message, i.accounts.len());
        message.extend(i.accounts.iter().map(|a| index(a.key)));
        short(&mut message, i.data.len());
        message.extend(&i.data);
    }
    message.push(0); // no address lookup tables
    let mut raw = vec![2];
    raw.extend([0u8; 64]);
    raw.extend(merchant.sign(&message));
    raw.extend(message);
    if raw.len() > 1232 {
        return Err(denied());
    }
    Ok(STANDARD.encode(raw))
}
pub fn credential(selected: &Selected, transaction: &str) -> Result<String> {
    let value =
        json!({"challenge":selected,"payload":{"type":"transaction","transaction":transaction}});
    Ok(format!(
        "Payment {}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).map_err(|_| denied())?)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use allowit_native::crypto::{LocalSigner, verify};
    const DEVNET_MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    impl Signer for LocalSigner {
        fn public_key(&self) -> [u8; 32] {
            LocalSigner::public_key(self).0
        }
        fn sign(&self, message: &[u8]) -> [u8; 64] {
            LocalSigner::sign(self, message)
        }
    }
    fn signer() -> LocalSigner {
        // Fixed disposable fixture signing material, never a funded merchant.
        LocalSigner::from_secret(
            &[
                vec![7u8; 32],
                vec![
                    234, 74, 108, 99, 226, 156, 82, 10, 190, 245, 80, 123, 19, 46, 197, 249, 149,
                    71, 118, 174, 190, 190, 123, 146, 66, 30, 234, 105, 20, 70, 210, 44,
                ],
            ]
            .concat(),
        )
        .unwrap()
    }
    const PAYEE: &str = "Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP";
    const PAYER: &str = "BcdwLA62UPEAvRn7AWauMUXKtYMXxdLzTPaSQg5tNaFc";
    fn config() -> MerchantConfig {
        MerchantConfig {
            approved_recipients: vec![key(PAYEE).unwrap().0],
            approved_fee_payers: vec![key(PAYER).unwrap().0],
        }
    }
    fn charge_value() -> Value {
        json!({"amount":"1000","currency":MAINNET_MINT,"recipient":PAYEE,"description":"Air quality","methodDetails":{"decimals":6,"feePayer":true,"feePayerKey":PAYER,"network":"mainnet","recentBlockhash":"BCu9mmpTfK93NUW73saEcH9LwbvX4Bc7SkV9ErnBsDVv","tokenProgram":TOKEN_PROGRAM,"transactionVersions":[0,1],"splits":[{"amount":"250","recipient":PAYEE,"memo":"Operator fee","label":"Operator"},{"amount":"1","recipient":PAYEE,"memo":"Platform fee","label":"Platform"}]}})
    }
    fn selected(value: &Value) -> Selected {
        Selected {
            id: "golden-public-challenge".into(),
            realm: "AirQuality".into(),
            method: "solana".into(),
            intent: "charge".into(),
            request: URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap()),
            expires: (chrono::Utc::now() + chrono::Duration::seconds(300)).to_rfc3339(),
            description: None,
            digest: None,
            opaque: None,
        }
    }
    fn header(selected: &Selected) -> String {
        format!(
            "Payment id=\"{}\", realm=\"{}\", method=\"solana\", intent=\"charge\", request=\"{}\", expires=\"{}\"",
            selected.id, selected.realm, selected.request, selected.expires
        )
    }
    fn valid_charge() -> Charge {
        validate_charge(
            &selected(&charge_value()),
            &config(),
            1000,
            chrono::Utc::now().timestamp(),
        )
        .unwrap()
    }
    // Decode the constructed wire independently of its encoder, including global
    // roles and every local instruction. This rejects substitution without a RPC.
    fn decode(raw: &[u8]) -> (Vec<u8>, Vec<Meta>, Vec<Instruction>) {
        fn compact(raw: &[u8], offset: &mut usize) -> usize {
            let mut n = 0;
            let mut shift = 0;
            loop {
                let b = raw[*offset];
                *offset += 1;
                n |= ((b & 127) as usize) << shift;
                if b < 128 {
                    return n;
                }
                shift += 7;
                assert!(shift <= 14);
            }
        }
        assert_eq!(raw[0], 2);
        assert_eq!(&raw[1..65], &[0; 64]);
        let message = raw[129..].to_vec();
        assert_eq!(&message[..3], &[128, 2, 1]);
        let readonly = message[3] as usize;
        let mut pos = 4;
        let count = compact(&message, &mut pos);
        let mut keys = vec![];
        for i in 0..count {
            keys.push(Meta {
                key: Key(message[pos..pos + 32].try_into().unwrap()),
                signer: i < 2,
                writable: if i < 2 { i == 0 } else { i < count - readonly },
            });
            pos += 32;
        }
        pos += 32;
        let count = compact(&message, &mut pos);
        let mut ix = vec![];
        for _ in 0..count {
            let program = keys[message[pos] as usize].key;
            pos += 1;
            let n = compact(&message, &mut pos);
            let accounts = message[pos..pos + n]
                .iter()
                .map(|i| keys[*i as usize].clone())
                .collect();
            pos += n;
            let n = compact(&message, &mut pos);
            let data = message[pos..pos + n].to_vec();
            pos += n;
            ix.push(Instruction {
                program,
                accounts,
                data,
            });
        }
        assert_eq!(message[pos..], [0]);
        (message, keys, ix)
    }
    #[test]
    fn v0_pull_transaction_has_exact_roles_split_amounts_memos_and_envelope() {
        let c = valid_charge();
        let signer = signer();
        let tx = build_charge(&c, &signer).unwrap();
        let raw = STANDARD.decode(&tx).unwrap();
        let (message, keys, ix) = decode(&raw);
        verify(signer.public_key(), &message, &raw[65..129]).unwrap();
        assert_eq!(keys[0].key, key(PAYER).unwrap());
        assert_eq!(
            keys[1],
            Meta {
                key: signer.public_key(),
                signer: true,
                writable: false
            }
        );
        let expected = instructions(&c, signer.public_key()).unwrap();
        assert_eq!(
            ix.iter()
                .map(|i| (
                    &i.program,
                    &i.data,
                    i.accounts.iter().map(|a| a.key).collect::<Vec<_>>()
                ))
                .collect::<Vec<_>>(),
            expected
                .iter()
                .map(|i| (
                    &i.program,
                    &i.data,
                    i.accounts.iter().map(|a| a.key).collect::<Vec<_>>()
                ))
                .collect::<Vec<_>>()
        );
        assert_eq!(ix.len(), 7);
        assert_eq!(
            u64::from_le_bytes(ix[2].data[1..9].try_into().unwrap()),
            749
        );
        assert_eq!(
            u64::from_le_bytes(ix[3].data[1..9].try_into().unwrap()),
            250
        );
        assert_eq!(ix[4].data, b"Operator fee");
        assert_eq!(u64::from_le_bytes(ix[5].data[1..9].try_into().unwrap()), 1);
        assert_eq!(ix[6].data, b"Platform fee");
        let s = selected(&charge_value());
        let encoded = credential(&s, &tx).unwrap();
        let envelope: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(encoded.strip_prefix("Payment ").unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(envelope["challenge"]["request"], s.request);
        assert_eq!(
            envelope["payload"],
            json!({"type":"transaction","transaction":tx})
        );
        let mut tampered = raw;
        tampered[140] ^= 1;
        assert!(verify(signer.public_key(), &tampered[129..], &tampered[65..129]).is_err());
    }
    #[test]
    fn official_sdk_golden_v0_transaction_and_credential_match_exact_semantics() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/official-mpp-google-v0.json"
        ))
        .unwrap();
        let captured_time = chrono::DateTime::parse_from_rfc3339("2026-10-07T23:34:00Z")
            .unwrap()
            .timestamp();
        let selected =
            parse_challenge(fixture["challengeHeader"].as_str().unwrap(), captured_time).unwrap();
        assert_eq!(
            serde_json::to_value(&selected).unwrap(),
            fixture["challenge"]
        );
        let charge = validate_charge(&selected, &config(), 1000, captured_time).unwrap();
        let merchant = key(fixture["merchant"].as_str().unwrap()).unwrap();
        let transaction = fixture["transactionBase64"].as_str().unwrap();
        let raw = STANDARD.decode(transaction).unwrap();
        let (message, keys, decoded) = decode(&raw);
        verify(merchant, &message, &raw[65..129]).unwrap();
        assert_eq!(keys[0].key, charge.method_details.fee_payer_key);
        assert_eq!(
            keys[1],
            Meta {
                key: merchant,
                signer: true,
                writable: false
            }
        );
        let expected = instructions(&charge, merchant).unwrap();
        for (actual, expected) in decoded.iter().zip(&expected) {
            assert_eq!(actual.program, expected.program);
            assert_eq!(actual.data, expected.data);
            assert_eq!(
                actual.accounts.iter().map(|a| a.key).collect::<Vec<_>>(),
                expected.accounts.iter().map(|a| a.key).collect::<Vec<_>>()
            );
        }
        assert_eq!(decoded.len(), expected.len());
        let rebuilt = credential(&selected, transaction).unwrap();
        let parse = |s: &str| -> Value {
            serde_json::from_slice(
                &URL_SAFE_NO_PAD
                    .decode(s.strip_prefix("Payment ").unwrap())
                    .unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            parse(&rebuilt),
            parse(fixture["authorization"].as_str().unwrap())
        );
        // Optional offline interoperability artifact; this historical expired
        // challenge and disposable test signer never reach a network transport.
        if let Ok(path) = std::env::var("ALLOWIT_STOCK_TEST_VECTOR_PATH") {
            let generated = build_charge(&charge, &signer()).unwrap();
            let vector = json!({"scope":"offline expired challenge, fixed disposable signer, no broadcast", "authorization":credential(&selected, &generated).unwrap(), "transactionBase64":generated,"merchant":signer().public_key(),"challenge":selected});
            std::fs::write(path, serde_json::to_vec_pretty(&vector).unwrap()).unwrap();
        }
        assert_eq!(fixture["rpcCalls"], json!([]));
    }
    #[test]
    fn malicious_charge_asset_recipient_price_program_and_memo_are_rejected() {
        for (path, value) in [
            ("/currency", json!("SOL")),
            ("/currency", json!(DEVNET_MINT)),
            ("/recipient", json!(Key([4; 32]).to_string())),
            ("/amount", json!("1001")),
            ("/amount", json!("01000")),
            ("/methodDetails/decimals", json!(9)),
            ("/methodDetails/network", json!("testnet")),
            ("/methodDetails/feePayer", json!(false)),
            (
                "/methodDetails/feePayerKey",
                json!(Key([4; 32]).to_string()),
            ),
            ("/methodDetails/tokenProgram", json!(MEMO)),
            ("/methodDetails/transactionVersions", json!([1])),
            (
                "/methodDetails/splits/0/recipient",
                json!(Key([4; 32]).to_string()),
            ),
            ("/methodDetails/splits/0/amount", json!("1000")),
            ("/methodDetails/splits/0/memo", json!("\nprivate injection")),
        ] {
            let mut value0 = charge_value();
            *value0.pointer_mut(path).unwrap() = value;
            assert!(
                validate_charge(
                    &selected(&value0),
                    &config(),
                    1000,
                    chrono::Utc::now().timestamp()
                )
                .is_err(),
                "{path}"
            );
        }
        let mut v = charge_value();
        v["methodDetails"]["splits"][0]["ataCreationRequired"] = json!(true);
        assert!(
            validate_charge(
                &selected(&v),
                &config(),
                1000,
                chrono::Utc::now().timestamp()
            )
            .is_err()
        );
        v = charge_value();
        v["methodDetails"]["programInstructions"] = json!([]);
        assert!(
            validate_charge(
                &selected(&v),
                &config(),
                1000,
                chrono::Utc::now().timestamp()
            )
            .is_err()
        );
        assert!(
            validate_charge(
                &selected(&charge_value()),
                &config(),
                999,
                chrono::Utc::now().timestamp()
            )
            .is_err()
        );
    }
    #[test]
    fn challenge_parser_rejects_expiry_duplicates_extra_schemes_and_encoded_substitution() {
        let now = chrono::Utc::now().timestamp();
        let s = selected(&charge_value());
        assert_eq!(
            parse_challenge(&header(&s), now).unwrap().request,
            s.request
        );
        for text in [
            format!("{}, id=\"replacement\"", header(&s)),
            format!("{}, Bearer token=\"value\"", header(&s)),
            header(&s).replace("intent=\"charge\"", "intent=\"arbitrary\""),
            header(&s).replace("method=\"solana\"", "method=\"evm\""),
            header(&s).replace(&s.expires, "2020-01-01T00:00:00Z"),
        ] {
            assert!(parse_challenge(&text, now).is_err());
        }
        let mut s = selected(&charge_value());
        s.request.push('=');
        assert!(validate_charge(&s, &config(), 1000, now).is_err());
    }
    #[test]
    fn temporary_challenge_statuses_are_recoverable_but_invalid_offers_are_not() {
        for status in [200, 408, 429, 500, 503] {
            assert_eq!(challenge_status(status, 0).unwrap_err().status, 503);
        }
        for (status, count) in [(401, 0), (402, 0), (402, 2)] {
            assert_eq!(challenge_status(status, count).unwrap_err().status, 502);
        }
        challenge_status(402, 1).unwrap();
    }
    #[test]
    fn stock_http_preserves_challenge_and_one_authorization_submission() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for reply in [
                "HTTP/1.1 402 Payment Required\r\nWWW-Authenticate: Payment fixture\r\nContent-Length: 900000\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nPayment-Receipt: receipt-fixture\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 2048];
                loop {
                    let n = socket.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(at) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..at]).to_lowercase();
                        let size = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .unwrap()
                            .parse::<usize>()
                            .unwrap();
                        if bytes.len() >= at + 4 + size {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                socket.write_all(reply.as_bytes()).unwrap();
            }
            requests
        });
        let transport = HttpStock {
            endpoint,
            client: HttpClient::without_connection_reuse(Options {
                timeout: Duration::from_secs(3),
                no_proxy: true,
                max_response_bytes: 65536,
                connect_timeout: None,
            })
            .unwrap(),
        };
        assert_eq!(
            transport.challenge("{\"input\":1}").unwrap(),
            "Payment fixture"
        );
        assert_eq!(
            transport
                .submit("{\"input\":1}", "Payment signed-fixture")
                .unwrap(),
            (json!({"ok":true}), Some("receipt-fixture".into()))
        );
        let requests = worker.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(!requests[0].to_lowercase().contains("authorization:"));
        assert!(
            requests[1]
                .to_lowercase()
                .contains("authorization: payment signed-fixture\r\n")
        );
        assert!(
            requests
                .iter()
                .all(|value| value.ends_with("{\"input\":1}"))
        );
    }
}
