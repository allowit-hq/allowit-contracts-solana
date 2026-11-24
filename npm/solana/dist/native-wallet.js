import { base58, base64, concat, equal, hex, readU64, sha256, u32, u64, unbase64, utf8 } from './bytes.js';
import { address, canSign, compile, instructionsOf, messageBytes, readMessage, readWire, verify, withSeed } from './message.js';
import { assets, canonicalNetwork } from './networks.js';
import { account, deposit, recentBlockhash, sendRaw, status } from './rpc.js';
import { remember } from './signatures.js';
/** The action of the owner step that sets up the agent's wallet. */
export const SET_UP_WALLET = 'set_up_wallet';
/**
 * The action of the owner step that approves the policy of a wallet. It signs a message and moves nothing. Its
 * payload is the base64 text of the message, as UTF-8, and its hash is the SHA-256 of those bytes.
 */
export const APPROVE_POLICY = 'approve_policy';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** SPL Memo, the version that x402 facilitators accept. */
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** The size of an SPL Token account and of an SPL Token multisig. */
export const TOKEN_ACCOUNT_LEN = 165;
export const MULTISIG_LEN = 355;
/** The most that the network takes for a payment of the wallet, in lamports: the ceiling that an approval may state. */
export const MAX_FEE_LAMPORTS = 20_000;
/** How long a prepared setup asks to be sent again, in seconds: about the life of its blockhash. */
const SETUP_WINDOW_SECS = 90;
/** The most that one setup approves, in base units of the wallet's token. */
const MAX_ALLOWANCE = 0xffffffffffffffffn;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A `createAccountWithSeed` seed: 32 characters, from a domain tag and the parts that it binds. */
function seed(tag, parts) {
    const digest = sha256(concat(utf8('allowit-native-v1\0'), utf8(tag), ...parts.map(part => address(part))));
    return `${tag[0]}:${hex(digest.subarray(0, 15))}`;
}
/**
 * Checks the roles and derives the wallet's addresses. The owner, the agent and the server are three keys that can
 * sign: with one key as both agent and server, one signature would meet the two-of-two delegate.
 */
export function walletOf({ owner, mint, agent, server }) {
    for (const [name, key] of [['owner', owner], ['agent', agent], ['server', server]])
        if (!canSign(key))
            throw new Error(`The ${name} key is not a key that can sign.`);
    if (!address(mint))
        throw new Error('The wallet token is invalid.');
    if (new Set([owner, agent, server]).size !== 3)
        throw new Error('The owner, the agent and the server are three different keys.');
    // The token account's seed leaves the server out: a new server delegate keeps the account.
    const tokenSeed = seed('token', [mint, agent]), delegateSeed = seed('delegate', [agent, server]);
    return { tokenSeed, delegateSeed, tokenAccount: withSeed(owner, tokenSeed, TOKEN_PROGRAM), delegate: withSeed(owner, delegateSeed, TOKEN_PROGRAM) };
}
const w = (at) => ({ address: at, signer: false, writable: true });
const r = (at) => ({ address: at, signer: false, writable: false });
const rs = (at) => ({ address: at, signer: true, writable: false });
const ws = (at) => ({ address: at, signer: true, writable: true });
const token = (tag, accounts, rest = []) => ({ program: TOKEN_PROGRAM, accounts, data: concat([tag], rest) });
const seedBytes = (text) => concat(u64(BigInt(text.length)), utf8(text));
/** The System instructions that open a seeded SPL Token account as `found` requires. */
function open(owner, at, seedText, space, found) {
    const [base, program] = [address(owner), address(TOKEN_PROGRAM)];
    if (found === 'ready')
        return [];
    if ('nothing' in found)
        // CreateAccountWithSeed: base, seed, lamports, space, program; the funder and the base sign.
        return [{ program: SYSTEM_PROGRAM, accounts: [ws(owner), w(at), rs(owner)], data: concat(u32(3), base, seedBytes(seedText), u64(found.nothing), u64(BigInt(space)), program) }];
    const out = [];
    // Transfer of the missing deposit.
    if (found.funded > 0n)
        out.push({ program: SYSTEM_PROGRAM, accounts: [ws(owner), w(at)], data: concat(u32(2), u64(found.funded)) });
    // AllocateWithSeed: base, seed, space, program; the base signs.
    out.push({ program: SYSTEM_PROGRAM, accounts: [w(at), rs(owner)], data: concat(u32(9), base, seedBytes(seedText), u64(BigInt(space)), program) });
    return out;
}
/**
 * The setup message: each account that is not ready, with its deposit, then the approval of the allowance to the
 * delegate, then the memo. Only the owner signs, and the owner pays the fee and the deposits.
 */
export function setupMessage(terms) {
    const { owner, mint, agent, server, allowance, decimals } = terms;
    const own = walletOf(terms);
    if (allowance < 0n || allowance > MAX_ALLOWANCE || !Number.isInteger(decimals) || decimals < 0 || decimals > 255)
        throw new Error('The allowance is out of range.');
    const memo = utf8(terms.tag);
    if (memo.length === 0 || memo.length > 256)
        throw new Error('A transaction tag has 1 to 256 bytes.');
    const ixs = open(owner, own.tokenAccount, own.tokenSeed, TOKEN_ACCOUNT_LEN, terms.token);
    // InitializeAccount3: the owner is in the data, so the instruction needs no signer and no rent account.
    if (terms.token !== 'ready')
        ixs.push(token(18, [w(own.tokenAccount), r(mint)], address(owner)));
    ixs.push(...open(owner, own.delegate, own.delegateSeed, MULTISIG_LEN, terms.delegate));
    // InitializeMultisig2: the agent and the server, two of two.
    if (terms.delegate !== 'ready')
        ixs.push(token(19, [w(own.delegate), r(agent), r(server)], [2]));
    // ApproveChecked: the allowance replaces an earlier one.
    ixs.push(token(13, [w(own.tokenAccount), r(mint), r(own.delegate), rs(owner)], concat(u64(allowance), [decimals])));
    ixs.push({ program: MEMO_PROGRAM, accounts: [], data: memo });
    const message = compile(ixs, owner, terms.blockhash);
    if (1 + 64 * message.signers + messageBytes(message).length > 1_232)
        throw new Error('The setup transaction is too large.');
    return message;
}
/** The memo of a setup that this package prepares: it names the agent, the server and the time until which the same bytes are sent again. */
const setupTag = (agent, server, validUntil) => `allowit:setup:${agent}:${server}:${validUntil}`;
const SETUP_TAG = /^allowit:setup:([1-9A-HJ-NP-Za-km-z]{32,44}):([1-9A-HJ-NP-Za-km-z]{32,44}):([1-9][0-9]{9})$/;
/**
 * Reads a setup message. The memo names the agent, the server and the time bound; the approval names the owner, the
 * token, the wallet and the delegate. The bytes are a setup only when the setup builder makes exactly them from what
 * was read: the wallet and the delegate are then the addresses of those roles, and the message holds nothing else.
 */
export function setupOf(messageBytesIn, parsed) {
    try {
        const ixs = instructionsOf(parsed);
        const memo = ixs.at(-1), approve = ixs.at(-2);
        if (parsed.signers !== 1 || !memo || !approve || memo.program !== MEMO_PROGRAM || memo.accounts.length !== 0
            || approve.program !== TOKEN_PROGRAM || approve.data.length !== 10 || approve.data[0] !== 13 || approve.accounts.length !== 4)
            return null;
        const tag = new TextDecoder('utf-8', { fatal: true }).decode(memo.data);
        const named = SETUP_TAG.exec(tag);
        if (!named)
            return null;
        const [, agent, server, until] = named;
        const [wallet, mint, delegate, owner] = approve.accounts.map(a => a.address);
        const roles = { owner, mint, agent, server };
        const own = walletOf(roles);
        if (owner !== parsed.keys[0] || own.tokenAccount !== wallet || own.delegate !== delegate)
            return null;
        // What the setup opens: the kind of each opening and its lamports, by the address that it opens.
        const found = (at) => {
            const system = ixs.filter(ix => ix.program === SYSTEM_PROGRAM);
            const create = system.find(ix => ix.data.length >= 4 && ix.data[0] === 3 && ix.accounts[1]?.address === at);
            if (create)
                return { nothing: readU64(create.data, 76) };
            const allocate = system.find(ix => ix.data.length >= 4 && ix.data[0] === 9 && ix.accounts[0]?.address === at);
            if (!allocate)
                return 'ready';
            const transfer = system.find(ix => ix.data.length === 12 && ix.data[0] === 2 && ix.accounts[1]?.address === at);
            return { funded: transfer ? readU64(transfer.data, 4) : 0n };
        };
        const [tokenFound, delegateFound] = [found(wallet), found(delegate)];
        const allowance = readU64(approve.data, 1), decimals = approve.data[9];
        const rebuilt = setupMessage({ ...roles, allowance, decimals, token: tokenFound, delegate: delegateFound, tag, blockhash: parsed.blockhash });
        if (!equal(messageBytes(rebuilt), messageBytesIn))
            return null;
        const lamports = (f) => f === 'ready' ? 0n : 'nothing' in f ? f.nothing : f.funded;
        return { ...roles, wallet, delegate, allowance, decimals, deposits: lamports(tokenFound) + lamports(delegateFound), validUntil: Number(until), blockhash: parsed.blockhash };
    }
    catch {
        return null;
    }
}
/** The token of a wallet as the rail lists it for `network`: an asset with an issuer, which is its mint. SOL is none. */
function listedToken(network, asset) {
    const listed = object(asset) && typeof asset.symbol === 'string' && typeof asset.issuer === 'string'
        ? assets(network).find(item => item.id === asset.issuer && item.symbol === asset.symbol && item.symbol !== 'SOL') : undefined;
    if (!listed)
        throw new Error('The wallet token is not a token that this network lists. A Solana wallet holds one listed token.');
    return { mint: listed.id, symbol: listed.symbol, decimals: listed.decimals };
}
/** Base units of a decimal amount with at most `decimals` decimals, or null. */
function units(amount, decimals) {
    const match = typeof amount === 'string' ? new RegExp(`^([0-9]{1,15})(?:\\.([0-9]{1,${decimals}}))?$`).exec(amount) : null;
    return match ? BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] ?? '').padEnd(decimals, '0')) : null;
}
/** Decimal text of base units as a person writes it: no trailing zeros. */
export function plainDecimal(value, decimals) {
    const scale = 10n ** BigInt(decimals), fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${value / scale}${fraction ? `.${fraction}` : ''}`;
}
/** What the setup finds at `at`, for an account that needs `needs` lamports and is ready when `ready` says so. */
async function find(network, at, length, ready, what, send) {
    const [needs, seen] = [await deposit(network, length, send), await account(network, at, send)];
    if (!seen || (seen.lamports === 0n && seen.data.length === 0))
        return { nothing: needs };
    if (seen.owner === SYSTEM_PROGRAM && seen.data.length === 0)
        return { funded: needs > seen.lamports ? needs - seen.lamports : 0n };
    if (seen.owner === TOKEN_PROGRAM && ready(seen.data))
        return 'ready';
    throw new Error(`The ${what} address holds another account. Nothing was signed.`);
}
/** Whether `data` is the wallet's token account: the mint, the owner, initialized, not frozen, closable by the owner. */
export function isTokenAccount(data, mint, owner) {
    const [m, o] = [address(mint), address(owner)];
    const none = data.length === TOKEN_ACCOUNT_LEN && equal(data.subarray(129, 133), Uint8Array.of(0, 0, 0, 0));
    const own = data.length === TOKEN_ACCOUNT_LEN && equal(data.subarray(129, 133), Uint8Array.of(1, 0, 0, 0)) && equal(data.subarray(133, 165), o);
    return data.length === TOKEN_ACCOUNT_LEN && equal(data.subarray(0, 32), m) && equal(data.subarray(32, 64), o) && data[108] === 1 && (none || own);
}
/** Whether `data` is the wallet's delegate: an initialized multisig of exactly the agent and the server, two of two. */
function isDelegate(data, agent, server) {
    return data.length === MULTISIG_LEN && data[0] === 2 && data[1] === 2 && data[2] === 1
        && equal(data.subarray(3, 35), address(agent)) && equal(data.subarray(35, 67), address(server));
}
/** The hash of a step: the SHA-256 of the message that the owner signs, as lowercase hexadecimal. */
export const messageHash = (message) => hex(sha256(message));
/**
 * Prepares the setup of the wallet of an agent: one transaction on a finalized blockhash, built from what the
 * finalized bank holds at the wallet's two addresses. Only the owner signs it.
 */
export async function prepareSetup({ network, owner, agent, server, amount, asset, fetch: send, now = Date.now }) {
    const id = canonicalNetwork(network);
    if (!id)
        throw new Error('Select a supported Solana network.');
    const held = listedToken(id, asset);
    const allowance = units(amount, held.decimals);
    if (allowance === null || allowance > MAX_ALLOWANCE)
        throw new Error(`Enter an amount of ${held.symbol} with at most ${held.decimals} decimals.`);
    const roles = { owner, mint: held.mint, agent, server };
    const own = walletOf(roles);
    const tokenFound = await find(id, own.tokenAccount, TOKEN_ACCOUNT_LEN, data => isTokenAccount(data, held.mint, owner), 'wallet', send);
    const delegateFound = await find(id, own.delegate, MULTISIG_LEN, data => isDelegate(data, agent, server), 'delegate', send);
    const blockhash = await recentBlockhash(id, send);
    const validUntil = Math.floor(now() / 1000) + SETUP_WINDOW_SECS;
    const message = messageBytes(setupMessage({ ...roles, allowance, decimals: held.decimals, token: tokenFound, delegate: delegateFound, tag: setupTag(agent, server, validUntil), blockhash }));
    const hash = messageHash(message);
    return {
        wallet: own.tokenAccount,
        step: { action: SET_UP_WALLET, payload: base64(message), hash, expiresAt: validUntil },
        complete(ownerSigned) {
            const signed = readWire(unbase64(ownerSigned) ?? new Uint8Array());
            if (!signed || signed.signatures.length !== 1 || !equal(signed.message, message))
                throw new Error('The wallet returned another transaction. Nothing was sent.');
            if (!verify(owner, message, signed.signatures[0]))
                throw new Error('The wallet signed with another account than the owner. Nothing was saved or sent; sign with the owner account.');
            remember(hash, signed.signatures[0]);
            return ownerSigned;
        },
    };
}
/**
 * What signed setup bytes are: their hash, their roles, the token of their wallet, the allowance that they approve,
 * as decimal text, and the time until which they are sent again. Null for bytes that are no setup of this network
 * with its owner's signature. The signed bytes decide; saved metadata is unsigned.
 */
export function signedSetupOf(signedPayload, network) {
    const id = canonicalNetwork(network);
    const signed = id ? readWire(unbase64(signedPayload) ?? new Uint8Array()) : null;
    const setup = signed ? setupOf(signed.message, signed.parsed) : null;
    if (!id || !signed || !setup || signed.signatures.length !== 1 || !verify(setup.owner, signed.message, signed.signatures[0]))
        return null;
    const listed = assets(id).find(item => item.id === setup.mint && item.symbol !== 'SOL');
    if (!listed || listed.decimals !== setup.decimals)
        return null;
    const hash = messageHash(signed.message);
    remember(hash, signed.signatures[0]);
    return { hash, owner: setup.owner, wallet: setup.wallet, agent: setup.agent, server: setup.server, validUntil: setup.validUntil,
        asset: { symbol: listed.symbol, issuer: listed.id }, amount: plainDecimal(setup.allowance, listed.decimals), signature: signed.signatures[0], blockhash: setup.blockhash };
}
/**
 * The token of the refill step of a wallet, as the server builds it: an unsigned transaction of the owner with one
 * `ApproveChecked` and a memo. Null for any other payload. The payload is the base64 text of the message.
 */
function refillMintOf(payload) {
    const bytes = unbase64(payload);
    const parsed = bytes ? readMessage(bytes) : null;
    if (!parsed || parsed.signers !== 1)
        return null;
    const ixs = instructionsOf(parsed);
    const [approve, memo] = ixs;
    return ixs.length === 2 && approve.program === TOKEN_PROGRAM && approve.data.length === 10 && approve.data[0] === 13 && approve.accounts.length === 4
        && approve.accounts[3].address === parsed.keys[0] && memo.program === MEMO_PROGRAM && memo.accounts.length === 0 ? approve.accounts[1].address : null;
}
const assetLabel = (asset) => asset.issuer === null ? asset.symbol : `${asset.symbol} (mint ${asset.issuer})`;
/**
 * Checks the token of a wallet's bytes against `asset`, the token of the reviewed policy: Core's
 * `keypairSetup.checkAsset`. `payload` is signed setup bytes, which must set up a wallet of that token, or the refill
 * step that the server prepared, which must approve it. Throws an error whose `code` is `asset_mismatch` otherwise,
 * for a payload that is neither, and when `asset` is no token that the network lists. The check is of the token only.
 */
export function checkAsset(payload, network, asset) {
    const refused = (message) => Object.assign(new Error(message), { code: 'asset_mismatch' });
    const id = canonicalNetwork(network);
    let expected;
    try {
        if (!id)
            throw new Error();
        expected = listedToken(id, asset);
    }
    catch {
        throw refused('The asset of the reviewed policy is not a token that this Solana network lists. Nothing was signed; a saved setup stays saved.');
    }
    const want = { symbol: expected.symbol, issuer: expected.mint };
    const setup = signedSetupOf(payload, network);
    if (setup) {
        if (setup.asset.issuer !== expected.mint)
            throw refused(`The signed wallet setup is for ${assetLabel(setup.asset)}, and the reviewed policy pays in ${assetLabel(want)}. It stays saved; resume the policy of that setup.`);
        return;
    }
    const mint = refillMintOf(payload);
    if (!mint)
        throw refused('These bytes are neither a signed wallet setup nor a wallet refill step of this network, so their token cannot be read. Nothing was signed; a saved setup stays saved.');
    if (mint !== expected.mint)
        throw refused(`The refill step approves the token ${mint}, and the reviewed policy pays in ${assetLabel(want)}. Nothing was signed.`);
}
/**
 * Sends signed setup bytes and waits until the finalized bank holds them. The slot of the successful transaction, or
 * null without a certain answer: a refused send, a failed transaction and a wait that ends early are all null, and the
 * workflow settles them from the saved bytes.
 */
export async function sendSetup(network, signedPayload, hash, send, wait = ms => new Promise(done => setTimeout(done, ms))) {
    const setup = signedSetupOf(signedPayload, network);
    if (!setup || setup.hash !== hash)
        return null;
    const signature = base58(setup.signature);
    // A refusal proves nothing: the node may already hold the transaction. The status below decides.
    await sendRaw(network, signedPayload, send).catch(() => null);
    for (let attempt = 0; attempt < 30; attempt++) {
        const seen = await status(network, signature, send).catch(() => null);
        if (seen?.status?.finalized)
            return seen.status.failed ? null : seen.status.slot;
        await wait(2_000);
    }
    return null;
}
/**
 * The installation document of a wallet, as the server registers it: the document of the rail crate's own setup
 * (`owner_client::installation`). It names the roles and the token and holds no policy yet; the server binds the
 * owner's approved policy to it. The server reads the wallet from the ledger and refuses a document that it does not
 * match.
 */
export function walletConfiguration(network, wallet, owner, agent, server, asset) {
    const id = canonicalNetwork(network);
    if (!id)
        throw new Error('Select a supported Solana network.');
    const held = listedToken(id, asset);
    if (walletOf({ owner, mint: held.mint, agent, server }).tokenAccount !== wallet)
        throw new Error('The wallet is not the token account of these roles.');
    return {
        network: id, policyInstance: hex(policyInstance(id, wallet)), wallet, owner, agent, server, route: 'native',
        mint: held.mint, assetSymbol: held.symbol, decimals: held.decimals, policySource: '', sourceHash: hex(sha256(new Uint8Array())),
        moduleDigest: hex(new Uint8Array(32)), params: {}, maxFeeLamports: MAX_FEE_LAMPORTS,
    };
}
/** The name of a wallet's installation: of its network and its address, so a second setup of the wallet names the same one. */
const policyInstance = (network, wallet) => sha256(concat(utf8('allowit-solana-installation-v1\0'), utf8(network), [0], address(wallet)));
/** Canonical text of a JSON value: object keys in code-unit order at every level. */
export function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (object(value))
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}
const APPROVAL_TITLE = 'Allowit: I approve this policy source for my wallet.';
/**
 * Reads the exact text of a policy approval of `network`: its title line, then the JSON of the approval, with no
 * space and no key twice. Any other text is null: another title, a text that is not the plain form of its own
 * content, another network or route, or a source or values whose hash differs from the hash that the message states.
 */
export function policyApproval(message, network) {
    const id = canonicalNetwork(network);
    if (typeof message !== 'string' || !id || message.length > 262_144)
        return null;
    const at = message.indexOf('\n');
    if (at < 0 || message.slice(0, at) !== APPROVAL_TITLE)
        return null;
    const text = message.slice(at + 1);
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    // The text is its own content written once: the server's key order is kept, and nothing else is.
    if (!object(value) || JSON.stringify(value) !== text)
        return null;
    const { policyId, revision, wallet, source, sourceHash, paramsHash, params } = value;
    if (value.route !== 'native' || value.network !== id || typeof policyId !== 'string' || !policyId || policyId.length > 128
        || !Number.isSafeInteger(revision) || revision <= 0 || typeof wallet !== 'string' || !address(wallet)
        || typeof source !== 'string' || typeof sourceHash !== 'string' || hex(sha256(utf8(source))) !== sourceHash
        || typeof paramsHash !== 'string' || !object(params) || hex(sha256(utf8(canonical(params)))) !== paramsHash)
        return null;
    return { policyId, revision: revision, network: id, wallet, source, sourceHash, paramsHash, params, fields: value };
}
/**
 * The fields of an approval that the server derives for its own records: its digests of the source and the name of
 * its installation. A Native wallet enforces none of them.
 */
const SERVER_FIELDS = new Set(['irHash', 'moduleDigest', 'policyInstance']);
/**
 * Whether a policy approval of `wallet` is exactly what the owner reviewed. Every field that the wallet signs is
 * checked. The policy and its revision come from the service. The source, rules, values and tier must be the reviewed
 * ones, and a Native wallet has no tier. The network, wallet and route must be the wallet's own, the token must be the
 * token of the reviewed policy, and the fee ceiling is at most the rail's. The agent and the server must be two keys:
 * which keys they are is decided by the wallet address, which binds the agent, and by the delegate that the ledger
 * holds, which binds both. Any other field, or any other value, is refused.
 */
export function approvalHolds(approval, wallet, reviewed) {
    let held;
    try {
        held = listedToken(approval.network, reviewed.asset);
    }
    catch {
        return false;
    }
    const f = approval.fields;
    const expected = {
        policyId: approval.policyId, revision: approval.revision, network: approval.network, wallet, route: 'native', mint: held.mint,
        source: reviewed.source, sourceHash: hex(sha256(utf8(reviewed.source))), params: reviewed.params,
        paramsHash: hex(sha256(utf8(canonical(reviewed.params)))), rules: reviewed.rules === undefined ? f.rules : reviewed.rules,
        tier: null, language: f.language, agent: f.agent, server: f.server, maxFeeLamports: f.maxFeeLamports,
    };
    const keys = Object.keys(f).filter(key => !SERVER_FIELDS.has(key));
    // Only the fields of `expected` itself count: a name that every object inherits is no field of an approval.
    return keys.length === Object.keys(expected).length && keys.every(key => Object.hasOwn(expected, key) && canonical(f[key]) === canonical(expected[key]))
        && (reviewed.tier === undefined || reviewed.tier === null)
        && typeof f.language === 'string' && /^[a-z0-9-]{1,64}$/.test(f.language) && canSign(f.agent) && canSign(f.server) && f.agent !== f.server
        && Number.isSafeInteger(f.maxFeeLamports) && f.maxFeeLamports > 0 && f.maxFeeLamports <= MAX_FEE_LAMPORTS;
}
/** The messages of the approval steps of this page, by their hash: a signature is checked over the message itself. */
const MESSAGES = new Map();
/** The step that asks the owner's wallet to approve a policy. It signs the message and moves nothing. */
export function approvalStep(message, now = Date.now()) {
    const bytes = utf8(message), hash = messageHash(bytes);
    MESSAGES.set(hash, bytes);
    return { action: APPROVE_POLICY, payload: base64(bytes), hash, expiresAt: Math.floor(now / 1000) + 300 };
}
/** The message of an approval step, or null when the payload is no UTF-8 text or differs from the step's hash. */
export function approvalMessage(step) {
    try {
        const bytes = unbase64(step.payload, 400_000);
        return bytes && messageHash(bytes) === step.hash ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : null;
    }
    catch {
        return null;
    }
}
/**
 * Whether `signature` is the signature of `signer` over the message of the approval step with `hash`. A Solana wallet
 * signs the message itself, so the step must be one that `approvalStep` made in this page.
 */
export function approvalSignedBy(signer, hash, signature) {
    const message = MESSAGES.get(hash);
    return message !== undefined && verify(signer, message, Uint8Array.from(signature));
}
/** The owner of a wallet: the owner of its token account in the finalized bank, or null. */
export async function walletOwner(network, wallet, send) {
    const seen = await account(network, wallet, send).catch(() => null);
    return seen && seen.owner === TOKEN_PROGRAM && seen.data.length === TOKEN_ACCOUNT_LEN && seen.data[108] === 1 ? base58(seen.data.subarray(32, 64)) : null;
}
