//! A Native wallet's whole life on Solana Devnet, with real transactions. Ignored by default: it
//! needs a Devnet RPC endpoint and an owner key that holds Devnet SOL.
//!
//! ```sh
//! ALLOWIT_LIVE_RPC=https://api.devnet.solana.com \
//! ALLOWIT_LIVE_OWNER_SEED=<file with the owner's 32-byte seed as 64 hex characters> \
//!   cargo test -p allowit-solana --test live_devnet -- --ignored --nocapture
//! ```
//!
//! The agent's and the server's keys derive from the owner's seed. The run sets the wallet up,
//! refills it, stops it and closes it, each with the owner's key alone. When the owner's associated
//! USDC account holds at least 0.2 USDC, the run also funds the wallet from it, gives the server
//! SOL for the fee, and makes one payment through the rail's runtime, signed by the agent and the
//! server, back to the owner's associated account. Every transaction is printed with its link.
use allowit_core::vendor::plugin::RailPlugin as _;
use allowit_core::vendor::{
    KeyProvider as _, RuntimeProvider as _,
    config::ServerAuthority,
    runtime::{Accounting, Action, Signer as _, Status, Terms, Validity},
};
use allowit_solana::{
    DEVNET, KEYS, KeySigner, PLUGIN, USDC_DEVNET,
    config::source_hash,
    native::{Address, OwnerStep, TOKEN_PROGRAM, Wallet},
    owner::{self, Journal, Ledger as _, Outcome, Request, Retained},
    owner_client::{Template, installation},
    rpc::Rpc,
    runtime::{Bundle, Consent, Runtime, consent_message, consent_payload},
};
use sha2::{Digest, Sha256};
use solana_address::address;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SYSTEM_PROGRAM: Address = address!("11111111111111111111111111111111");
const ASSOCIATED_TOKEN_PROGRAM: Address = address!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC: u64 = 1_000_000;

#[derive(Default)]
struct Book(Mutex<BTreeMap<String, Retained>>);
impl Journal for Book {
    fn load(&self, id: &str) -> allowit_core::vendor::error::Result<Option<Retained>> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    fn save(&self, id: &str, retained: &Retained) -> allowit_core::vendor::error::Result<()> {
        self.0.lock().unwrap().insert(id.into(), retained.clone());
        Ok(())
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn tx_link(signature: &[u8; 64]) -> String {
    format!(
        "https://explorer.solana.com/tx/{}?cluster=devnet",
        bs58::encode(signature).into_string()
    )
}

/// Send the owner's `request` under `id` and ask again until the finalized bank holds it.
fn settle(
    ledger: &Rpc,
    book: &Book,
    owner: &KeySigner,
    wallet: &Wallet,
    id: &str,
    request: &Request,
) {
    for _ in 0..60 {
        match owner::send(ledger, book, owner, wallet, id, request).unwrap() {
            Outcome::Settled { signature } => {
                println!("{id}: settled {}", tx_link(&signature));
                return;
            }
            Outcome::Failed { signature } => {
                panic!("{id} failed on the ledger: {}", tx_link(&signature))
            }
            Outcome::Pending { .. } | Outcome::Unconfirmed { .. } => {
                std::thread::sleep(Duration::from_secs(2))
            }
        }
    }
    panic!("{id} was not finalized within two minutes");
}

/// A transaction of the test itself, signed by the owner alone, until the finalized bank holds it.
fn owner_transaction(ledger: &Rpc, owner: &KeySigner, instructions: &[Instruction], what: &str) {
    let payer: Address = owner.identity().parse().unwrap();
    let recent = ledger.recent().unwrap();
    let message = Message::new_with_blockhash(instructions, Some(&payer), &recent.blockhash);
    let bytes = message.serialize();
    let signature: [u8; 64] = owner.sign_bytes(&bytes).unwrap().try_into().unwrap();
    let mut wire = vec![1u8];
    wire.extend_from_slice(&signature);
    wire.extend_from_slice(&bytes);
    ledger.submit(&wire).unwrap();
    for _ in 0..60 {
        match ledger.observe(&signature).unwrap().status {
            owner::Status::Finalized { failed: false } => {
                println!("{what}: settled {}", tx_link(&signature));
                return;
            }
            owner::Status::Finalized { failed: true } => {
                panic!("{what} failed: {}", tx_link(&signature))
            }
            _ => std::thread::sleep(Duration::from_secs(2)),
        }
    }
    panic!("{what} was not finalized within two minutes");
}

/// The token amount of a token account, or 0 when there is none.
fn tokens(ledger: &Rpc, at: &Address) -> u64 {
    ledger
        .account(at)
        .unwrap()
        .filter(|a| a.owner == TOKEN_PROGRAM && a.data.len() == 165)
        .map_or(0, |a| {
            u64::from_le_bytes(a.data[64..72].try_into().unwrap())
        })
}

#[test]
#[ignore = "live: needs ALLOWIT_LIVE_RPC and ALLOWIT_LIVE_OWNER_SEED with Devnet SOL"]
fn a_native_wallet_lives_its_whole_life_on_devnet() {
    let endpoint = std::env::var("ALLOWIT_LIVE_RPC").expect("ALLOWIT_LIVE_RPC");
    let seed_file = std::env::var("ALLOWIT_LIVE_OWNER_SEED").expect("ALLOWIT_LIVE_OWNER_SEED");
    let text = std::fs::read_to_string(seed_file).unwrap();
    let seed: [u8; 32] = (0..32)
        .map(|i| u8::from_str_radix(&text.trim()[2 * i..2 * i + 2], 16).unwrap())
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    let derive =
        |role: &str| -> [u8; 32] { Sha256::digest([&seed[..], role.as_bytes()].concat()).into() };
    let owner = KeySigner(KEYS.derive(&seed).unwrap());
    let agent = KeySigner(KEYS.derive(&derive("agent")).unwrap());
    let server = KeySigner(KEYS.derive(&derive("server")).unwrap());
    let key = |s: &KeySigner| -> Address { s.identity().parse().unwrap() };
    let mint: Address = USDC_DEVNET.parse().unwrap();
    let wallet = Wallet {
        owner: key(&owner),
        mint,
        agent: key(&agent),
        server: key(&server),
    };
    let (owner_ata, _) = Address::find_program_address(
        &[key(&owner).as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM,
    );
    println!("owner  {}", owner.identity());
    println!("agent  {}", agent.identity());
    println!("server {}", server.identity());
    println!("wallet {}", wallet.token_account());
    let transport = PLUGIN.connect(DEVNET, &endpoint).unwrap();
    let ledger = Rpc(transport.clone());
    let lamports = ledger
        .account(&key(&owner))
        .unwrap()
        .map_or(0, |a| a.lamports);
    assert!(
        lamports >= 20_000_000,
        "fund the owner {} with at least 0.02 Devnet SOL: https://faucet.solana.com (it holds {lamports} lamports)",
        owner.identity()
    );
    let book = Book::default();
    let run = now();
    let id = |step: &str| format!("live-{run}-{step}");

    // The owner's setup: the token account, the delegate and an allowance of 1 USDC.
    settle(
        &ledger,
        &book,
        &owner,
        &wallet,
        &id("setup"),
        &Request::Setup {
            allowance: USDC,
            decimals: 6,
        },
    );
    assert_eq!(owner::remaining(&ledger, &wallet).unwrap(), USDC);
    // The same request id again signs nothing and reads the same transaction.
    let again = owner::send(
        &ledger,
        &book,
        &owner,
        &wallet,
        &id("setup"),
        &Request::Setup {
            allowance: USDC,
            decimals: 6,
        },
    )
    .unwrap();
    assert!(matches!(again, Outcome::Settled { .. }));
    // A refill adds to what is left.
    settle(
        &ledger,
        &book,
        &owner,
        &wallet,
        &id("refill"),
        &Request::Refill {
            units: USDC / 2,
            decimals: 6,
        },
    );
    assert_eq!(owner::remaining(&ledger, &wallet).unwrap(), USDC + USDC / 2);

    // A payment, when the owner holds USDC to fund the wallet with.
    let held = tokens(&ledger, &owner_ata);
    if held >= USDC / 5 {
        let amount = USDC / 10;
        // The owner funds the wallet and gives the server the SOL of its fee.
        let mut transfer = 2u32.to_le_bytes().to_vec();
        transfer.extend_from_slice(&5_000_000u64.to_le_bytes());
        let mut checked = vec![12u8];
        checked.extend_from_slice(&amount.to_le_bytes());
        checked.push(6);
        owner_transaction(
            &ledger,
            &owner,
            &[
                Instruction::new_with_bytes(
                    SYSTEM_PROGRAM,
                    &transfer,
                    vec![
                        AccountMeta::new(key(&owner), true),
                        AccountMeta::new(key(&server), false),
                    ],
                ),
                Instruction::new_with_bytes(
                    TOKEN_PROGRAM,
                    &checked,
                    vec![
                        AccountMeta::new(owner_ata, false),
                        AccountMeta::new_readonly(mint, false),
                        AccountMeta::new(wallet.token_account(), false),
                        AccountMeta::new_readonly(key(&owner), true),
                    ],
                ),
            ],
            "fund the wallet and the server's fee",
        );
        // The installation, with the owner's consent, as the server imports it.
        let mut config = installation(
            DEVNET,
            &wallet,
            &Template {
                mint: USDC_DEVNET.into(),
                symbol: "USDC".into(),
                decimals: 6,
                max_fee_lamports: 20_000,
            },
        )
        .unwrap();
        let source = "pub fn execute(ctx: &AllowitContext) -> allowit::Result { Ok(()) }";
        config.policy_source = source.into();
        config.source_hash = source_hash(source);
        let payload = consent_payload(
            &config,
            "live-policy",
            1,
            "",
            "portable",
            &[],
            &serde_json::json!({}),
            "",
        );
        let signature = owner
            .sign_bytes(consent_message(&payload).unwrap().as_bytes())
            .unwrap();
        let bundle = serde_json::to_vec(&Bundle {
            version: 1,
            policy_id: "live-policy".into(),
            config,
            consent: Consent {
                payload,
                signature: bs58::encode(signature).into_string(),
            },
        })
        .unwrap();
        let runtime = Runtime::new(DEVNET, Arc::new(Rpc(transport.clone()))).unwrap();
        let authority =
            ServerAuthority::validated(DEVNET, "https://allowit.example", server.identity())
                .unwrap();
        let installed = runtime.import(&authority, &bundle).unwrap();
        let accounting = Accounting::default();
        let request = runtime
            .request(
                &installed,
                Sha256::digest(id("pay")).into(),
                Action::Transfer {
                    recipient: owner_ata.to_string(),
                    units: i128::from(amount),
                },
                Some(&accounting),
            )
            .unwrap();
        let t = now();
        let prepared = runtime
            .prepare(
                &installed,
                &request,
                &Terms::default(),
                Some(&accounting),
                Validity {
                    now: t,
                    expires_at: t + 60,
                },
            )
            .unwrap();
        runtime
            .authorize_preparation(&installed, &prepared, &server, None, t)
            .unwrap();
        runtime.revalidate(&installed, &prepared, t).unwrap();
        let signatures = [
            runtime.sign(&installed, &prepared, &agent, t).unwrap(),
            runtime.sign(&installed, &prepared, &server, t).unwrap(),
        ];
        let signed = runtime
            .authorize(&installed, &prepared, &signatures, t)
            .unwrap();
        runtime.broadcast(&signed, t).unwrap();
        let mut settled = false;
        for _ in 0..60 {
            if runtime.status(&signed).unwrap() == Status::Confirmed {
                settled = true;
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        assert!(settled, "the payment was not finalized within two minutes");
        let receipt = runtime.observe(&signed).unwrap().expect("a receipt");
        let info = receipt.0.provider().receipt_info(&receipt.0).unwrap();
        println!(
            "payment: settled, fee {} lamports, debit {} units",
            info.fee.native_units, info.debits[0].units
        );
        assert_eq!(info.debits[0].units, i128::from(amount));
        assert_eq!(
            owner::remaining(&ledger, &wallet).unwrap(),
            USDC + USDC / 2 - amount
        );
    } else {
        println!(
            "payment skipped: the owner's USDC account {owner_ata} holds {held} units; get Devnet USDC at https://faucet.circle.com for the owner {}",
            owner.identity()
        );
    }

    // The owner stops the wallet: no payment can follow.
    settle(
        &ledger,
        &book,
        &owner,
        &wallet,
        &id("stop"),
        &Request::Steps(vec![OwnerStep::Stop]),
    );
    assert_eq!(owner::remaining(&ledger, &wallet).unwrap(), 0);
    // The owner takes the balance back and closes the token account; its deposit returns.
    let balance = tokens(&ledger, &wallet.token_account());
    let mut steps = Vec::new();
    if balance > 0 {
        steps.push(OwnerStep::Recover {
            to: owner_ata,
            amount: balance,
            decimals: 6,
        });
    }
    steps.push(OwnerStep::Close);
    settle(
        &ledger,
        &book,
        &owner,
        &wallet,
        &id("close"),
        &Request::Steps(steps),
    );
    assert_eq!(ledger.account(&wallet.token_account()).unwrap(), None);
}
