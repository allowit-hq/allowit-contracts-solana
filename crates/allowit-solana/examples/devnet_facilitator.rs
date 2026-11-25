//! A host of the rail's settlement service for Devnet tests: the Allowit facilitator for x402
//! `exact` payments on Solana Devnet, until the engine serves Solana (plan task T15).
//!
//! It serves the engine's facilitator routes with the engine's reply shapes:
//! `GET facilitator/supported`, `POST facilitator/verify` and `POST facilitator/settle`, each
//! also under `/api/`. There is no session, no agent proof and no app origin, as in the engine; a
//! request rate per minute bounds `verify` and `settle` (HTTP 429, code
//! `facilitator_rate_limited`) and the service's hourly fee budget bounds what settlements pay.
//!
//! Configuration, from the environment:
//!
//! - `ALLOWIT_FACILITATOR_SOLANA_KEYPAIR` (required): the path of the fee payer's Solana CLI
//!   keypair file. The key is never printed.
//! - `ALLOWIT_FACILITATOR_SOLANA_RPC`: the Solana RPC endpoint, by default the public Devnet one.
//!   The host refuses to start unless the endpoint's genesis is Solana Devnet's.
//! - `ALLOWIT_FACILITATOR_PORT`: the port on 127.0.0.1, by default 4402.
//! - `ALLOWIT_FACILITATOR_REQUESTS_PER_MINUTE` (120), `ALLOWIT_FACILITATOR_MAX_FEE_UNITS`
//!   (50000 lamports) and `ALLOWIT_FACILITATOR_HOURLY_FEE_UNITS` (5000000 lamports).
use allowit_core::vendor::{
    KeyProvider as _, error::Error, plugin::RailPlugin as _, runtime::Signer as _,
    settlement_service::Limits,
};
use allowit_solana::{
    DEVNET, KEYS, KeySigner, PLUGIN,
    rpc::Rpc,
    settlement_service::{HOURLY_FEE_LAMPORTS, Service, SettlementLedger, VERSION},
    x402,
};
use serde_json::{Value, json};
use std::{
    io::{BufRead as _, BufReader, Read as _, Write as _},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

/// The public Solana Devnet RPC endpoint.
const DEVNET_RPC: &str = "https://api.devnet.solana.com";
/// Solana Devnet's genesis hash.
const DEVNET_GENESIS: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/// The code of a 429 for a request above the request rate, as the engine names it.
const RATE_LIMITED: &str = "facilitator_rate_limited";
/// The engine's defaults: the fee ceiling of one settlement and the requests of one minute.
const DEFAULT_MAX_FEE: u128 = 50_000;
const DEFAULT_REQUESTS_PER_MINUTE: u64 = 120;
/// How long a settlement waits for the ledger, as in the engine, and how often it reads it.
const SETTLEMENT_WAIT: Duration = Duration::from_secs(45);
const POLL: Duration = Duration::from_secs(2);
/// The largest request head and body that the host reads.
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 256 * 1024;

/// An HTTP answer: its status and its JSON body.
type Reply = (u16, Value);

/// The facilitator: the settlement service on one ledger with the fee payer's key.
struct Host {
    ledger: Arc<dyn SettlementLedger + Send + Sync>,
    signer: KeySigner,
    service: Service,
    limits: Limits,
    poll: Duration,
    requests_per_minute: u64,
    /// The minute and the requests counted in it.
    requests: Mutex<(u64, u64)>,
    clock: fn() -> u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn fault(status: u16, message: &str) -> Reply {
    (status, json!({ "error": message }))
}

/// The answer to a fault of the settlement service or its ledger read: the request is neither
/// valid nor refused. The rail's message stays in the host's log; it may quote the RPC.
fn unavailable(error: &Error) -> Reply {
    eprintln!(
        "allowit solana facilitator: unavailable code={} message={}",
        error.code, error.message
    );
    fault(
        503,
        "The Allowit Solana facilitator could not read the Solana Devnet RPC; nothing was settled. Retry later.",
    )
}

/// A refusal to start unless `genesis` is Solana Devnet's.
fn devnet_only(genesis: &str) -> Result<(), String> {
    if genesis == DEVNET_GENESIS {
        Ok(())
    } else {
        Err(format!(
            "The Solana RPC endpoint serves the network of genesis {genesis}, not Solana Devnet ({DEVNET_GENESIS}); this facilitator settles Devnet only."
        ))
    }
}

impl Host {
    fn new(
        ledger: Arc<dyn SettlementLedger + Send + Sync>,
        signer: KeySigner,
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let number = |key: &str, default: u128| -> Result<u128, String> {
            env(key).map_or(Ok(default), |value| {
                value
                    .trim()
                    .parse()
                    .map_err(|_| format!("{key} must be a whole number."))
            })
        };
        let requests_per_minute = number(
            "ALLOWIT_FACILITATOR_REQUESTS_PER_MINUTE",
            u128::from(DEFAULT_REQUESTS_PER_MINUTE),
        )?;
        Ok(Self {
            ledger,
            signer,
            service: Service::new(number(
                "ALLOWIT_FACILITATOR_HOURLY_FEE_UNITS",
                HOURLY_FEE_LAMPORTS,
            )?),
            limits: Limits {
                max_fee: number("ALLOWIT_FACILITATOR_MAX_FEE_UNITS", DEFAULT_MAX_FEE)?,
                wait: SETTLEMENT_WAIT,
            },
            poll: POLL,
            requests_per_minute: u64::try_from(requests_per_minute)
                .map_err(|_| "ALLOWIT_FACILITATOR_REQUESTS_PER_MINUTE is too large.".to_owned())?,
            requests: Mutex::new((0, 0)),
            clock: now,
        })
    }

    /// What the facilitator settles, as the engine lists it, with the fee payer in each kind's
    /// `extra`: the x402 `exact` SVM scheme names the fee payer there, and sellers read it.
    fn supported(&self) -> Value {
        let fee_payer = self.signer.identity();
        json!({
            "kinds": [{
                "x402Version": VERSION,
                "scheme": x402::SCHEME,
                "network": DEVNET,
                "extra": { "feePayer": fee_payer },
            }],
            "extensions": [],
            "signers": { "solana:*": [fee_payer] },
        })
    }

    /// Count one request against the rate of the current minute.
    fn admit_request(&self) -> Result<(), Reply> {
        let minute = (self.clock)() / 60;
        let mut counted = self.requests.lock().map_err(|_| {
            fault(
                503,
                "The Allowit Solana facilitator's request counter is unavailable. Retry later.",
            )
        })?;
        if counted.0 != minute {
            *counted = (minute, 0);
        }
        if counted.1 >= self.requests_per_minute {
            return Err((
                429,
                json!({
                    "error": "The Allowit Solana facilitator serves no more requests this minute. Retry later.",
                    "code": RATE_LIMITED,
                }),
            ));
        }
        counted.1 += 1;
        Ok(())
    }

    /// The request body as JSON, for Solana Devnet.
    fn request(body: &[u8]) -> Result<Value, Reply> {
        let request: Value = serde_json::from_slice(body)
            .map_err(|_| fault(400, "The request body is not JSON."))?;
        match request["paymentRequirements"]["network"].as_str() {
            None => Err(fault(
                400,
                "Provide paymentPayload and paymentRequirements.",
            )),
            Some(network) if network != DEVNET => {
                Err(fault(400, "The facilitator does not serve this network."))
            }
            Some(_) => Ok(request),
        }
    }

    fn verify(&self, body: &[u8]) -> Result<Reply, Reply> {
        self.admit_request()?;
        let request = Self::request(body)?;
        let verified = self
            .service
            .verify_on(
                &*self.ledger,
                DEVNET,
                self.signer.identity(),
                &request,
                &self.limits,
                (self.clock)(),
            )
            .map_err(|error| unavailable(&error))?;
        Ok((200, verified.reply))
    }

    fn settle(&self, body: &[u8]) -> Result<Reply, Reply> {
        self.admit_request()?;
        let request = Self::request(body)?;
        let settled = self
            .service
            .settle_on(
                &*self.ledger,
                DEVNET,
                &self.signer,
                &request,
                &self.limits,
                (self.clock)(),
                self.poll,
            )
            .map_err(|error| unavailable(&error))?;
        Ok((200, settled.reply))
    }

    /// The answer to one request: the engine's facilitator routes, with or without `/api/`.
    fn handle(&self, method: &str, path: &str, body: &[u8]) -> Reply {
        let path = path.split('?').next().unwrap_or_default();
        let path = path
            .strip_prefix("/api/")
            .unwrap_or(path.trim_start_matches('/'));
        let answer = match (method, path) {
            ("GET", "facilitator/supported") => Ok((200, self.supported())),
            ("POST", "facilitator/verify") => self.verify(body),
            ("POST", "facilitator/settle") => self.settle(body),
            (_, "facilitator/supported" | "facilitator/verify" | "facilitator/settle") => {
                Err(fault(405, "Use the documented facilitator method."))
            }
            _ => Err(fault(404, "Endpoint not found.")),
        };
        answer.unwrap_or_else(|reply| reply)
    }
}

/// Read one HTTP/1.1 request from `stream`: its method, path and body. `Err` is the reply.
fn read_request(stream: &TcpStream) -> Result<(String, String, Vec<u8>), Reply> {
    let bad = || fault(400, "The request is not HTTP/1.1.");
    let mut reader = BufReader::new(stream.take((MAX_HEAD + MAX_BODY) as u64));
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|_| bad())?;
    let mut parts = line.split_whitespace();
    let (Some(method), Some(path)) = (parts.next(), parts.next()) else {
        return Err(bad());
    };
    let (method, path) = (method.to_owned(), path.to_owned());
    let (mut head, mut length) = (line.len(), 0usize);
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).map_err(|_| bad())? == 0 {
            return Err(bad());
        }
        head += header.len();
        if head > MAX_HEAD {
            return Err(fault(431, "The request head is too large."));
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.trim().eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().map_err(|_| bad())?;
        }
    }
    if length > MAX_BODY {
        return Err(fault(413, "The request body is too large."));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|_| bad())?;
    Ok((method, path, body))
}

fn write_reply(mut stream: &TcpStream, (status, body): &Reply) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        _ => "Service Unavailable",
    };
    let body = body.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

/// Serve `host` on `listener`, one thread per connection.
fn serve(host: Arc<Host>, listener: TcpListener) {
    for stream in listener.incoming().flatten() {
        let host = Arc::clone(&host);
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
            let reply = match read_request(&stream) {
                Ok((method, path, body)) => host.handle(&method, &path, &body),
                Err(reply) => reply,
            };
            write_reply(&stream, &reply);
        });
    }
}

/// The fee payer's key from a Solana CLI keypair file: a JSON array of the 64 bytes of seed and
/// public key. Nothing of it is printed.
fn fee_payer(path: &str) -> Result<KeySigner, String> {
    let text =
        Zeroizing::new(std::fs::read_to_string(path).map_err(|_| {
            "ALLOWIT_FACILITATOR_SOLANA_KEYPAIR names no readable file.".to_owned()
        })?);
    let bytes: Zeroizing<Vec<u8>> = Zeroizing::new(serde_json::from_str(&text).map_err(|_| {
        "The fee payer's keypair file is not a Solana CLI keypair (a JSON array of 64 bytes)."
            .to_owned()
    })?);
    if bytes.len() != 64 {
        return Err("The fee payer's keypair file does not hold 64 bytes.".into());
    }
    let secret = Zeroizing::new(bs58::encode(&bytes[..]).into_string());
    KEYS.parse(&secret)
        .map(KeySigner)
        .map_err(|error| format!("The fee payer's keypair file is refused: {}", error.message))
}

fn start() -> Result<(), String> {
    let env = |key: &str| {
        std::env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty())
    };
    let signer = fee_payer(&env("ALLOWIT_FACILITATOR_SOLANA_KEYPAIR").ok_or(
        "Set ALLOWIT_FACILITATOR_SOLANA_KEYPAIR to the path of the fee payer's Solana CLI keypair file.",
    )?)?;
    let endpoint = env("ALLOWIT_FACILITATOR_SOLANA_RPC").unwrap_or_else(|| DEVNET_RPC.into());
    let port: u16 = env("ALLOWIT_FACILITATOR_PORT")
        .map_or(Ok(4402), |port| port.trim().parse())
        .map_err(|_| "ALLOWIT_FACILITATOR_PORT must be a port number.".to_owned())?;
    let ledger = Rpc(PLUGIN
        .connect(DEVNET, &endpoint)
        .map_err(|error| format!("The Solana RPC endpoint is refused: {}", error.message))?);
    let genesis = ledger.genesis_hash().map_err(|error| {
        format!(
            "The Solana RPC endpoint {endpoint} did not answer getGenesisHash ({}).",
            error.message
        )
    })?;
    devnet_only(&genesis)?;
    let host = Host::new(Arc::new(ledger), signer, &env)?;
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| format!("127.0.0.1:{port} is not available: {error}"))?;
    println!(
        "Allowit Solana Devnet facilitator: fee payer {} on {endpoint}, serving http://127.0.0.1:{port}/facilitator",
        host.signer.identity()
    );
    serve(Arc::new(host), listener);
    Ok(())
}

fn main() {
    if let Err(message) = start() {
        eprintln!("allowit solana facilitator: {message}");
        std::process::exit(1);
    }
}

#[cfg(test)]
#[path = "../tests/common/mod.rs"]
mod common;

#[cfg(test)]
mod tests {
    use super::{common::*, *};
    use allowit_solana::{native::Budget, settlement_service as service};
    use solana_hash::Hash;

    impl SettlementLedger for Svm {
        fn genesis_hash(&self) -> Result<String> {
            Ok(DEVNET_GENESIS.into())
        }
        fn blockhash_bound(&self, blockhash: &Hash) -> Result<Option<u64>> {
            let state = self.0.lock().unwrap();
            Ok((state.svm.latest_blockhash() == *blockhash).then_some(state.height + 150))
        }
        fn simulate(&self, wire: &[u8]) -> Result<Option<String>> {
            let tx: Transaction = wincode::deserialize(wire).unwrap();
            let mut state = self.0.lock().unwrap();
            let svm = std::mem::take(&mut state.svm).with_sigverify(false);
            let failed = svm.simulate_transaction(tx).is_err();
            state.svm = svm.with_sigverify(true);
            Ok(failed.then(|| "simulation failed".to_owned()))
        }
    }

    /// A host on a LiteSVM ledger where a wallet holds 10 tokens with an allowance of 5, its
    /// seller's associated token account exists and the fee payer has lamports.
    fn host(env: &[(&str, &str)]) -> (Host, Fixture, Address) {
        let f = fixture(5 * TOKEN, 10 * TOKEN);
        let facilitator = signer(4);
        let seller = address(&signer(5));
        let ata = x402::associated_token_account(&seller, &f.wallet.mint);
        {
            let mut state = f.chain.0.lock().unwrap();
            state
                .svm
                .airdrop(&address(&facilitator), 1_000_000_000)
                .unwrap();
            let mut data = vec![0u8; 165];
            data[0..32].copy_from_slice(f.wallet.mint.as_ref());
            data[32..64].copy_from_slice(seller.as_ref());
            data[108] = 1;
            let lamports = state.svm.minimum_balance_for_rent_exemption(165);
            let account = Account {
                lamports,
                data,
                owner: TOKEN_PROGRAM,
                executable: false,
                rent_epoch: 0,
            };
            state.svm.set_account(ata, account).unwrap();
        }
        let env: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let lookup = move |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        let mut host = Host::new(f.chain.clone(), facilitator, &lookup).unwrap();
        (host.poll, host.limits.wait, host.clock) = (Duration::ZERO, Duration::ZERO, || NOW);
        (host, f, seller)
    }

    /// The seller's request body: the client's payment, signed by the agent and the server.
    fn body(host: &Host, f: &Fixture, seller: &Address, units: u64) -> Vec<u8> {
        let fee_payer = host.signer.identity();
        let requirements = json!({
            "scheme": "exact", "network": DEVNET, "amount": units.to_string(), "asset": USDC_DEVNET,
            "payTo": seller.to_string(), "maxTimeoutSeconds": 60, "extra": {"feePayer": fee_payer},
        });
        let ata = x402::associated_token_account(seller, &f.wallet.mint);
        let blockhash = f.chain.0.lock().unwrap().svm.latest_blockhash();
        let fee_payer = address(&signer(4));
        let p = f
            .wallet
            .payment(
                &ata,
                units,
                DECIMALS,
                Budget::PAYMENT,
                Some("order"),
                &fee_payer,
                blockhash,
            )
            .unwrap();
        let wire = p
            .wire(&[p.sign(&f.agent).unwrap(), p.sign(&f.server).unwrap()])
            .unwrap();
        json!({
            "x402Version": 2,
            "paymentPayload": {"x402Version": 2, "accepted": requirements, "payload": {"transaction": STANDARD.encode(wire)}},
            "paymentRequirements": requirements,
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn supported_names_devnet_exact_version_2_and_the_fee_payer() {
        let (host, ..) = host(&[]);
        let fee_payer = address(&signer(4)).to_string();
        let (status, reply) = host.handle("GET", "/facilitator/supported", b"");
        assert_eq!(status, 200);
        assert_eq!(
            reply,
            json!({
                "kinds": [{"x402Version": 2, "scheme": "exact", "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "extra": {"feePayer": fee_payer}}],
                "extensions": [],
                "signers": {"solana:*": [fee_payer]},
            })
        );
        assert_eq!(
            host.handle("GET", "/api/facilitator/supported?x=1", b"").1,
            reply
        );
    }

    #[test]
    fn routes_answer_in_the_engine_shapes() {
        let (host, ..) = host(&[]);
        assert_eq!(host.handle("GET", "/facilitator/nothing", b"").0, 404);
        assert_eq!(host.handle("GET", "/facilitator/verify", b"").0, 405);
        assert_eq!(host.handle("POST", "/facilitator/supported", b"").0, 405);
        let (status, reply) = host.handle("POST", "/facilitator/verify", b"{");
        assert_eq!((status, reply["error"].is_string()), (400, true));
        let (status, reply) = host.handle("POST", "/facilitator/settle", b"{}");
        assert_eq!(
            reply,
            json!({"error": "Provide paymentPayload and paymentRequirements."})
        );
        assert_eq!(status, 400);
        let other =
            br#"{"paymentRequirements": {"network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"}}"#;
        assert_eq!(host.handle("POST", "/facilitator/verify", other).0, 400);
        // A malformed payment for Devnet is a well-formed refusal, not a fault.
        let crafted = json!({"x402Version": 2, "paymentPayload": {"x402Version": 2, "payload": {"transaction": "AAAA"}},
            "paymentRequirements": {"scheme": "exact", "network": DEVNET}});
        let (status, reply) = host.handle(
            "POST",
            "/facilitator/verify",
            crafted.to_string().as_bytes(),
        );
        assert_eq!((status, &reply["isValid"]), (200, &json!(false)), "{reply}");
        assert!(
            reply["invalidReason"]
                .as_str()
                .unwrap()
                .starts_with("invalid_exact_svm")
        );
        let (status, reply) = host.handle(
            "POST",
            "/facilitator/settle",
            crafted.to_string().as_bytes(),
        );
        assert_eq!(
            (status, &reply["success"], &reply["network"]),
            (200, &json!(false), &json!(DEVNET))
        );
    }

    #[test]
    fn requests_above_the_rate_answer_429() {
        let (host, ..) = host(&[("ALLOWIT_FACILITATOR_REQUESTS_PER_MINUTE", "2")]);
        for _ in 0..2 {
            assert_eq!(host.handle("POST", "/facilitator/verify", b"{}").0, 400);
        }
        let (status, reply) = host.handle("POST", "/facilitator/settle", b"{}");
        assert_eq!((status, &reply["code"]), (429, &json!(RATE_LIMITED)));
        // The list of what it settles is not counted, as in the engine.
        assert_eq!(host.handle("GET", "/facilitator/supported", b"").0, 200);
    }

    #[test]
    fn it_starts_on_devnet_only() {
        assert!(devnet_only(DEVNET_GENESIS).is_ok());
        let mainnet = devnet_only("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d").unwrap_err();
        assert!(mainnet.contains("not Solana Devnet"), "{mainnet}");
        assert!(devnet_only("").is_err());
    }

    #[test]
    fn a_payment_verifies_and_settles_once_through_http() {
        let (host, f, seller) = host(&[]);
        let body = body(&host, &f, &seller, 2 * TOKEN);
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || serve(Arc::new(host), listener));
        let call = |method: &str, path: &str, body: &[u8]| -> (u16, Value) {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(
                stream,
                "{method} {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
            let mut answer = String::new();
            stream.read_to_string(&mut answer).unwrap();
            let (head, json) = answer.split_once("\r\n\r\n").unwrap();
            (
                head[9..12].parse().unwrap(),
                serde_json::from_str(json).unwrap(),
            )
        };
        assert_eq!(call("GET", "/facilitator/supported", b"").0, 200);
        let (status, verified) = call("POST", "/facilitator/verify", &body);
        assert_eq!(
            (status, &verified["isValid"]),
            (200, &json!(true)),
            "{verified}"
        );
        assert_eq!(verified["payer"], f.wallet.token_account().to_string());
        let (status, settled) = call("POST", "/facilitator/settle", &body);
        assert_eq!(
            (status, &settled["success"]),
            (200, &json!(true)),
            "{settled}"
        );
        assert_eq!(
            f.balance(&x402::associated_token_account(&seller, &f.wallet.mint)),
            2 * TOKEN
        );
        let (_, again) = call("POST", "/facilitator/settle", &body);
        assert_eq!(again["errorReason"], service::DUPLICATE);
    }
}
