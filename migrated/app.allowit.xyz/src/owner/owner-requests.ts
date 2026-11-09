/**
 * Owner answers to agent requests that wait for the owner, shared by every route. The owner signs one readable,
 * origin-bound message per answer through Wallet Standard `solana:signMessage`. The signature itself moves no funds and
 * changes no policy. Yes answers one question of one request only; for PaySH it queues a new, full policy evaluation in
 * which only that question counts as answered, never an approved payment. The server is the authority: it binds the
 * challenge to the session owner and the question's immutable intent and consumes each decision once.
 *
 * Rules kept here, independent of the UI:
 * - The request is fetched again before any wallet prompt, so an answer from another tab is found first.
 * - Every listed item and challenge names the verified owner and this exact origin. Anything else fails closed.
 * - The signed message is parsed, not searched: a fixed two-line header, a fixed notice, then one JSON object whose
 *   every field must equal the challenge and the request on screen. Duplicate or unknown fields fail before signing.
 * - The exact current owner is checked against the server session before and after signing.
 * - A wallet refusal, or any wallet error, leaves the request pending. It is never recorded as No.
 * - A returned signature is stored with its message before it is sent. A lost reply is resolved from the server list,
 *   including its history of earlier answers for the same request; the same proof is sent again only on an explicit
 *   request, and the wallet is never asked again for the same question while it exists.
 * - One request can ask a new question after an answer. An old answer is matched only by its decision ID and is never
 *   shown or counted as the answer to a newer question.
 * - Expired is its own outcome, never a No, even when a signed Yes expired before the agent continued.
 * - Absence from the list is never read as answered or denied.
 * - An optional owner note (the reason) is signed exactly as entered, never trimmed or normalized. It is in the signed
 *   message only when it is not empty, so an answer without a note signs the earlier message unchanged. The challenge
 *   request, challenge, signed message, saved proof and every send of that proof carry the same note.
 */
import {ApiError, request} from '../api';
import {isUserRefusal} from '../wallet/wallet';

export type OwnerRequestKind = 'micro' | 'paysh' | 'native';
export type Decision = 'yes' | 'no';
export interface OwnerRequestRef {kind: OwnerRequestKind; policyId: string; requestId: string}
/** One earlier, consumed answer for the same request. It may belong to a different question than the current one. */
export interface PastDecision {decisionId: string; approved: boolean; answeredAt: number; expiresAt: number; origin: string}
export interface OwnerRequest extends OwnerRequestRef {
  owner: string;
  /** Empty only on an item that has not been signed for yet. */
  origin: string;
  status: string;
  question: string;
  purpose: string;
  network: string;
  inputHash: string;
  scope: Record<string, unknown>;
  envelope: Record<string, unknown>;
  scoreBps?: number;
  thresholdBps?: number;
  /** Unix seconds. */
  expiresAt?: number;
  approved?: boolean;
  /** Unix seconds. */
  answeredAt?: number;
  decisionId?: string;
  /** The owner's signed note for the recorded answer. Set only on an answered item with a nonempty note. */
  note?: string;
  /** Native: one-based position of this question among those the same purchase asked. */
  questionNumber?: number;
  decisionHistory: PastDecision[];
}
export interface OwnerBinding extends OwnerRequestRef {origin: string; owner: string; network: string; inputHash: string; question: string; purpose: string; scope: Record<string, unknown>; envelope: Record<string, unknown>}
export interface OwnerChallenge {decisionId: string; message: string; expiresAt: number; decision: Decision; binding: OwnerBinding; note: string}
export interface OwnerAnswer extends OwnerRequestRef {status: string; approved: boolean; decisionId: string; answeredAt: number; note: string}
/**
 * Exactly what was signed and is sent again on recovery. No cookie, session or key. `note` is the signed note, empty
 * when the message has none; a proof saved before notes existed reads as an empty note.
 */
export interface SignedProof {v: 2; origin: string; owner: string; ref: OwnerRequestRef; intent: string; decision: Decision; decisionId: string; message: string; signature: string; expiresAt: number; signedAt: number; note: string}

export class OwnerContractError extends Error {}
const fail = (what: string) => new OwnerContractError(`The owner request ${what}. Nothing was signed.`);

/* ------------------------------------------------------------------ values */

const ID = /^[A-Za-z0-9_:.-]{1,128}$/;
/** A PaySH service ID, as the public CLI accepts it (e.g. `solana-foundation/google/airquality`). Not for request or decision IDs. */
const SERVICE_ID = /^[A-Za-z0-9_:./-]{1,200}$/;
const HASH = /^[A-Za-z0-9_:.+/=-]{8,200}$/;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
// Line breaks and tabs only. Other C0/C1 controls, bidirectional marks, overrides and isolates, zero-width and other
// invisible format characters, line and paragraph separators and the byte order mark could disguise a message.
const UNREADABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/;
// An owner note also permits the zero-width non-joiner and joiner (U+200C, U+200D), which emoji sequences and scripts
// such as Persian need. Every other character above stays unreadable, as the backend requires.
const NOTE_UNREADABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/;
/** A challenge lives at most five minutes. */
export const MAX_TTL_SECONDS = 300;
/** Tolerated difference between this device's clock and the server's when checking a challenge expiry. */
const CLOCK_SKEW_SECONDS = 60;
const MAX_HISTORY = 64;
/** The backend's limit for an owner note, in UTF-8 bytes. */
export const MAX_NOTE_BYTES = 2000;
/** The existing ceiling for non-native signed messages, including a fully escaped note. */
const MAX_MESSAGE_CHARS = 16_000 + 2 * MAX_NOTE_BYTES;
/**
 * Native messages also carry the original context (16,384 UTF-8 bytes, 128 children, depth 8).
 * Allow its pretty-print whitespace, bounded binding fields and note without truncating signed data.
 * This is a UTF-16 character ceiling; only a fully validated native binding gets the larger limit.
 */
const MAX_NATIVE_MESSAGE_CHARS = 65_536;
export const MESSAGE_TITLE = 'AllowIt owner decision v1';
export const MESSAGE_DOMAIN = 'allowit-owner-decision';
type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const words = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !UNREADABLE.test(v);
const bps = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000;
const seconds = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const origin = (v: unknown): v is string => typeof v === 'string' && ORIGIN.test(v);
/** Every key and string in a shown or signed JSON value is readable. */
const readable = (v: unknown, depth = 0): boolean =>
  depth <= 16 && (typeof v === 'string' ? !UNREADABLE.test(v) : Array.isArray(v) ? v.every(x => readable(x, depth + 1)) : isRecord(v) ? Object.entries(v).every(([k, x]) => !UNREADABLE.test(k) && readable(x, depth + 1)) : true);
const exactKeys = (v: Json, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

const utf8 = new TextEncoder();
const MAX_NATIVE_CONTEXT_BYTES = 16_384;
const MAX_NATIVE_CONTEXT_DEPTH = 8;
const MAX_NATIVE_CONTEXT_VALUES = 128;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** The size the backend counts. */
export const noteBytes = (note: string) => utf8.encode(note).length;

/** Mirrors the Rust runtime-context admission contract for native owner questions. */
function readableNativeContext(value: unknown): boolean {
  if (!isRecord(value)) return false;
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { return false; }
  if (encoded === undefined) return false;
  if (utf8.encode(encoded).length > MAX_NATIVE_CONTEXT_BYTES) return false;
  let values = 0;
  const walk = (current: unknown, depth: number): boolean => {
    if (depth > MAX_NATIVE_CONTEXT_DEPTH) return false;
    if (typeof current === 'string') return !UNREADABLE.test(current);
    if (current === null || typeof current === 'boolean') return true;
    if (typeof current === 'number') return Number.isFinite(current);
    const entries = Array.isArray(current) ? current.map((child, index) => [String(index), child] as const) : isRecord(current) ? Object.entries(current) : null;
    if (!entries) return false;
    for (const [key, child] of entries) {
      if (!Array.isArray(current) && (!key || utf8.encode(key).length > 128 || UNREADABLE.test(key))) return false;
      values += 1;
      if (values > MAX_NATIVE_CONTEXT_VALUES || !walk(child, depth + 1)) return false;
    }
    return true;
  };
  return walk(value, 0);
}
export type NoteProblem = 'unreadable' | 'blank' | 'too_long';
/**
 * Null for a note that can be signed as entered: empty, or visible text within the UTF-8 limit. The signed-message rules
 * apply, except that U+200C and U+200D are permitted, plus no carriage return and no unpaired surrogate, which UTF-8
 * cannot carry. A note is never trimmed or normalized; one with only spaces or line breaks is refused rather than
 * signed as invisible text.
 */
export function noteProblem(note: string): NoteProblem | null {
  if (!note) return null;
  if (NOTE_UNREADABLE.test(note) || note.includes('\r') || LONE_SURROGATE.test(note)) return 'unreadable';
  if (noteBytes(note) > MAX_NOTE_BYTES) return 'too_long';
  if (!/\S/.test(note)) return 'blank';
  return null;
}
const validNote = (v: unknown): v is string => typeof v === 'string' && noteProblem(v) === null;

export const refKey = (r: OwnerRequestRef) => `${r.kind}|${r.policyId}|${r.requestId}`;
export const sameRef = (a: OwnerRequestRef, b: OwnerRequestRef) => a.kind === b.kind && a.policyId === b.policyId && a.requestId === b.requestId;

/** Key-order independent JSON equality. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isRecord(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
export const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

type Intent = Pick<OwnerBinding, 'kind' | 'policyId' | 'requestId' | 'network' | 'inputHash' | 'question' | 'purpose' | 'scope' | 'envelope'>;
/**
 * The question being answered, independent of key order. One request ID can carry several questions in turn, so every
 * per-question state (a saved proof, a note, an optimistic answer) is bound to this, not to the request ID alone.
 */
export const intentKey = (r: Intent) =>
  canonical({kind: r.kind, policyId: r.policyId, requestId: r.requestId, network: r.network, inputHash: r.inputHash, question: r.question, purpose: r.purpose, scope: r.scope, envelope: r.envelope});
/** The signed intent. A request whose intent changed after it was shown is reviewed again, never signed. */
export const sameIntent = (a: Intent, b: Intent) => intentKey(a) === intentKey(b);

export const isAnswered = (r: OwnerRequest) => typeof r.approved === 'boolean';
/** Only `awaiting_input` without a recorded answer can be answered. */
export const isPending = (r: OwnerRequest) => r.status === 'awaiting_input' && !isAnswered(r);

export type ItemPhase = 'pending' | 'answered' | 'expired' | 'closed';
/** `expired` is never a No: an item can be expired with a signed Yes that the agent did not use in time. */
export function itemPhase(r: OwnerRequest, nowMs: number): ItemPhase {
  if (r.status === 'expired') return 'expired';
  if (isAnswered(r)) return 'answered';
  if (r.status !== 'awaiting_input') return 'closed';
  return r.expiresAt !== undefined && r.expiresAt * 1000 <= nowMs ? 'expired' : 'pending';
}

/** Earlier answer with this decision ID, at the top level or in the history, for this origin. */
export function findDecision(item: OwnerRequest, decisionId: string, at: string): {approved: boolean; answeredAt?: number; current: boolean} | null {
  if (item.decisionId === decisionId && isAnswered(item) && (!item.origin || item.origin === at)) return {approved: item.approved!, answeredAt: item.answeredAt, current: true};
  const past = item.decisionHistory.find(d => d.decisionId === decisionId && d.origin === at);
  return past ? {approved: past.approved, answeredAt: past.answeredAt, current: false} : null;
}

function parseHistory(v: unknown): PastDecision[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_HISTORY) return null;
  const out: PastDecision[] = [];
  for (const d of v) {
    if (!isRecord(d) || !id(d.decisionId) || typeof d.approved !== 'boolean' || !seconds(d.answeredAt) || !seconds(d.expiresAt) || !origin(d.origin)) return null;
    if (out.some(p => p.decisionId === d.decisionId)) return null;
    out.push({decisionId: d.decisionId, approved: d.approved, answeredAt: d.answeredAt, expiresAt: d.expiresAt, origin: d.origin});
  }
  return out;
}

export interface NativePurchase {
  executionPolicyId: string; revision: number; sourceHash: string; irHash: string; executionPolicyDigest: string;
  amount: string; token: 'USDC'; mint: string; recipient: string; action: string; merchant: string;
  inputKey: string; contextHash: string; requestExpiresAt: number; context?: unknown;
}
/** The original request, never inferred from a later server summary or an editable owner note. */
export function nativePurchase(value: Pick<OwnerBinding, 'network' | 'inputHash' | 'scope' | 'envelope'>): NativePurchase | null {
  const s=value.scope,e=value.envelope,hex=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
  const address=(v:unknown)=>typeof v==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  const keys=['inputKey','amount','token','mint','recipient','action','merchant','contextHash','requestExpiresAt'];
  if(value.network!=='solana:devnet'||!hex(value.inputHash)||!exactKeys(s,['executionPolicyId','revision','sourceHash','irHash','executionPolicyDigest'])
    ||!id(s.executionPolicyId)||!Number.isSafeInteger(s.revision)||Number(s.revision)<1||!hex(s.sourceHash)||!hex(s.irHash)||!hex(s.executionPolicyDigest)
    ||!exactKeys(e,Object.hasOwn(e,'context')?[...keys,'context']:keys)||!hex(e.inputKey)||!hex(e.contextHash)
    ||typeof e.amount!=='string'||e.amount.length>24||!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(e.amount)||!/[1-9]/.test(e.amount)
    ||e.token!=='USDC'||!address(e.mint)||!address(e.recipient)||!words(e.action,200)||typeof e.merchant!=='string'||e.merchant.length>200||UNREADABLE.test(e.merchant)
    ||!seconds(e.requestExpiresAt)||(Object.hasOwn(e,'context')&&e.context!==null&&!readableNativeContext(e.context)))return null;
  return {...s,...e} as unknown as NativePurchase;
}

const TASK_FIELDS = ['task', 'item', 'paymentPurpose', 'purpose', 'description', 'title'] as const;
/**
 * What tells two waiting native purchases apart at a glance. Policy questions repeat across purchases, so the card leads
 * with the amount, payee and the agent's own stated task. The task is an unverified claim and is labelled as one.
 */
export function nativePurchaseSummary(item: OwnerRequest): {amount: string; recipient: string; merchant: string; action: string; task?: string; questionNumber?: number} | null {
  const purchase = nativePurchase(item);
  if (!purchase) return null;
  const context = isRecord(purchase.context) ? purchase.context : {};
  const found = TASK_FIELDS.map(key => context[key]).find((v): v is string => typeof v === 'string' && v.trim() !== '' && !UNREADABLE.test(v));
  const task = found === undefined ? undefined : found.trim().length > 160 ? `${found.trim().slice(0, 159)}…` : found.trim();
  return {amount: purchase.amount, recipient: purchase.recipient, merchant: purchase.merchant, action: purchase.action, ...(task ? {task} : {}), ...(item.questionNumber ? {questionNumber: item.questionNumber} : {})};
}

function parseItem(v: unknown, owner: string, at: string): OwnerRequest | null {

  if (!isRecord(v)) return null;
  if ((v.kind !== 'micro' && v.kind !== 'paysh' && v.kind !== 'native') || !id(v.policyId) || !id(v.requestId)) return null;
  // Another owner's item, or one bound to another site, is never shown or answered here.
  if (v.owner !== owner || (v.origin !== '' && v.origin !== at)) return null;
  if (!words(v.status, 64) || !words(v.question, 4000) || !words(v.purpose, 4000) || !words(v.network, 64)) return null;
  if (typeof v.inputHash !== 'string' || !HASH.test(v.inputHash) || !isRecord(v.scope) || !isRecord(v.envelope) || !readable(v.scope) || !readable(v.envelope)) return null;
  const history = parseHistory(v.decisionHistory);
  if (!history) return null;
  const item: OwnerRequest = {kind: v.kind, owner, origin: v.origin, policyId: v.policyId, requestId: v.requestId, status: v.status, question: v.question, purpose: v.purpose, network: v.network, inputHash: v.inputHash, scope: v.scope, envelope: v.envelope, decisionHistory: history};
  if (v.scoreBps !== undefined) { if (!bps(v.scoreBps)) return null; item.scoreBps = v.scoreBps; }
  if (v.thresholdBps !== undefined) { if (!bps(v.thresholdBps)) return null; item.thresholdBps = v.thresholdBps; }
  if (v.expiresAt !== undefined) { if (!seconds(v.expiresAt)) return null; item.expiresAt = v.expiresAt; }
  if (v.approved !== undefined) { if (typeof v.approved !== 'boolean') return null; item.approved = v.approved; }
  if (v.answeredAt !== undefined) { if (!seconds(v.answeredAt)) return null; item.answeredAt = v.answeredAt; }
  if (v.decisionId !== undefined) { if (!id(v.decisionId)) return null; item.decisionId = v.decisionId; }
  if (v.questionNumber !== undefined) { if (!Number.isSafeInteger(v.questionNumber) || Number(v.questionNumber) < 1 || Number(v.questionNumber) > 64) return null; item.questionNumber = Number(v.questionNumber); }
  // An unanswered item's note belongs to a challenge not yet signed: it is ignored, never shown and never a reason to
  // drop the request. A recorded answer's note is the signed reason and must be valid.
  if (item.approved !== undefined && v.note !== undefined) { if (!validNote(v.note)) return null; if (v.note) item.note = v.note; }
  // A recorded answer names its decision and is not still waiting; history never repeats the current decision.
  if (item.kind === 'native' && (!nativePurchase(item) || item.expiresAt === undefined || item.expiresAt > Number(item.envelope.requestExpiresAt))) return null;
  if (item.approved !== undefined && (item.status === 'awaiting_input' || item.decisionId === undefined)) return null;
  if (item.decisionId !== undefined && history.some(d => d.decisionId === item.decisionId)) return null;
  return item;
}

/**
 * `GET owner/requests`: one current item per request, for the verified owner. An unreadable item, or one for another
 * owner or site, is left out and counted; it can never be answered. Items sharing one reference are all left out,
 * because the request they describe is ambiguous.
 */
export function parseInbox(value: unknown, owner: string, at: string): {items: OwnerRequest[]; unreadable: number} {
  if (!isRecord(value) || !Array.isArray(value.requests)) throw new OwnerContractError('The owner request list could not be read.');
  const parsed = value.requests.map(v => parseItem(v, owner, at));
  const counts = new Map<string, number>();
  for (const item of parsed) if (item) counts.set(refKey(item), (counts.get(refKey(item)) ?? 0) + 1);
  const items = parsed.filter((item): item is OwnerRequest => !!item && counts.get(refKey(item)) === 1);
  return {items, unreadable: value.requests.length - items.length};
}

/* ------------------------------------------------------------------ signed message */

/**
 * Strict JSON for the signed message. Unlike `JSON.parse` it refuses duplicate keys, which could otherwise show one
 * value and sign another, and numbers that would not survive a round trip exactly.
 */
export function strictJson(text: string): unknown {
  let i = 0;
  const bad = (): never => { throw new SyntaxError('Not strict JSON.'); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const str = (): string => {
    const start = i;
    if (text[i++] !== '"') bad();
    for (;;) {
      if (i >= text.length) bad();
      const c = text[i++];
      if (c === '"') break;
      if (c < ' ') bad();
      if (c === '\\') {
        const e = text[i++];
        if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i, i + 4))) bad(); i += 4; }
        else if (!'"\\/bfnrt'.includes(e ?? 'x')) bad();
      }
    }
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (depth: number): unknown => {
    if (depth > 16) bad();
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const out: Json = {};
      ws();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        ws();
        const k = str();
        if (Object.hasOwn(out, k)) bad();
        ws();
        if (text[i++] !== ':') bad();
        out[k] = value(depth + 1);
        ws();
        const n = text[i++];
        if (n === '}') return out;
        if (n !== ',') bad();
      }
    }
    if (c === '[') {
      i++;
      const out: unknown[] = [];
      ws();
      if (text[i] === ']') { i++; return out; }
      for (;;) {
        out.push(value(depth + 1));
        ws();
        const n = text[i++];
        if (n === ']') return out;
        if (n !== ',') bad();
      }
    }
    if (c === '"') return str();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) if (text.startsWith(word, i)) { i += word.length; return v; }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) bad();
    i += m![0].length;
    const n = Number(m![0]);
    if (!Number.isFinite(n) || String(n) !== m![0] || (Number.isInteger(n) && !Number.isSafeInteger(n))) bad();
    return n;
  };
  const out = value(0);
  ws();
  if (i !== text.length) bad();
  return out;
}

const BINDING_KEYS = ['kind', 'origin', 'owner', 'network', 'policyId', 'requestId', 'inputHash', 'question', 'purpose', 'scope', 'envelope'] as const;
const SIGNED_KEYS = ['domain', 'version', 'origin', 'decision', 'nonce', 'issuedAt', 'expiresAt', 'expiryMeaning', 'binding'] as const;
/** A nonempty note is one more signed field. An empty note is absent, so the message is the earlier one unchanged. */
const signedKeys = (note: string): readonly string[] => (note ? [...SIGNED_KEYS, 'note'] : SIGNED_KEYS);
/** The note signed in a message: empty when it has none, null when it is present but not a valid, nonempty note. */
function signedNote(c: Json): string | null {
  if (!Object.hasOwn(c, 'note')) return '';
  return validNote(c.note) && c.note ? c.note : null;
}
/** A PaySH challenge also names `startDeadline`, equal to its expiry. Any other challenge omits it. */
const CHALLENGE_KEYS = ['decisionId', 'message', 'expiresAt', 'expiryMeaning', 'decision', 'binding', 'note'] as const;
const PAYSH_CHALLENGE_KEYS = [...CHALLENGE_KEYS, 'startDeadline'] as const;
/**
 * What the expiry bounds, stated in the challenge and the signed message alike. PaySH: the answer and the start of the
 * agent's continuation (its first native authorization); later stages keep their own native request expiry, policy
 * expiry, pause and hard limits. Other requests: the answer only.
 */
export type ExpiryMeaning = 'answer_and_start_deadline' | 'answer_deadline';
export const expiryMeaningFor = (kind: OwnerRequestKind): ExpiryMeaning => (kind === 'paysh' ? 'answer_and_start_deadline' : 'answer_deadline');

/**
 * The PaySH envelope: the one quote the owner is asked about, with the service input, payee, token and policy
 * allocation it was quoted for. Its caps equal that quote exactly (payment, swap input, minimum swap output and
 * per-execution service fee), never the policy's broader maxima. Amounts are integer base units: six decimals for the
 * payment token, lamports for SOL.
 */
export interface PayshLimits {
  serviceId: string;
  /** The service input the quote was made for. */
  input: Record<string, unknown>;
  /** The payee token account and the payment token mint. */
  recipient: string;
  mint: string;
  allocationLamports: number;
  amountUsdc: number;
  /** Null when the quote needs no swap. */
  swap: {amountInLamports: number; minOutUsdc: number} | null;
  feeLamportsPerExecution: number;
  maxExecutions: 1 | 2;
  maxTotalFeeLamports: number;
  scoreBps: number;
  thresholdBps: number;
}
/** Exactly the backend's owner-binding serialization of a PaySH envelope: all sixteen fields, no others. */
const PAYSH_ENVELOPE_KEYS = ['allocationLamports', 'input', 'maxExecutions', 'maxPaymentUsdc', 'maxServiceFeeLamportsPerExecution', 'maxSwapLamports', 'maxTotalServiceFeeLamports', 'minSwapOutputUsdc', 'mint', 'originalAmountUsdc', 'originalServiceFeeLamportsPerExecution', 'originalSwap', 'recipient', 'scoreBps', 'serviceId', 'thresholdBps'] as const;
const units = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** A base58 Solana address. */
const address = (v: unknown): v is string => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const MAX_INPUT_CHARS = 4000;
/** A service input is one readable JSON object of bounded size; nesting is bounded by the strict signed-JSON parser. */
const serviceInput = (v: unknown): v is Json => isRecord(v) && readable(v) && canonical(v).length <= MAX_INPUT_CHARS;
/**
 * Null unless the envelope has exactly the PaySH fields and every cap equals the original quote: two executions with a
 * swap (swap, then payment), one without.
 */
export function payshLimits(e: Record<string, unknown>): PayshLimits | null {
  if (!exactKeys(e, PAYSH_ENVELOPE_KEYS) || typeof e.serviceId !== 'string' || !SERVICE_ID.test(e.serviceId) || !bps(e.scoreBps) || !bps(e.thresholdBps)) return null;
  const {input, recipient, mint, allocationLamports: allocation} = e;
  if (!serviceInput(input) || !address(recipient) || !address(mint) || !units(allocation)) return null;
  const {originalAmountUsdc: amount, originalServiceFeeLamportsPerExecution: fee, maxExecutions: runs, maxTotalServiceFeeLamports: total} = e;
  if (!units(amount) || !units(fee) || !units(total) || (runs !== 1 && runs !== 2)) return null;
  const s = e.originalSwap;
  let swap: PayshLimits['swap'] = null;
  if (s !== null) {
    if (!isRecord(s) || !exactKeys(s, ['type', 'amountInLamports', 'minOutUsdc']) || s.type !== 'swap' || !units(s.amountInLamports) || !units(s.minOutUsdc) || s.amountInLamports === 0) return null;
    swap = {amountInLamports: s.amountInLamports, minOutUsdc: s.minOutUsdc};
  }
  if (runs !== (swap ? 2 : 1)) return null;
  if (e.maxPaymentUsdc !== amount || e.maxSwapLamports !== (swap?.amountInLamports ?? 0) || e.minSwapOutputUsdc !== (swap?.minOutUsdc ?? 0) || e.maxServiceFeeLamportsPerExecution !== fee) return null;
  if (BigInt(total) > BigInt(fee) * BigInt(runs)) return null;
  return {serviceId: e.serviceId, input, recipient, mint, allocationLamports: allocation, amountUsdc: amount, swap, feeLamportsPerExecution: fee, maxExecutions: runs, maxTotalFeeLamports: total, scoreBps: e.scoreBps, thresholdBps: e.thresholdBps};
}

/**
 * Reads `AllowIt owner decision v1`, `Answer: Yes|No`, the fixed notice and one pretty-printed JSON object to the end
 * of the message. The notice is plain prose: it may not restate an answer or carry structured data. Returns the
 * signed content and the decision of the header, which must agree.
 */
export function readMessage(message: string): {decision: Decision; content: Json} | null {
  // The raw text may carry the joiners of a note. Every other part keeps the strict rules below.
  if (typeof message !== 'string' || !message || message.length > MAX_NATIVE_MESSAGE_CHARS || NOTE_UNREADABLE.test(message)) return null;
  const lines = message.split('\n');
  if (lines[0] !== MESSAGE_TITLE) return null;
  const header = /^Answer: (Yes|No)$/.exec(lines[1] ?? '');
  if (!header) return null;
  const open = lines.indexOf('{', 2);
  if (open < 3) return null;
  const notice = lines.slice(2, open);
  if (!notice.some(l => l.trim()) || notice.join('\n').length > 2000) return null;
  // The notice may mention when to answer, but never states an answer line of its own.
  if (notice.some(l => UNREADABLE.test(l) || /[{}\r]/.test(l) || /^\s*(?:answer|decision)\s*:/i.test(l) || l.startsWith(MESSAGE_TITLE))) return null;
  let content: unknown;
  try { content = strictJson(lines.slice(open).join('\n')); } catch { return null; }
  if (!isRecord(content)) return null;
  if (message.length > MAX_MESSAGE_CHARS) {
    const binding = readBinding(content.binding);
    if (binding?.kind !== 'native' || !nativePurchase(binding)) return null;
  }
  // Only the note may contain joiners; signedNote checks it with the note rules.
  if (!Object.entries(content).every(([k, x]) => !UNREADABLE.test(k) && (k === 'note' || readable(x)))) return null;
  return {decision: header[1] === 'Yes' ? 'yes' : 'no', content};
}

function readBinding(b: unknown): OwnerBinding | null {
  if (!isRecord(b) || !exactKeys(b, BINDING_KEYS)) return null;
  if ((b.kind !== 'micro' && b.kind !== 'paysh' && b.kind !== 'native') || !id(b.policyId) || !id(b.requestId) || !origin(b.origin) || typeof b.owner !== 'string' || !b.owner) return null;
  if (!words(b.network, 64) || typeof b.inputHash !== 'string' || !HASH.test(b.inputHash) || !words(b.question, 4000) || !words(b.purpose, 4000) || !isRecord(b.scope) || !isRecord(b.envelope) || !readable(b.scope) || !readable(b.envelope)) return null;
  return {kind: b.kind, origin: b.origin, owner: b.owner, network: b.network, policyId: b.policyId, requestId: b.requestId, inputHash: b.inputHash, question: b.question, purpose: b.purpose, scope: b.scope, envelope: b.envelope};
}

/**
 * `POST owner/requests/challenge`. Fails closed unless the challenge has exactly the expected fields, its binding names
 * this origin, owner and the listed request field by field, its expiry is fresh and at most five minutes, its expiry
 * meaning matches the request kind (PaySH: with a start deadline equal to the expiry, and never later than the listed
 * deadline, which a PaySH request must have), a PaySH envelope caps exactly
 * its original quote, and the signed message parses to the same domain, version, origin, answer, nonce, expiry, expiry
 * meaning and complete binding.
 */
export function validateChallenge(value: unknown, item: OwnerRequest, decision: Decision, owner: string, at: string, nowMs: number, note = ''): OwnerChallenge {
  if (!isRecord(value)) throw fail('challenge could not be read');
  if (!validNote(note)) throw fail('reason cannot be signed as written');
  const paysh = item.kind === 'paysh';
  if (!exactKeys(value, paysh ? PAYSH_CHALLENGE_KEYS : CHALLENGE_KEYS)) throw fail('challenge has unexpected or missing fields');
  const {decisionId, message, expiresAt} = value;
  if (!id(decisionId)) throw fail('challenge has no valid decision ID');
  if (value.decision !== decision) throw fail('challenge is for a different answer');
  if (value.note !== note) throw fail('challenge reason is not the reason entered');
  const now = Math.floor(nowMs / 1000);
  if (!seconds(expiresAt) || expiresAt <= now || expiresAt > now + MAX_TTL_SECONDS + CLOCK_SKEW_SECONDS) throw fail('challenge expiry is not valid');
  if (value.expiryMeaning !== expiryMeaningFor(item.kind)) throw fail('challenge expiry meaning is not valid for this request');
  if (paysh && value.startDeadline !== expiresAt) throw fail('challenge start deadline is not its expiry');
  // The listed deadline is the latest permitted; a challenge may only narrow it.
  if (paysh && item.expiresAt === undefined) throw fail('has no answer-and-start deadline');
  if (paysh && expiresAt > item.expiresAt!) throw fail('challenge start deadline is later than the deadline shown');
  const b = readBinding(value.binding);
  if (!b) throw fail('challenge binding could not be read');
  if (b.origin !== at) throw fail('challenge belongs to another site');
  if (b.owner !== owner || item.owner !== owner) throw fail('challenge is for a different owner');
  if (!sameRef(b, item)) throw fail('challenge is for a different request');
  if (b.network !== item.network) throw fail('challenge is for a different network');
  if (b.inputHash !== item.inputHash) throw fail('challenge input does not match the request');
  if (b.question !== item.question || b.purpose !== item.purpose) throw fail('challenge question does not match the request');
  if (!sameJson(b.scope, item.scope)) throw fail('challenge scope does not match the request');
  if (!sameJson(b.envelope, item.envelope)) throw fail('challenge limits do not match the request');
  if (paysh && !payshLimits(b.envelope)) throw fail('challenge limits are not exactly the original quote');
  if (item.kind === 'native') {
    const purchase=nativePurchase(b);
    if(!purchase||item.expiresAt===undefined||expiresAt>item.expiresAt||expiresAt>purchase.requestExpiresAt) throw fail('challenge is not the original native purchase within its deadline');
  }

  if (typeof message !== 'string') throw fail('challenge message is not readable text');
  const read = readMessage(message);
  if (!read) throw fail('challenge message is not in the expected form');
  if (read.decision !== decision) throw fail('challenge message does not state this answer');
  const c = read.content;
  if (!exactKeys(c, signedKeys(note))) throw fail('challenge message has unexpected or missing fields');
  if (signedNote(c) !== note) throw fail('challenge message reason is not the reason entered');
  if (c.domain !== MESSAGE_DOMAIN || c.version !== 1) throw fail('challenge message is not an Allowit owner decision');
  if (c.origin !== at) throw fail('challenge message belongs to another site');
  if (c.decision !== decision) throw fail('challenge message does not state this answer');
  if (c.nonce !== decisionId) throw fail('challenge message is for another decision');
  if (c.expiresAt !== expiresAt || !seconds(c.issuedAt) || c.issuedAt >= expiresAt || expiresAt - c.issuedAt > MAX_TTL_SECONDS || c.issuedAt > now + CLOCK_SKEW_SECONDS) throw fail('challenge message expiry is not valid');
  const signed = readBinding(c.binding);
  if (!signed || !sameJson(signed, b)) throw fail('challenge message does not match the request');
  if (c.expiryMeaning !== value.expiryMeaning) throw fail('challenge expiry meaning does not match the signed message');
  return {decisionId, message, expiresAt, decision, binding: b, note};
}

/**
 * `POST owner/requests/answer`. The reply must name this request, this decision and the signed answer. Its status is
 * the request's current phase: a repeated proof can report a later phase, because another tab or the agent may have
 * continued since, or a new question for the same request. PaySH records No as `denied`.
 */
export function parseAnswer(value: unknown, ref: OwnerRequestRef, decision: Decision, decisionId: string, note = ''): OwnerAnswer {
  if (!isRecord(value) || value.kind !== ref.kind || value.policyId !== ref.policyId || value.requestId !== ref.requestId) throw new OwnerContractError('The answer reply is for a different request.');
  if (value.decisionId !== decisionId || value.approved !== (decision === 'yes') || !words(value.status, 64) || !seconds(value.answeredAt)) throw new OwnerContractError('The answer reply does not match the signed answer.');
  if ((ref.kind === 'paysh' || ref.kind === 'native') && decision === 'no' && value.status !== 'denied') throw new OwnerContractError('The answer reply has an unexpected status.');
  // A reply without a note can only confirm an answer that had none.
  if ((value.note ?? '') !== note) throw new OwnerContractError('The answer reply does not match the signed reason.');
  return {kind: ref.kind, policyId: ref.policyId, requestId: ref.requestId, status: value.status, approved: value.approved, decisionId, answeredAt: value.answeredAt, note};
}

const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const validSignature = (s: unknown): s is string => typeof s === 'string' && SIGNATURE.test(s) && atob(s).length === 64;

/* ------------------------------------------------------------------ proof storage */

export interface ProofStore {read(key: string): string | null; write(key: string, value: string): void; remove(key: string): void; keys(): string[]}
const PROOF = 'allowit.owner-answer.v2:';
const CLAIM = 'allowit.owner-signing.v1:';
const scope = (at: string, owner: string) => `${at}|${owner}|`;
/** One key per decision: a request can hold a proof for an earlier question while a newer one is answered. */
export const proofKey = (at: string, owner: string, ref: OwnerRequestRef, decisionId: string) => `${PROOF}${scope(at, owner)}${refKey(ref)}|${decisionId}`;
export const isProofKey = (key: string | null) => !!key && (key.startsWith(PROOF) || key.startsWith(CLAIM));

/** localStorage, so a proof survives reload and is visible to other tabs; sessionStorage when it is unavailable. */
export function browserStore(): ProofStore {
  const areas = (): Storage[] => {
    const out: Storage[] = [];
    for (const get of [() => localStorage, () => sessionStorage]) try { out.push(get()); } catch { /* Unavailable. */ }
    return out;
  };
  return {
    read: key => { for (const s of areas()) try { const v = s.getItem(key); if (v !== null) return v; } catch { /* Next area. */ } return null; },
    write: (key, value) => {
      for (const s of areas()) try { s.setItem(key, value); return; } catch { /* Next area. */ }
      throw new Error('Site storage is unavailable.');
    },
    remove: key => { for (const s of areas()) try { s.removeItem(key); } catch { /* Best effort. */ } },
    keys: () => { const out = new Set<string>(); for (const s of areas()) try { for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k) out.add(k); } } catch { /* Next area. */ } return [...out]; },
  };
}

/** The note saved with a proof is exactly the note in its signed message, so the proof sends what was signed. */
function proofNoteMatches(message: string, note: string): boolean {
  const read = readMessage(message);
  return !!read && signedNote(read.content) === note;
}
function readProof(raw: string | null, at: string, owner: string): SignedProof | null {
  if (!raw) return null;
  let p: unknown;
  try { p = JSON.parse(raw); } catch { return null; }
  if (!isRecord(p) || p.v !== 2 || p.origin !== at || p.owner !== owner || !isRecord(p.ref) || typeof p.intent !== 'string') return null;
  const r = p.ref;
  if ((r.kind !== 'micro' && r.kind !== 'paysh' && r.kind !== 'native') || !id(r.policyId) || !id(r.requestId)) return null;
  if ((p.decision !== 'yes' && p.decision !== 'no') || !id(p.decisionId) || typeof p.message !== 'string' || !validSignature(p.signature) || !seconds(p.expiresAt) || !seconds(p.signedAt)) return null;
  // A proof saved before notes existed has no note and a message without one.
  const note = p.note ?? '';
  if (!validNote(note) || !proofNoteMatches(p.message, note)) return null;
  return {v: 2, origin: at, owner, ref: {kind: r.kind, policyId: r.policyId, requestId: r.requestId}, intent: p.intent, decision: p.decision, decisionId: p.decisionId, message: p.message, signature: p.signature, expiresAt: p.expiresAt, signedAt: p.signedAt, note};
}
export function ownerProofs(store: ProofStore, at: string, owner: string): SignedProof[] {
  const prefix = PROOF + scope(at, owner);
  return store
    .keys()
    .filter(k => k.startsWith(prefix))
    .map(k => [k, readProof(store.read(k), at, owner)] as const)
    .filter((e): e is readonly [string, SignedProof] => !!e[1] && e[0] === proofKey(at, owner, e[1].ref, e[1].decisionId))
    .map(e => e[1]);
}
export const refProofs = (store: ProofStore, at: string, owner: string, ref: OwnerRequestRef) => ownerProofs(store, at, owner).filter(p => sameRef(p.ref, ref));
const clearProof = (store: ProofStore, p: SignedProof) => store.remove(proofKey(p.origin, p.owner, p.ref, p.decisionId));

/** One wallet prompt per request across tabs. A claim lapses after two minutes. */
function claim(store: ProofStore, at: string, owner: string, ref: OwnerRequestRef, nowMs: number): boolean {
  const key = CLAIM + scope(at, owner) + refKey(ref);
  const until = Number(store.read(key));
  if (Number.isFinite(until) && until > nowMs) return false;
  store.write(key, String(nowMs + 120_000));
  return true;
}
const release = (store: ProofStore, at: string, owner: string, ref: OwnerRequestRef) => store.remove(CLAIM + scope(at, owner) + refKey(ref));

/* ------------------------------------------------------------------ flow */

export interface OwnerApi {list(): Promise<unknown>; challenge(body: OwnerRequestRef & {decision: Decision; note: string}): Promise<unknown>; answer(body: OwnerRequestRef & {decisionId: string; signature: string; note: string}): Promise<unknown>; session(): Promise<string | null>}
/** A route's verified owner. `current` is false as soon as the route's wallet link or session changes. */
export interface OwnerSigner {owner: string; current(): boolean; sign(message: string): Promise<string>}
export interface OwnerEnv {api: OwnerApi; store: ProofStore; origin: string; now(): number}
export type OwnerPhase = 'checking' | 'signing' | 'sending';

export type Outcome =
  /**
   * The server recorded this signed answer. `earlier` when the request has since moved on to a newer question.
   * `expiresAt` is the exact expiry in the signed message: for a PaySH Yes, the agent's start deadline.
   */
  | {type: 'answered'; answer: OwnerAnswer; intent: string; earlier: boolean; expiresAt: number}
  /** The server lists this question as already answered, from another tab or session. */
  | {type: 'already'; item: OwnerRequest}
  /** The question expired before an answer was recorded, or the signed challenge expired. Not a No. */
  | {type: 'expired'; note: string}
  /** The listed request differs from the one shown. Nothing was signed. */
  | {type: 'changed'; item: OwnerRequest}
  /** The request is not listed as waiting. Nothing was signed; no outcome is inferred. */
  | {type: 'closed'; item?: OwnerRequest}
  /** Nothing was recorded and the request stays pending. */
  | {type: 'kept'; note: string}
  /** A signed answer is saved and not yet confirmed by the server. */
  | {type: 'unconfirmed'; proof: SignedProof; note: string}
  /** The server conclusively refused the signed answer. Its proof is cleared and the request stays pending. */
  | {type: 'rejected'; note: string};

export const httpOwnerApi: OwnerApi = {
  list: () => request('owner/requests'),
  challenge: body => request('owner/requests/challenge', body),
  answer: body => request('owner/requests/answer', body),
  session: async () => {
    const r = await request<{session: {address?: unknown; network?: unknown} | null}>('session');
    return r.session && r.session.network !== 'local:dev' && typeof r.session.address === 'string' ? r.session.address : null;
  },
};

class OwnerChanged extends Error {}
async function verifyOwner(env: OwnerEnv, signer: OwnerSigner) {
  if (!signer.current()) throw new OwnerChanged();
  const address = await env.api.session();
  if (address !== signer.owner || !signer.current()) throw new OwnerChanged();
}
const OWNER_CHANGED = 'The signed-in owner changed. Sign in again as the owner to answer.';
const reason = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

async function listed(env: OwnerEnv, owner: string, ref: OwnerRequestRef): Promise<OwnerRequest | undefined> {
  return parseInbox(await env.api.list(), owner, env.origin).items.find(i => sameRef(i, ref));
}

/** Resolves a saved proof from the server list. Clears it only on a server-confirmed outcome. */
export async function reconcileProof(env: OwnerEnv, proof: SignedProof): Promise<Outcome> {
  let item: OwnerRequest | undefined;
  try { item = await listed(env, proof.owner, proof.ref); }
  catch (e) { return unread(proof, e); }
  return resolved(env, proof, item, false);
}
const unread = (proof: SignedProof, e: unknown): Outcome => ({type: 'unconfirmed', proof, note: `Answer signed, not confirmed. ${reason(e, 'The request list could not be read.')}`});
const answerOf = (item: OwnerRequest, proof: SignedProof, found: {approved: boolean; answeredAt?: number; current: boolean}, nowMs: number): OwnerAnswer => ({
  kind: item.kind,
  policyId: item.policyId,
  requestId: item.requestId,
  status: found.current ? item.status : 'answered',
  approved: found.approved,
  decisionId: proof.decisionId,
  answeredAt: found.answeredAt ?? Math.floor(nowMs / 1000),
  note: proof.note,
});

/**
 * The server's view of one saved proof. `refusedAsExpired` is true only after the server answered this proof with an
 * expiry refusal; with the list confirming nothing was recorded for it, the expired proof is cleared.
 */
function resolved(env: OwnerEnv, proof: SignedProof, item: OwnerRequest | undefined, refusedAsExpired: boolean): Outcome {
  if (item) {
    const found = findDecision(item, proof.decisionId, proof.origin);
    if (found) {
      if (found.approved !== (proof.decision === 'yes')) return {type: 'unconfirmed', proof, note: 'The server reports a different answer for this signature. It stays saved; nothing else was signed.'};
      if (found.current && (item.note ?? '') !== proof.note) return {type: 'unconfirmed', proof, note: 'The server reports a different reason for this signature. It stays saved; nothing else was signed.'};
      clearProof(env.store, proof);
      return {type: 'answered', answer: answerOf(item, proof, found, env.now()), intent: proof.intent, earlier: !found.current, expiresAt: proof.expiresAt};
    }
    const same = intentKey(item) === proof.intent;
    if (same && isAnswered(item) && item.status !== 'expired') {
      clearProof(env.store, proof);
      return {type: 'already', item};
    }
    if (same && itemPhase(item, env.now()) === 'expired' && (item.status === 'expired' || refusedAsExpired)) {
      clearProof(env.store, proof);
      // Another tab or session may have answered first; its answer is reported, never erased by the expiry.
      if (isAnswered(item))
        return {type: 'expired', note: item.approved ? 'This question was answered Yes in another tab or session, and that Yes has since expired. Expiry is not a No. Your saved signature was not used.' : 'This question was answered No in another tab or session and has since expired. Your saved signature was not used.'};
      return {type: 'expired', note: 'This question expired before your answer was recorded. Nothing was approved or denied.'};
    }
    if (refusedAsExpired && proof.expiresAt * 1000 <= env.now()) {
      clearProof(env.store, proof);
      return same && isPending(item)
        ? {type: 'expired', note: 'Your signed answer expired before the server recorded it. Nothing was approved or denied, and the question still waits for you.'}
        : {type: 'expired', note: 'Your signed answer for an earlier question expired before the server recorded it. It cannot answer the current question.'};
    }
  }
  if (!item && refusedAsExpired && proof.expiresAt * 1000 <= env.now()) {
    // Refused as expired and not listed: nothing was recorded for it, and it can never be recorded now.
    clearProof(env.store, proof);
    return {type: 'expired', note: 'Your signed answer expired before the server recorded it, so it approved and denied nothing.'};
  }
  if (item && intentKey(item) !== proof.intent) return {type: 'unconfirmed', proof, note: 'Answer signed for an earlier question of this request. The server has not confirmed it.'};
  return {type: 'unconfirmed', proof, note: item && isPending(item) ? 'Answer signed. The server has not recorded it yet.' : 'Answer signed. The server has not confirmed it yet.'};
}

/** Saved proofs the server list resolves: recorded, superseded by another answer, or expired. The rest stay. */
export function settleProofs(env: OwnerEnv, owner: string, items: readonly OwnerRequest[]): {proof: SignedProof; outcome: Outcome}[] {
  return ownerProofs(env.store, env.origin, owner).flatMap(proof => {
    const item = items.find(i => sameRef(i, proof.ref));
    if (!item) return [];
    const outcome = resolved(env, proof, item, false);
    return outcome.type === 'unconfirmed' ? [] : [{proof, outcome}];
  });
}

/** 422 is a conclusively invalid signature. 409 is an expiry, cleared only after the server list confirms it. */
async function deliver(env: OwnerEnv, proof: SignedProof): Promise<Outcome> {
  let raw: unknown;
  try {
    raw = await env.api.answer({...proof.ref, decisionId: proof.decisionId, signature: proof.signature, note: proof.note});
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) {
      clearProof(env.store, proof);
      return {type: 'rejected', note: `Your answer could not be verified. Nothing was approved. ${e.message}`};
    }
    let item: OwnerRequest | undefined;
    try { item = await listed(env, proof.owner, proof.ref); }
    catch (read) { return unread(proof, read); }
    const seen = resolved(env, proof, item, e instanceof ApiError && e.status === 409);
    if (seen.type === 'unconfirmed' && e instanceof ApiError && (e.status === 401 || e.status === 403)) return {...seen, note: 'Answer signed, not sent. Sign in again as the owner, then send the same answer.'};
    return seen;
  }
  let answer: OwnerAnswer;
  try { answer = parseAnswer(raw, proof.ref, proof.decision, proof.decisionId, proof.note); }
  catch { return reconcileProof(env, proof); }
  clearProof(env.store, proof);
  return {type: 'answered', answer, intent: proof.intent, earlier: false, expiresAt: proof.expiresAt};
}

/** Null while the listed request still asks the question shown and waits for an answer; otherwise why it cannot be answered. */
function notOpen(item: OwnerRequest | undefined, shown: OwnerRequest, nowMs: number): Outcome | null {
  if (!item) return {type: 'closed'};
  if (!sameIntent(item, shown)) return isPending(item) ? {type: 'changed', item} : isAnswered(item) ? {type: 'already', item} : {type: 'closed', item};
  if (isAnswered(item) && item.status !== 'expired') return {type: 'already', item};
  if (itemPhase(item, nowMs) !== 'pending') return {type: 'closed', item};
  return null;
}

/**
 * Answers one listed request. Fetches it again, checks the owner, validates the challenge, signs once, stores the
 * proof, checks the owner again and sends. A saved proof for the same question is reconciled instead of signing, also
 * when another tab saved it while this one waited for the cross-tab lock; a saved proof for an earlier question of the
 * same request never answers this one. `note` is the exact reason to sign, empty for none; it is checked before any
 * request and never changed.
 */
export async function answerRequest(env: OwnerEnv, signer: OwnerSigner, shown: OwnerRequest, decision: Decision, phase: (p: OwnerPhase) => void = () => {}, note = ''): Promise<Outcome> {
  phase('checking');
  if (!validNote(note)) return {type: 'kept', note: 'The reason cannot be signed as written. Nothing was signed.'};
  const saved = () => refProofs(env.store, env.origin, signer.owner, shown).find(p => p.intent === intentKey(shown));
  const before = saved();
  if (before) return reconcileProof(env, before);
  let item: OwnerRequest | undefined;
  try { item = await listed(env, signer.owner, shown); }
  catch (e) { return {type: 'kept', note: `${reason(e, 'The request list could not be read.')} No answer was sent.`}; }
  const shut = notOpen(item, shown, env.now());
  if (shut || !item) return shut ?? {type: 'closed'};
  let challenge: OwnerChallenge;
  try {
    challenge = validateChallenge(await env.api.challenge({kind: item.kind, policyId: item.policyId, requestId: item.requestId, decision, note}), item, decision, signer.owner, env.origin, env.now(), note);
    await verifyOwner(env, signer);
  } catch (e) {
    return {type: 'kept', note: e instanceof OwnerChanged ? OWNER_CHANGED : `${reason(e, 'The challenge could not be prepared.')}${e instanceof OwnerContractError ? '' : ' Nothing was signed.'}`};
  }
  try {
    if (!claim(env.store, env.origin, signer.owner, item, env.now())) return {type: 'kept', note: 'Another tab is waiting for your wallet to answer this request.'};
  } catch {
    return {type: 'kept', note: 'Site storage is required to keep a signed answer. Nothing was signed.'};
  }
  // Another tab may have signed this question, or finished answering it, while this one waited for the lock.
  const signedElsewhere = saved();
  if (signedElsewhere) {
    release(env.store, env.origin, signer.owner, item);
    return reconcileProof(env, signedElsewhere);
  }
  let again: OwnerRequest | undefined;
  try { again = await listed(env, signer.owner, shown); }
  catch (e) {
    release(env.store, env.origin, signer.owner, item);
    return {type: 'kept', note: `${reason(e, 'The request list could not be read.')} No answer was sent.`};
  }
  const moved = notOpen(again, shown, env.now());
  if (moved) {
    release(env.store, env.origin, signer.owner, item);
    return moved;
  }
  let signature: string;
  try {
    phase('signing');
    signature = await signer.sign(challenge.message);
  } catch (e) {
    release(env.store, env.origin, signer.owner, item);
    return {type: 'kept', note: isUserRefusal(e) ? 'Wallet prompt closed. No answer recorded.' : `${reason(e, 'The wallet did not sign.')} No answer recorded.`};
  }
  if (!validSignature(signature)) {
    release(env.store, env.origin, signer.owner, item);
    return {type: 'kept', note: 'The wallet returned an unreadable signature. No answer recorded.'};
  }
  const ref = {kind: item.kind, policyId: item.policyId, requestId: item.requestId};
  const proof: SignedProof = {v: 2, origin: env.origin, owner: signer.owner, ref, intent: intentKey(challenge.binding), decision, decisionId: challenge.decisionId, message: challenge.message, signature, expiresAt: challenge.expiresAt, signedAt: Math.floor(env.now() / 1000), note: challenge.note};
  let stored = true;
  try { env.store.write(proofKey(env.origin, signer.owner, ref, proof.decisionId), JSON.stringify(proof)); } catch { stored = false; }
  release(env.store, env.origin, signer.owner, item);
  try { await verifyOwner(env, signer); }
  catch { return {type: 'unconfirmed', proof, note: 'The wallet or session changed after signing, so the answer was not sent. It stays saved for this owner.'}; }
  phase('sending');
  const outcome = await deliver(env, proof);
  return !stored && outcome.type === 'unconfirmed' ? {...outcome, note: `${outcome.note} This browser could not save it, so keep this page open.`} : outcome;
}

/** Sends the identical saved proof again, after checking the owner and that the server has not recorded an answer. */
export async function resendProof(env: OwnerEnv, signer: OwnerSigner, proof: SignedProof, phase: (p: OwnerPhase) => void = () => {}): Promise<Outcome> {
  phase('checking');
  if (proof.owner !== signer.owner || proof.origin !== env.origin) return {type: 'kept', note: OWNER_CHANGED};
  try { await verifyOwner(env, signer); } catch { return {type: 'unconfirmed', proof, note: OWNER_CHANGED}; }
  // Sent again only after the server list was read and shows no answer.
  let item: OwnerRequest | undefined;
  try { item = await listed(env, proof.owner, proof.ref); } catch (e) { return unread(proof, e); }
  const seen = resolved(env, proof, item, false);
  if (seen.type !== 'unconfirmed') return seen;
  phase('sending');
  return deliver(env, proof);
}
