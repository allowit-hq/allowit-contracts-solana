//! Live checks against a running Allowit server that serves Solana Devnet. Ignored by default:
//! they need a server, named by `ALLOWIT_LIVE_SERVER` (an origin such as `http://127.0.0.1:8097`)
//! and, for the app origin that the server allows, `ALLOWIT_LIVE_APP_ORIGIN`.
//!
//! ```sh
//! ALLOWIT_LIVE_SERVER=http://127.0.0.1:8097 cargo test -p allowit-solana --test live_server -- --ignored
//! ```
use allowit_core::{
    transport::{
        http::{HttpClient, Method, Request},
        rpc::Options,
    },
    vendor::{KeyProvider, runtime::Signer},
};
use allowit_solana::{DEVNET, KEYS, KeySigner};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::time::Duration;

struct Server {
    http: HttpClient,
    origin: String,
    app: String,
    cookie: Option<String>,
}

impl Server {
    fn from_env() -> Option<Self> {
        let origin = std::env::var("ALLOWIT_LIVE_SERVER").ok()?;
        Some(Self {
            http: HttpClient::new(Options {
                timeout: Duration::from_secs(30),
                max_response_bytes: 1_048_576,
                no_proxy: true,
                connect_timeout: None,
            })
            .unwrap(),
            origin: origin.trim_end_matches('/').to_owned(),
            app: std::env::var("ALLOWIT_LIVE_APP_ORIGIN")
                .unwrap_or_else(|_| "http://127.0.0.1:5173".into()),
            cookie: None,
        })
    }
    fn call(&mut self, method: Method, path: &str, body: Option<&Value>) -> (u16, Value) {
        let mut headers = vec![
            ("Origin".to_owned(), self.app.clone()),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ];
        if let Some(cookie) = &self.cookie {
            headers.push(("Cookie".to_owned(), cookie.clone()));
        }
        let bytes = body.map(|body| serde_json::to_vec(body).unwrap());
        let response = self
            .http
            .send(
                Request {
                    method,
                    url: &format!("{}{path}", self.origin),
                    headers: &headers,
                    body: bytes.as_deref(),
                },
                None,
            )
            .unwrap();
        if let Some(set) = response.header("set-cookie") {
            self.cookie = set.split(';').next().map(str::to_owned);
        }
        (
            response.status,
            serde_json::from_slice(&response.body).unwrap_or(Value::Null),
        )
    }
}

#[test]
#[ignore = "live: needs ALLOWIT_LIVE_SERVER"]
fn the_server_offers_the_native_wallet_on_devnet_and_signs_an_owner_in() {
    let Some(mut server) = Server::from_env() else {
        panic!("set ALLOWIT_LIVE_SERVER to the origin of a running server");
    };
    let (status, kinds) = server.call(
        Method::Get,
        &format!("/api/wallet-kinds?network={DEVNET}"),
        None,
    );
    assert_eq!(status, 200, "{kinds}");
    assert_eq!(kinds["network"], DEVNET);
    assert_eq!(kinds["kinds"][0]["id"], "native");
    assert_eq!(kinds["kinds"].as_array().unwrap().len(), 1);

    // The owner signs the server's message as a Solana wallet signs a text message.
    let owner = KeySigner(KEYS.derive(&[41; 32]).unwrap());
    let address = owner.identity().to_owned();
    let (status, challenge) = server.call(
        Method::Post,
        "/api/auth/challenge",
        Some(&json!({"address": address})),
    );
    assert_eq!(status, 200, "{challenge}");
    let message = challenge["message"].as_str().unwrap();
    assert!(message.contains(&address));
    let sign_in = |signature: &[u8]| {
        json!({"id": challenge["id"], "address": address, "message": message,
            "signature": STANDARD.encode(signature)})
    };
    // Another key's signature is refused, and the challenge is still open afterwards.
    let other = KeySigner(KEYS.derive(&[42; 32]).unwrap());
    let forged = other.sign_bytes(message.as_bytes()).unwrap();
    let (status, refused) = server.call(Method::Post, "/api/auth/verify", Some(&sign_in(&forged)));
    assert_eq!(status, 401, "{refused}");
    let signature = owner.sign_bytes(message.as_bytes()).unwrap();
    let (status, session) =
        server.call(Method::Post, "/api/auth/verify", Some(&sign_in(&signature)));
    assert_eq!(status, 200, "{session}");
    assert_eq!(session["session"]["address"], address);
    // A used challenge signs nobody in again.
    let (status, _) = server.call(Method::Post, "/api/auth/verify", Some(&sign_in(&signature)));
    assert_eq!(status, 401);

    // Signed in, the owner reads the server's wallet template and its identity on Devnet.
    let (status, templates) = server.call(
        Method::Post,
        &format!("/api/native/templates?network={DEVNET}"),
        Some(&json!({})),
    );
    assert_eq!(status, 200, "{templates}");
    let identity = templates["server"].as_str().expect("the server's identity");
    println!("templates: {templates}");
    // The server registers a wallet from the ledger. This owner never set one up, so the
    // registration reads Devnet through the rail and refuses: nothing is stored.
    use allowit_solana::config::{Route, WalletConfig, source_hash};
    let agent = KeySigner(KEYS.derive(&[43; 32]).unwrap());
    let source = "pub fn execute(ctx: &AllowitContext) -> allowit::Result { Ok(()) }";
    let mut config = WalletConfig {
        network: DEVNET.into(),
        policy_instance: [9; 32],
        wallet: String::new(),
        owner: address.clone(),
        agent: agent.identity().into(),
        server: identity.into(),
        route: Route::Native,
        mint: allowit_solana::USDC_DEVNET.into(),
        asset_symbol: "USDC".into(),
        decimals: 6,
        policy_source: source.into(),
        source_hash: source_hash(source),
        module_digest: [0; 32],
        params: Default::default(),
        max_fee_lamports: 20_000,
    };
    config.wallet = config.roles().unwrap().token_account().to_string();
    let (status, refused) = server.call(
        Method::Post,
        &format!("/api/native/register?network={DEVNET}"),
        Some(&json!({"configuration": config})),
    );
    println!("register: HTTP {status} {refused}");
    assert!((400..500).contains(&status), "{refused}");
    assert!(
        refused["error"].as_str().unwrap().contains("closed"),
        "the rail's own refusal: {refused}"
    );
    // A document whose wallet is not the account of its roles never reaches the ledger.
    let mut forged = serde_json::to_value(&config).unwrap();
    forged["wallet"] = json!(agent.identity());
    let (status, refused) = server.call(
        Method::Post,
        &format!("/api/native/register?network={DEVNET}"),
        Some(&json!({"configuration": forged})),
    );
    println!("register forged: HTTP {status} {refused}");
    assert!((400..500).contains(&status), "{refused}");
}

/// The owner's client against the running server: it signs the owner in and reads the asset
/// of a new wallet, and believes the template only from the configured server key.
#[test]
#[ignore = "live: needs ALLOWIT_LIVE_SERVER"]
fn the_owners_client_signs_in_and_reads_the_wallet_asset() {
    use allowit_core::vendor::{
        config::ServerAuthority, error::Error, owner::Context, plugin::RailPlugin as _,
    };
    use allowit_solana::PLUGIN;
    let Some(mut server) = Server::from_env() else {
        panic!("set ALLOWIT_LIVE_SERVER to the origin of a running server");
    };
    // The server's identity, read once as an operator would configure it.
    let probe = KeySigner(KEYS.derive(&[44; 32]).unwrap());
    let address = probe.identity().to_owned();
    let (_, challenge) = server.call(
        Method::Post,
        "/api/auth/challenge",
        Some(&json!({"address": address})),
    );
    let message = challenge["message"].as_str().unwrap();
    let signature = probe.sign_bytes(message.as_bytes()).unwrap();
    server.call(
        Method::Post,
        "/api/auth/verify",
        Some(
            &json!({"id": challenge["id"], "address": address, "message": message,
            "signature": STANDARD.encode(signature)}),
        ),
    );
    let (_, templates) = server.call(
        Method::Post,
        &format!("/api/native/templates?network={DEVNET}"),
        Some(&json!({})),
    );
    let identity = templates["server"].as_str().expect("the server's identity");
    // The installation that a setup registers has no policy yet. The server reads it and asks
    // the ledger: the wallet of this owner was never set up, so the rail refuses there.
    {
        use allowit_solana::{native::Wallet, owner_client};
        let found = owner_client::read_template(&templates, DEVNET, identity).unwrap();
        let wallet = Wallet {
            owner: address.parse().unwrap(),
            mint: found.mint.parse().unwrap(),
            agent: KeySigner(KEYS.derive(&[47; 32]).unwrap())
                .identity()
                .parse()
                .unwrap(),
            server: identity.parse().unwrap(),
        };
        let config = owner_client::installation(DEVNET, &wallet, &found).unwrap();
        let (status, refused) = server.call(
            Method::Post,
            &format!("/api/native/register?network={DEVNET}"),
            Some(&json!({"configuration": config})),
        );
        println!("register a setup's installation: HTTP {status} {refused}");
        assert!(
            refused["error"].as_str().unwrap().contains("closed"),
            "the rail's own refusal: {refused}"
        );
    }

    struct Owner(KeySigner);
    impl allowit_core::vendor::wallet::Signer for Owner {
        fn network(&self) -> &str {
            DEVNET
        }
        fn address(&self) -> &str {
            self.0.identity()
        }
        fn sign_hash(&self, bytes: &[u8]) -> allowit_core::vendor::error::Result<Vec<u8>> {
            self.0.sign_bytes(bytes)
        }
    }
    let owner = Owner(KeySigner(KEYS.derive(&[45; 32]).unwrap()));
    let store = || Err(Error::config("the live check opens no journal"));
    let clock = || {
        Ok(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs())
    };
    let asset = |server_key: &str| {
        let authority = ServerAuthority::validated(DEVNET, &server.origin, server_key).unwrap();
        PLUGIN.owner().native_wallet_asset(&Context {
            network: DEVNET,
            backend: &server.origin,
            authority: &authority,
            origin: &server.app,
            rpc_url: "",
            store: &store,
            signer: &owner,
            clock: &clock,
        })
    };
    let found = asset(identity).unwrap();
    assert_eq!(found.symbol, "USDC");
    assert_eq!(found.issuer.as_deref(), Some(allowit_solana::USDC_DEVNET));
    // Configured with another server key, the client refuses the server's template.
    let other = KeySigner(KEYS.derive(&[46; 32]).unwrap());
    assert!(asset(other.identity()).is_err());
}

/// The rail's ledger reads against a real Solana Devnet RPC, named by `ALLOWIT_LIVE_RPC` (such
/// as `https://api.devnet.solana.com`). Nothing is sent: every call is a read.
#[test]
#[ignore = "live: needs ALLOWIT_LIVE_RPC"]
fn the_ledger_reads_parse_what_a_real_devnet_node_answers() {
    use allowit_core::vendor::plugin::RailPlugin as _;
    use allowit_solana::{
        PLUGIN, USDC_DEVNET,
        native::{Address, TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM},
        owner::{Ledger as _, Status},
        payment::Receipts as _,
        rpc::Rpc,
        runtime::Chain as _,
    };
    let endpoint = std::env::var("ALLOWIT_LIVE_RPC")
        .expect("set ALLOWIT_LIVE_RPC to a Solana Devnet RPC endpoint");
    let ledger = Rpc(PLUGIN.connect(DEVNET, &endpoint).unwrap());

    let bank = ledger.bank().unwrap();
    assert!(bank.height > 0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let time = bank
        .time
        .expect("Devnet states the time of a finalized block");
    assert!(time.abs_diff(now) < 600, "block time {time} against {now}");

    let recent = ledger.recent().unwrap();
    assert!(recent.last_valid_height > bank.height);
    // The blockhash is read a moment after the bank, so its window starts a few blocks later:
    // one batch to one node gives exactly 150.
    assert!((150..=200).contains(&(recent.last_valid_height - bank.height)));

    // Circle's Devnet USDC mint: a token-program account of 82 bytes with 6 decimals.
    let mint: Address = USDC_DEVNET.parse().unwrap();
    let account = ledger.account(&mint).unwrap().expect("the mint exists");
    assert_eq!(account.owner, TOKEN_PROGRAM);
    assert_eq!(account.data.len(), 82);
    assert_eq!(account.data[44], 6);
    assert_eq!(
        ledger.account(&Address::new_from_array([251; 32])).unwrap(),
        None
    );
    // The deposits are the ledger's to say: Devnet's differ from the long-standing 2,039,280
    // lamports of a token account, so the rail reads them and assumes none.
    let (token_deposit, delegate_deposit) = (
        ledger.deposit(TOKEN_ACCOUNT_LEN).unwrap(),
        ledger.deposit(355).unwrap(),
    );
    assert!(token_deposit > 0 && delegate_deposit > token_deposit);
    println!("deposits: token account {token_deposit}, delegate {delegate_deposit}");

    // A signature that no transaction has: no status, at the finalized bank or past it.
    let seen = ledger.observe(&[7; 64]).unwrap();
    assert_eq!(seen.status, Status::Unknown);
    assert!(seen.finalized_height >= bank.height);
    assert_eq!(ledger.transaction(&[7; 64]).unwrap(), None);

    // The mint's recent finalized history, and one of its transactions read back whole.
    let history = ledger.history(&mint, now - 120).unwrap();
    if let Some(signature) = history.first() {
        let finalized = ledger
            .transaction(signature)
            .unwrap()
            .expect("a listed transaction");
        assert_eq!(finalized.wire[1..65], signature[..]);
        assert!(finalized.fee >= 5_000);
        assert!(finalized.slot > 0);
        assert!(matches!(
            ledger.observe(signature).unwrap().status,
            Status::Finalized { .. }
        ));
    }
    println!(
        "height {} time {time} last valid {} history {}",
        bank.height,
        recent.last_valid_height,
        history.len()
    );
}
