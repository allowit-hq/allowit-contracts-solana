import {PublicKey} from '@solana/web3.js';
import {canonicalUnsigned, DEVNET_GENESIS, decimal, isNativeNetwork, isOwnerMethod, isSlotMethod, matchesPinnedRelease, MAX_ALLOWED_SERVICES, settledOperation, supersededOwner, units, type AllowedService, type NativeConfig, type NativeDeployment, type NativeNetwork, type NativeRelease, type Operation, type OwnerMethod, type Policy, type PublicOperation, type VaultState} from './native-contracts';
import type {PreparationStatus} from './native-api';
import {parseNativeX402Services} from './native-x402';

/**
 * What the owner's vault is, derived only from verified chain state and exact proofs. A missing vault account is
 * never read as closed on its own: closure needs a settled close for that vault instance.
 */

export type VaultPhase = 'draft' | 'creating' | 'active' | 'revoked' | 'closed' | 'missing' | 'unknown';
export const terminal = (status: unknown) => status === 'settled' || status === 'failed';

/** The owner intent a journaled record carries. */
export function intentOf(record: Pick<Operation, 'intent'>): {method: string; amount: string | null; instanceSlot: string | null} {
  try {
    const i = JSON.parse(record.intent);
    return {method: String(i.method), amount: typeof i.amount === 'string' ? i.amount : null, instanceSlot: i.instanceSlot === null || i.instanceSlot === undefined ? null : String(i.instanceSlot)};
  } catch {
    return {method: '', amount: null, instanceSlot: null};
  }
}

const slotOf = (value: unknown): bigint | null => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  return canonicalUnsigned(value) ? BigInt(value) : null;
};
interface Proof {id: string; method: string; status: string; instanceSlot: bigint | null; finalizedSlot: bigint | null}
function proofs(records: readonly Operation[], serverOps: readonly PublicOperation[]): Proof[] {
  const byId = new Map<string, Proof>();
  const observations = new Map(serverOps.map(op => [op.id, op]));
  const localOnly: Proof[] = [];
  for (const op of serverOps) byId.set(op.id, {id: op.id, method: op.method, status: op.method === 'close' && op.status === 'settled' && !settledOperation(op) ? 'uncertain' : op.status, instanceSlot: slotOf(op.instanceSlot), finalizedSlot: slotOf(op.finalizedSlot)});
  // Chain observations belong to the exact signed proof, not just its request ID. The local intent remains intact.
  for (const r of records) {
    const instanceSlot = slotOf(intentOf(r).instanceSlot ?? r.instanceSlot);
    const observed = observations.get(r.id);
    const matches = !!observed && observed.method === r.method && observed.signature === r.signature
      && (r.method !== 'close' || slotOf(observed.instanceSlot) === instanceSlot);
    const server = matches ? byId.get(r.id) : undefined;
    const status = server?.status ?? r.status;
    const proof = {id: r.id, method: r.method, status, instanceSlot, finalizedSlot: server?.status === 'settled' ? server.finalizedSlot : null};
    if (matches) byId.set(r.id, proof);
    else localOnly.push(proof); // A conflicting local ID cannot erase a newer server deployment or its uncertainty.
  }
  return [...byId.values(), ...localOnly];
}

/**
 * `state` is the verified vault (null: no account) or undefined when it could not be read. A settled close for
 * another instance never closes a newer vault, and a vault that exists is never shown as closed.
 */
export function vaultPhase(state: VaultState | null | undefined, records: readonly Operation[], serverOps: readonly PublicOperation[]): {phase: VaultPhase; closedBy: string | null} {
  const all = proofs(records, serverOps);
  if (state) return {phase: state.approved ? 'active' : 'revoked', closedBy: null};
  if (state === undefined) return {phase: 'unknown', closedBy: null};
  if (all.some(p => p.method === 'deploy' && !terminal(p.status))) return {phase: 'creating', closedBy: null};
  const deployed = all.filter(p => p.method === 'deploy' && p.status === 'settled');
  const closes = all.filter(p => p.method === 'close' && p.status === 'settled');
  const ordered = closes.filter(p => p.instanceSlot !== null && p.finalizedSlot !== null && p.finalizedSlot > p.instanceSlot)
    .sort((a, b) => a.instanceSlot! < b.instanceSlot! ? 1 : a.instanceSlot! > b.instanceSlot! ? -1 : 0);
  // A close names the creation slot of its instance. A newer deployment cannot be covered by that close.
  // Receipt slots come from backend-verified finalized transactions; wall clocks and operation-list order do not.
  // A close in its creation slot remains ambiguous because a redeployment could share that same slot.
  const closed = ordered.find(close => deployed.every(deploy => deploy.finalizedSlot !== null && deploy.finalizedSlot <= close.instanceSlot!));
  if (closed) return {phase: 'closed', closedBy: closed.id};
  if (deployed.length || closes.length) return {phase: 'missing', closedBy: null};
  return {phase: 'draft', closedBy: null};
}

/** A retained preparation (never signed here) or a saved signed proof that is not final yet. */
export interface Pending {
  id: string; method: OwnerMethod; amount: string | null; instanceSlot: string | null; signed: boolean;
  /** Its blockhash is verified expired: it can no longer be sent. A signed one may still have landed earlier. */
  expired: boolean;
  /** The backend has no record of this preparation; the same intent re-prepares under the same id. */
  absent: boolean;
  /** A close prepared for an earlier vault instance. It cannot apply to the current vault. */
  stale: boolean;
  transactionUrl?: string; status?: Operation['status'];
}
export interface Retained {id: string; method: OwnerMethod; amount: string | null; instanceSlot: string | null; status: PreparationStatus | null; absent: boolean}

export function pendingOf(localRecords: readonly Operation[], retained: readonly Retained[], state: VaultState | null | undefined, serverOps: readonly PublicOperation[] = []): Pending[] {
  const records = localRecords.map(r => {
    const observed = serverOps.find(o => o.id === r.id && o.signature === r.signature);
    return {...r, ...(observed?.blockhashExpired === true ? {blockhashExpired: true} : {}),
      ...(typeof observed?.supersededBy === 'string' ? {supersededBy: observed.supersededBy} : {})};
  });
  const stale = (method: string, slot: string | null) => method === 'close' && !!state && slot !== null && slot !== state.instanceSlot;
  const signed = records.filter(r => isOwnerMethod(r.method) && !terminal(r.status) && !supersededOwner(r, records)).map((r): Pending => {
    const i = intentOf(r);
    return {id: r.id, method: r.method as OwnerMethod, amount: i.amount, instanceSlot: i.instanceSlot, signed: true, expired: r.blockhashExpired === true, absent: false, stale: stale(r.method, i.instanceSlot), transactionUrl: r.transactionUrl, status: r.status};
  });
  const unsigned = retained.filter(p => !signed.some(s => s.id === p.id)).map((p): Pending => ({
    id: p.id, method: p.method, amount: p.amount, instanceSlot: p.instanceSlot, signed: false, expired: p.status?.blockhashExpired === true, absent: p.absent, stale: stale(p.method, p.instanceSlot),
  }));
  return [...signed, ...unsigned];
}

/** Whether a new owner operation may start, and how. Mirrors the lifecycle and backend guards. */
export function admission(method: OwnerMethod, pending: readonly Pending[], retained: readonly Retained[]): {ok: true; mode: 'new' | 'continue' | 'additional' | 'retry'; original?: Pending} | {ok: false; reason: string; blocker: Pending} {
  const own = pending.filter(p => p.method === method);
  const others = pending.filter(p => p.method !== method);
  // Revocation stays available while funding, withdrawal or closure is unresolved.
  if (method !== 'revoke') {
    const blocker = others.find(p => p.signed ? !(p.expired && isSlotMethod(p.method)) : !p.expired);
    if (blocker) return {ok: false, blocker, reason: blocker.signed ? 'unconfirmed' : 'prepared'};
  }
  const signedLive = own.find(p => p.signed && !p.expired);
  if (signedLive) return {ok: false, blocker: signedLive, reason: 'unconfirmed'};
  const unsigned = own.find(p => !p.signed);
  if (unsigned && !unsigned.expired) return {ok: true, mode: 'continue', original: unsigned};
  const signedExpired = own.find(p => p.signed && p.expired);
  if (signedExpired) return isSlotMethod(method) ? {ok: true, mode: 'additional', original: signedExpired} : {ok: false, blocker: signedExpired, reason: 'unconfirmed'};
  if (!unsigned) return {ok: true, mode: 'new'};
  const status = retained.find(r => r.id === unsigned.id)?.status;
  if (!unsigned.expired) return {ok: true, mode: 'continue', original: unsigned};
  if (isSlotMethod(method)) return status?.additionalOwnerOperationAllowed ? {ok: true, mode: 'additional', original: unsigned} : {ok: false, blocker: unsigned, reason: 'prepared'};
  return status?.retryPreparationAllowed ? {ok: true, mode: 'retry', original: unsigned} : {ok: false, blocker: unsigned, reason: 'prepared'};
}

export type EntryKind = 'create' | 'deposit' | 'withdraw' | 'close' | 'revoke' | 'spend' | 'other';
export interface Entry {id: string; at: string | null; kind: EntryKind; amount: string | null; status: string; url: string | null}
const KIND: Record<string, EntryKind> = {deploy: 'create', fund: 'deposit', withdraw: 'withdraw', close: 'close', revoke: 'revoke', execute: 'spend'};

/**
 * Vault activity: this device's signed owner proofs (with their exact amounts and signing times) merged with the
 * backend's published operations, which carry no amount or time. Nothing is inferred beyond those fields.
 */
export function history(records: readonly Operation[], serverOps: readonly PublicOperation[]): Entry[] {
  const local = new Map(records.map(r => [r.id, r]));
  const out: Entry[] = records.map(r => {
    const server = serverOps.find(o => o.id === r.id && o.method === r.method && o.signature === r.signature);
    const status = server && (server.status === 'failed' || settledOperation(server)) ? server.status : r.status === 'settled' && !settledOperation(r) ? 'uncertain' : r.status;
    return {id: r.id, at: typeof r.signedAt === 'string' ? r.signedAt : null, kind: KIND[r.method] ?? 'other', amount: intentOf(r).amount, status, url: r.transactionUrl ?? null};
  });
  out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  for (const o of serverOps) {
    if (local.has(o.id) || o.status === 'prepared' || !o.signature) continue;
    out.push({id: o.id, at: null, kind: KIND[o.method] ?? 'other', amount: null, status: o.status === 'settled' && !settledOperation(o) ? 'uncertain' : o.status, url: typeof o.transactionUrl === 'string' ? o.transactionUrl : null});
  }
  return out;
}

/* ------------------------------------------------------------ public configuration */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const ACTIVE_CONFIG_KEY = 'allowit.native.active-config.v2';

export function parseRelease(body: unknown): {network: NativeNetwork; release: NativeRelease} | null {
  const b = body as {network?: unknown; profile?: unknown; release?: Partial<NativeRelease>} | null;
  const r = b?.release;
  if (!b || b.profile !== 'solana-native-v2' || !isNativeNetwork(b.network) || !matchesPinnedRelease(r)) return null;
  return {network: b.network, release: r};
}

/** Public configuration bound to the page's pinned release and network. Anything else is refused, never adapted. */
export function parseConfig(v: unknown, release: NativeRelease, network: NativeNetwork): NativeConfig | null {
  const c = v as Partial<NativeConfig> | null;
  const d = c?.deployment as Partial<NativeDeployment> | undefined;
  if (!c || !isNativeNetwork(network) || c.network !== network || (c.genesis !== undefined && c.genesis !== DEVNET_GENESIS) || !matchesPinnedRelease(release) || c.rpcUrl !== 'https://api.devnet.solana.com') return null;
  // Each vault names its agent's own executor key; the server's former executor is only listed for older vaults.
  const executor = c.executor ?? '';
  if (![c.mint, c.authority, d?.policy, d?.policyData, d?.custody, ...(executor ? [executor] : [])].every(x => typeof x === 'string' && BASE58.test(x))) return null;
  if (c.authority === executor) return null;
  try {
    for (const address of [c.mint, c.authority, d?.policy, d?.policyData, d?.custody, ...(executor ? [executor] : [])]) if (new PublicKey(address!).toBase58() !== address) return null;
    if (![c.authority, ...(executor ? [executor] : [])].every(address => PublicKey.isOnCurve(new PublicKey(address!).toBytes()))) return null;
    if (!new PublicKey(d!.policyData!).equals(PublicKey.findProgramAddressSync([new PublicKey(d!.policy!).toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0])) return null;
  } catch {return null;}
  if (!d || d.network !== network || typeof d.sourceBundle !== 'string' || d.sourceBundle !== release.sourceBundle) return null;
  // Rolling deploys may briefly serve the pre-catalog shape. Absence means no advertised service; a present malformed
  // catalog still fails closed.
  const x402Services = c.x402Services === undefined ? [] : parseNativeX402Services(c.x402Services);
  if (!x402Services) return null;
  return {network, genesis: DEVNET_GENESIS, release, rpcUrl: c.rpcUrl, mint: c.mint!, executor, authority: c.authority!, deployment: {network, sourceBundle: d.sourceBundle, policy: d.policy!, policyData: d.policyData!, custody: d.custody!}, x402Services};
}

export const storageKey = (c: NativeConfig) => `allowit.native.v2:${c.network}:${c.genesis}:${c.mint}:${c.executor}:${c.authority}:${c.deployment.policy}:${c.deployment.policyData}:${c.deployment.custody}:${c.release.sourceBundle}`;
export const draftKey = (network: NativeNetwork) => `allowit.native.v2:${network}:draft`;
/** ABI-v1 saved policies stay on the device untouched. This page only reports that they exist. */
export function legacyPolicySaved(storage: Storage): boolean {
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k?.startsWith('allowit.native.v1:')) continue;
      const v = JSON.parse(storage.getItem(k) ?? 'null');
      if (v?.policy || v?.owner) return true;
    }
  } catch {
    /* Unreadable storage holds nothing this page can report. */
  }
  return false;
}

/* ------------------------------------------------------------ amounts */

/** Exact base units to a display amount with at least two decimals. */
export function fmt(n: bigint | string) {
  const [whole, fraction = ''] = decimal(BigInt(n)).split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

/** Parses an owner-typed amount into exact base units. Accepts a decimal comma; never rounds. */
export function parseAmount(raw: string, max?: bigint, maxError?: string): {amount: bigint | null; error: string | null} {
  let v = raw.trim();
  if (!v) return {amount: null, error: 'Enter an amount.'};
  if (v.startsWith('-')) return {amount: null, error: 'Enter an amount above 0.'};
  if (!/^\d*[.,]?\d*$/.test(v) || !/\d/.test(v)) return {amount: null, error: 'Use digits and a decimal point or comma, without separators.'};
  v = v.replace(',', '.').replace(/^0+(?=\d)/, '').replace(/\.$/, '');
  let n: bigint;
  try {
    n = units(v.startsWith('.') ? `0${v}` : v);
  } catch (e) {
    return {amount: null, error: e instanceof Error && /u64/.test(e.message) ? 'That amount is too large.' : 'Use a number with at most six decimal places.'};
  }
  if (n === 0n) return {amount: null, error: 'Enter an amount above 0.'};
  if (max !== undefined && n > max) return {amount: null, error: maxError ?? `The most you can enter is ${fmt(max)}.`};
  return {amount: n, error: null};
}

/** Today's spend, by UTC day. Display only; the program uses finalized chain time. */
export function spentToday(state: Pick<VaultState, 'spent' | 'spentDay'>, now = Date.now()) {
  return BigInt(state.spentDay) === BigInt(Math.floor(now / 86_400_000)) ? BigInt(state.spent) : 0n;
}

/** A PaySH whitelist row as the owner types it. */
export interface WhitelistRow {key: number; id: string; recipient: string}

/**
 * The owner's PaySH whitelist, checked as the server checks it. Rows left completely blank are ignored. Each listed
 * service needs both its ID and the token account it is paid at; IDs and accounts appear once.
 */
export function checkWhitelist(rows: readonly WhitelistRow[]): {services: AllowedService[]; error: string | null} {
  const services = rows.map(r => ({id: r.id.trim(), recipient: r.recipient.trim()})).filter(r => r.id || r.recipient);
  const fail = (error: string) => ({services: [], error});
  if (services.length > MAX_ALLOWED_SERVICES) return fail(`List at most ${MAX_ALLOWED_SERVICES} services.`);
  for (const s of services) {
    if (!s.id || !s.recipient) return fail('Each service needs its ID and the token account it is paid at.');
    if (!/^[A-Za-z0-9./_:-]{1,64}$/.test(s.id)) return fail('Use a service ID of letters, digits, dots, slashes, dashes, underscores or colons.');
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.recipient)) return fail(`${s.id}: use a Solana token account address.`);
    try {if (new PublicKey(s.recipient).toBase58() !== s.recipient) return fail(`${s.id}: use a Solana token account address.`);}
    catch {return fail(`${s.id}: use a Solana token account address.`);}
  }
  if (new Set(services.map(s => s.id)).size !== services.length || new Set(services.map(s => s.recipient)).size !== services.length) return fail('List each service and token account once.');
  return {services, error: null};
}
