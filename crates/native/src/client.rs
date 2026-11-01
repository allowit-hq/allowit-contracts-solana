use crate::{
    crypto::Key,
    error::{Error, Result},
    policy::{Policy, digest, genesis},
    release,
    rpc::{self, Rpc},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
pub const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const LOADER: &str = "BPFLoaderUpgradeab1e11111111111111111111111";
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub network: String,
    pub source_bundle: String,
    pub policy: Key,
    pub policy_data: Key,
    pub custody: Key,
}
#[derive(Clone, Serialize)]
pub struct Config {
    pub network: String,
    pub mint: Option<Key>,
    pub executor: Option<Key>,
    pub authority: Option<Key>,
    pub deployment: Option<Deployment>,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub owner: Key,
    pub executor: Key,
    pub authority: Key,
    pub mint: Key,
    pub vault: Key,
    pub token_account: Key,
    pub policy: Key,
    pub policy_data: Key,
    pub custody: Key,
    pub bump: u8,
}
pub struct NativeClient {
    pub config: Config,
    pub rpc: Arc<dyn Rpc>,
    verified: std::sync::Mutex<Option<(String, bool)>>,
}
impl NativeClient {
    pub fn new(config: Config, rpc: Arc<dyn Rpc>) -> Result<Self> {
        genesis(&config.network)?;
        Ok(Self {
            config,
            rpc,
            verified: std::sync::Mutex::new(None),
        })
    }
    pub fn check_network(&self) -> Result<()> {
        let observed = self.rpc.call("getGenesisHash", json!([]))?;
        if observed != genesis(&self.config.network)? {
            return Err(Error::config(
                "RPC genesis does not match the policy network",
            ));
        }
        Ok(())
    }
    pub fn public_binding(&self, policy: &Policy, owner: Key) -> Result<Binding> {
        let d = self
            .config
            .deployment
            .as_ref()
            .ok_or_else(|| Error::config("Deployment/network mismatch"))?;
        if policy.network != self.config.network
            || d.network != self.config.network
            || d.source_bundle != release().source_bundle
        {
            return Err(Error::config("Deployment/network mismatch"));
        }
        let loader = Key::parse(LOADER)?;
        if d.policy_data != Key::find_program_address(&[&d.policy.0], loader)?.0 {
            return Err(Error::config("Policy ProgramData mismatch"));
        }
        let id = hex32(&policy.id)?;
        let (vault, bump) =
            Key::find_program_address(&[b"allowit-vault-v2", &owner.0, &id], d.custody)?;
        let mint = self
            .config
            .mint
            .ok_or_else(|| Error::config("Invalid native mint"))?;
        let executor = self
            .config
            .executor
            .ok_or_else(|| Error::config("Invalid native executor"))?;
        let authority = self
            .config
            .authority
            .ok_or_else(|| Error::config("Invalid native authority"))?;
        if authority == executor
            || authority == owner
            || executor == owner
            || !owner.on_curve()
            || !executor.on_curve()
            || !authority.on_curve()
        {
            return Err(Error::config(
                "Native authority, executor, and owner must be distinct",
            ));
        }
        let token_account = associated_token_address(mint, vault, true)?;
        Ok(Binding {
            owner,
            executor,
            authority,
            mint,
            vault,
            token_account,
            policy: d.policy,
            policy_data: d.policy_data,
            custody: d.custody,
            bump,
        })
    }
    pub fn verify_release(&self, recovery: bool) -> Result<Deployment> {
        self.check_network()?;
        let identity = digest(
            serde_json::to_vec(&self.config)
                .map_err(|_| Error::config("Invalid native configuration"))?,
        );
        let d = self.config.deployment.as_ref().ok_or_else(|| {
            Error::config("Configure an independently verified native deployment")
        })?;
        if d.network != self.config.network || d.source_bundle != release().source_bundle {
            return Err(Error::config(
                "Configure an independently verified native deployment",
            ));
        }
        if self
            .verified
            .lock()
            .map_err(|_| Error::config("Native verification state unavailable"))?
            .as_ref()
            .is_some_and(|(key, full)| *key == identity && (*full || recovery))
        {
            return Ok(d.clone());
        }
        for (program, expected) in [
            (d.policy, &release().artifacts[0].sha256),
            (d.custody, &release().artifacts[1].sha256),
        ]
        .into_iter()
        .skip(usize::from(recovery))
        {
            let loader = Key::parse(LOADER)?;
            let info = rpc::account(self.rpc.as_ref(), program, None)?
                .ok_or_else(|| Error::config("Invalid deployed native program"))?;
            if !info.executable
                || info.owner != loader
                || info.data.len() != 36
                || u32::from_le_bytes(info.data[..4].try_into().unwrap()) != 2
            {
                return Err(Error::config("Invalid deployed native program"));
            }
            let linked = Key(info.data[4..36].try_into().unwrap());
            if linked != Key::find_program_address(&[&program.0], loader)?.0 {
                return Err(Error::config("Invalid ProgramData link"));
            }
            let data = rpc::account(self.rpc.as_ref(), linked, None)?.ok_or_else(|| {
                Error::config("Native deployment must have exact immutable artifact bytes")
            })?;
            if data.owner != loader
                || data.data.len() < 46
                || u32::from_le_bytes(data.data[..4].try_into().unwrap()) != 3
                || data.data[12] != 0
                || digest(&data.data[45..]) != *expected
            {
                return Err(Error::config(
                    "Native deployment must have exact immutable artifact bytes",
                ));
            }
        }
        if d.policy_data != Key::find_program_address(&[&d.policy.0], Key::parse(LOADER)?)?.0 {
            return Err(Error::config("Configured policy ProgramData mismatch"));
        }
        self.mint(
            self.config
                .mint
                .ok_or_else(|| Error::config("Invalid native mint"))?,
        )?;
        let mut verified = self
            .verified
            .lock()
            .map_err(|_| Error::config("Native verification state unavailable"))?;
        let full = !recovery
            || verified
                .as_ref()
                .is_some_and(|(key, full)| *key == identity && *full);
        *verified = Some((identity, full));
        Ok(d.clone())
    }
    pub fn binding(&self, policy: &Policy, owner: Key, recovery: bool) -> Result<Binding> {
        policy.validate()?;
        if policy.network != self.config.network {
            return Err(Error::config("Policy network mismatch"));
        }
        self.verify_release(recovery)?;
        self.public_binding(policy, owner)
    }
    pub fn mint(&self, address: Key) -> Result<()> {
        let a = rpc::account(self.rpc.as_ref(), address, None)?
            .ok_or_else(|| Error::config("Expected a classic SPL Token account"))?;
        if a.owner != Key::parse(TOKEN_PROGRAM)? || a.data.len() != 82 {
            return Err(Error::config("Expected a classic SPL Token account"));
        }
        if u32::from_le_bytes(a.data[..4].try_into().unwrap()) > 1
            || a.data[44] != 6
            || a.data[45] != 1
            || u32::from_le_bytes(a.data[46..50].try_into().unwrap()) > 1
        {
            return Err(Error::config(
                "Expected an initialized six-decimal test mint",
            ));
        }
        Ok(())
    }
    /// Resolve an ordinary wallet to its canonical classic-token ATA. Callers
    /// allowing absence must compose idempotent ATA creation before transfer.
    pub fn recipient_token_account(&self, wallet: Key, allow_missing: bool) -> Result<Key> {
        let mint = self
            .config
            .mint
            .ok_or_else(|| Error::config("Missing token mint"))?;
        let address = associated_token_address(mint, wallet, false)?;
        if let Some(account) = rpc::account(self.rpc.as_ref(), wallet, None)? {
            if account.owner != Key::parse("11111111111111111111111111111111")?
                || account.executable
                || !account.data.is_empty()
            {
                return Err(Error::config(
                    "Recipient must be an ordinary wallet address",
                ));
            }
        }
        let present = rpc::account(self.rpc.as_ref(), address, None)?.is_some();
        if !present && allow_missing {
            return Ok(address);
        }
        let token = self.token(address)?;
        if token.mint != mint || token.owner != wallet {
            return Err(Error::config("Recipient ATA mint or wallet owner changed"));
        }
        Ok(address)
    }
    pub fn token(&self, address: Key) -> Result<TokenAccount> {
        let a = rpc::account(self.rpc.as_ref(), address, None)?
            .ok_or_else(|| Error::config("Expected a classic SPL Token account"))?;
        if a.owner != Key::parse(TOKEN_PROGRAM)? || a.data.len() != 165 {
            return Err(Error::config("Expected a classic SPL Token account"));
        }
        let d = &a.data;
        if d[108] != 1 {
            return Err(Error::config(
                "Expected an initialized unfrozen token account",
            ));
        }
        for offset in [72, 109, 129] {
            if u32::from_le_bytes(d[offset..offset + 4].try_into().unwrap()) > 1 {
                return Err(Error::config("Invalid SPL option"));
            }
        }
        Ok(TokenAccount {
            mint: Key(d[..32].try_into().unwrap()),
            owner: Key(d[32..64].try_into().unwrap()),
            amount: u64::from_le_bytes(d[64..72].try_into().unwrap()),
            delegate: u32::from_le_bytes(d[72..76].try_into().unwrap()) != 0,
            close_authority: u32::from_le_bytes(d[129..133].try_into().unwrap()) != 0,
        })
    }
}
#[derive(Debug)]
pub struct TokenAccount {
    pub mint: Key,
    pub owner: Key,
    pub amount: u64,
    pub delegate: bool,
    pub close_authority: bool,
}
pub fn associated_token_address(mint: Key, owner: Key, off_curve: bool) -> Result<Key> {
    if !off_curve && !owner.on_curve() {
        return Err(Error::config("Owner must be an Ed25519 account"));
    }
    Ok(Key::find_program_address(
        &[&owner.0, &Key::parse(TOKEN_PROGRAM)?.0, &mint.0],
        Key::parse(ATA_PROGRAM)?,
    )?
    .0)
}
pub fn hex32(value: &str) -> Result<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(Error::config("Invalid digest"));
    }
    let mut bytes = [0; 32];
    for (i, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        bytes[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::LocalSigner;
    use base64::Engine;
    struct FakeRpc(serde_json::Value);
    impl Rpc for FakeRpc {
        fn call(&self, _: &str, _: serde_json::Value) -> Result<serde_json::Value> {
            Ok(self.0.clone())
        }
    }
    fn client(response: serde_json::Value) -> NativeClient {
        NativeClient::new(
            Config {
                network: "solana:testnet".into(),
                mint: None,
                executor: None,
                authority: None,
                deployment: None,
            },
            Arc::new(FakeRpc(response)),
        )
        .unwrap()
    }
    fn account(data: &[u8], owner: Key, slot: u64) -> serde_json::Value {
        json!({"context":{"slot":slot},"value":{"owner":owner.to_string(),"executable":false,"data":[base64::engine::general_purpose::STANDARD.encode(data),"base64"]}})
    }
    #[test]
    fn network_and_context_are_bound() {
        assert!(
            client(json!(genesis("solana:devnet").unwrap()))
                .check_network()
                .is_err()
        );
        assert!(
            NativeClient::new(
                Config {
                    network: "solana:mainnet".into(),
                    mint: None,
                    executor: None,
                    authority: None,
                    deployment: None
                },
                Arc::new(FakeRpc(json!(null)))
            )
            .is_err()
        );
        let response = account(&[], Key([1; 32]), 9);
        assert!(rpc::account(&FakeRpc(response.clone()), Key([2; 32]), Some(10)).is_err());
        assert!(rpc::account(&FakeRpc(response), Key([2; 32]), Some(9)).is_ok());
        assert!(rpc::account(&FakeRpc(json!({"value":null})), Key([2; 32]), None).is_err());
    }
    #[test]
    fn token_layout_and_authorities_are_checked() {
        let mut bytes = vec![0; 165];
        bytes[..32].fill(3);
        bytes[32..64].fill(4);
        bytes[64..72].copy_from_slice(&12u64.to_le_bytes());
        bytes[108] = 1;
        let program = Key::parse(TOKEN_PROGRAM).unwrap();
        let token = client(account(&bytes, program, 1))
            .token(Key([5; 32]))
            .unwrap();
        assert_eq!(token.amount, 12);
        assert_eq!(token.owner, Key([4; 32]));
        assert!(!token.delegate);
        bytes[72] = 2;
        assert!(
            client(account(&bytes, program, 1))
                .token(Key([5; 32]))
                .is_err()
        );
        bytes[72] = 0;
        bytes[108] = 2;
        assert!(
            client(account(&bytes, program, 1))
                .token(Key([5; 32]))
                .is_err()
        );
        bytes[108] = 1;
        assert!(
            client(account(&bytes, Key([9; 32]), 1))
                .token(Key([5; 32]))
                .is_err()
        );
    }
    #[test]
    fn prepare_wallet_payment_creates_only_a_missing_canonical_ata_and_keeps_limits() {
        use crate::native::Options;
        use std::collections::BTreeMap;
        struct PaymentRpc {
            accounts: BTreeMap<String, serde_json::Value>,
        }
        impl Rpc for PaymentRpc {
            fn call(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
                Ok(match method {
                    "getGenesisHash" => json!(genesis("solana:devnet").unwrap()),
                    "getAccountInfo" => self
                        .accounts
                        .get(params[0].as_str().unwrap())
                        .cloned()
                        .unwrap_or_else(|| json!({"context":{"slot":99},"value":null})),
                    "getSlot" => json!(99),
                    "getBlockTime" => json!(100),
                    "getLatestBlockhash" => {
                        json!({"value":{"blockhash":Key([88;32]),"lastValidBlockHeight":120}})
                    }
                    "simulateTransaction" => {
                        json!({"context":{"slot":99},"value":{"err":null,"unitsConsumed":1000}})
                    }
                    _ => panic!("Unexpected payment RPC {method}"),
                })
            }
        }
        let signer = |n| {
            LocalSigner::from_secret(
                &ed25519_dalek::SigningKey::from_bytes(&[n; 32]).to_keypair_bytes(),
            )
            .unwrap()
            .public_key()
        };
        let owner = signer(1);
        let executor = signer(2);
        let authority = signer(3);
        let wallet = signer(4);
        let mint = Key([11; 32]);
        let program = Key([5; 32]);
        let policy =
            Policy::generate("solana:devnet", "Spend up to 2 test tokens per day").unwrap();
        let config = Config {
            network: policy.network.clone(),
            mint: Some(mint),
            executor: Some(executor),
            authority: Some(authority),
            deployment: Some(Deployment {
                network: policy.network.clone(),
                source_bundle: release().source_bundle.clone(),
                policy: program,
                policy_data: Key::find_program_address(&[&program.0], Key::parse(LOADER).unwrap())
                    .unwrap()
                    .0,
                custody: Key([6; 32]),
            }),
        };
        let token = |token_mint: Key, token_owner: Key, balance: u64, state: u8| {
            let mut bytes = vec![0; 165];
            bytes[..32].copy_from_slice(&token_mint.0);
            bytes[32..64].copy_from_slice(&token_owner.0);
            bytes[64..72].copy_from_slice(&balance.to_le_bytes());
            bytes[108] = state;
            account(&bytes, Key::parse(TOKEN_PROGRAM).unwrap(), 99)
        };
        for mode in [
            "missing",
            "valid",
            "wrong-owner",
            "wrong-mint",
            "frozen",
            "program-wallet",
            "action-cap",
            "daily-cap",
            "balance",
        ] {
            let mut c = NativeClient::new(config.clone(), Arc::new(FakeRpc(json!(null)))).unwrap();
            let b = c.public_binding(&policy, owner).unwrap();
            let destination = associated_token_address(mint, wallet, false).unwrap();
            let mut state = vec![0; 352];
            state[0] = 2;
            state[1] = b.bump;
            for (i, key) in [b.owner, b.executor, b.mint, b.token_account, b.policy]
                .iter()
                .enumerate()
            {
                state[2 + i * 32..34 + i * 32].copy_from_slice(&key.0);
            }
            for (offset, value) in [
                (162, &policy.source_bundle),
                (194, &policy.policy_artifact),
                (226, &policy.id),
            ] {
                state[offset..offset + 32].copy_from_slice(&hex32(value).unwrap());
            }
            for (offset, value) in [
                (
                    258,
                    if mode == "daily-cap" {
                        400_000u64
                    } else {
                        2_000_000
                    },
                ),
                (290, 1),
                (331, 1_000_000),
                (339, 77),
            ] {
                state[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
            }
            state[298] = 1;
            state[299..331].copy_from_slice(&authority.0);
            let mut accounts = BTreeMap::new();
            accounts.insert(b.vault.to_string(), account(&state, b.custody, 99));
            accounts.insert(
                b.token_account.to_string(),
                token(
                    mint,
                    b.vault,
                    if mode == "balance" {
                        100_000
                    } else {
                        2_000_000
                    },
                    1,
                ),
            );
            if mode != "missing" {
                accounts.insert(
                    destination.to_string(),
                    token(
                        if mode == "wrong-mint" {
                            Key([42; 32])
                        } else {
                            mint
                        },
                        if mode == "wrong-owner" { owner } else { wallet },
                        0,
                        if mode == "frozen" { 2 } else { 1 },
                    ),
                );
            }
            if mode == "program-wallet" {
                accounts.insert(
                    wallet.to_string(),
                    account(&[], Key::parse(TOKEN_PROGRAM).unwrap(), 99),
                );
            }
            c.rpc = Arc::new(PaymentRpc { accounts });
            // Cache only immutable program verification; exercise real state, recipient, limits, composition and simulation.
            *c.verified.lock().unwrap() =
                Some((digest(serde_json::to_vec(&config).unwrap()), true));
            let mut options = Options {
                amount: Some(if mode == "action-cap" { "1.1" } else { "0.5" }.into()),
                recipient: Some(destination),
                recipient_wallet: Some(wallet),
                expires_at: Some(200),
                commitment: Some("11".repeat(32)),
                instance_slot: Some(77),
                ..Options::default()
            };
            let result = c.prepare(&policy, owner, "execute", &options);
            assert_eq!(
                result.is_ok(),
                matches!(mode, "missing" | "valid"),
                "{mode}: {:?}",
                result.as_ref().err()
            );
            if let Ok(prepared) = result {
                let ata = &prepared.transaction.instructions[2];
                assert_eq!(ata.program, Key::parse(ATA_PROGRAM).unwrap());
                assert_eq!(ata.data, vec![1]);
                assert_eq!(ata.accounts[0].key, executor);
                assert_eq!(ata.accounts[1].key, destination);
                assert_eq!(ata.accounts[2].key, wallet);
                options.recipient = Some(owner);
                assert!(
                    c.prepare(&policy, owner, "execute", &options).is_err(),
                    "wallet must commit its canonical ATA"
                );
            }
            if mode == "missing" {
                options.recipient = Some(destination);
                options.recipient_wallet = None;
                assert!(
                    c.prepare(&policy, owner, "execute", &options).is_err(),
                    "legacy token-account payments cannot invent an account"
                );
            }
        }
    }

    #[test]
    fn wallet_ata_resolution_distinguishes_absence_from_invalid_or_unavailable_accounts() {
        struct WalletRpc {
            wallet: Key,
            token: serde_json::Value,
            unavailable: bool,
        }
        impl Rpc for WalletRpc {
            fn call(&self, _: &str, params: serde_json::Value) -> Result<serde_json::Value> {
                if self.unavailable {
                    return Err(Error::uncertain("Unavailable fixture RPC"));
                }
                if params[0] == self.wallet.to_string() {
                    return Ok(json!({"context":{"slot":1},"value":null}));
                }
                Ok(self.token.clone())
            }
        }
        let wallet = LocalSigner::from_secret(
            &ed25519_dalek::SigningKey::from_bytes(&[18; 32]).to_keypair_bytes(),
        )
        .unwrap()
        .public_key();
        let mint = Key([3; 32]);
        for mode in [
            "valid",
            "missing",
            "owner",
            "mint",
            "frozen",
            "program",
            "unavailable",
        ] {
            let mut bytes = vec![0; 165];
            bytes[..32].copy_from_slice(&mint.0);
            bytes[32..64].copy_from_slice(&wallet.0);
            bytes[108] = 1;
            match mode {
                "owner" => bytes[32..64].fill(20),
                "mint" => bytes[..32].fill(20),
                "frozen" => bytes[108] = 2,
                _ => (),
            }
            let token = if mode == "missing" {
                json!({"context":{"slot":1},"value":null})
            } else {
                account(
                    &bytes,
                    if mode == "program" {
                        Key([20; 32])
                    } else {
                        Key::parse(TOKEN_PROGRAM).unwrap()
                    },
                    1,
                )
            };
            let mut c = client(json!(null));
            c.config.mint = Some(mint);
            c.rpc = Arc::new(WalletRpc {
                wallet,
                token,
                unavailable: mode == "unavailable",
            });
            assert_eq!(
                c.recipient_token_account(wallet, true).is_ok(),
                matches!(mode, "valid" | "missing"),
                "{mode}"
            );
            assert_eq!(
                c.recipient_token_account(wallet, false).is_ok(),
                mode == "valid",
                "{mode}"
            );
        }
    }

    #[test]
    fn mint_accepts_an_optional_freeze_authority() {
        let program = Key::parse(TOKEN_PROGRAM).unwrap();
        let mut bytes = vec![0; 82];
        bytes[44] = 6;
        bytes[45] = 1;
        assert!(
            client(account(&bytes, program, 1))
                .mint(Key([5; 32]))
                .is_ok()
        );
        bytes[46..50].copy_from_slice(&1u32.to_le_bytes());
        bytes[50..82].fill(7);
        assert!(
            client(account(&bytes, program, 1))
                .mint(Key([5; 32]))
                .is_ok()
        );
        bytes[46..50].copy_from_slice(&2u32.to_le_bytes());
        assert!(
            client(account(&bytes, program, 1))
                .mint(Key([5; 32]))
                .is_err()
        );
        bytes[46..50].copy_from_slice(&1u32.to_le_bytes());
        bytes[..4].copy_from_slice(&2u32.to_le_bytes());
        assert!(
            client(account(&bytes, program, 1))
                .mint(Key([5; 32]))
                .is_err()
        );
    }
    #[test]
    fn public_binding_requires_canonical_program_data() {
        let signer = |n| {
            LocalSigner::from_secret(
                &ed25519_dalek::SigningKey::from_bytes(&[n; 32]).to_keypair_bytes(),
            )
            .unwrap()
            .public_key()
        };
        let owner = signer(1);
        let p = Policy::generate("solana:testnet", "Spend up to 5 test tokens per day").unwrap();
        let policy = Key([2; 32]);
        let data = Key::find_program_address(&[&policy.0], Key::parse(LOADER).unwrap())
            .unwrap()
            .0;
        let mut c = client(json!(null));
        c.config.mint = Some(Key([3; 32]));
        c.config.executor = Some(signer(2));
        c.config.authority = Some(signer(3));
        c.config.deployment = Some(Deployment {
            network: p.network.clone(),
            source_bundle: release().source_bundle.clone(),
            policy,
            policy_data: data,
            custody: Key([5; 32]),
        });
        let binding = c.public_binding(&p, owner).unwrap();
        assert!(!binding.vault.on_curve());
        c.config.deployment.as_mut().unwrap().policy_data = Key([9; 32]);
        assert!(c.public_binding(&p, owner).is_err());
    }
    #[test]
    fn verification_cache_is_scoped_to_exact_configuration_and_recovery_profile() {
        let mut c = client(json!(genesis("solana:testnet").unwrap()));
        let program = Key([2; 32]);
        let data = Key::find_program_address(&[&program.0], Key::parse(LOADER).unwrap())
            .unwrap()
            .0;
        c.config.mint = Some(Key([3; 32]));
        c.config.executor = Some(Key([4; 32]));
        c.config.authority = Some(Key([7; 32]));
        c.config.deployment = Some(Deployment {
            network: c.config.network.clone(),
            source_bundle: release().source_bundle.clone(),
            policy: program,
            policy_data: data,
            custody: Key([5; 32]),
        });
        let identity = digest(serde_json::to_vec(&c.config).unwrap());
        *c.verified.lock().unwrap() = Some((identity.clone(), true));
        assert!(c.verify_release(false).is_ok());
        c.config.mint = Some(Key([6; 32]));
        assert!(c.verify_release(false).is_err());
        c.config.mint = Some(Key([3; 32]));
        *c.verified.lock().unwrap() = Some((identity, false));
        assert!(c.verify_release(true).is_ok());
        assert!(c.verify_release(false).is_err());
    }
}
