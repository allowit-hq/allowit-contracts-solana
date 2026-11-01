use crate::{
    crypto::Key,
    error::{Error, Result},
};
use base64::Engine;
use serde_json::{Value, json};
use std::{
    io::Read,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
/// Host-injected transport; tests can model missing responses without any keys.
pub trait Rpc: Send + Sync {
    fn call(&self, method: &str, params: Value) -> Result<Value>;
}
pub struct HttpRpc {
    url: String,
    client: reqwest::blocking::Client,
    next: AtomicU64,
    backoff: Duration,
}
impl HttpRpc {
    pub fn new(url: impl Into<String>) -> Result<Self> {
        let url = url.into();
        let parsed = reqwest::Url::parse(&url).map_err(|_| Error::config("Invalid RPC URL"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(Error::config("Invalid RPC URL"));
        }
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(60))
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .build()
            .map_err(|_| Error::config("Cannot configure RPC connection"))?;
        Ok(Self {
            url,
            client,
            next: AtomicU64::new(1),
            backoff: Duration::from_millis(500),
        })
    }
}
impl Rpc for HttpRpc {
    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let block_time_read = method == "getBlockTime"
            && params
                .as_array()
                .is_some_and(|p| p.len() == 1 && p[0].as_u64().is_some());
        let body =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
                .map_err(|_| Error::config("Invalid RPC request"))?;
        let mut attempt = 0;
        loop {
            let mut response = self
                .client
                .post(&self.url)
                .header("Content-Type", "application/json")
                .body(body.clone())
                .send()
                .map_err(|_| {
                    Error::uncertain(
                        "RPC request failed; retain the original journal and request ID",
                    )
                })?;
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < 4 {
                drop(response);
                std::thread::sleep(self.backoff.saturating_mul(1 << attempt));
                attempt += 1;
                continue;
            }
            if response.status() != reqwest::StatusCode::OK {
                return Err(Error::uncertain(
                    "RPC request failed; retain the original journal and request ID",
                ));
            }
            let mut raw = Vec::new();
            Read::by_ref(&mut response)
            .take(4_194_305)
            .read_to_end(&mut raw)
            .map_err(|_| {
                Error::uncertain(
                    "RPC response could not be read; retain the original journal and request ID",
                )
            })?;
            if raw.len() > 4_194_304 {
                return Err(Error::config("RPC response exceeded its size limit"));
            }
            let envelope: Value =
                serde_json::from_slice(&raw).map_err(|_| Error::config("Invalid RPC response"))?;
            if envelope["jsonrpc"] != "2.0" || envelope["id"] != id {
                return Err(Error::config("RPC response does not match the request"));
            }
            // A live processed slot may not yet have an indexed block time. Retry
            // only this exact read, never another slot or a transaction submission.
            let block_time_pending = block_time_read
                && (envelope["error"]["code"].as_i64() == Some(-32004)
                    || (envelope["error"].is_null()
                        && envelope.get("result").is_some_and(Value::is_null)));
            if block_time_pending {
                if attempt == 4 {
                    return Err(Error::uncertain(
                        "Block time is unavailable; retain the original journal and request ID",
                    ));
                }
                std::thread::sleep(self.backoff.saturating_mul(1 << attempt));
                attempt += 1;
                continue;
            }
            if !envelope["error"].is_null() {
                return Err(Error::config("RPC refused the request"));
            }
            return envelope
                .get("result")
                .cloned()
                .ok_or_else(|| Error::config("Invalid RPC response"));
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener};
    fn rate_limit(replies: &[u16]) -> (Result<Value>, Vec<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let replies = replies.to_vec();
        let server = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for status in replies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut header = Vec::new();
                let mut byte = [0];
                while !header.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap();
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|n| n.parse::<usize>().ok())
                    })
                    .unwrap();
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                let value: Value = serde_json::from_slice(&body).unwrap();
                let result = json!({"jsonrpc":"2.0","id":value["id"],"result":"ok"}).to_string();
                bodies.push(body);
                write!(stream,"HTTP/1.1 {status} Result\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{result}",result.len()).unwrap();
            }
            bodies
        });
        let mut rpc = HttpRpc::new(url).unwrap();
        rpc.backoff = Duration::from_millis(1);
        let response = rpc.call("getGenesisHash", json!([]));
        (response, server.join().unwrap())
    }
    #[test]
    fn rate_limit_retries_identical_request_and_stops_at_five_attempts() {
        let (result, requests) = rate_limit(&[429, 429, 200]);
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(requests.len(), 3);
        assert!(requests.windows(2).all(|p| p[0] == p[1]));
        let (result, requests) = rate_limit(&[429; 5]);
        assert_eq!(result.unwrap_err().code, 5);
        assert_eq!(requests.len(), 5);
        assert!(requests.windows(2).all(|p| p[0] == p[1]));
    }

    fn scripted_rpc(
        method: &str,
        params: Value,
        replies: Vec<Value>,
    ) -> (Result<Value>, Vec<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for mut reply in replies {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(std::time::Instant::now() < deadline, "expected RPC request");
                            std::thread::sleep(Duration::from_millis(1));
                        }
                        Err(e) => panic!("RPC fixture failed: {e}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut header = Vec::new();
                let mut byte = [0];
                while !header.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                let header = String::from_utf8(header).unwrap();
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|n| n.parse::<usize>().ok())
                    })
                    .unwrap();
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                let request: Value = serde_json::from_slice(&body).unwrap();
                if reply.get("id").is_none() {
                    reply["id"] = request["id"].clone();
                }
                let raw = reply.to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{raw}",
                    raw.len()
                )
                .unwrap();
                bodies.push(body);
            }
            bodies
        });
        let mut rpc = HttpRpc::new(url).unwrap();
        rpc.backoff = Duration::from_millis(1);
        let result = rpc.call(method, params);
        (result, server.join().unwrap())
    }

    fn pending_time() -> Value {
        json!({"jsonrpc":"2.0", "error":{"code":-32004, "message":"Block not available"}})
    }

    #[test]
    fn fresh_block_time_retries_identical_slot_and_request_until_available() {
        let (result, requests) = scripted_rpc(
            "getBlockTime",
            json!([509902168]),
            vec![
                pending_time(),
                json!({"jsonrpc":"2.0", "result":null}),
                json!({"jsonrpc":"2.0", "result":1791721873}),
            ],
        );
        assert_eq!(result.unwrap(), 1791721873);
        assert_eq!(requests.len(), 3);
        assert!(requests.windows(2).all(|p| p[0] == p[1]));
        let request: Value = serde_json::from_slice(&requests[0]).unwrap();
        assert_eq!(request["method"], "getBlockTime");
        assert_eq!(request["params"], json!([509902168]));
    }

    #[test]
    fn unavailable_block_time_stops_without_fabricating_time() {
        for pending in [pending_time(), json!({"jsonrpc":"2.0", "result":null})] {
            let (result, requests) =
                scripted_rpc("getBlockTime", json!([509902168]), vec![pending; 5]);
            assert_eq!(result.unwrap_err().code, 5);
            assert_eq!(requests.len(), 5);
            assert!(requests.windows(2).all(|p| p[0] == p[1]));
        }
    }

    #[test]
    fn only_a_pending_block_time_is_retried() {
        let block_time = ("getBlockTime", json!([509902168]));
        let pending = pending_time();
        for (method, params, reply) in [
            (
                block_time.0,
                block_time.1.clone(),
                json!({"jsonrpc":"2.0", "id":99, "error":{"code":-32004}}),
            ),
            (
                block_time.0,
                block_time.1.clone(),
                json!({"jsonrpc":"1.0", "error":{"code":-32004}}),
            ),
            (
                block_time.0,
                block_time.1.clone(),
                json!({"jsonrpc":"2.0", "error":{"code":-32602}}),
            ),
            (block_time.0, block_time.1.clone(), json!({"jsonrpc":"2.0"})),
            (
                "sendTransaction",
                json!(["signed-proof", {"encoding":"base64"}]),
                pending.clone(),
            ),
            (
                "getBlockHeight",
                json!([{"commitment":"processed"}]),
                pending.clone(),
            ),
        ] {
            let (result, requests) = scripted_rpc(method, params, vec![reply]);
            assert_eq!(result.unwrap_err().code, 3, "{method}");
            assert_eq!(requests.len(), 1, "{method}");
        }
    }
}
#[derive(Debug, Clone)]
pub struct Account {
    pub owner: Key,
    pub executable: bool,
    pub data: Vec<u8>,
}
pub fn account(
    rpc: &dyn Rpc,
    address: Key,
    min_context_slot: Option<u64>,
) -> Result<Option<Account>> {
    let mut config = json!({"commitment":"finalized","encoding":"base64"});
    if let Some(slot) = min_context_slot {
        config["minContextSlot"] = json!(slot);
    }
    let response = rpc.call("getAccountInfo", json!([address.to_string(), config]))?;
    let observed = response["context"]["slot"]
        .as_u64()
        .ok_or_else(|| Error::config("Invalid account context"))?;
    if min_context_slot.is_some_and(|s| observed < s) {
        return Err(Error::config("Incoherent finalized vault observation"));
    }
    let value = &response["value"];
    if value.is_null() {
        return Ok(None);
    }
    let owner = Key::parse(
        value["owner"]
            .as_str()
            .ok_or_else(|| Error::config("Invalid account owner"))?,
    )?;
    let executable = value["executable"]
        .as_bool()
        .ok_or_else(|| Error::config("Invalid account executable flag"))?;
    if value["data"][1] != "base64" {
        return Err(Error::config("Invalid account encoding"));
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(
            value["data"][0]
                .as_str()
                .ok_or_else(|| Error::config("Invalid account data"))?,
        )
        .map_err(|_| Error::config("Invalid account data"))?;
    Ok(Some(Account {
        owner,
        executable,
        data,
    }))
}
