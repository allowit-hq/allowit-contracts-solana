import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Inbox, LoaderCircle, X} from 'lucide-react';
import {
  answerRequest,
  browserStore,
  findDecision,
  httpOwnerApi,
  intentKey,
  isPending,
  isProofKey,
  itemPhase,
  MAX_NOTE_BYTES,
  noteBytes,
  noteProblem,
  ownerProofs,
  parseInbox,
  payshLimits,
  nativePurchase,
  nativePurchaseSummary,
  reconcileProof,
  refKey,
  resendProof,
  sameRef,
  settleProofs,
  type Decision,
  type NoteProblem,
  type OwnerAnswer,
  type OwnerEnv,
  type OwnerPhase,
  type OwnerRequest,
  type OwnerRequestRef,
  type OwnerSigner,
  type Outcome,
  type PayshLimits,
  type NativePurchase,
  type SignedProof,
} from './owner-requests';
import {returnFocus} from './request-link';
import './owner-inbox.css';

/**
 * One owner inbox for every route, mounted in the header. Each route passes only a verified owner signer; this
 * component never answers without a fresh server check, a validated challenge and the owner's wallet signature.
 * See owner-requests.ts for the rules.
 *
 * A request can ask a new question after an answer. Everything this tab remembers about a request (an answer it just
 * sent, a note, a saved proof) is bound to the question it was about, so a change of question resets it and an earlier
 * answer is never shown as the answer to the current question.
 */

const POLL_MS = 5000;
const CHANNEL = 'allowit.owner-requests';
const SOON_MS = 5 * 60_000;

/** An answer this tab sent and the server confirmed, until the server list shows it. `reason` is its signed note. */
interface Verified {ref: OwnerRequestRef; intent: string; decisionId: string; question?: string; approved: boolean; at: number; status: string; reason: string}
/** The reason being written for one question. It is kept in memory only and dropped when the question changes. */
interface Draft {intent: string; text: string}
/** A note bound to one question when `intent` is set; it is dropped once the request asks another question. */
interface Note {text: string; tone: 'info' | 'bad'; intent?: string}
/** `signedExpiry`: the exact expiry of each answer this tab signed and saw recorded, by decision ID, from its saved proof. */
interface InboxState {owner: string; items: OwnerRequest[]; unreadable: number; loaded: boolean; error: string | null; verified: Record<string, Verified>; proofs: SignedProof[]; notes: Record<string, Note>; signedExpiry: Record<string, number>; drafts: Record<string, Draft>}
const empty = (owner: string): InboxState => ({owner, items: [], unreadable: 0, loaded: false, error: null, verified: {}, proofs: [], notes: {}, signedExpiry: {}, drafts: {}});
type Filter = 'pending' | 'answered' | 'history';
interface Work {key: string; phase: OwnerPhase; decision?: Decision}
/**
 * One answered, expired or closed question. `earlier` marks a question the request has since replaced. `signedExpiry`
 * (unix seconds) is the exact expiry of the signed answer, known only from this device's saved proof.
 */
export interface AnsweredEntry {key: string; ref: OwnerRequestRef; question?: string; approved?: boolean; at?: number; status: string; phase: 'answered' | 'expired' | 'closed'; earlier: boolean; signedExpiry?: number; reason?: string}

export interface OwnerInbox {
  owner: string;
  pending: OwnerRequest[];
  answered: AnsweredEntry[];
  proofs: SignedProof[];
  notes: Record<string, Note>;
  loaded: boolean;
  error: string | null;
  unreadable: number;
  work: Work | null;
  isOpen: boolean;
  filter: Filter;
  focus: {key: string; after: number} | null;
  /** A request whose card an answer removes while the drawer is open; keyboard focus moves on once it is gone. */
  refocus: {key: string; after: number} | null;
  loads: number;
  missing: string | null;
  live: string;
  toast: OwnerRequestRef | null;
  items: OwnerRequest[];
  title: (ref: OwnerRequestRef) => string | undefined;
  /** The status chip for one request's current question, or null when it is not in this owner's list. */
  statusOf: (ref: OwnerRequestRef) => string | null;
  openAt: (ref?: OwnerRequestRef, from?: HTMLElement | null) => void;
  closed: () => void;
  setFilter: (f: Filter) => void;
  clearFocus: (missing?: string) => void;
  clearRefocus: () => void;
  dismissToast: () => void;
  /** The reason entered for this question; empty for another question of the same request. */
  draft: (item: OwnerRequest) => string;
  setDraft: (item: OwnerRequest, text: string) => void;
  answer: (item: OwnerRequest, decision: Decision) => Promise<void>;
  resend: (proof: SignedProof) => Promise<void>;
  check: (proof: SignedProof) => Promise<void>;
}

export const OwnerInboxContext = createContext<OwnerInbox | null>(null);
export const useOwnerInboxContext = () => useContext(OwnerInboxContext);

const word = (approved: boolean) => (approved ? 'Yes' : 'No');
const timeFmt = new Intl.DateTimeFormat(undefined, {hour: '2-digit', minute: '2-digit'});
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const fitFmt = new Intl.NumberFormat('en-US', {maximumFractionDigits: 2});
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);
const omit = <T,>(r: Record<string, T>, key: string) => {
  const next = {...r};
  delete next[key];
  return next;
};
/** A note applies to the current question unless it was bound to another one. */
export const noteFor = (note: Note | undefined, item?: OwnerRequest) => (note && (!note.intent || !item || note.intent === intentKey(item)) ? note : undefined);
/** A draft reason applies only to the question it was written for. */
export const draftFor = (draft: Draft | undefined, item: OwnerRequest) => (draft && draft.intent === intentKey(item) ? draft.text : '');

export function useOwnerInbox({signer, title, onAnswered, available = false}: {signer: OwnerSigner | null; title?: (ref: OwnerRequestRef) => string | undefined; onAnswered?: (answer: OwnerAnswer) => void; available?: boolean}): OwnerInbox {
  const owner = signer?.owner ?? '';
  const env = useMemo<OwnerEnv>(() => ({api: httpOwnerApi, store: browserStore(), origin: window.location.origin, now: Date.now}), []);
  const signerRef = useRef(signer);
  signerRef.current = signer;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const titleRef = useRef(title);
  titleRef.current = title;
  const answeredRef = useRef(onAnswered);
  answeredRef.current = onAnswered;
  const [raw, setRaw] = useState<InboxState>(() => empty(owner));
  const state = raw.owner === owner ? raw : empty(owner);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** Updates only while the same owner is current; a reply for an earlier owner is dropped. */
  const update = useCallback((o: string, fn: (s: InboxState) => InboxState) => {
    if (!o || o !== ownerRef.current) return;
    setRaw(prev => fn(prev.owner === o ? prev : empty(o)));
  }, []);
  const [work, setWork] = useState<Work | null>(null);
  const busy = useRef(false);
  const [isOpen, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = isOpen;
  const [filter, setFilter] = useState<Filter>('pending');
  const [focus, setFocus] = useState<{key: string; after: number} | null>(null);
  const [refocus, setRefocus] = useState<{key: string; after: number} | null>(null);
  const [loads, setLoads] = useState(0);
  const loadsRef = useRef(0);
  const [missing, setMissing] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const [toast, setToast] = useState<OwnerRequestRef | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const cancelReturn = useRef<(() => void) | null>(null);
  /** Questions already announced, by request and question. A new question on a known request is announced again. */
  const seen = useRef<{owner: string; keys: Set<string>} | null>(null);
  const version = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  // A repeated message still changes the text, so it is announced again.
  const announce = useCallback((text: string) => setLive(prev => (prev === text ? `${text} ` : text)), []);

  const load = useCallback(async () => {
    const o = ownerRef.current;
    if (!o) return;
    const v = ++version.current;
    let parsed: ReturnType<typeof parseInbox>;
    try {
      parsed = parseInbox(await env.api.list(), o, env.origin);
    } catch (e) {
      if (v === version.current) update(o, s => ({...s, error: e instanceof Error && e.message ? e.message : 'Requests could not be loaded.'}));
      return;
    }
    if (v !== version.current || o !== ownerRef.current) return;
    const settled = settleProofs(env, o, parsed.items);
    const current = (key: string) => parsed.items.find(i => refKey(i) === key);
    update(o, s => {
      // The server list is authoritative once it shows an answer this tab sent.
      const verified = Object.fromEntries(Object.entries(s.verified).filter(([key, a]) => {
        const item = current(key);
        return !item || !findDecision(item, a.decisionId, env.origin);
      }));
      // Per-question notes reset when the request now asks another question.
      const notes = Object.fromEntries(Object.entries(s.notes).filter(([key, n]) => !!noteFor(n, current(key))));
      // So do draft reasons, and a reason for a question no longer listed.
      const drafts = Object.fromEntries(Object.entries(s.drafts).filter(([key, d]) => {
        const item = current(key);
        return !!item && draftFor(d, item) !== '';
      }));
      const signedExpiry = {...s.signedExpiry};
      for (const {proof, outcome} of settled) {
        if (outcome.type === 'answered') signedExpiry[proof.decisionId] = outcome.expiresAt;
        const key = refKey(proof.ref);
        if (outcome.type === 'answered' && outcome.earlier) notes[key] = {text: `Your signed ${word(outcome.answer.approved)} for an earlier question of this request is recorded. It does not answer the current question.`, tone: 'info'};
        else if (outcome.type === 'expired') notes[key] = {text: outcome.note, tone: 'info'};
        else if (outcome.type === 'already') notes[key] = {text: `Already answered ${word(!!outcome.item.approved)} in another tab or session. Your saved signature was not used.`, tone: 'info', intent: proof.intent};
      }
      return {...s, items: parsed.items, unreadable: parsed.unreadable, loaded: true, error: null, verified, notes, drafts, signedExpiry, proofs: ownerProofs(env.store, env.origin, o)};
    });
    for (const {outcome} of settled) if (outcome.type === 'answered') answeredRef.current?.(outcome.answer);
    loadsRef.current += 1;
    setLoads(loadsRef.current);
    const waiting = parsed.items.filter(isPending);
    const qkey = (i: OwnerRequest) => `${refKey(i)}#${intentKey(i)}`;
    if (!seen.current || seen.current.owner !== o) {
      seen.current = {owner: o, keys: new Set(waiting.map(qkey))};
      return;
    }
    const known = seen.current.keys;
    const fresh = waiting.filter(i => !known.has(qkey(i)));
    for (const i of fresh) known.add(qkey(i));
    if (fresh.length) {
      announce(fresh.length === 1 ? 'A new request needs your answer.' : `${fresh.length} new requests need your answer.`);
      if (!openRef.current) setToast(fresh[fresh.length - 1]);
    }
  }, [env, update, announce]);

  useEffect(() => {
    setOpen(false);
    setToast(null);
    setFocus(null);
    setRefocus(null);
    setMissing(null);
    setLive('');
    if (!owner) return;
    void load();
    const visible = () => document.visibilityState === 'visible';
    const tick = window.setInterval(() => {
      if (visible()) void load();
    }, POLL_MS);
    const wake = () => {
      if (visible()) void load();
    };
    // Another tab only prompts a fresh server read; its message is never trusted as an answer.
    const storage = (e: StorageEvent) => {
      if (isProofKey(e.key)) void load();
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('storage', storage);
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = () => void load();
    } catch {
      /* Storage events still reach other tabs. */
    }
    channel.current = bc;
    return () => {
      window.clearInterval(tick);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('storage', storage);
      bc?.close();
      channel.current = null;
    };
  }, [owner, load]);

  const apply = useCallback(
    (o: string, ref: OwnerRequestRef, intent: string, outcome: Outcome) => {
      const key = refKey(ref);
      const moveOn = () => {
        if (o === ownerRef.current && openRef.current) setRefocus({key, after: loadsRef.current});
      };
      const note = (text: string, tone: Note['tone'], bound?: string) => {
        update(o, s => ({...s, notes: {...s.notes, [key]: {text, tone, intent: bound}}}));
        announce(text);
      };
      switch (outcome.type) {
        case 'answered': {
          const a = outcome.answer;
          update(o, s => ({...s, signedExpiry: {...s.signedExpiry, [a.decisionId]: outcome.expiresAt}}));
          if (outcome.earlier) {
            note(`Your signed ${word(a.approved)} for an earlier question of this request is recorded. It does not answer the current question.`, 'info');
          } else {
            update(o, s => ({
              ...s,
              notes: omit(s.notes, key),
              drafts: omit(s.drafts, key),
              verified: {...s.verified, [key]: {ref, intent: outcome.intent, decisionId: a.decisionId, question: s.items.find(i => sameRef(i, ref) && intentKey(i) === outcome.intent)?.question, approved: a.approved, at: a.answeredAt * 1000, status: a.status, reason: a.note}},
            }));
            const start = a.kind === 'paysh' && a.approved && a.status !== 'expired' ? ` The agent must start by ${timeFmt.format(outcome.expiresAt * 1000)}.` : '';
            announce(a.status === 'expired' ? `Answered ${word(a.approved)}. The answer has since expired.` : `Answered ${word(a.approved)}.${start}`);
            moveOn();
          }
          if (o === ownerRef.current) answeredRef.current?.(a);
          break;
        }
        case 'already': {
          const at = outcome.item.answeredAt ? ` at ${timeFmt.format(outcome.item.answeredAt * 1000)}` : '';
          note(`Already answered ${word(!!outcome.item.approved)}${at}, in another tab or session. No new answer was signed.`, 'info', intentKey(outcome.item));
          update(o, s => ({...s, drafts: omit(s.drafts, key)}));
          moveOn();
          break;
        }
        case 'expired':
          note(outcome.note, 'info');
          break;
        case 'changed':
          note('This request changed after it was shown. Review it again before answering. Nothing was signed.', 'bad');
          break;
        case 'closed':
          note('This request is not waiting for an answer. Nothing was signed.', 'bad', intent);
          if (o === ownerRef.current) setMissing('This request is not waiting for an answer. Nothing was signed.');
          break;
        case 'kept':
        case 'unconfirmed':
        case 'rejected':
          note(outcome.note, 'bad', intent);
          break;
      }
      update(o, s => ({...s, proofs: ownerProofs(env.store, env.origin, o)}));
    },
    [env, update, announce],
  );

  const run = useCallback(
    async (ref: OwnerRequestRef, intent: string, decision: Decision | undefined, fn: (signer: OwnerSigner, phase: (p: OwnerPhase) => void) => Promise<Outcome>) => {
      const signer = signerRef.current;
      const o = ownerRef.current;
      if (busy.current || !o || !signer || signer.owner !== o) return;
      busy.current = true;
      const key = refKey(ref);
      setWork({key, phase: 'checking', decision});
      update(o, s => ({...s, notes: omit(s.notes, key)}));
      try {
        const outcome = await fn(signer, p => {
          if (ownerRef.current !== o) return;
          setWork({key, phase: p, decision});
          if (p === 'signing') announce('Sign the answer in your wallet. The signature itself moves no funds and has no network fee.');
        });
        apply(o, ref, intent, outcome);
      } catch (e) {
        apply(o, ref, intent, {type: 'kept', note: `${e instanceof Error && e.message ? e.message : 'The answer could not be completed.'} No answer recorded.`});
      } finally {
        busy.current = false;
        setWork(null);
        channel.current?.postMessage('changed');
        void load();
      }
    },
    [apply, announce, load, update],
  );

  /** An answer this tab sent hides its question until the server list shows it; a different question stays visible. */
  const sent = (i: OwnerRequest) => state.verified[refKey(i)]?.intent === intentKey(i);
  const pending = state.items.filter(i => isPending(i) && !sent(i));
  const now = Date.now();
  const answered: AnsweredEntry[] = [
    ...state.items
      .filter(i => !isPending(i))
      .flatMap((i): AnsweredEntry[] => {
        const v = state.verified[refKey(i)];
        if (v && v.intent === intentKey(i)) return [];
        const phase = itemPhase(i, now);
        return [{key: `${refKey(i)}|${i.decisionId ?? 'current'}`, ref: i, question: i.question, approved: i.approved, at: i.answeredAt ? i.answeredAt * 1000 : undefined, status: i.status, phase: phase === 'pending' ? 'closed' : phase, earlier: false, signedExpiry: i.decisionId ? state.signedExpiry[i.decisionId] : undefined, reason: i.note}];
      }),
    // Answers this tab sent stay visible until the server lists them.
    ...Object.values(state.verified).map((v): AnsweredEntry => {
      const item = state.items.find(i => sameRef(i, v.ref));
      return {key: `${refKey(v.ref)}|${v.decisionId}`, ref: v.ref, question: v.question, approved: v.approved, at: v.at, status: v.status, phase: v.status === 'expired' ? 'expired' : 'answered', earlier: !!item && intentKey(item) !== v.intent, signedExpiry: state.signedExpiry[v.decisionId], reason: v.reason || undefined};
    }),
    // Earlier questions of the same request. Their text is not part of the history, so none is shown for them.
    ...state.items.flatMap(i => i.decisionHistory.map((d): AnsweredEntry => ({key: `${refKey(i)}|${d.decisionId}`, ref: i, approved: d.approved, at: d.answeredAt * 1000, status: 'answered', phase: 'answered', earlier: true}))),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const statusOf = useCallback(
    (ref: OwnerRequestRef) => {
      const s = stateRef.current;
      const key = refKey(ref);
      if (work?.key === key) return work.phase === 'signing' ? 'Signing' : work.phase === 'sending' ? 'Sending answer' : 'Checking';
      const item = s.items.find(i => sameRef(i, ref));
      const v = s.verified[key];
      if (v && (!item || intentKey(item) === v.intent)) return v.status === 'expired' ? `Expired after your ${word(v.approved)}` : `Answered ${word(v.approved)}`;
      if (s.proofs.some(p => sameRef(p.ref, ref) && (!item || p.intent === intentKey(item)))) return 'Answer signed, confirming';
      if (!item) return null;
      switch (itemPhase(item, Date.now())) {
        case 'answered':
          return `Answered ${word(!!item.approved)}`;
        case 'expired':
          return item.approved === undefined ? 'Expired, no answer' : `Expired after your ${word(item.approved)}`;
        case 'closed':
          return 'Not waiting';
        default:
          return 'Pending';
      }
    },
    [work],
  );

  return {
    owner,
    pending,
    answered,
    items: state.items,
    proofs: state.proofs,
    notes: state.notes,
    loaded: state.loaded || (!owner && available),
    error: state.error,
    unreadable: state.unreadable,
    work,
    isOpen,
    filter,
    focus,
    refocus,
    loads,
    missing,
    live,
    toast,
    title: ref => titleRef.current?.(ref),
    statusOf,
    openAt: (ref, from) => {
      if (!ownerRef.current && !available) return;
      cancelReturn.current?.();
      cancelReturn.current = null;
      opener.current = from ??(document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setToast(null);
      setMissing(null);
      if (ref) setFocus({key: refKey(ref), after: loadsRef.current});
      else setFilter('pending');
      // Opening always reads the server list, so the drawer never shows only the last poll.
      void load();
      setOpen(true);
    },
    closed: () => {
      setOpen(false);
      setFocus(null);
      setRefocus(null);
      const back = opener.current;
      opener.current = null;
      // A dialog that closes later, such as the review the drawer was opened from, replaces this return while it is pending.
      cancelReturn.current = returnFocus(() => {
        cancelReturn.current = null;
        // Native close may already have restored focus, or the user moved it; a late frame never takes it back.
        const active = document.activeElement;
        if (active && active !== document.body && !active.closest('.owner-drawer')) return;
        // With the opener gone and another dialog still open, the header behind it is inert, so focus stays in that dialog.
        const target = back?.isConnected ? back : document.querySelector('dialog[open]:not(.owner-drawer)') ? null : document.querySelector<HTMLElement>('.owner-trigger');
        target?.focus();
      });
    },
    setFilter,
    clearFocus: text => {
      setFocus(null);
      if (text) setMissing(text);
    },
    clearRefocus: () => setRefocus(null),
    dismissToast: () => setToast(null),
    draft: item => draftFor(state.drafts[refKey(item)], item),
    setDraft: (item, text) => {
      if (busy.current) return;
      update(owner, s => ({...s, drafts: {...s.drafts, [refKey(item)]: {intent: intentKey(item), text}}}));
    },
    answer: (item, decision) => {
      // The reason is fixed here: the exact text on screen at the click is what is signed and sent.
      const note = draftFor(stateRef.current.drafts[refKey(item)], item);
      return run(item, intentKey(item), decision, (s, p) => answerRequest(env, s, item, decision, p, note));
    },
    resend: proof => run(proof.ref, proof.intent, proof.decision, (s, p) => resendProof(env, s, proof, p)),
    check: proof => run(proof.ref, proof.intent, proof.decision, () => reconcileProof(env, proof)),
  };
}

/* ------------------------------------------------------------------ presentation */

const ACRONYMS: Record<string, string> = {usdc: 'USDC', sol: 'SOL', id: 'ID', url: 'URL', bps: 'bps', api: 'API', xlm: 'XLM', lp: 'LP'};
/** True on Testnet and Devnet, where amounts are test token units with no real value. */
const testNetwork = (network: string) => /testnet|devnet/i.test(network);
/**
 * `maxPaymentUsdc` and `max_payment_usdc` read as "Max payment USDC". On a test network the token is named as test
 * token units instead, so a fixture amount never reads as real USDC.
 */
function label(key: string, testUnits: boolean) {
  let unit = false;
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .flatMap(p => {
      if (testUnits && p.toLowerCase() === 'usdc') {
        unit = true;
        return [];
      }
      return [ACRONYMS[p.toLowerCase()] ?? p.toLowerCase()];
    });
  const text = parts.join(' ') + (unit ? ' (test token units)' : '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : key;
}
const MAX_FIELDS = 24;
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

function Value({value, depth, testUnits}: {value: unknown; depth: number; testUnits: boolean}) {
  if (value === null || value === undefined) return <span className="muted">None</span>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (typeof value === 'number' || typeof value === 'bigint') return <span className="num">{String(value)}</span>;
  if (typeof value === 'string') return <span className={/\s/.test(value) ? undefined : 'mono'}>{clip(value)}</span>;
  if (Array.isArray(value) && value.every(v => v === null || typeof v !== 'object')) return <span className="mono">{clip(value.map(String).join(', ')) || 'None'}</span>;
  if (depth < 1 && value && typeof value === 'object' && !Array.isArray(value)) return <Facts value={value as Record<string, unknown>} depth={depth + 1} testUnits={testUnits} />;
  return <span className="mono">{clip(JSON.stringify(value) ?? '')}</span>;
}

/** A bounded, readable rendering of server JSON. Keys are shown as words; values are never interpreted. */
function Facts({value, depth = 0, testUnits}: {value: Record<string, unknown>; depth?: number; testUnits: boolean}) {
  const entries = Object.entries(value);
  if (!entries.length) return <p className="small muted">None</p>;
  return (
    <dl className="owner-facts">
      {entries.slice(0, MAX_FIELDS).map(([k, v]) => (
        <div key={k}>
          <dt>{label(k, testUnits)}</dt>
          <dd>
            <Value value={v} depth={depth} testUnits={testUnits} />
          </dd>
        </div>
      ))}
      {entries.length > MAX_FIELDS ? (
        <div>
          <dt>Not shown</dt>
          <dd>{entries.length - MAX_FIELDS} more fields</dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * Semantic fit against the policy threshold, on one 0–100 scale. A point score, not a probability. A valid score below
 * the threshold is why the policy asks the owner; a Yes allows this one request and leaves the threshold unchanged.
 */
function Fit({score, threshold}: {score?: number; threshold?: number}) {
  if (score === undefined) return null;
  const s = score / 100;
  const t = threshold === undefined ? undefined : threshold / 100;
  const text =
    t === undefined
      ? `Semantic fit ${fitFmt.format(s)} of 100.`
      : s < t
        ? `Semantic fit ${fitFmt.format(s)} of 100, below this policy's threshold of ${fitFmt.format(t)}, so the policy asks you. Yes answers this question for this request only; the threshold stays ${fitFmt.format(t)}.`
        : `Semantic fit ${fitFmt.format(s)} of 100. Policy threshold ${fitFmt.format(t)}.`;
  return (
    <div className="owner-fit">
      <p className="small">{text}</p>
      <div className="owner-fit-track" data-below={t !== undefined && s < t ? true : undefined} aria-hidden="true">
        <span className="owner-fit-score" style={{width: `${s}%`}} />
        {t !== undefined ? <span className="owner-fit-threshold" style={{left: `${t}%`}} /> : null}
      </div>
    </div>
  );
}

const Spinner = () => <LoaderCircle className="spin" size={14} aria-hidden="true" />;

/** Integer base units as an exact decimal. */
function decimal(value: number, places: number) {
  const n = BigInt(value);
  const base = 10n ** BigInt(places);
  const fraction = (n % base).toString().padStart(places, '0').replace(/0+$/, '');
  return (n / base).toString() + (fraction ? `.${fraction}` : '');
}
const solName = (network: string) => (/testnet/i.test(network) ? 'Testnet SOL' : /devnet/i.test(network) ? 'Devnet SOL' : 'SOL');

/** The original quote a PaySH answer is capped at: payment, swap, minimum output and fees, in their own units. */
function PayshQuote({limits, network}: {limits: PayshLimits; network: string}) {
  // Units of the signed mint shown under Binding; a token name is never inferred from field names.
  const token = testNetwork(network) ? 'test token' : 'token units';
  const coin = solName(network);
  const runs = limits.maxExecutions === 1 ? '1 execution' : `${limits.maxExecutions} executions`;
  return (
    <dl className="owner-facts">
      <div>
        <dt>Payment</dt>
        <dd>
          <span className="num">{decimal(limits.amountUsdc, 6)}</span> {token}
        </dd>
      </div>
      <div>
        <dt>Swap</dt>
        <dd>
          {limits.swap ? (
            <>
              At most <span className="num">{decimal(limits.swap.amountInLamports, 9)}</span> {coin} in, at least <span className="num">{decimal(limits.swap.minOutUsdc, 6)}</span> {token} out
            </>
          ) : (
            'None'
          )}
        </dd>
      </div>
      <div>
        <dt>Service fee</dt>
        <dd>
          <span className="num">{decimal(limits.feeLamportsPerExecution, 9)}</span> {coin} per execution, at most {runs}, <span className="num">{decimal(limits.maxTotalFeeLamports, 9)}</span> {coin} in total
        </dd>
      </div>
      <div>
        <dt>Service</dt>
        <dd className="mono">{limits.serviceId}</dd>
      </div>
    </dl>
  );
}

/** `signedExpiry` is shown only when this device knows the exact signed deadline; a listed deadline is never shown as it. */
function afterYes(kind: OwnerRequestRef['kind'], signedExpiry?: number) {
  if (kind === 'native') return 'This signed answer resumes only the original purchase and answers only this question. Every source rule, purchase tier, daily limit, balance and revocation is checked again. The executor signs any allowed transfer; no owner transfer signature is requested.';
  if (kind !== 'paysh') return 'The request continues its policy checks. This answer is not a payment; a transfer still needs your wallet.';
  const by = signedExpiry !== undefined ? `by ${dateTimeFmt.format(signedExpiry * 1000)}, the deadline in your signed answer` : 'by the deadline in your signed answer';
  return `This answer paid nothing and approved no payment. It queued a new, full policy evaluation of this request, with only this question answered Yes, a fresh quote and context, and every hard limit. The agent must start ${by}; the request and policy deadlines still apply. Only if that evaluation passes is a freshly signed native run sent on chain, within the signed original quote, without another signature from you.`;
}

/** PaySH: Yes queues a fresh policy evaluation in which only this question counts as answered; every limit still applies. */
function terms(item: OwnerRequest) {
  if (item.kind === 'native') return 'Approve answers this question for the original purchase only. It does not change your policy or bypass other questions, tiers, limits or revocation. Your wallet signs an off-chain answer with no network fee, not a transfer. Deny stops this purchase.';
  if (item.kind !== 'paysh') return 'Yes allows this one request only. Thresholds, budget, recipients and expiry stay as they are. The signature itself moves no funds and has no network fee. A transfer still needs your wallet.';
  const latest = item.expiresAt !== undefined ? ` and never later than ${timeFmt.format(item.expiresAt * 1000)}` : '';
  return `Yes queues a fresh policy evaluation of this request that overrides only this question; every spending limit still applies, including the original quote above. The agent must start by the deadline in the message you sign, at most five minutes after it is prepared${latest}; the request and policy deadlines still apply. The signature moves no funds and has no network fee, and No denies the request.`;
}

/** Service input, payee, token and allocation the PaySH quote is bound to, as signed. */
function PayshBinding({limits, network}: {limits: PayshLimits; network: string}) {
  return (
    <dl className="owner-facts">
      <div>
        <dt>Recipient</dt>
        <dd className="mono">{limits.recipient}</dd>
      </div>
      <div>
        <dt>Token mint</dt>
        <dd className="mono">{limits.mint}</dd>
      </div>
      <div>
        <dt>Allocation</dt>
        <dd>
          <span className="num">{decimal(limits.allocationLamports, 9)}</span> {solName(network)}
        </dd>
      </div>
      <div>
        <dt>Service input</dt>
        <dd className="mono">{JSON.stringify(limits.input)}</dd>
      </div>
    </dl>
  );
}

/** Earlier questions answered under the same request. Shown so they are never mistaken for this question's answer. */
function History({item}: {item: OwnerRequest}) {
  if (!item.decisionHistory.length) return null;
  const recent = [...item.decisionHistory].sort((a, b) => b.answeredAt - a.answeredAt).slice(0, 3);
  return (
    <ul className="owner-history" aria-label="Earlier questions of this request">
      {recent.map(d => (
        <li key={d.decisionId}>
          Earlier question answered {word(d.approved)} at {dateTimeFmt.format(d.answeredAt * 1000)}. It does not answer this one.
        </li>
      ))}
    </ul>
  );
}

function NativePurchaseDetails({purchase}: {purchase: NativePurchase}) {
  return <>
    <dl className="owner-facts">
      <div><dt>Original amount</dt><dd>{purchase.amount} Devnet USDC</dd></div>
      <div><dt>Recipient</dt><dd className="mono">{purchase.recipient}</dd></div>
      <div><dt>Action</dt><dd>{purchase.action}</dd></div>
      <div><dt>Service</dt><dd>{purchase.merchant || 'No service claimed'}</dd></div>
      <div><dt>Saved policy</dt><dd>Revision {purchase.revision} · <span className="mono">{purchase.sourceHash}</span></dd></div>
      <div><dt>Token mint</dt><dd className="mono">{purchase.mint}</dd></div>
    </dl>
    <details className="owner-details"><summary>Original purchase context</summary>
      <p className="small muted">Supplied purchase context is untrusted. It is shown unchanged and does not prove provider delivery.</p>
      <pre className="small" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(purchase.context ?? null,null,2)}</pre>
    </details>
  </>;
}

function Card({inbox, item, now}: {inbox: OwnerInbox; item: OwnerRequest; now: number}) {
  const key = refKey(item);
  const intent = intentKey(item);
  const proof = inbox.proofs.find(p => sameRef(p.ref, item) && p.intent === intent);
  const note = noteFor(inbox.notes[key], item);
  const status = inbox.statusOf(item) ?? 'Pending';
  const mine = inbox.work?.key === key;
  const expiresMs = item.expiresAt !== undefined ? item.expiresAt * 1000 : undefined;
  const expired = expiresMs !== undefined && expiresMs <= now;
  const soon = expiresMs !== undefined && !expired && expiresMs - now <= SOON_MS;
  const titleId = `owner-q-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const who = inbox.title(item) ?? 'Policy';
  const paysh = item.kind === 'paysh';
  const native = item.kind === 'native';
  const purchase = native ? nativePurchase(item) : null;
  const summary = native ? nativePurchaseSummary(item) : null;
  // A PaySH answer is offered only for an envelope capped exactly at its original quote; the challenge is refused otherwise.
  const limits = paysh ? payshLimits(item.envelope) : null;
  const unreadableLimits = (paysh && !limits) || (native && !purchase);
  // A PaySH answer also sets the agent's start deadline, so it needs the listed latest deadline to bound it.
  const noDeadline = (paysh || native) && expiresMs === undefined;
  const reason = inbox.draft(item);
  const problem = noteProblem(reason);
  const disabled = !!inbox.work || expired || !!proof || unreadableLimits || noDeadline || !!problem;
  const testUnits = testNetwork(item.network);
  return (
    <article className="owner-card" data-owner-ref={key} tabIndex={-1} aria-labelledby={titleId}>
      <div className="owner-card-top">
        <span className="owner-chip" data-tone={expired ? 'bad' : 'wait'}>
          {mine ? <Spinner /> : null}
          {status}
        </span>
        {expiresMs !== undefined ? (
          <span className="small owner-when" data-soon={soon ? true : undefined}>
            {expired ? `Expired ${timeFmt.format(expiresMs)}` : `${paysh ? 'Answer and start no later than' : 'Answer by'} ${timeFmt.format(expiresMs)}`}
            {soon ? `, ${Math.max(1, Math.ceil((expiresMs - now) / 60_000))} min left` : ''}
          </span>
        ) : null}
      </div>
      <p className="small owner-who">
        {who} <span className="mono">{short(item.policyId)}</span>
      </p>
      {summary ? (
        <div className="owner-purchase-head">
          <p className="owner-purchase-amount">
            Pay <span className="num">{summary.amount}</span> Devnet USDC to <span className="mono" title={summary.recipient}>{short(summary.recipient)}</span>
            {summary.merchant ? ` · ${summary.merchant}` : ''}
          </p>
          {summary.task ? <p className="small">Agent’s stated task, not verified: {summary.task}</p> : null}
          <p className="small muted">
            Action {summary.action} · request <span className="mono">{short(item.requestId)}</span>
            {summary.questionNumber ? ` · question ${summary.questionNumber}` : ''}
          </p>
        </div>
      ) : null}
      <h3 className="owner-question" id={titleId}>
        {item.question}
      </h3>

      <p className="small">{item.purpose}</p>
      <Fit score={limits?.scoreBps ?? item.scoreBps} threshold={limits?.thresholdBps ?? item.thresholdBps} />
      <div className="owner-block">
        <h4 className="owner-block-title">{native ? 'Original purchase, unchanged' : limits ? 'Original quote, the limit for this answer' : 'Limits for this answer'}</h4>
        {limits ? <p className="small muted">These are the caps, not the policy’s larger maximums.</p> : null}
        {testUnits ? <p className="small muted">{paysh ? `Test network: test token units and ${solName(item.network)} with no real value, not USDC. An answer confirms no provider delivery.` :'Amounts are test token units on a test network, not real USDC.'}</p> : null}
        {purchase ? <NativePurchaseDetails purchase={purchase} /> : limits ? <PayshQuote limits={limits} network={item.network} /> : <Facts value={item.envelope} testUnits={testUnits} />}
        {unreadableLimits ? (
          <p className="small owner-note" data-tone="bad">
            These limits are not in the expected form, so this request cannot be answered here.
          </p>
        ) : null}
        {noDeadline ? (
          <p className="small owner-note" data-tone="bad">
            {native ? 'This purchase has no valid answer deadline, so it cannot be answered here.' : 'This request has no answer-and-start deadline, so it cannot be answered here.'}
          </p>
        ) : null}
      </div>
      <History item={item} />
      <details className="owner-details">
        <summary className="small">Request details</summary>
        <dl className="owner-facts">
          <div>
            <dt>Request</dt>
            <dd className="mono">{item.requestId}</dd>
          </div>
          <div>
            <dt>Policy</dt>
            <dd className="mono">{item.policyId}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd className="mono">{item.network}</dd>
          </div>
          <div>
            <dt>Input hash</dt>
            <dd className="mono">{item.inputHash}</dd>
          </div>
        </dl>
        {limits ? (
          <>
            <h4 className="owner-block-title">Quoted for</h4>
            <PayshBinding limits={limits} network={item.network} />
            <h4 className="owner-block-title">Signed limits</h4>
            <Facts value={item.envelope} testUnits={testUnits} />
          </>
        ) : null}
        <h4 className="owner-block-title">Scope</h4>
        <Facts value={item.scope} testUnits={testUnits} />
      </details>
      {proof ? (
        <ProofActions inbox={inbox} proof={proof} />
      ) : (
        <>
          <p className="small muted owner-terms">{terms(item)}</p>
          <ReasonField id={`${titleId}-reason`} value={reason} problem={problem} locked={!!inbox.work || expired} onChange={text => inbox.setDraft(item, text)} />
          <div className="btn-row owner-actions">
            <button type="button" className="btn btn-primary" aria-label={native ? 'Approve this question for the original purchase' : paysh ? 'Yes, queue a new policy evaluation of this request' : 'Yes, allow this request only'} aria-describedby={problem ? `${titleId}-reason-feedback` : undefined} disabled={disabled} onClick={() => void inbox.answer(item, 'yes')}>
              {mine && inbox.work?.decision === 'yes' ? <Spinner /> : null}
              {native ? 'Approve' : 'Yes'}
            </button>
            <button type="button" className="btn" aria-label={native ? 'Deny this purchase' : 'No, deny this request'} aria-describedby={problem ? `${titleId}-reason-feedback` : undefined} disabled={disabled} onClick={() => void inbox.answer(item, 'no')}>
              {mine && inbox.work?.decision === 'no' ? <Spinner /> : null}
              {native ? 'Deny' : 'No'}
            </button>
          </div>
        </>
      )}
      {note ? (
        <p className="small owner-note" data-tone={note.tone}>
          {note.text}
        </p>
      ) : null}
    </article>
  );
}

/** Bytes left before the counter is shown. */
const NOTE_COUNTER_FROM = 1500;
const NOTE_ERRORS: Record<NoteProblem, string> = {
  unreadable: 'This reason has hidden or control characters that cannot be signed. Remove them or type it again.',
  blank: 'This reason has only spaces or line breaks. Add text or clear it.',
  too_long: 'This reason is too long. Shorten it to answer.',
};

/**
 * The optional reason signed with an answer. Its size is counted in UTF-8 bytes, as the server counts it, so there is no
 * `maxLength`, which counts UTF-16 units. It is locked while an answer is in progress, so the text shown is the text signed.
 */
function ReasonField({id, value, problem, locked, onChange}: {id: string; value: string; problem: NoteProblem | null; locked: boolean; onChange: (text: string) => void}) {
  const left = MAX_NOTE_BYTES - noteBytes(value);
  const feedback = problem ? NOTE_ERRORS[problem] : left < MAX_NOTE_BYTES - NOTE_COUNTER_FROM ? `${left} bytes left.` : '';
  return (
    <div className="field owner-reason">
      <label htmlFor={id}>Reason (optional)</label>
      <textarea
        id={id}
        rows={2}
        value={value}
        disabled={locked}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-hint ${id}-feedback`}
        onChange={e => onChange(e.currentTarget.value)}
      />
      <span className="field-hint" id={`${id}-hint`}>
        Signed with your answer. It guides later evaluations of this policy and cannot change a limit.
      </span>
      <span className={problem ? 'field-error' : 'field-hint'} id={`${id}-feedback`} aria-live="polite">
        {feedback}
      </span>
    </div>
  );
}

/** A signed or recorded reason, shown exactly as signed. */
function SignedReason({text, label}: {text?: string; label: string}) {
  if (!text) return null;
  return (
    <div className="owner-reason-shown">
      <p className="small muted">{label}</p>
      <p className="small">{text}</p>
    </div>
  );
}

function ProofActions({inbox, proof}: {inbox: OwnerInbox; proof: SignedProof}) {
  return (
    <div className="owner-proof">
      <p className="small">
        Your signed {word(proof.decision === 'yes')} is saved on this device. It is never signed again; only the same answer can be sent.
      </p>
      <SignedReason text={proof.note} label="Signed reason" />
      <div className="btn-row">
        <button type="button" className="btn btn-sm" disabled={!!inbox.work} onClick={() => void inbox.check(proof)}>
          Check status
        </button>
        <button type="button" className="btn btn-sm btn-quiet" disabled={!!inbox.work} onClick={() => void inbox.resend(proof)}>
          Send the same answer again
        </button>
      </div>
    </div>
  );
}

function chipFor(entry: AnsweredEntry) {
  if (entry.phase === 'expired') return entry.approved === undefined ? 'Expired, no answer' : `Expired after your ${word(entry.approved)}`;
  if (entry.approved === undefined) return 'Not waiting';
  return `Answered ${word(entry.approved)}`;
}

function AnsweredCard({inbox, entry}: {inbox: OwnerInbox; entry: AnsweredEntry}) {
  const key = refKey(entry.ref);
  const titleId = `owner-a-${entry.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const item = inbox.items.find(i => sameRef(i, entry.ref));
  const note = entry.earlier ? undefined : noteFor(inbox.notes[key], item);
  const heading = entry.earlier ? `Earlier question of request ${short(entry.ref.requestId)}` : (entry.question ?? `Request ${short(entry.ref.requestId)}`);
  return (
    <article className="owner-card" data-owner-ref={key} tabIndex={-1} aria-labelledby={titleId}>
      <div className="owner-card-top">
        <span className="owner-chip" data-tone="done">
          {chipFor(entry)}
        </span>
        {entry.at ? <span className="small owner-when">{dateTimeFmt.format(entry.at)}</span> : null}
      </div>
      <p className="small owner-who">
        {inbox.title(entry.ref) ?? 'Policy'} <span className="mono">{short(entry.ref.policyId)}</span>
      </p>
      <h3 className="owner-question" id={titleId}>
        {heading}
      </h3>
      {entry.phase === 'expired' ? (
        <p className="small">
          {entry.approved === true
            ? `Your Yes expired before ${entry.ref.kind === 'paysh' ? 'the agent started' : 'the request continued'}. Expiry is not a No.`
            : 'This question expired without an answer. Expiry is not a No.'}
        </p>
      ) : entry.earlier ? (
        <p className="small">This answer applies to an earlier question only.</p>
      ) : entry.approved === true ? (
        <p className="small">{afterYes(entry.ref.kind, entry.signedExpiry)}</p>
      ) : entry.approved === false ? (
        <p className="small">The request is denied.</p>
      ) : null}
      {entry.earlier ? null : <SignedReason text={entry.reason} label="Your reason" />}
      {note ? (
        <p className="small owner-note" data-tone={note.tone}>
          {note.text}
        </p>
      ) : null}
    </article>
  );
}

/** A signed answer whose question is not currently listed as waiting. */
function ProofCard({inbox, proof}: {inbox: OwnerInbox; proof: SignedProof}) {
  const key = refKey(proof.ref);
  const item = inbox.items.find(i => sameRef(i, proof.ref));
  const earlier = !!item && intentKey(item) !== proof.intent;
  const note = noteFor(inbox.notes[key], earlier ? undefined : item);
  return (
    <article className="owner-card" data-owner-ref={key} tabIndex={-1} aria-label={`Signed answer for request ${proof.ref.requestId}`}>
      <div className="owner-card-top">
        <span className="owner-chip" data-tone="wait">
          {inbox.work?.key === key ? <Spinner /> : null}
          {earlier ? 'Signed for an earlier question' : (inbox.statusOf(proof.ref) ?? 'Answer signed, confirming')}
        </span>
      </div>
      <p className="small owner-who">
        {inbox.title(proof.ref) ?? 'Policy'} <span className="mono">{short(proof.ref.policyId)}</span>
      </p>
      <p className="small mono owner-id">Request {proof.ref.requestId}</p>
      {earlier ? <p className="small">This signature is for an earlier question of this request. It cannot answer the current question.</p> : null}
      <ProofActions inbox={inbox} proof={proof} />
      {note ? (
        <p className="small owner-note" data-tone={note.tone}>
          {note.text}
        </p>
      ) : null}
    </article>
  );
}

/** Other authenticated request flows keep their own answer protocol inside this shared drawer. */
export interface OwnerInboxExtension {pendingCount: number; pending: ReactNode; answeredCount?: number; answered?: ReactNode; history: ReactNode; loading?: boolean; error?: string | null; available?: boolean}

export default function OwnerApprovalInbox({inbox, extension}: {inbox: OwnerInbox; extension?: OwnerInboxExtension}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const count = inbox.pending.length + (extension?.pendingCount ?? 0);
  // Saved answers with no matching question on screen, including answers for an earlier question of a listed request.
  const orphans = inbox.proofs.filter(p => !inbox.pending.some(i => sameRef(i, p.ref) && intentKey(i) === p.intent));

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (inbox.isOpen && !d.open) d.showModal();
    if (!inbox.isOpen && d.open) d.close();
  }, [inbox.isOpen]);

  // Expiry text only. The countdown is never announced.
  useEffect(() => {
    if (!inbox.isOpen) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [inbox.isOpen]);

  const pendingKeys = new Set([...inbox.pending.map(refKey), ...orphans.map(p => refKey(p.ref))]);
  const answeredKeys = new Set(inbox.answered.map(e => refKey(e.ref)));
  const {focus, filter, isOpen, loads, setFilter, clearFocus} = inbox;
  useEffect(() => {
    if (!isOpen || !focus) return;
    const where: Filter | null = pendingKeys.has(focus.key) ? 'pending' : answeredKeys.has(focus.key) ? 'answered' : null;
    if (where && where !== filter) {
      setFilter(where);
      return;
    }
    const el = dialog.current?.querySelector<HTMLElement>(`[data-owner-ref="${CSS.escape(focus.key)}"]`);
    if (el) {
      el.focus({preventScroll: true});
      el.scrollIntoView({block: 'nearest'});
      clearFocus();
    } else if (!where && loads > focus.after) clearFocus('This request is not in your owner list. No answer was sent.');
  });

  // Once an answer removes its card, focus the next pending card, else the drawer heading, so it stays in the drawer.
  const shownOrder = useRef<string[]>([]);
  const {refocus, clearRefocus} = inbox;
  useEffect(() => {
    const d = dialog.current;
    const before = shownOrder.current;
    shownOrder.current = Array.from(d?.querySelectorAll<HTMLElement>('[data-owner-ref]') ?? [], e => e.dataset.ownerRef ?? '');
    if (!refocus) return;
    if (!isOpen || !d || filter !== 'pending') return clearRefocus();
    const card = (key: string) => d.querySelector<HTMLElement>(`[data-owner-ref="${CSS.escape(key)}"]`);
    const active = document.activeElement;
    const lost = !active || active === document.body || active === d || !d.contains(active);
    const still = card(refocus.key);
    if (still) {
      if (loads <= refocus.after) return;
      if (lost) still.focus();
    } else if (lost) {
      const i = before.indexOf(refocus.key);
      const next = [...before.slice(i + 1), ...before.slice(0, Math.max(i, 0)).reverse()].map(card).find(Boolean);
      (next ?? d.querySelector<HTMLElement>('#owner-drawer-title'))?.focus();
    }
    clearRefocus();
  });

  if (!inbox.owner && !extension?.available) return null;
  const toastItem = inbox.toast ? inbox.pending.find(i => sameRef(i, inbox.toast!)) : undefined;
  const list = filter === 'pending' ? inbox.pending : [];
  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-quiet owner-trigger"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={count ? `Requests, ${count} pending` : 'Requests'}
        title="Owner requests"
        onClick={e => inbox.openAt(undefined, e.currentTarget)}
      >
        <Inbox size={14} aria-hidden="true" />
        <span className="top-label">Requests</span>
        {count ? (
          <span className="owner-badge num" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </button>
      {createPortal(
        <>
          {/* Announced once through the live text; the visible notice itself is not a live region. */}
          <p className="sr-only" role="status">
            {!isOpen ? inbox.live : ''}
          </p>
          {toastItem && !isOpen ? (
            <div className="owner-toast">
              <span>A request needs your answer.</span>
              <button type="button" className="link-btn" onClick={() => inbox.openAt(toastItem, document.querySelector<HTMLElement>('.owner-trigger'))}>
                View
              </button>
              <button type="button" className="owner-toast-close" aria-label="Dismiss" onClick={inbox.dismissToast}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <dialog className="owner-drawer" ref={dialog} aria-labelledby="owner-drawer-title" onClose={inbox.closed}>
            <div className="owner-drawer-head">
              <h2 id="owner-drawer-title" tabIndex={-1}>
                Requests
              </h2>
              <button type="button" className="btn btn-sm" onClick={() => dialog.current?.close()}>
                Close
              </button>
            </div>
            <div className="owner-filter" role="group" aria-label="Show requests">
              <button type="button" aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>
                Pending{count ? <span className="num"> {count}</span> : null}
              </button>
              <button type="button" aria-pressed={filter === 'answered'} onClick={() => setFilter('answered')}>
                Answered
              </button>
              {extension ? <button type="button" aria-pressed={filter === 'history'} onClick={() => setFilter('history')}>History</button> : null}
            </div>
            <p className="sr-only" role="status">
              {isOpen ? inbox.live : ''}
            </p>
            <div className="owner-drawer-body">
              {inbox.error ? (
                <p className="small owner-note" data-tone="bad" role="alert">
                  {inbox.error}
                </p>
              ) : null}
              {extension?.error ? <p className="small owner-note" data-tone="bad" role="alert">{extension.error}</p> : null}
              {inbox.missing ? (
                <p className="small owner-note" data-tone="bad">
                  {inbox.missing}
                </p>
              ) : null}
              {inbox.unreadable ? <p className="small muted">{inbox.unreadable === 1 ? '1 request could not be read and is not shown.' : `${inbox.unreadable} requests could not be read and are not shown.`}</p> : null}
              {filter === 'history' ? isOpen ? extension?.history : null : filter === 'pending' ? <>
              {(!inbox.loaded && !inbox.error) || extension?.loading ? (
                <p className="small muted" role="status">
                  Loading requests…
                </p>
              ) : null}
              {list.length || orphans.length ? (
                  <ol className="owner-list">
                    {list.map(item => (
                      <li key={refKey(item)}>
                        <Card inbox={inbox} item={item} now={now} />
                      </li>
                    ))}
                    {orphans.map(p => (
                      <li key={`${refKey(p.ref)}|${p.decisionId}`}>
                        <ProofCard inbox={inbox} proof={p} />
                      </li>
                    ))}
                  </ol>
                ) : null}
              {extension?.pending}
              {!count && !orphans.length && inbox.loaded && !inbox.error && !extension?.loading && !extension?.error ? (
                  <p className="small muted">No requests are waiting for your answer.</p>
                ) : null}
              </> : <>{(!inbox.loaded && !inbox.error) || extension?.loading ? <p className="small muted" role="status">Loading requests…</p> : null}{inbox.answered.length ? (
                <ol className="owner-list">
                  {inbox.answered.map(entry => (
                    <li key={entry.key}>
                      <AnsweredCard inbox={inbox} entry={entry} />
                    </li>
                  ))}
                </ol>
              ) : null}{extension?.answered}{!inbox.answered.length && !extension?.answeredCount && inbox.loaded && !inbox.error && !extension?.loading && !extension?.error ? (
                <p className="small muted">No answered requests to show.</p>
              ) : null}</>}
            </div>
          </dialog>
        </>,
        document.body,
      )}
    </>
  );
}
