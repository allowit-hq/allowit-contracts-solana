//! The agent's client against a server on a ledger. The server here is the rail's own runtime
//! over LiteSVM, behind the two backend routes, so the test exercises the whole exchange: the
//! agent's request, the server's prepared payment, both signatures, the submission and the
//! receipt. The server can also be told to misbehave.
mod common;
use common::*;

use allowit_core::vendor::{
    runtime::{Prepared, Signature as RoleSignature, Signed},
    typed_request::operation_nonce,
};
use allowit_solana::client::{Backend, Client, EXECUTE_PATH, Records, STATUS_PATH, Sent};
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::time::Duration;

#[derive(Default)]
struct Journal(RefCell<BTreeMap<String, Value>>);
impl Records for Journal {
    fn load(&self, name: &str) -> Result<Option<Value>> {
        Ok(self.0.borrow().get(name).cloned())
    }
    fn save(&self, name: &str, record: &Value) -> Result<()> {
        self.0.borrow_mut().insert(name.into(), record.clone());
        Ok(())
    }
}

/// How the server departs from the protocol.
#[derive(Clone, Copy, PartialEq)]
enum Fault {
    None,
    /// It prepares a payment of one unit more than the agent asked for.
    PrepareMore,
    /// It handles a submit call and its answer is lost.
    LoseSubmitAnswer,
    /// It takes the agent's signature, sends nothing and says that the payment is confirmed.
    ClaimConfirmed,
}

struct Server<'a> {
    f: &'a Fixture,
    installation: Installation,
    fault: Cell<Fault>,
    prepared: RefCell<BTreeMap<String, Prepared>>,
    signed: RefCell<BTreeMap<String, Signed>>,
    calls: RefCell<Vec<String>>,
}
impl<'a> Server<'a> {
    fn new(f: &'a Fixture) -> Self {
        Self {
            installation: f.installed(),
            f,
            fault: Cell::new(Fault::None),
            prepared: RefCell::default(),
            signed: RefCell::default(),
            calls: RefCell::default(),
        }
    }
    fn answer(&self, id: &str, status: Status) -> Result<Value> {
        let prepared = self.prepared.borrow().get(id).cloned().unwrap();
        let signed = self.signed.borrow().get(id).cloned();
        let receipt = match &signed {
            Some(signed) if self.fault.get() != Fault::ClaimConfirmed => {
                self.f.runtime.observe(signed)?
            }
            _ => None,
        };
        Ok(
            json!({"prepared": prepared, "operation": {"status": status},
            "signedOperation": signed, "receipt": receipt, "walletKind": "native"}),
        )
    }
    fn handle(&self, path: &str, body: &Value) -> Result<Value> {
        let rt = &self.f.runtime;
        let i = &self.installation;
        let id = body["requestId"].as_str().unwrap().to_owned();
        assert_eq!(body["policyId"], "policy-1");
        if path == STATUS_PATH {
            let status = match self.signed.borrow().get(&id) {
                Some(_) if self.fault.get() == Fault::ClaimConfirmed => Status::Confirmed,
                Some(signed) => rt.status(signed)?,
                None => Status::Prepared,
            };
            return self.answer(&id, status);
        }
        assert_eq!(path, EXECUTE_PATH);
        match body["phase"].as_str().unwrap() {
            "prepare" => {
                let mut asked = body["request"].clone();
                if self.fault.get() == Fault::PrepareMore {
                    let units: u64 = asked["units"].as_str().unwrap().parse().unwrap();
                    asked["units"] = json!((units + 1).to_string());
                }
                let request = rt.read_request(i, &serde_json::to_vec(&asked).unwrap())?;
                assert_eq!(request.operation_id()?, operation_nonce("policy-1", &id));
                let prepared = rt.prepare(
                    i,
                    &request,
                    &Terms::default(),
                    Some(&Accounting::default()),
                    Validity {
                        now: NOW,
                        expires_at: NOW + 60,
                    },
                )?;
                self.prepared.borrow_mut().insert(id.clone(), prepared);
                self.answer(&id, Status::Prepared)
            }
            "submit" => {
                let prepared = self.prepared.borrow().get(&id).cloned().unwrap();
                let agent: RoleSignature =
                    serde_json::from_value(body["agentSignature"].clone()).unwrap();
                let server = rt.sign(i, &prepared, &self.f.server, NOW)?;
                let signed = rt.authorize(i, &prepared, &[agent, server], NOW)?;
                self.signed.borrow_mut().insert(id.clone(), signed.clone());
                if self.fault.get() == Fault::ClaimConfirmed {
                    return self.answer(&id, Status::Confirmed);
                }
                let status = rt.broadcast(&signed, NOW)?;
                self.answer(&id, status)
            }
            other => panic!("unknown phase {other}"),
        }
    }
}
impl Backend for Server<'_> {
    fn origin(&self) -> &str {
        "https://allowit.example"
    }
    fn post(&self, path: &str, body: &Value) -> Result<Sent> {
        let phase = body["phase"].as_str().unwrap_or("status").to_owned();
        self.calls.borrow_mut().push(phase.clone());
        match self.handle(path, body) {
            Ok(_) if phase == "submit" && self.fault.get() == Fault::LoseSubmitAnswer => {
                Ok(Sent::Unanswered)
            }
            Ok(reply) => Ok(Sent::Reply(200, serde_json::to_vec(&reply).unwrap())),
            Err(error) => Ok(Sent::Reply(
                409,
                serde_json::to_vec(&json!({"error": error.message, "code": "operation_refused"}))
                    .unwrap(),
            )),
        }
    }
}

struct World {
    f: Fixture,
    profile: Bundle,
    journal: Journal,
}
fn world() -> World {
    let f = fixture(5 * TOKEN, 10 * TOKEN);
    let profile = serde_json::from_slice(&f.bundle(&f.owner)).unwrap();
    World {
        f,
        profile,
        journal: Journal::default(),
    }
}
impl World {
    fn client<'a>(&'a self, server: &'a Server<'a>, chain: bool) -> Client<'a> {
        Client {
            backend: server,
            records: &self.journal,
            profile: &self.profile,
            agent: &self.f.agent,
            clock: &|| Ok(NOW),
            chain: chain.then_some(&self.f.runtime),
            sleep: &|_| {},
        }
    }
    fn record(&self) -> Value {
        self.journal.0.borrow().values().next().cloned().unwrap()
    }
}
fn payee(w: &World) -> String {
    w.f.payee.to_string()
}

#[test]
fn a_payment_goes_from_the_agents_request_to_a_verified_receipt_once() {
    let w = world();
    let server = Server::new(&w.f);
    for own_rpc in [false, true] {
        let id = if own_rpc { "pay-2" } else { "pay-1" };
        let client = w.client(&server, own_rpc);
        let before = w.f.balance(&w.f.payee);
        let outcome = client
            .execute(id, &payee(&w), 2 * TOKEN, Duration::ZERO)
            .unwrap();
        assert_eq!(outcome.status, Status::Confirmed);
        assert_eq!(w.f.balance(&w.f.payee), before + 2 * TOKEN);
        let settlement = &outcome.document["settlement"];
        assert_eq!(settlement["amount"]["units"], (2 * TOKEN).to_string());
        assert_eq!(settlement["amount"]["text"], "2 USDC");
        assert_eq!(settlement["fee"]["units"], "10001");
        assert_eq!(settlement["fee"]["asset"]["symbol"], "SOL");
        assert!(
            outcome.document["explorer"]
                .as_str()
                .unwrap()
                .starts_with("https://explorer.solana.com/tx/")
        );
        // The same id again reads the same payment: nothing is prepared, signed or moved.
        let calls = server.calls.borrow().len();
        let again = client
            .execute(id, &payee(&w), 2 * TOKEN, Duration::ZERO)
            .unwrap();
        assert_eq!(again.status, Status::Confirmed);
        assert_eq!(again.document["signature"], outcome.document["signature"]);
        assert_eq!(server.calls.borrow()[calls..], ["status"]);
        assert_eq!(w.f.balance(&w.f.payee), before + 2 * TOKEN);
        // The id binds its input: another amount or recipient under it is refused.
        assert!(
            client
                .execute(id, &payee(&w), 3 * TOKEN, Duration::ZERO)
                .is_err()
        );
    }
    assert_eq!(
        server.calls.borrow()[..3],
        ["prepare", "submit", "status"],
        "one prepare and one submit for the first payment"
    );
}

#[test]
fn the_agent_signs_nothing_when_the_server_prepares_another_payment() {
    let w = world();
    let server = Server::new(&w.f);
    server.fault.set(Fault::PrepareMore);
    let client = w.client(&server, false);
    assert!(
        client
            .execute("pay-1", &payee(&w), 2 * TOKEN, Duration::ZERO)
            .is_err()
    );
    assert_eq!(*server.calls.borrow(), ["prepare"], "no submit call");
    assert!(w.record()["agentSignature"].is_null());
    assert_eq!(w.f.balance(&w.f.payee), 0);
    // An honest server continues the same retained intent under the same id.
    server.fault.set(Fault::None);
    let outcome = client
        .execute("pay-1", &payee(&w), 2 * TOKEN, Duration::ZERO)
        .unwrap();
    assert_eq!(outcome.status, Status::Confirmed);
    assert_eq!(w.f.balance(&w.f.payee), 2 * TOKEN);
}

#[test]
fn a_lost_answer_is_unknown_and_the_same_id_reads_the_payment() {
    let w = world();
    let server = Server::new(&w.f);
    server.fault.set(Fault::LoseSubmitAnswer);
    let client = w.client(&server, false);
    let lost = client
        .execute("pay-1", &payee(&w), 2 * TOKEN, Duration::ZERO)
        .err()
        .unwrap();
    assert_eq!(lost.code, 5, "unknown, not failed: {}", lost.message);
    // The signature was retained before the call whose answer was lost.
    assert!(w.record()["agentSignature"].is_string());
    assert_eq!(w.f.balance(&w.f.payee), 2 * TOKEN);
    server.fault.set(Fault::None);
    let read = client.status("pay-1", Duration::ZERO).unwrap();
    assert_eq!(read.status, Status::Confirmed);
    let again = client
        .execute("pay-1", &payee(&w), 2 * TOKEN, Duration::ZERO)
        .unwrap();
    assert_eq!(again.status, Status::Confirmed);
    assert_eq!(
        *server.calls.borrow(),
        ["prepare", "submit", "status", "status"],
        "one signature, then reads"
    );
    assert_eq!(w.f.balance(&w.f.payee), 2 * TOKEN);
    assert!(
        client.status("pay-9", Duration::ZERO).is_err(),
        "an id without a retained payment"
    );
}

#[test]
fn a_servers_word_is_not_a_receipt() {
    let w = world();
    let server = Server::new(&w.f);
    server.fault.set(Fault::ClaimConfirmed);
    // Without its own RPC the agent reports the payment as unknown, not as confirmed.
    let blind = w.client(&server, false);
    let outcome = blind
        .execute("pay-1", &payee(&w), 2 * TOKEN, Duration::ZERO)
        .unwrap();
    assert_eq!(outcome.status, Status::SubmissionUnknown);
    assert!(outcome.document.get("settlement").is_none());
    assert_eq!(w.f.balance(&w.f.payee), 0);
    // With its own RPC it reads the ledger: still open while the blockhash lives, then lapsed.
    let sighted = w.client(&server, true);
    let open = sighted.status("pay-1", Duration::ZERO).unwrap();
    assert_eq!(open.status, Status::SubmissionUnknown);
    w.f.chain.0.lock().unwrap().height = 1_151;
    let lapsed = sighted.status("pay-1", Duration::ZERO).unwrap();
    assert_eq!(lapsed.status, Status::Prepared);
    assert_eq!(lapsed.document["lapsed"], true);
    assert_eq!(w.f.balance(&w.f.payee), 0);
}

#[test]
fn another_key_or_another_backend_does_not_continue_a_request() {
    let w = world();
    let server = Server::new(&w.f);
    let client = w.client(&server, false);
    client
        .execute("pay-1", &payee(&w), TOKEN, Duration::ZERO)
        .unwrap();
    // The owner's key is not the profile's agent.
    let other = Client {
        agent: &w.f.owner,
        ..w.client(&server, false)
    };
    assert!(
        other
            .execute("pay-2", &payee(&w), TOKEN, Duration::ZERO)
            .is_err()
    );
    // The same journal under another origin refuses the retained id.
    struct Elsewhere<'a>(&'a Server<'a>);
    impl Backend for Elsewhere<'_> {
        fn origin(&self) -> &str {
            "https://other.example"
        }
        fn post(&self, path: &str, body: &Value) -> Result<Sent> {
            self.0.post(path, body)
        }
    }
    let moved = Elsewhere(&server);
    let elsewhere = Client {
        backend: &moved,
        ..w.client(&server, false)
    };
    let calls = server.calls.borrow().len();
    assert!(
        elsewhere
            .execute("pay-1", &payee(&w), TOKEN, Duration::ZERO)
            .is_err()
    );
    assert_eq!(server.calls.borrow().len(), calls, "nothing was asked");
}
