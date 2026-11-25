//! The agent's client: one payment from the agent's request to its outcome, through the
//! backend's execute and status routes.
//!
//! The backend is not trusted for what it answers. The client keeps its own request, checks the
//! prepared payment against it byte for byte before the agent's key signs
//! ([`crate::agent`]), and reads every later answer against what it retained: the prepared
//! payment cannot change after the signature, a signed payment must carry the agent's own
//! signature, and a receipt must be the receipt of those signed bytes and of the amount that
//! moved. With the agent's own RPC ([`Client::chain`]) the ledger decides, not the backend.
//!
//! The record of a request is written before each step that leaves the machine: the intent
//! before the prepare call, the agent's signature before the submit call. A repeat of a request
//! id continues that record and never signs a second payment. An unanswered call is unknown, not
//! failed: the same request id reads its status.
use crate::agent;
use crate::config::hex32;
use crate::networks;
use crate::packets::{self, PACKETS, PreparedDoc, ReceiptDoc, Request, SignedDoc};
use crate::runtime::{Bundle, Runtime};
use allowit_core::{
    client::store::Store,
    transport::{
        http::{HttpClient, Method, Request as HttpRequest},
        rpc::Options,
    },
    vendor::{
        RuntimeProvider as _,
        error::{Error, Result},
        execution::{EXPLORER_KEY, Outcome, Quantity, Settlement},
        input::asset::AssetDisplay,
        plugin::LinkKind,
        request_proof,
        runtime::{PacketProvider as _, Signer, Status},
        typed_request::operation_nonce,
    },
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use std::time::{Duration, Instant};

/// The backend route that prepares and submits an operation.
pub const EXECUTE_PATH: &str = "/api/native/execute";
/// The backend route that reads an operation.
pub const STATUS_PATH: &str = "/api/native/execute/status";
/// How long the client waits between two reads of a pending operation.
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// The longest wait that a caller may ask for.
pub const MAX_WAIT: Duration = Duration::from_secs(600);

/// What came back from one call to the backend.
pub enum Sent {
    /// An HTTP status and a body.
    Reply(u16, Vec<u8>),
    /// No whole answer: the request may or may not have arrived.
    Unanswered,
}

/// The backend, as the client reaches it: one authenticated POST of a JSON body to a path.
pub trait Backend {
    /// The origin that the calls go to. A retained request belongs to one origin.
    fn origin(&self) -> &str;
    fn post(&self, path: &str, body: &Value) -> Result<Sent>;
}

/// The caller's journal of requests, by record name.
pub trait Records {
    fn load(&self, name: &str) -> Result<Option<Value>>;
    /// Retain `record` durably before this returns.
    fn save(&self, name: &str, record: &Value) -> Result<()>;
}

impl Records for Store {
    fn load(&self, name: &str) -> Result<Option<Value>> {
        Store::load::<Value>(self, name)
    }
    fn save(&self, name: &str, record: &Value) -> Result<()> {
        Store::save(self, name, record)
    }
}

/// What the client retains of one request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub version: u8,
    pub origin: String,
    pub request_id: String,
    pub profile: Bundle,
    pub request: Request,
    /// The prepared payment that the agent signed, once it signed.
    pub prepared: Option<PreparedDoc>,
    /// The agent's signature of that payment's message, base58.
    pub agent_signature: Option<String>,
}

/// The backend's answer to an execute or status call. Fields that the client does not read are
/// ignored: nothing here is believed before it is checked.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reply {
    prepared: Box<RawValue>,
    operation: Operation,
    #[serde(default)]
    signed_operation: Option<SignedDoc>,
    #[serde(default)]
    receipt: Option<ReceiptDoc>,
}
#[derive(Deserialize)]
struct Operation {
    status: Status,
}

/// The agent's client for one wallet profile.
pub struct Client<'a> {
    pub backend: &'a dyn Backend,
    pub records: &'a dyn Records,
    pub profile: &'a Bundle,
    pub agent: &'a dyn Signer,
    pub clock: &'a dyn Fn() -> Result<u64>,
    /// The agent's own view of the ledger, when it has an RPC endpoint. With it the client reads
    /// receipts and lapses itself and does not take the backend's word for them.
    pub chain: Option<&'a Runtime>,
    pub sleep: &'a dyn Fn(Duration),
}

fn uncertain(what: &str) -> Error {
    Error::uncertain(format!(
        "{what} Read the original request ID with status; do not start a replacement payment."
    ))
}

/// A refusal of the backend: its status, its stable code and its text, where it gives them.
fn refusal(status: u16, body: &[u8]) -> Error {
    let reply: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let text = |key: &str| reply.get(key).and_then(Value::as_str).map(str::to_owned);
    let message = text("error")
        .or_else(|| text("message"))
        .unwrap_or_else(|| "the server gave no reason".to_owned());
    match text("code") {
        Some(code) => Error::refused(status, code, message),
        None => Error::api(status, message),
    }
}

fn record_name(request: &Request) -> String {
    hex32::encode(&request.nonce)
}

/// The longest wait for one answer of the backend: an evaluation can take minutes.
const BACKEND_TIMEOUT: Duration = Duration::from_secs(180);

/// The backend over HTTPS. Each call carries the agent's request proof of exactly its path and
/// the canonical form of its body.
pub struct HttpBackend<'a> {
    http: HttpClient,
    origin: String,
    agent: &'a dyn Signer,
    clock: &'a dyn Fn() -> Result<u64>,
}

impl<'a> HttpBackend<'a> {
    pub fn new(
        origin: &str,
        agent: &'a dyn Signer,
        clock: &'a dyn Fn() -> Result<u64>,
    ) -> Result<Self> {
        Ok(Self {
            http: HttpClient::new(Options {
                timeout: BACKEND_TIMEOUT,
                max_response_bytes: 1_048_576,
                no_proxy: false,
                connect_timeout: None,
            })
            .map_err(|_| Error::config("Cannot initialize the transport to the Allowit server"))?,
            origin: allowit_core::vendor::config::parse_origin(origin)?,
            agent,
            clock,
        })
    }
}

impl Backend for HttpBackend<'_> {
    fn origin(&self) -> &str {
        &self.origin
    }
    fn post(&self, path: &str, body: &Value) -> Result<Sent> {
        let encode = || Error::config("Cannot encode the request to the Allowit server");
        let canonical = serde_json_canonicalizer::to_vec(body).map_err(|_| encode())?;
        let proof = request_proof::authorize(
            crate::proof::request_proof_protocol(),
            self.agent.identity(),
            (self.clock)()?,
            path,
            &canonical,
            |digest| self.agent.sign_hash(digest),
        )?;
        let bytes = serde_json::to_vec(body).map_err(|_| encode())?;
        let headers = [
            ("Authorization".to_owned(), proof),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ];
        let answer = self.http.send(
            HttpRequest {
                method: Method::Post,
                url: &format!("{}{path}", self.origin),
                headers: &headers,
                body: Some(&bytes),
            },
            None,
        );
        Ok(match answer {
            Ok(response) => Sent::Reply(response.status, response.body),
            Err(_) => Sent::Unanswered,
        })
    }
}

impl Client<'_> {
    fn check(&self) -> Result<()> {
        self.profile.validate()?;
        if self.agent.identity() != self.profile.config.agent {
            return Err(Error::config(
                "The agent key differs from the wallet profile's agent",
            ));
        }
        Ok(())
    }

    fn call(&self, path: &str, body: Value) -> Result<Reply> {
        let (status, bytes) = match self.backend.post(path, &body)? {
            Sent::Reply(status, bytes) => (status, bytes),
            Sent::Unanswered => {
                return Err(uncertain("The Allowit server did not answer."));
            }
        };
        if !(200..300).contains(&status) {
            return Err(refusal(status, &bytes));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| uncertain("The Allowit server's answer is not an operation."))
    }

    fn load(&self, name: &str) -> Result<Option<Record>> {
        self.records
            .load(name)?
            .map(|value| {
                serde_json::from_value::<Record>(value).map_err(|_| {
                    Error::config("The request journal holds a record that this rail did not write")
                })
            })
            .transpose()
    }

    fn save(&self, record: &Record) -> Result<()> {
        self.records.save(
            &record_name(&record.request),
            &serde_json::to_value(record)
                .map_err(|_| Error::config("Cannot encode the request record"))?,
        )
    }

    /// The record of `request_id`, checked against this client: the same backend and profile,
    /// and the same request when the caller states one, or a refusal.
    fn retained(&self, request: Option<&Request>, request_id: &str) -> Result<Option<Record>> {
        let name = hex32::encode(&operation_nonce(&self.profile.policy_id, request_id));
        let Some(record) = self.load(&name)? else {
            return Ok(None);
        };
        if record.version != 1
            || record.origin != self.backend.origin()
            || record.request_id != request_id
            || record.profile != *self.profile
            || record_name(&record.request) != name
            || request.is_some_and(|request| record.request != *request)
        {
            return Err(Error::config(
                "The original request ID already binds different input",
            ));
        }
        Ok(Some(record))
    }

    /// Read the backend's `reply` against `record` and say where the payment stands.
    fn outcome(&self, record: &Record, reply: &Reply) -> Result<Outcome> {
        // The prepared payment is the agent's request, whatever the backend says about it.
        let (prepared, _) = agent::check_prepared(
            self.profile,
            &record.request,
            reply.prepared.get().as_bytes(),
            0,
        )?;
        if record
            .prepared
            .as_ref()
            .is_some_and(|kept| *kept != prepared)
        {
            return Err(uncertain(
                "The Allowit server returned another prepared payment than the agent signed.",
            ));
        }
        let network = prepared.config.network.clone();
        let mut signature = None;
        let mut receipt = None;
        let mut lapsed = false;
        if let Some(signed) = &reply.signed_operation {
            let transaction = signed.validate()?;
            let wire = STANDARD
                .decode(&signed.wire)
                .map_err(|_| uncertain("The signed payment is not readable."))?;
            let ours = record
                .agent_signature
                .as_deref()
                .and_then(|text| bs58::decode(text).into_vec().ok());
            if signed.prepared != prepared || ours.as_deref() != Some(&wire[65..129]) {
                return Err(uncertain(
                    "The Allowit server returned a signed payment that the agent did not sign.",
                ));
            }
            signature = Some(transaction);
            let packet = packets::signed(signed)?;
            if let Some(chain) = self.chain {
                // The agent's own ledger read decides.
                receipt = chain
                    .observe(&packet)?
                    .map(|receipt| packets::decode::<ReceiptDoc>(&receipt.0))
                    .transpose()?;
                lapsed = receipt.is_none() && chain.status(&packet)? == Status::Prepared;
            } else if let Some(claimed) = &reply.receipt {
                PACKETS.verify_receipt(&packets::receipt(claimed)?.0, &packet.0)?;
                receipt = Some(claimed.clone());
            }
        } else if reply.receipt.is_some() {
            return Err(uncertain(
                "The Allowit server returned a receipt without the signed payment.",
            ));
        }
        let status = match (&receipt, reply.operation.status.clone()) {
            (Some(receipt), _) if receipt.failed => Status::Failed,
            (Some(_), _) => Status::Confirmed,
            // The lapse that the agent's own RPC proved: the bytes never ran and cannot run.
            (None, _) if lapsed => Status::Prepared,
            // A final status needs its receipt. Without one the outcome is still open.
            (None, Status::Confirmed | Status::Failed) => Status::SubmissionUnknown,
            // A signature of the agent is out: "prepared" is the backend's word, not a proof.
            (None, Status::Prepared) if record.agent_signature.is_some() => {
                Status::SubmissionUnknown
            }
            (None, status) => status,
        };
        let mut document = json!({
            "requestId": record.request_id,
            "status": status,
            "network": network,
            "transactionHash": hex32::encode(&prepared.transaction_hash),
        });
        if let Some(signature) = signature {
            let text = bs58::encode(signature).into_string();
            if let Some(link) = networks::explorer(&network, LinkKind::Transaction, &text) {
                document[EXPLORER_KEY] = link.into();
            }
            document["signature"] = text.into();
        }
        if lapsed {
            document["lapsed"] = true.into();
        }
        if let Some(receipt) = &receipt {
            let asset = AssetDisplay {
                symbol: prepared.config.asset_symbol.clone(),
                decimals: prepared.config.decimals,
                name: prepared.config.asset_symbol.clone(),
                native: false,
            };
            let settlement = Settlement {
                height: receipt.slot,
                fee: Quantity::new(i128::from(receipt.fee_lamports), networks::native_display()),
                amount: receipt
                    .transfer
                    .as_ref()
                    .map(|transfer| Quantity::new(i128::from(transfer.units), asset)),
            };
            document[Settlement::KEY] = serde_json::to_value(settlement)
                .map_err(|_| Error::config("Cannot encode the settlement"))?;
        }
        Ok(Outcome { document, status })
    }

    fn read(&self, record: &Record) -> Result<Outcome> {
        let reply = self.call(
            STATUS_PATH,
            json!({"policyId": self.profile.policy_id, "requestId": record.request_id}),
        )?;
        self.outcome(record, &reply)
    }

    /// Read until the payment is final or `wait` is over.
    fn poll(&self, record: &Record, mut outcome: Outcome, wait: Duration) -> Result<Outcome> {
        let end = Instant::now() + wait.min(MAX_WAIT);
        while matches!(
            outcome.status,
            Status::Submitted | Status::SubmissionUnknown
        ) && Instant::now() + POLL_INTERVAL <= end
        {
            (self.sleep)(POLL_INTERVAL);
            outcome = self.read(record)?;
        }
        Ok(outcome)
    }

    /// The request that `request_id` names for a transfer of `units` to `recipient`.
    pub fn request(&self, request_id: &str, recipient: &str, units: u64) -> Result<Request> {
        self.check()?;
        agent::request(self.profile, request_id, recipient, units)
    }

    /// Pay `units` to the token account `recipient` under `request_id`, and wait up to `wait`
    /// for the outcome. A repeat of the id continues the retained request.
    pub fn execute(
        &self,
        request_id: &str,
        recipient: &str,
        units: u64,
        wait: Duration,
    ) -> Result<Outcome> {
        let request = self.request(request_id, recipient, units)?;
        let mut record = match self.retained(Some(&request), request_id)? {
            // The agent signed already: this call reads, and signs nothing more.
            Some(record) if record.agent_signature.is_some() => {
                let outcome = self.read(&record)?;
                return self.poll(&record, outcome, wait);
            }
            Some(record) => record,
            None => Record {
                version: 1,
                origin: self.backend.origin().into(),
                request_id: request_id.into(),
                profile: self.profile.clone(),
                request: request.clone(),
                prepared: None,
                agent_signature: None,
            },
        };
        // The intent is retained before the backend hears of it.
        self.save(&record)?;
        let reply = self.call(
            EXECUTE_PATH,
            json!({"policyId": self.profile.policy_id, "requestId": request_id,
                "phase": "prepare", "request": request}),
        )?;
        if reply.operation.status != Status::Prepared || reply.signed_operation.is_some() {
            return Err(uncertain(
                "The Allowit server answered a prepare call with another state than prepared.",
            ));
        }
        let prepared = reply.prepared.get().as_bytes();
        let now = (self.clock)()?;
        let (doc, _) = agent::check_prepared(self.profile, &request, prepared, now)?;
        let signature = agent::sign(self.profile, &request, prepared, self.agent, now)?;
        record.prepared = Some(doc);
        record.agent_signature = Some(bs58::encode(&signature.bytes).into_string());
        // The signature is retained before it leaves: from here the id only reads.
        self.save(&record)?;
        let reply = self.call(
            EXECUTE_PATH,
            json!({"policyId": self.profile.policy_id, "requestId": request_id,
                "phase": "submit", "agentSignature": signature}),
        )?;
        let outcome = self.outcome(&record, &reply)?;
        self.poll(&record, outcome, wait)
    }

    /// Where the payment that `request_id` retains stands, waiting up to `wait`.
    pub fn status(&self, request_id: &str, wait: Duration) -> Result<Outcome> {
        self.check()?;
        let record = self
            .retained(None, request_id)?
            .ok_or_else(|| Error::usage("This request ID has no retained payment"))?;
        let outcome = self.read(&record)?;
        self.poll(&record, outcome, wait)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packets::tests::key;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// One HTTP exchange on a local socket: the request as received, and `reply` sent back.
    fn exchange(reply: &'static str) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                seen.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&seen);
                if let Some(head) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if seen.len() >= head + 4 + length {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            stream.write_all(reply.as_bytes()).unwrap();
            seen
        });
        (origin, server)
    }

    #[test]
    fn a_call_carries_the_agents_proof_of_its_path_and_body() {
        let agent = key(2);
        let clock = || Ok(1_800_000_000);
        let (origin, server) = exchange(
            "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: 44\r\nConnection: close\r\n\r\n{\"error\":\"stopped\",\"code\":\"wallet_paused\"}  ",
        );
        let backend = HttpBackend::new(&origin, &agent, &clock).unwrap();
        assert_eq!(backend.origin(), origin);
        let body = json!({"requestId": "r1", "policyId": "p", "phase": "prepare"});
        let Sent::Reply(status, answer) = backend.post(EXECUTE_PATH, &body).unwrap() else {
            panic!("the server answered");
        };
        assert_eq!(status, 409);
        let refused = refusal(status, &answer);
        assert_eq!(refused.api_code.as_deref(), Some("wallet_paused"));
        assert!(refused.message.ends_with("stopped"), "{}", refused.message);
        let seen = String::from_utf8(server.join().unwrap()).unwrap();
        assert!(seen.starts_with("POST /api/native/execute HTTP/1.1"));
        let proof = seen
            .lines()
            .find_map(|line| {
                line.strip_prefix("authorization: ")
                    .or_else(|| line.strip_prefix("Authorization: "))
            })
            .unwrap()
            .trim();
        let proof = proof.strip_prefix("Bearer ").unwrap_or(proof);
        // The proof names the agent for exactly this path and the canonical body.
        let canonical = serde_json_canonicalizer::to_vec(&body).unwrap();
        let verify = |path: &str, body: &[u8]| {
            request_proof::verify(
                crate::proof::request_proof_protocol(),
                proof,
                1_800_000_000,
                path,
                body,
            )
        };
        assert_eq!(verify(EXECUTE_PATH, &canonical).unwrap(), agent.identity());
        assert!(verify(STATUS_PATH, &canonical).is_err());
        assert!(verify(EXECUTE_PATH, b"{}").is_err());
        assert!(seen.ends_with(&String::from_utf8(serde_json::to_vec(&body).unwrap()).unwrap()));
    }

    #[test]
    fn a_server_that_gives_no_answer_is_unanswered_not_refused() {
        let agent = key(2);
        let clock = || Ok(1_800_000_000);
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        let backend = HttpBackend::new(&origin, &agent, &clock).unwrap();
        assert!(matches!(
            backend.post(STATUS_PATH, &json!({})).unwrap(),
            Sent::Unanswered
        ));
        // A refusal without a body still says what the server answered.
        let bare = refusal(503, b"");
        assert_eq!(bare.status, Some(503));
        assert!(bare.message.contains("503"));
    }
}
