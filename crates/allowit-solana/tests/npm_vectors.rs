//! The vectors that the browser package `npm/solana` is tested against: the addresses of a
//! wallet, the exact bytes of its owner transactions, its installation document and the text of
//! a policy approval, as this crate makes them. The file is committed; this test fails when the
//! crate no longer makes it, and writes it anew with `ALLOWIT_WRITE_VECTORS=1`.
use allowit_core::vendor::{KeyProvider, runtime::Signer};
use allowit_solana::{
    DEVNET, KEYS, KeySigner, USDC_DEVNET,
    native::{Address, Found, OwnerStep, Wallet},
    owner_client::{self, Template},
    packets::message_hash,
    runtime::{consent_message, consent_payload},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use solana_hash::Hash;

fn key(seed: u8) -> KeySigner {
    KeySigner(KEYS.derive(&[seed; 32]).unwrap())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn vectors() -> Value {
    let (owner, agent, server) = (key(1), key(2), key(3));
    let address = |signer: &KeySigner| -> Address { signer.identity().parse().unwrap() };
    let wallet = Wallet {
        owner: address(&owner),
        mint: USDC_DEVNET.parse().unwrap(),
        agent: address(&agent),
        server: address(&server),
    };
    let blockhash = Hash::new_from_array([7; 32]);
    let tag = "allowit:wallet-0123456789abcdef-1800000000";
    let message = |bytes: &[u8]| json!({"message": STANDARD.encode(bytes), "hash": hex(&message_hash(bytes))});
    let found = |found: Found| match found {
        Found::Nothing { deposit } => json!({"nothing": deposit}),
        Found::Funded { shortfall } => json!({"funded": shortfall}),
        Found::Ready => json!("ready"),
    };
    let setups: Vec<Value> = [
        (
            Found::Nothing { deposit: 1_488_440 },
            Found::Nothing { deposit: 2_810_840 },
        ),
        (Found::Nothing { deposit: 2_039_280 }, Found::Ready),
        (
            Found::Funded { shortfall: 1_000 },
            Found::Funded { shortfall: 0 },
        ),
        (Found::Ready, Found::Nothing { deposit: 3_361_680 }),
        (Found::Ready, Found::Ready),
    ]
    .into_iter()
    .map(|(token, delegate)| {
        let prepared = wallet
            .setup_tagged(5_000_000, 6, token, delegate, tag, blockhash)
            .unwrap();
        let mut vector = message(prepared.message_bytes());
        vector["token"] = found(token);
        vector["delegate"] = found(delegate);
        vector
    })
    .collect();
    // The signed setup of the first case, as the owner's wallet returns it.
    let first = wallet
        .setup_tagged(
            5_000_000,
            6,
            Found::Nothing { deposit: 1_488_440 },
            Found::Nothing { deposit: 2_810_840 },
            tag,
            blockhash,
        )
        .unwrap();
    let signed = first.wire(&[first.sign(&owner).unwrap()]).unwrap();
    let refill = wallet
        .owner_steps_tagged(
            &[OwnerStep::Approve {
                allowance: 7_000_000,
                decimals: 6,
            }],
            "allowit:owner:fund",
            blockhash,
        )
        .unwrap();
    let template = Template {
        mint: USDC_DEVNET.into(),
        symbol: "USDC".into(),
        decimals: 6,
        max_fee_lamports: 20_000,
    };
    let config = owner_client::installation(DEVNET, &wallet, &template).unwrap();
    let params = json!({"payment_limit": {"Int": "1000000"}});
    let payload = consent_payload(
        &config,
        "policy-1",
        3,
        &"ab".repeat(32),
        "allowit-portable-v1",
        &["payment_limit".to_owned()],
        &params,
        &"cd".repeat(32),
    );
    let consent = consent_message(&payload).unwrap();
    json!({
        "network": DEVNET,
        "owner": owner.identity(),
        "agent": agent.identity(),
        "server": server.identity(),
        "mint": USDC_DEVNET,
        "tokenSeed": wallet.token_seed(),
        "delegateSeed": wallet.delegate_seed(),
        "tokenAccount": wallet.token_account().to_string(),
        "delegate": wallet.delegate().to_string(),
        "blockhash": blockhash.to_string(),
        "tag": tag,
        "allowance": "5000000",
        "setups": setups,
        "signedSetup": STANDARD.encode(&signed),
        "signedSetupSignature": bs58::encode(&signed[1..65]).into_string(),
        "refill": message(refill.message_bytes()),
        "configuration": config,
        "consent": {
            "message": consent,
            "signature": STANDARD.encode(owner.sign_bytes(consent.as_bytes()).unwrap()),
        },
    })
}

#[test]
fn the_browser_package_is_tested_against_what_this_crate_makes() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../npm/solana/tests/vectors.json"
    );
    let made = serde_json::to_string_pretty(&vectors()).unwrap() + "\n";
    if std::env::var_os("ALLOWIT_WRITE_VECTORS").is_some() {
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, &made).unwrap();
    }
    let committed = std::fs::read_to_string(path)
        .expect("npm/solana/tests/vectors.json; write it with ALLOWIT_WRITE_VECTORS=1")
        .replace("\r\n", "\n");
    assert_eq!(
        committed, made,
        "npm/solana/tests/vectors.json differs from what the crate makes"
    );
}
