//! Fixed-origin transport for the cooperating PaySH gateway protocol.
use allowit_sdk::service::{Result, bad, fault};
use reqwest::{blocking::Client, redirect::Policy as RedirectPolicy};
use serde_json::{Value, json};
use std::{io::Read, time::Duration};

pub struct CooperatingClient {
    origin: String,
    token: String,
    client: Client,
}

#[derive(Debug, PartialEq)]
pub enum Recovery {
    Pending,
    NotClaimed,
    Delivered(Value),
}

impl CooperatingClient {
    pub fn new(origin: &str, token: String, allow_loopback: bool) -> Result<Self> {
        let url = reqwest::Url::parse(origin).map_err(|_| bad("Invalid PaySH gateway origin."))?;
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if (url.scheme() != "https" && !(allow_loopback && loopback && url.scheme() == "http"))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || token.len() < 32
        {
            return Err(bad(
                "PaySH gateway requires a fixed HTTPS origin and scoped server credential.",
            ));
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(RedirectPolicy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| fault(503, "PaySH gateway transport unavailable."))?;
        Ok(Self {
            origin: origin.into(),
            token,
            client,
        })
    }

    fn request(&self, path: &str, body: Value) -> Result<Value> {
        let response = self
            .client
            .post(format!("{}{path}", self.origin.trim_end_matches('/')))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .map_err(|_| {
                fault(
                    503,
                    "PaySH gateway result is unknown. Recover the original operation.",
                )
            })?;
        if !response.status().is_success() {
            return Err(fault(
                503,
                "PaySH gateway could not complete the original operation.",
            ));
        }
        let mut bytes = vec![];
        response
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|_| fault(503, "PaySH gateway response is unknown."))?;
        if bytes.len() > 65536 {
            return Err(fault(
                503,
                "PaySH gateway response exceeds the supported size.",
            ));
        }
        serde_json::from_slice(&bytes).map_err(|_| fault(503, "PaySH gateway response is invalid."))
    }

    pub fn challenge(&self, service_id: &str, input: &Value) -> Result<Value> {
        self.request("/challenge", json!({"serviceId":service_id,"input":input}))
    }

    pub fn deliver(
        &self,
        challenge: &Value,
        input: &Value,
        receipt: &Value,
        request_hash: &str,
        challenge_hash: &str,
    ) -> Result<Value> {
        let response = self.request(
            "/deliver",
            json!({"challenge":challenge,"input":input,"receipt":receipt}),
        )?;
        if response["status"] != "delivered"
            || response["requestHash"] != request_hash
            || response["challengeHash"] != challenge_hash
            || !response
                .as_object()
                .is_some_and(|m| m.contains_key("response"))
        {
            return Err(fault(503, "Paid API delivery is not yet confirmed."));
        }
        Ok(response["response"].clone())
    }

    pub fn recover(
        &self,
        challenge_id: &str,
        request_hash: &str,
        challenge_hash: &str,
    ) -> Result<Recovery> {
        let response = self.request(
            "/status",
            json!({"challengeId":challenge_id,"requestHash":request_hash}),
        )?;
        if response["status"] == "pending" {
            return Ok(Recovery::Pending);
        }
        if response["status"] == "unpaid" && response["challengeHash"] == challenge_hash {
            return Ok(Recovery::NotClaimed);
        }
        if response["status"] != "delivered"
            || response["requestHash"] != request_hash
            || response["challengeHash"] != challenge_hash
            || !response
                .as_object()
                .is_some_and(|m| m.contains_key("response"))
        {
            return Err(fault(
                503,
                "Gateway recovery proof does not match this purchase.",
            ));
        }
        Ok(Recovery::Delivered(response["response"].clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    fn server(
        status: u16,
        body: String,
    ) -> (
        CooperatingClient,
        mpsc::Receiver<String>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = vec![];
            let mut buffer = [0; 2048];
            loop {
                let n = stream.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(offset) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..offset]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= offset + 4 + length {
                        break;
                    }
                }
            }
            tx.send(String::from_utf8(bytes).unwrap()).unwrap();
            write!(
                stream,
                "HTTP/1.1 {status} Result\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        (
            CooperatingClient::new(
                &format!("http://{address}"),
                "fixture-token-which-is-long-enough".into(),
                true,
            )
            .unwrap(),
            rx,
            handle,
        )
    }
    fn run(
        status: u16,
        response: Value,
        f: impl FnOnce(&CooperatingClient) -> Result<Value>,
    ) -> (Result<Value>, String) {
        let (client, rx, handle) = server(status, response.to_string());
        let result = f(&client);
        let request = rx.recv().unwrap();
        handle.join().unwrap();
        (result, request)
    }
    #[test]
    fn challenge_uses_fixed_path_and_exact_request() {
        let (value, request) = run(200, json!({"id":"bound"}), |client| {
            client.challenge("service", &json!({"latitude":1}))
        });
        assert_eq!(value.unwrap(), json!({"id":"bound"}));
        assert!(request.starts_with("POST /challenge HTTP/1.1\r\n"));
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer fixture-token-which-is-long-enough\r\n")
        );
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body, json!({"serviceId":"service","input":{"latitude":1}}));
    }
    #[test]
    fn delivery_requires_both_bound_hashes_and_response() {
        for response in [
            json!({"status":"delivered","requestHash":"wrong","challengeHash":"challenge","response":1}),
            json!({"status":"delivered","requestHash":"request","challengeHash":"wrong","response":1}),
            json!({"status":"delivered","requestHash":"request","challengeHash":"challenge"}),
        ] {
            let (result, _) = run(200, response, |client| {
                client.deliver(&json!({}), &json!({}), &json!({}), "request", "challenge")
            });
            assert_eq!(result.unwrap_err().status, 503);
        }
        let (value, request) = run(
            200,
            json!({"status":"delivered","requestHash":"request","challengeHash":"challenge","response":null}),
            |client| {
                client.deliver(
                    &json!({"id":1}),
                    &json!({"x":2}),
                    &json!({"signature":3}),
                    "request",
                    "challenge",
                )
            },
        );
        assert_eq!(value.unwrap(), Value::Null);
        assert!(request.starts_with("POST /deliver "));
    }
    #[test]
    fn recovery_preserves_pending_unpaid_and_exact_delivered_states() {
        for (response, expected) in [
            (json!({"status":"pending"}), Recovery::Pending),
            (
                json!({"status":"unpaid","challengeHash":"challenge"}),
                Recovery::NotClaimed,
            ),
            (
                json!({"status":"delivered","requestHash":"request","challengeHash":"challenge","response":{"ok":true}}),
                Recovery::Delivered(json!({"ok":true})),
            ),
            (
                json!({"status":"delivered","requestHash":"request","challengeHash":"challenge","response":null}),
                Recovery::Delivered(Value::Null),
            ),
        ] {
            let (client, rx, handle) = server(200, response.to_string());
            assert_eq!(
                client.recover("id", "request", "challenge").unwrap(),
                expected
            );
            assert!(rx.recv().unwrap().starts_with("POST /status "));
            handle.join().unwrap();
        }
        let (client, rx, handle) = server(
            200,
            json!({"status":"unpaid","challengeHash":"other"}).to_string(),
        );
        assert_eq!(
            client
                .recover("id", "request", "challenge")
                .unwrap_err()
                .status,
            503
        );
        rx.recv().unwrap();
        handle.join().unwrap();
    }
    #[test]
    fn recovery_rejects_delivered_status_without_response() {
        let (client, rx, handle) = server(
            200,
            json!({"status":"delivered","requestHash":"request","challengeHash":"challenge"})
                .to_string(),
        );
        assert_eq!(
            client
                .recover("id", "request", "challenge")
                .unwrap_err()
                .status,
            503
        );
        assert!(rx.recv().unwrap().starts_with("POST /status "));
        handle.join().unwrap();
    }
    #[test]
    fn origin_and_credential_restrictions_apply_before_http() {
        for origin in [
            "http://vendor.example",
            "https://user:password@vendor.example",
            "https://vendor.example/path",
            "https://vendor.example/?key=secret",
            "https://vendor.example/#fragment",
            "http://127.0.0.1:9000",
        ] {
            assert!(CooperatingClient::new(origin, "x".repeat(32), false).is_err());
        }
        assert!(CooperatingClient::new("https://vendor.example", "short".into(), false).is_err());
    }
    #[test]
    fn failed_and_oversized_responses_do_not_expose_credentials_or_provider_body() {
        for (status, body) in [
            (302, "private-provider-response".into()),
            (503, "private-provider-response".into()),
            (200, "x".repeat(65537)),
            (200, "invalid json".into()),
        ] {
            let (client, rx, handle) = server(status, body);
            let error = client.challenge("service", &json!({})).unwrap_err();
            assert_eq!(error.status, 503);
            assert!(!error.message.contains("fixture-token"));
            assert!(!error.message.contains("private-provider"));
            rx.recv().unwrap();
            handle.join().unwrap();
        }
    }
}
