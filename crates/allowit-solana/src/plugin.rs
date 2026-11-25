//! The Solana rail plugin: the one value that the SDK registers.
//!
//! What a server needs of a rail is here in full for the Native wallet: the runtime, the owner
//! runtime, the server hooks, the packets and the request proof. The client's own workflows
//! (the CLI's `exec`, the owner's setup through a backend session) are not in this revision:
//! they refuse, and the plugin's test support names each of them as skipped with its reason, so nothing
//! reports a feature that it does not have.
use crate::client::{Client, HttpBackend, Record};
use crate::config::{Route, WalletConfig, source_hash};
use crate::networks::{self, DEVNET, USDC_DEVNET};
use crate::owner_runtime::OWNER_RUNTIME;
use crate::packets::{self, PACKETS};
use crate::rpc::Rpc;
use crate::runtime::{Bundle, Consent, Runtime, consent_message, consent_payload};
use crate::server::HOOKS;
use crate::{KEYS, KeySigner, keys, proof};
use allowit_core::{
    transport::rpc::{ErrorKind, RpcClient},
    vendor::{
        KeyProvider, OwnerProvider, RuntimeProvider,
        error::{Error, Result},
        execution::{Binding, Capabilities, Outcome, Recovery, RecoveryBinding, Request},
        generation::{GenerateRequest, GeneratedDraft},
        input::{
            Formats,
            asset::{Amount, AssetDisplay, ResolvedAsset, Token},
        },
        kinds::WalletKind,
        owner,
        paid_service::PaidServiceProvider,
        plugin::{
            Deadlines, ExecutionProvider, Feature, Fixtures, GenerateContext, LinkKind,
            OwnerRuntime, RailPlugin, ServerHooks, StoreOpener, TestSupport,
        },
        profiles::{Description, Profile, ProfileBinding},
        request_proof::Protocol,
        routing::RailInfo,
        runtime::{
            Installation, Kind, Packet, PacketProvider as _, PolicyInstallation, Signer as _,
            Transport,
        },
        wallet::{MessageSignature, Signer},
    },
};
use ed25519_dalek::{Signature as Ed25519Signature, VerifyingKey};
use serde_json::{Value, json, value::RawValue};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

/// The rail's plugin.
pub static PLUGIN: Plugin = Plugin;
pub struct Plugin;

struct Execution;
static EXECUTION: Execution = Execution;
struct Owner;
static OWNER: Owner = Owner;
struct Messages;
static MESSAGES: Messages = Messages;
static PAID_SERVICE: crate::x402::PaidService = crate::x402::PaidService;

/// The error code of a call that got no answer, shared by every rail: nothing was observed, so
/// a retry with the same request ID is safe.
pub const NETWORK_UNAVAILABLE: i32 = 7;

/// The mint that names SOL as a token.
pub const WRAPPED_SOL_MINT: &str = "So11111111111111111111111111111111111111112";

/// The name of the rail's text-message signature: a Solana wallet's `signMessage`.
pub const MESSAGE_SIGNATURE_METHOD: &str = "solana-sign-message";

const NOT_YET_CLIENT: &str =
    "the Solana rail's client workflow is not in this revision; the server's runtime is";

fn not_yet(what: &str) -> Error {
    Error::unsupported(format!(
        "The Solana rail does not {what} yet: its client workflow is not in this revision"
    ))
}

static TEST_SUPPORT: TestSupport = TestSupport {
    network: DEVNET,
    skips: &[
        (Feature::EditParams, NOT_YET_CLIENT),
        (Feature::Verify, NOT_YET_CLIENT),
        (Feature::PairedExport, NOT_YET_CLIENT),
        (Feature::Live, "the rail has no funded Devnet key in tests"),
        (
            Feature::KeysFund,
            "the Devnet faucet is closed to RPC requests",
        ),
        (Feature::Swap, "a Native wallet makes transfers only"),
        (Feature::Deposit, "a Native wallet makes transfers only"),
        (Feature::Redeem, "a Native wallet makes transfers only"),
        (Feature::Deploy, "a Native wallet has no code to deploy"),
        (
            Feature::Fund,
            "the owner funds a Native wallet by its own approval",
        ),
        (
            Feature::UpdateParams,
            "the server keeps a Native wallet's params",
        ),
        (Feature::CustomBuild, "a Native wallet has no code to build"),
    ],
    fixtures,
};

fn address_bytes(text: &str) -> Option<[u8; 32]> {
    keys::public_key(text).ok()
}
fn any_address(text: &str) -> bool {
    address_bytes(text).is_some()
}
fn signer_address(text: &str) -> bool {
    address_bytes(text).is_some_and(|key| keys::signer_identity(&key).is_ok())
}
fn wallet_error(address: &str) -> Option<String> {
    if any_address(address) {
        return None;
    }
    let mut clipped: String = address.chars().take(64).collect();
    if clipped.len() < address.len() {
        clipped.push('…');
    }
    Some(format!(
        "{clipped} is not a valid Solana address: base58 of 32 bytes."
    ))
}
fn address_candidate(token: &str) -> bool {
    (32..=44).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() && !matches!(b, b'0' | b'O' | b'I' | b'l'))
}
fn asset_code(code: &str) -> bool {
    !code.is_empty() && code.len() <= 10 && code.bytes().all(|b| b.is_ascii_alphanumeric())
}
/// The decimals of a mint that a network of the rail lists.
fn asset_contract(mint: &str) -> Option<u8> {
    networks::NETWORKS.iter().find_map(|network| {
        networks::tokens(network.id)
            .iter()
            .find(|token| token.issuer == Some(mint))
            .map(|token| token.decimals)
    })
}
/// The identity of an asset: the listed token of `symbol`, or the one whose mint is `issuer`.
/// SOL is named by its wrapped mint, as every token program names it; a wallet of this rail
/// holds a listed SPL token, so an installation with SOL is refused where it is checked.
fn resolve_asset(
    network: &str,
    symbol: &str,
    issuer: Option<&str>,
    known_default: bool,
) -> Result<ResolvedAsset> {
    let token = networks::tokens(networks::network(network)?.id)
        .iter()
        .find(|token| {
            token.code == symbol
                && match issuer {
                    Some(mint) => token.issuer.unwrap_or(WRAPPED_SOL_MINT) == mint,
                    None => known_default,
                }
        })
        .ok_or_else(|| {
            Error::usage(format!(
                "The Solana rail lists no token {symbol} with that mint on this network"
            ))
        })?;
    Ok(ResolvedAsset {
        symbol: token.code.into(),
        address: token.issuer.unwrap_or(WRAPPED_SOL_MINT).into(),
        decimals: u32::from(token.decimals),
    })
}

/// Solana address and asset formats: every address is base58 of 32 bytes, and a token is named
/// by its mint.
pub static FORMATS: Formats = Formats {
    account: (signer_address, "a base58 Solana address of a key"),
    wallet: (any_address, "a base58 Solana address"),
    wallet_error,
    recipient: (any_address, "a base58 Solana token account address"),
    token: (any_address, "a base58 Solana mint address"),
    // A Solana wallet signs the bytes of a text, not a digest of it: see `MESSAGES`. This is the
    // 32-byte name of a text for hosts that key a statement by one.
    signing_digest: |message| packets::message_hash(message.as_bytes()),
    account_key: address_bytes,
    address_candidate,
    resolve_asset,
    same_wallet: |a, b| a == b,
    asset_code,
    asset_contract,
    issuer_decimals: None,
};

impl MessageSignature for Messages {
    /// A Solana wallet signs the exact bytes of the text.
    fn sign_message(&self, signer: &dyn Signer, message: &str) -> Result<Vec<u8>> {
        signer.sign_hash(message.as_bytes())
    }
    fn verify_message(
        &self,
        network: &str,
        address: &str,
        message: &str,
        signature: &[u8],
    ) -> Result<()> {
        HOOKS.verify_sign_in(network, address, message.as_bytes(), signature)
    }
    fn method(&self) -> Result<&'static str> {
        Ok(MESSAGE_SIGNATURE_METHOD)
    }
}

/// The caller's bounded HTTP transport to a Solana RPC endpoint.
struct HttpTransport(RpcClient);
impl Transport for HttpTransport {
    fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.0.call(method, &params).map_err(|error| match error.kind {
            // Nothing was observed, and a deadline that expires before the send sent nothing:
            // the same request may be sent again.
            ErrorKind::Timeout | ErrorKind::Connection | ErrorKind::Deadline => {
                let mut unavailable = Error::uncertain(format!(
                    "Solana RPC {method}: network unavailable; retry with the same request ID"
                ));
                unavailable.code = NETWORK_UNAVAILABLE;
                unavailable
            }
            // The request left and no whole answer came back: the outcome is unknown.
            ErrorKind::Transport | ErrorKind::Read => Error::uncertain(format!(
                "The Solana RPC did not answer {method}: {error} The result is unknown; look it up before any replacement."
            )),
            // The node answered and refused, or answered in another form.
            _ => Error::config(format!("The Solana RPC refused {method}: {error}")),
        })
    }
}

/// A wallet's public profile as the binding of a client profile.
impl ProfileBinding for Bundle {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    /// The ledger at `endpoint` holds this wallet's token account for these roles.
    fn verify_import(&self, endpoint: &str) -> Result<()> {
        let runtime = PLUGIN.runtime(
            &self.config.network,
            PLUGIN.connect(&self.config.network, endpoint)?,
        )?;
        let authority = allowit_core::vendor::config::ServerAuthority::validated(
            &self.config.network,
            "https://localhost",
            &self.config.server,
        )?;
        let bytes = serde_json::to_vec(self)
            .map_err(|_| Error::config("Cannot encode the wallet profile"))?;
        runtime.import(&authority, &bytes).map(|_| ())
    }
    fn verify_server_role(&self, server: &str) -> Result<()> {
        if self.config.server != server {
            return Err(Error::config(
                "The wallet profile names another server than the configured authority",
            ));
        }
        Ok(())
    }
    fn wallet_kind(&self) -> Option<WalletKind> {
        Some(WalletKind::Native)
    }
}

impl RailPlugin for Plugin {
    fn id(&self) -> &'static str {
        networks::ID
    }
    fn networks(&self) -> &'static [RailInfo] {
        networks::NETWORKS
    }
    /// What a host may ask of this rail today: the read of an imported wallet. The verbs of the
    /// client workflow join with it.
    fn capabilities(&self, _: &str) -> Capabilities {
        Capabilities {
            curve: keys::KEY_TYPE,
            address_is_key: true,
            operations: &["transfer"],
            build_only: false,
            verbs: &[
                "wallet import",
                "wallet show",
                "policy show",
                "exec",
                "status",
            ],
        }
    }
    fn test_support(&self) -> &'static TestSupport {
        &TEST_SUPPORT
    }
    fn formats(&self) -> &'static Formats {
        &FORMATS
    }
    fn tokens(&self, network: &str) -> &'static [Token] {
        networks::tokens(network)
    }
    fn native_asset(&self, network: &str) -> Result<AssetDisplay> {
        networks::network(network)?;
        Ok(networks::native_display())
    }
    fn explorer(&self, network: &str, kind: LinkKind, id: &str) -> Option<String> {
        networks::explorer(network, kind, id)
    }
    fn deadlines(&self, network: &str) -> Deadlines {
        networks::deadlines(network)
    }
    fn keys(&self) -> &'static dyn KeyProvider {
        &KEYS
    }
    fn fund_key(&self, network: &str, _: &str, _: Option<&str>) -> Result<String> {
        networks::network(network)?;
        Err(Error::unsupported(
            "The Solana Devnet faucet takes no RPC request; fund the key through its web form",
        ))
    }
    fn draft_params(
        &self,
        network: &str,
        document: &Value,
    ) -> Result<allowit_core::vendor::plugin::DraftParams> {
        crate::activation::draft_params(network, document)
    }
    fn decode_profile(
        &self,
        network: &str,
        bytes: &[u8],
    ) -> Result<(Description, Box<dyn ProfileBinding>)> {
        // A public profile holds no key. A document that carries signing material is refused by
        // that name, before anything of it is read or shown.
        let secret = |value: &Value| {
            ["signingSeed", "secretKey", "privateKey", "seed"]
                .iter()
                .any(|key| value.get(key).is_some())
        };
        if serde_json::from_slice::<Value>(bytes)
            .is_ok_and(|document| secret(&document) || secret(&document["config"]))
        {
            return Err(Error::config(
                "The public Solana wallet profile must not contain signing material",
            ));
        }
        let bundle: Bundle = serde_json::from_slice(bytes)
            .map_err(|_| Error::config("Invalid Solana wallet profile"))?;
        bundle.validate()?;
        if networks::network(network)?.id != bundle.config.network {
            return Err(Error::config(
                "Public profile belongs to another selected rail",
            ));
        }
        let c = &bundle.config;
        let description = Description {
            network: c.network.clone(),
            wallet: c.wallet.clone(),
            agent: c.agent.clone(),
            policy_id: bundle.policy_id.clone(),
            owner: c.owner.clone(),
            server: c.server.clone(),
            asset: c.mint.clone(),
            asset_symbol: c.asset_symbol.clone(),
            source: c.policy_source.clone(),
            source_hash: crate::config::hex32::encode(&c.source_hash),
            module_digest: crate::config::hex32::encode(&c.module_digest),
            params: c.params.clone(),
        };
        Ok((description, Box::new(bundle)))
    }
    fn generate(&self, cx: &GenerateContext<'_>, r: &GenerateRequest) -> Result<GeneratedDraft> {
        crate::generation::generate(cx, r)
    }
    fn execution(&self) -> &'static dyn ExecutionProvider {
        &EXECUTION
    }
    fn owner(&self) -> &'static dyn OwnerProvider {
        &OWNER
    }
    fn owner_runtime(&self) -> &'static dyn OwnerRuntime {
        &OWNER_RUNTIME
    }
    fn connect(&self, network: &str, endpoint: &str) -> Result<Arc<dyn Transport>> {
        networks::network(network)?;
        let client = RpcClient::new(endpoint, Duration::from_secs(15), 2 * 1024 * 1024)
            .map_err(|_| Error::config("Invalid Solana RPC endpoint"))?;
        Ok(Arc::new(HttpTransport(client)))
    }
    fn runtime(
        &self,
        network: &str,
        transport: Arc<dyn Transport>,
    ) -> Result<Box<dyn RuntimeProvider>> {
        Ok(Box::new(Runtime::new(network, Arc::new(Rpc(transport)))?))
    }
    /// A Native wallet is installed by its owner's setup, whose document the server registers:
    /// there is no policy wallet to bind an installation to.
    fn install(&self, _: PolicyInstallation) -> Result<Installation> {
        Err(Error::unsupported(
            "The Solana rail installs Native wallets only, through the owner's setup",
        ))
    }
    fn restore(&self, kind: Kind, raw: Box<RawValue>) -> Result<Packet> {
        packets::restore(kind, raw)
    }
    fn request_proof_protocol(&self) -> Protocol {
        proof::request_proof_protocol()
    }
    fn signer_identity(&self, key: &[u8; 32]) -> Result<String> {
        keys::signer_identity(key)
    }
    fn request_id(&self, packet: &Packet) -> Result<[u8; 32]> {
        PACKETS.request_id(packet)
    }
    fn server(&self) -> &'static dyn ServerHooks {
        &HOOKS
    }
    fn message_signature(&self) -> Option<&'static dyn MessageSignature> {
        Some(&MESSAGES)
    }
    /// The x402 `exact` scheme: the seller's challenge that this rail reads and the proof that
    /// it builds. The payment itself is an operation of the wallet.
    fn paid_service(&self) -> Option<&'static dyn PaidServiceProvider> {
        Some(&PAID_SERVICE)
    }
    /// The Allowit facilitator for x402 `exact` on Solana Devnet. A fee within the host's
    /// ceiling and the hourly budget bounds a transaction that fails after its simulation; an
    /// offer past its `expiresAt` is refused; the ledger bounds a blockhash's last valid height.
    fn settlement_service(
        &self,
    ) -> Option<&'static dyn allowit_core::vendor::settlement_service::SettlementProvider> {
        Some(&crate::settlement_service::SERVICE)
    }
}

/// The agent's key as the signer of the rail's own documents: its identity is its address, and
/// it signs the bytes that it is given.
struct AgentKey(Arc<dyn Signer>);
impl allowit_core::vendor::runtime::Signer for AgentKey {
    fn identity(&self) -> &str {
        self.0.address()
    }
    fn sign_hash(&self, digest: &[u8; 32]) -> Result<Vec<u8>> {
        self.0.sign_hash(digest)
    }
    fn sign_bytes(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        self.0.sign_hash(bytes)
    }
}

/// The Unix time of this machine, for request proofs and the expiry of a prepared payment.
fn clock() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .map_err(|_| Error::config("The system clock is before 1970"))
}

/// The wallet profile that a client profile binds.
fn bundle(profile: &Profile) -> Result<&Bundle> {
    profile
        .binding
        .as_any()
        .downcast_ref::<Bundle>()
        .ok_or_else(|| Error::config("Public profile belongs to another selected rail"))
}

/// The transfer that a host request asks for: its recipient and its amount in base units of
/// the wallet's own token.
fn transfer(bundle: &Bundle, request: &Request) -> Result<(String, u64)> {
    use allowit_core::vendor::input::asset::Asset;
    if request.op != "transfer" || request.token_out.is_some() || request.args.is_some() {
        return Err(Error::unsupported(
            "A Native wallet of the Solana rail makes plain transfers only",
        ));
    }
    if request.paid_service.is_some() {
        return Err(not_yet("pay a seller's challenge from the client"));
    }
    if request
        .wallet
        .as_deref()
        .is_some_and(|wallet| wallet != bundle.config.wallet)
    {
        return Err(Error::usage(
            "The request names another wallet than the profile's",
        ));
    }
    let config = &bundle.config;
    let own = match &request.amount.asset {
        Asset::Installed => true,
        Asset::Token { code, issuer } => {
            *code == config.asset_symbol && issuer.as_deref().is_none_or(|mint| mint == config.mint)
        }
        Asset::Contract(mint) => *mint == config.mint,
        Asset::Native { .. } => false,
    };
    if !own
        || request
            .amount
            .decimals
            .is_some_and(|decimals| decimals != config.decimals)
    {
        return Err(Error::usage(format!(
            "This wallet pays in {} only",
            config.asset_symbol
        )));
    }
    let units = u64::try_from(request.amount.units())
        .ok()
        .filter(|units| *units > 0)
        .ok_or_else(|| Error::usage("The amount is out of range"))?;
    Ok((request.to.clone(), units))
}

/// Run `work` with the agent's client for `profile`: the backend of the configured authority,
/// the caller's store, and the agent's own view of the ledger when it has an RPC endpoint.
fn with_client<T>(
    profile: &Profile,
    signer: Arc<dyn Signer>,
    store: StoreOpener<'_>,
    rpc: Option<&str>,
    work: impl FnOnce(&Client<'_>, &Bundle) -> Result<T>,
) -> Result<T> {
    let bundle = bundle(profile)?;
    if signer.network() != bundle.config.network {
        return Err(Error::config(
            "Agent signer belongs to another profile rail",
        ));
    }
    let authority = profile.require_authority()?;
    if authority.network() != bundle.config.network {
        return Err(Error::config("Server authority belongs to another rail"));
    }
    bundle.verify_server_role(authority.public_key())?;
    let agent = AgentKey(signer);
    let backend = HttpBackend::new(authority.origin(), &agent, &clock)?;
    // The agent's own RPC, when it has one: the ledger then decides, not the server.
    let chain = rpc
        .filter(|endpoint| !endpoint.is_empty())
        .map(|endpoint| {
            Runtime::new(
                &bundle.config.network,
                Arc::new(Rpc(PLUGIN.connect(&bundle.config.network, endpoint)?)),
            )
        })
        .transpose()?;
    let records = store()?;
    work(
        &Client {
            backend: &backend,
            records: &records,
            profile: bundle,
            agent: &agent,
            clock: &clock,
            chain: chain.as_ref(),
            sleep: &std::thread::sleep,
        },
        bundle,
    )
}

/// A retained request as what a host recovers.
struct Retained(Record);
impl RecoveryBinding for Retained {
    fn binding(&self) -> Binding {
        Binding {
            wallet: self.0.profile.config.wallet.clone(),
            policy: format!(
                "{}@{}",
                self.0.profile.policy_id,
                crate::config::hex32::encode(&self.0.profile.config.module_digest)
            ),
        }
    }
    fn signed(&self) -> bool {
        self.0.agent_signature.is_some()
    }
    fn into_any(self: Box<Self>) -> Box<dyn std::any::Any + Send + Sync> {
        self
    }
}

impl ExecutionProvider for Execution {
    /// What the rail can execute at all: a transfer to a token account, without extra args.
    fn check(
        &self,
        network: &str,
        op: &str,
        to: &str,
        minimum: Option<&Amount>,
        args: bool,
    ) -> Result<()> {
        networks::network(network)?;
        if op != "transfer" {
            return Err(Error::unsupported(
                "A Native wallet of the Solana rail makes transfers only",
            ));
        }
        if args || minimum.is_some() {
            return Err(Error::usage(
                "A transfer takes no arguments and no minimum output",
            ));
        }
        if !any_address(to) {
            return Err(Error::usage(
                "The recipient is not a Solana token account address",
            ));
        }
        Ok(())
    }
    /// The request that the client would send, without sending or retaining anything.
    fn build(
        &self,
        profile: &Profile,
        _: StoreOpener<'_>,
        _: Option<&str>,
        request: &Request,
    ) -> Result<Value> {
        let bundle = bundle(profile)?;
        let (recipient, units) = transfer(bundle, request)?;
        let input = crate::agent::request(bundle, &request.request_id, &recipient, units)?;
        Ok(json!({"requestId": request.request_id, "input": input}))
    }
    fn execute(
        &self,
        profile: Profile,
        signer: Arc<dyn Signer>,
        store: StoreOpener<'_>,
        rpc: Option<String>,
        request: &Request,
    ) -> Result<Outcome> {
        with_client(&profile, signer, store, rpc.as_deref(), |client, bundle| {
            let (recipient, units) = transfer(bundle, request)?;
            client.execute(&request.request_id, &recipient, units, request.wait)
        })
    }
    fn status(
        &self,
        profile: Profile,
        signer: Arc<dyn Signer>,
        store: StoreOpener<'_>,
        rpc: Option<String>,
        id: &str,
        wait: Duration,
    ) -> Result<Outcome> {
        with_client(&profile, signer, store, rpc.as_deref(), |client, _| {
            client.status(id, wait)
        })
    }
    /// The request that the journal retains under `id` for `network`, and for `wallet` when the
    /// caller names one. Two wallets may use one id, so more than one match is refused.
    fn retained(
        &self,
        store: StoreOpener<'_>,
        network: &str,
        wallet: Option<&str>,
        id: &str,
    ) -> Result<Option<Recovery>> {
        let network = networks::network(network)?.id;
        let mut found = store()?
            .entries::<Value>()?
            .into_iter()
            .filter_map(|entry| serde_json::from_value::<Record>(entry).ok())
            .filter(|record| {
                record.version == 1
                    && record.request_id == id
                    && record.profile.config.network == network
                    && wallet.is_none_or(|wallet| wallet == record.profile.config.wallet)
            });
        let Some(record) = found.next() else {
            return Ok(None);
        };
        if found.next().is_some() {
            return Err(Error::usage(
                "More than one wallet retains this request ID; name the wallet",
            ));
        }
        record.profile.validate()?;
        Ok(Some(Recovery {
            binding: Box::new(Retained(record)),
        }))
    }
    /// Read the payment of a retained request from the backend that the journal names. It only
    /// reads: a request that the agent never signed is continued by `execute`, with the current
    /// profile and authority, not from history.
    fn recover(
        &self,
        original: Recovery,
        signer: Arc<dyn Signer>,
        backend: &str,
        store: StoreOpener<'_>,
        id: &str,
        wait: Duration,
        request: Option<&Request>,
    ) -> Result<Outcome> {
        let Retained(record) = *original
            .binding
            .into_any()
            .downcast::<Retained>()
            .map_err(|_| Error::config("Retained operation belongs to another selected rail"))?;
        if record.request_id != id {
            return Err(Error::usage(
                "The retained operation has another request ID",
            ));
        }
        if let Some(request) = request {
            let (recipient, units) = transfer(&record.profile, request)?;
            if crate::agent::request(&record.profile, id, &recipient, units)? != record.request {
                return Err(Error::usage(
                    "Original request ID already binds different input",
                ));
            }
        }
        let agent = AgentKey(signer);
        let origin = allowit_core::vendor::config::parse_origin(backend)?;
        if origin != record.origin {
            return Err(Error::config(
                "The retained operation belongs to another server than the selected one",
            ));
        }
        let backend = HttpBackend::new(&origin, &agent, &clock)?;
        let records = store()?;
        Client {
            backend: &backend,
            records: &records,
            profile: &record.profile,
            agent: &agent,
            clock: &clock,
            chain: None,
            sleep: &std::thread::sleep,
        }
        .status(id, wait)
    }
}

impl OwnerProvider for Owner {
    fn deploy(&self, _: &owner::Context<'_>, _: owner::Deploy<'_>) -> Result<Value> {
        Err(Error::unsupported(
            "A Native wallet of the Solana rail has no code to deploy",
        ))
    }
    fn fund(
        &self,
        cx: &owner::Context<'_>,
        document: &[u8],
        id: &str,
        amount: &str,
        _fee: &str,
    ) -> Result<Value> {
        crate::owner_client::fund(cx, document, id, amount)
    }
    fn activate(&self, cx: &owner::Context<'_>, r: owner::Activate<'_>) -> Result<Value> {
        crate::owner_client::activate(
            cx,
            crate::activation::ActivateRequest {
                document: r.document,
                agent: r.agent,
                server: r.server,
                request_id: r.request_id,
            },
        )
    }
    fn export(&self, cx: &owner::Context<'_>, document: &[u8], id: &str) -> Result<Box<RawValue>> {
        crate::owner_client::export(cx, document, id)
    }
    fn setup(&self, cx: &owner::Context<'_>, r: owner::Setup<'_>) -> Result<Value> {
        crate::owner_client::setup(cx, r)
    }
    fn native_wallet_asset(&self, cx: &owner::Context<'_>) -> Result<owner::NativeWalletAsset> {
        crate::owner_client::native_wallet_asset(cx)
    }
    fn status(
        &self,
        store: &allowit_core::client::store::Store,
        network: &str,
        rpc: &str,
        id: &str,
    ) -> Result<Value> {
        crate::owner_client::status(store, network, rpc, id)
    }
}

/// A valid public profile of fixed test keys: owner 1, agent 2, server 3, Devnet USDC.
fn fixture_bundle() -> Bundle {
    let key = |seed: u8| KeySigner(KEYS.derive(&[seed; 32]).expect("a fixed seed"));
    let source = "pub async fn evaluate(ctx:&Context)->PolicyResult{Ok(())}";
    let mut config = WalletConfig {
        network: DEVNET.into(),
        policy_instance: [5; 32],
        wallet: String::new(),
        owner: key(1).identity().into(),
        agent: key(2).identity().into(),
        server: key(3).identity().into(),
        route: Route::Native,
        mint: USDC_DEVNET.into(),
        asset_symbol: "USDC".into(),
        decimals: 6,
        policy_source: source.into(),
        source_hash: source_hash(source),
        module_digest: [0; 32],
        params: BTreeMap::new(),
        max_fee_lamports: 20_000,
    };
    config.wallet = config
        .roles()
        .expect("fixed addresses")
        .token_account()
        .to_string();
    let payload = consent_payload(
        &config,
        "fixture-policy",
        1,
        "",
        "portable",
        &[],
        &json!({}),
        "",
    );
    let message = consent_message(&payload).expect("a JSON payload");
    let signature = key(1)
        .sign_bytes(message.as_bytes())
        .expect("a fixed key signs");
    Bundle {
        version: 1,
        policy_id: "fixture-policy".into(),
        config,
        consent: Consent {
            payload,
            signature: bs58::encode(signature).into_string(),
        },
    }
}

/// A Devnet ledger without the fixture wallet, for the shared tests that run offline: the
/// finalized bank at block height 1,000, a blockhash valid to height 1,150, the deposits of a
/// token account and a multisig, no account and no signature. Any other method is refused.
struct OfflineLedger;
impl Transport for OfflineLedger {
    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let context = json!({"slot": 1_200});
        Ok(match method {
            "getEpochInfo" => json!({"blockHeight": 1_000, "absoluteSlot": 1_200, "epoch": 0}),
            "getLatestBlockhash" => json!({"context": context, "value": {
                "blockhash": solana_hash::Hash::new_from_array([7; 32]).to_string(),
                "lastValidBlockHeight": 1_150}}),
            "getMinimumBalanceForRentExemption" => {
                let len = params[0].as_u64().unwrap_or(0);
                json!((len + 128) * 6_960)
            }
            "getAccountInfo" => json!({"context": context, "value": null}),
            "getSignatureStatuses" => json!({"context": context, "value": [null]}),
            _ => {
                return Err(Error::config(format!(
                    "The offline Solana ledger has no answer for {method}"
                )));
            }
        })
    }
}

/// A generation reply for the fixture wallet: a Native policy with a per-payment and a daily
/// limit in Devnet USDC.
fn fixture_generation(config: &WalletConfig) -> Value {
    let source = "pub fn execute(ctx: &AllowitContext) -> allowit::Result { Ok(()) }";
    let hash = crate::config::hex32::encode(&source_hash(source));
    json!({"policy": {
        "id": "fixture-policy", "revision": 1, "network": DEVNET, "code": source,
        "sourceHash": hash, "irHash": "",
        "runtime": {"instanceBinding": {
            "route": "native", "policyInstance": "05".repeat(32), "moduleDigest": "00".repeat(32),
            "wallet": config.wallet, "asset": config.mint, "assetSymbol": config.asset_symbol,
            "assetIssuer": config.mint, "maxFeeUnits": config.max_fee_lamports,
            "portable": {
                "language": "allowit-portable-v1", "sourceHash": hash, "tier": "native",
                "rules": ["payment_limit", "daily_spending_limit"],
                "params": {"payment_limit": {"Int": "5000000"},
                    "daily_spending_limit": {"Int": "20000000"}},
                "paramsHash": "", "unresolved": [],
            },
        }},
    }})
}

fn fixtures() -> Fixtures {
    let bundle = fixture_bundle();
    let mut invalid = bundle.config.owner.clone();
    invalid.push('0');
    Fixtures {
        account: bundle.config.owner.clone(),
        wallet: bundle.config.wallet.clone(),
        recipient: solana_address::Address::new_from_array([8; 32]).to_string(),
        invalid_address: invalid,
        token: networks::tokens(DEVNET)[0],
        agent_seed: [2; 32],
        public_profile: serde_json::to_vec(&bundle).expect("a profile encodes"),
        owner_generation: fixture_generation(&bundle.config),
        chain: Some(Arc::new(OfflineLedger)),
        live: None,
        wallet_code: Vec::new(),
    }
}

/// Verify `signature` of `address` over the exact bytes of `message`.
pub fn verify_message(address: &str, message: &[u8], signature: &[u8]) -> Result<()> {
    let key = keys::public_key(address)?;
    let invalid = || Error::usage("The message signature is invalid");
    VerifyingKey::from_bytes(&key)
        .map_err(|_| invalid())?
        .verify_strict(
            message,
            &Ed25519Signature::from_slice(signature).map_err(|_| invalid())?,
        )
        .map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plugin_serves_devnet_with_the_native_wallet_only() {
        assert_eq!(PLUGIN.id(), "solana");
        assert_eq!(PLUGIN.networks().len(), 1);
        assert_eq!(PLUGIN.wallet_kinds(DEVNET), [WalletKind::Native]);
        assert_eq!(PLUGIN.native_asset(DEVNET).unwrap().symbol, "SOL");
        assert_eq!(PLUGIN.asset_display(DEVNET, "USDC").unwrap().decimals, 6);
        assert_eq!(
            PLUGIN.asset_display(DEVNET, USDC_DEVNET).unwrap().symbol,
            "USDC"
        );
        assert!(PLUGIN.native_asset("solana:devnet").is_err());
        assert_eq!(PLUGIN.capabilities(DEVNET).operations, ["transfer"]);
        assert!(PLUGIN.fund_key(DEVNET, USDC_DEVNET, None).is_err());
    }

    #[test]
    fn the_fixture_profile_decodes_as_a_native_wallet_of_its_roles() {
        let fixtures = (PLUGIN.test_support().fixtures)();
        let (description, binding) = PLUGIN
            .decode_profile(DEVNET, &fixtures.public_profile)
            .unwrap();
        assert_eq!(description.wallet, fixtures.wallet);
        assert_eq!(description.owner, fixtures.account);
        assert_eq!(description.asset_symbol, "USDC");
        assert_eq!(binding.wallet_kind(), Some(WalletKind::Native));
        assert_eq!(
            PLUGIN
                .wallet_kind(DEVNET, &fixtures.public_profile)
                .unwrap(),
            WalletKind::Native
        );
        binding.verify_server_role(&description.server).unwrap();
        assert!(binding.verify_server_role(&description.agent).is_err());
        assert!(
            PLUGIN
                .decode_profile("solana:devnet", &fixtures.public_profile)
                .is_err()
        );
        // The agent of the fixture is the key of its seed, and the invalid address is refused.
        assert_eq!(
            KEYS.derive(&fixtures.agent_seed).unwrap().address(),
            description.agent
        );
        assert!((FORMATS.wallet.0)(&fixtures.wallet));
        assert!((FORMATS.account.0)(&fixtures.account));
        assert!(!(FORMATS.wallet.0)(&fixtures.invalid_address));
        assert!((FORMATS.wallet_error)(&fixtures.invalid_address).is_some());
        // A profile whose consent was signed for another fee bound is no profile.
        let mut changed: Bundle = serde_json::from_slice(&fixtures.public_profile).unwrap();
        changed.config.max_fee_lamports += 1;
        assert!(
            PLUGIN
                .decode_profile(DEVNET, &serde_json::to_vec(&changed).unwrap())
                .is_err()
        );
    }

    #[test]
    fn formats_name_a_token_by_its_mint() {
        let resolved = (FORMATS.resolve_asset)(DEVNET, "USDC", None, true).unwrap();
        assert_eq!(
            (resolved.address.as_str(), resolved.decimals),
            (USDC_DEVNET, 6)
        );
        (FORMATS.resolve_asset)(DEVNET, "USDC", Some(USDC_DEVNET), false).unwrap();
        // No default without the caller's word, and no other mint under a listed code.
        assert!((FORMATS.resolve_asset)(DEVNET, "USDC", None, false).is_err());
        let other = solana_address::Address::new_from_array([7; 32]).to_string();
        assert!((FORMATS.resolve_asset)(DEVNET, "USDC", Some(&other), true).is_err());
        assert!((FORMATS.resolve_asset)(DEVNET, "USDT", None, true).is_err());
        // SOL is named by its wrapped mint.
        let sol = (FORMATS.resolve_asset)(DEVNET, "SOL", None, true).unwrap();
        assert_eq!((sol.address.as_str(), sol.decimals), (WRAPPED_SOL_MINT, 9));
        assert!(any_address(WRAPPED_SOL_MINT));
        assert_eq!((FORMATS.asset_contract)(USDC_DEVNET), Some(6));
        assert_eq!((FORMATS.asset_contract)(&other), None);
        assert!((FORMATS.address_candidate)(USDC_DEVNET));
        assert!(!(FORMATS.address_candidate)("0OIl"));
        assert!((FORMATS.asset_code)("USDC") && !(FORMATS.asset_code)("US DC"));
    }

    #[test]
    fn a_text_message_is_signed_as_a_solana_wallet_signs_it() {
        let key = KeySigner(KEYS.derive(&[7; 32]).unwrap());
        let messages = PLUGIN.message_signature().unwrap();
        assert_eq!(messages.method().unwrap(), MESSAGE_SIGNATURE_METHOD);
        let signature = messages
            .sign_message(
                &Held(KeySigner(KEYS.derive(&[7; 32]).unwrap())),
                "a statement",
            )
            .unwrap();
        messages
            .verify_message(DEVNET, key.identity(), "a statement", &signature)
            .unwrap();
        verify_message(key.identity(), b"a statement", &signature).unwrap();
        assert!(
            messages
                .verify_message(DEVNET, key.identity(), "another statement", &signature)
                .is_err()
        );
    }

    #[test]
    fn the_plugin_reads_x402_challenges_and_offers_its_settlement_service() {
        use allowit_core::vendor::paid_service::SellerReply;
        let hook = PLUGIN.paid_service().unwrap();
        assert!(PLUGIN.test_support().skip(Feature::PaidService).is_none());
        assert!(PLUGIN.settlement_service().is_some());
        // A reply that offers no payment that the rail can settle is refused, not guessed.
        let reply = SellerReply {
            status: 402,
            headers: &[],
            body: b"{}",
        };
        assert!(
            hook.challenge(DEVNET, "https://seller.example/report", &reply)
                .is_err()
        );
    }

    /// A client profile of the fixture wallet, without a server authority.
    fn fixture_profile() -> Profile {
        let bytes = (PLUGIN.test_support().fixtures)().public_profile;
        let (description, binding) = PLUGIN.decode_profile(DEVNET, &bytes).unwrap();
        Profile {
            description,
            backend: "https://allowit.example".into(),
            binding,
            descriptor: RawValue::from_string(String::from_utf8(bytes).unwrap()).unwrap(),
            authority: None,
        }
    }
    fn ask(amount: Amount) -> Request {
        Request {
            op: "transfer".into(),
            to: solana_address::Address::new_from_array([8; 32]).to_string(),
            amount,
            token_out: None,
            args: None,
            request_id: "r1".into(),
            wait: Duration::ZERO,
            build_only: true,
            wallet: None,
            paid_service: None,
        }
    }
    fn units(asset: allowit_core::vendor::input::asset::Asset, quantity: u128) -> Amount {
        Amount {
            asset,
            quantity,
            decimals: None,
            text: quantity.to_string(),
        }
    }

    #[test]
    fn the_client_builds_the_request_that_the_server_derives_and_pays_in_the_wallets_token_only() {
        use allowit_core::vendor::{input::asset::Asset, typed_request::operation_nonce};
        let profile = fixture_profile();
        let opener = || -> Result<allowit_core::client::store::Store> {
            Err(Error::config("building a request opens no store"))
        };
        let built = PLUGIN
            .execution()
            .build(
                &profile,
                &opener,
                None,
                &ask(units(Asset::Installed, 2_000_000)),
            )
            .unwrap();
        assert_eq!(built["requestId"], "r1");
        assert_eq!(built["input"]["units"], "2000000");
        assert_eq!(
            built["input"]["nonce"],
            crate::config::hex32::encode(&operation_nonce("fixture-policy", "r1"))
        );
        let build = |request: Request| PLUGIN.execution().build(&profile, &opener, None, &request);
        let usdc = |issuer: Option<&str>| Asset::Token {
            code: "USDC".into(),
            issuer: issuer.map(str::to_owned),
        };
        build(ask(units(usdc(None), 1))).unwrap();
        build(ask(units(usdc(Some(USDC_DEVNET)), 1))).unwrap();
        build(ask(units(Asset::Contract(USDC_DEVNET.into()), 1))).unwrap();
        // Another token, SOL, a zero or oversized amount, other decimals, another wallet.
        assert!(build(ask(units(usdc(Some(WRAPPED_SOL_MINT)), 1))).is_err());
        assert!(build(ask(units(Asset::Native { code: "SOL".into() }, 1))).is_err());
        assert!(build(ask(units(Asset::Installed, 0))).is_err());
        assert!(build(ask(units(Asset::Installed, u128::from(u64::MAX) + 1))).is_err());
        let mut other_decimals = units(Asset::Installed, 1);
        other_decimals.decimals = Some(9);
        assert!(build(ask(other_decimals)).is_err());
        let mut elsewhere = ask(units(Asset::Installed, 1));
        elsewhere.wallet = Some(profile.description.owner.clone());
        assert!(build(elsewhere).is_err());
        let mut swap = ask(units(Asset::Installed, 1));
        swap.op = "swap".into();
        assert!(build(swap).is_err());
        // A fresh execution needs the configured server authority before anything is sent.
        let key: Arc<dyn Signer> = Arc::new(Held(KeySigner(KEYS.derive(&[2; 32]).unwrap())));
        let refused = PLUGIN.execution().execute(
            fixture_profile(),
            key,
            &opener,
            None,
            &ask(units(Asset::Installed, 1)),
        );
        assert!(refused.err().unwrap().message.contains("authority"));
    }

    /// A key as a host's wallet signer.
    struct Held(KeySigner);
    impl Signer for Held {
        fn network(&self) -> &str {
            DEVNET
        }
        fn address(&self) -> &str {
            self.0.identity()
        }
        fn sign_hash(&self, bytes: &[u8]) -> Result<Vec<u8>> {
            self.0.sign_bytes(bytes)
        }
    }

    #[test]
    fn the_native_wallets_features_run_the_shared_tests_and_the_rest_are_named_as_skipped() {
        let support = PLUGIN.test_support();
        for feature in [
            Feature::Transfer,
            Feature::Recover,
            Feature::OwnerSetup,
            Feature::Activate,
            Feature::Export,
            Feature::Limits,
            Feature::DraftDisplay,
            Feature::ExplorerLinks,
            Feature::PaidService,
        ] {
            assert!(support.skip(feature).is_none(), "{feature:?}");
        }
        for feature in [
            Feature::Deploy,
            Feature::Swap,
            Feature::CustomBuild,
            Feature::Verify,
        ] {
            assert!(support.skip(feature).is_some(), "{feature:?}");
        }
        PLUGIN
            .execution()
            .check(DEVNET, "transfer", USDC_DEVNET, None, false)
            .unwrap();
        assert!(
            PLUGIN
                .execution()
                .check(DEVNET, "swap", USDC_DEVNET, None, false)
                .is_err()
        );
        assert!(
            PLUGIN
                .execution()
                .check(DEVNET, "transfer", "not an address", None, false)
                .is_err()
        );
        assert!(
            PLUGIN
                .execution()
                .check(DEVNET, "transfer", USDC_DEVNET, None, true)
                .is_err()
        );
    }

    /// The offline ledger of the fixtures answers the rail's own reads, and the fixtures' drafts
    /// print their params in USDC.
    #[test]
    fn the_fixtures_serve_the_rails_reads_and_print_their_params() {
        use crate::owner::{Ledger as _, Status};
        let fx = fixtures();
        let ledger = Rpc(fx.chain.clone().expect("an offline ledger"));
        assert_eq!(ledger.recent().unwrap().last_valid_height, 1_150);
        assert_eq!(ledger.deposit(165).unwrap(), 2_039_280);
        assert_eq!(ledger.deposit(355).unwrap(), 3_361_680);
        let wallet: solana_address::Address = fx.wallet.parse().unwrap();
        assert_eq!(ledger.account(&wallet).unwrap(), None);
        assert_eq!(ledger.observe(&[7; 64]).unwrap().status, Status::Unknown);
        assert!(ledger.submit(&[0]).is_err());

        let draft = PLUGIN.draft_params(DEVNET, &fx.owner_generation).unwrap();
        assert_eq!(draft.asset.symbol, "USDC");
        assert_eq!(draft.asset.decimals, 6);
        assert_eq!(draft.params.len(), 2);
        let profile: Value = serde_json::from_slice(&fx.public_profile).unwrap();
        assert_eq!(
            PLUGIN.draft_params(DEVNET, &profile).unwrap().asset.symbol,
            "USDC"
        );
        assert!(PLUGIN.draft_params(DEVNET, &json!({})).is_err());
        assert!(
            PLUGIN
                .draft_params("unknown:none", &fx.owner_generation)
                .is_err()
        );
        // The generation reply is a policy that the owner's approval reads.
        let config = &fixture_bundle().config;
        crate::activation::approval(
            DEVNET,
            &fx.owner_generation["policy"],
            &config.owner,
            &config.agent,
            &config.server,
        )
        .unwrap();
    }

    #[test]
    fn a_profile_that_carries_signing_material_is_refused_by_that_name() {
        let fx = fixtures();
        let mut profile: Value = serde_json::from_slice(&fx.public_profile).unwrap();
        PLUGIN.decode_profile(DEVNET, &fx.public_profile).unwrap();
        for at in ["/signingSeed", "/config/secretKey"] {
            let mut with = profile.clone();
            let (parent, key) = at.rsplit_once('/').unwrap();
            let target = if parent.is_empty() {
                &mut with
            } else {
                with.pointer_mut(parent).unwrap()
            };
            target[key] = json!("must-remain-local");
            let Err(refused) = PLUGIN.decode_profile(DEVNET, &serde_json::to_vec(&with).unwrap())
            else {
                panic!("{at}: a profile with a key is decoded");
            };
            assert!(
                refused
                    .message
                    .contains("must not contain signing material"),
                "{}",
                refused.message
            );
            assert!(!refused.message.contains("must-remain-local"));
        }
        // Any other unknown field is still no profile.
        profile["extra"] = json!(1);
        assert!(
            PLUGIN
                .decode_profile(DEVNET, &serde_json::to_vec(&profile).unwrap())
                .is_err()
        );
    }
}
