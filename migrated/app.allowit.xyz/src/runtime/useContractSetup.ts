import {useEffect, useMemo, useRef, useState} from 'react';
import {IndexedSetupJournal} from '../paysh/setup-journal';
import type {SetupState} from '../paysh/paysh-contracts';
import type {SignedSetup} from '../paysh/paysh-wallet-intent';
import {isUserRefusal} from '../wallet/wallet';
import {signSetupTransaction} from '../wallet/setup-signing';
import type {MicroPolicy} from '../micro/micro-contracts';
import type {PreparedContractSetup, SetupContext, SetupDeps} from './contract-setup';
import {browserBindings} from './setup-bindings';
import {contractSetupPaused,isContractWallet} from './runtime';
import {browserServiceApprovals} from './service-approvals';

/**
 * The setup adapter needs the Solana SDK, so it loads only when a contract-wallet policy opens. Every check in it runs
 * unchanged; nothing is signed or sent before it has loaded.
 */
const adapter = () => import('./contract-setup');
type Adapter = Awaited<ReturnType<typeof adapter>>;

/**
 * Contract-wallet setup state for the selected policy and signed-in owner. Every async result is applied only while
 * the same owner and policy are current; an owner change shows nothing from the previous owner, and the saved proof
 * stays in the journal under its original owner.
 */
export type SetupView =
  | {phase: 'reading'}
  | {phase: 'unreadable'; message: string}
  | {phase: 'idle'}
  | {phase: 'prepared'; setup: PreparedContractSetup}
  | {phase: 'signing'}
  | {phase: 'signed'; proof: SignedSetup; context: SetupContext | null; unconfirmed?: string}
  | {phase: 'confirming'; proof: SignedSetup}
  | {phase: 'finalized' | 'absent'; proof: SignedSetup; state: SetupState; context: SetupContext};

export interface ContractSetupController {
  view: (policyId: string) => SetupView | null;
  notice: string | null;
  discard: () => Promise<void>;
  prepare: () => Promise<void>;
  back: () => void;
  sign: () => Promise<void>;
  /** Reads chain state for the saved proof. Never opens the wallet and never resends. */
  check: () => Promise<void>;
  /** Explicit: a status check, then the original signed bytes only. */
  resend: () => Promise<void>;
  /** Reads the journal again, as discard and recovery require. */
  hasProof: (policy: MicroPolicy) => Promise<boolean>;
}

const POLL_MS = 3000;
const POLL_LIMIT_MS = 60_000;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Options {
  owner: string;
  policy: MicroPolicy | null;
  /** The shared single-action runner: one action at a time, errors on the shared banner. */
  run: (name: string, fn: (o: string) => Promise<void>) => Promise<boolean>;
  /** Posts a common route and applies its `policies` for owner `o` only. */
  send: (o: string) => (path: string, body: unknown) => Promise<unknown>;
  current: (o: string) => boolean;
  reload: (o: string) => Promise<void>;
}

export default function useContractSetup({owner, policy, run, send, current, reload}: Options): ContractSetupController {
  const journal = useMemo(() => new IndexedSetupJournal(), []);
  const [state, setState] = useState<{key: string; view: SetupView} | null>(null);
  const [notice, setNotice] = useState<{key: string; text: string} | null>(null);
  const key = policy && owner && isContractWallet(policy) ? `${owner}|${policy.id}` : '';
  const keyRef = useRef(key);
  keyRef.current = key;
  // The newest policy reply, read again immediately before the wallet opens.
  const latest = useRef(policy);
  latest.current = policy;
  const live = (k: string) => keyRef.current === k;
  const set = (k: string, view: SetupView) => {if (live(k)) setState({key: k, view});};
  const deps = (o: string, a: Adapter): SetupDeps => ({send: send(o), journal, bindings: browserBindings, serviceApprovals: browserServiceApprovals, lock: a.browserLock, newId: () => crypto.randomUUID()});
  const signedView = async (a: Adapter, o: string, p: MicroPolicy, proof: SignedSetup): Promise<SetupView> => ({phase: 'signed', proof, context: await a.savedContext(browserBindings, o, p, proof)});

  // A saved signed setup is recovered before anything else renders in Funding.
  useEffect(() => {
    setNotice(null);
    if (!key || !policy) {setState(null); return;}
    const k = key, o = owner, p = policy;
    setState({key: k, view: {phase: 'reading'}});
    adapter().then(async a => {
      const proof = await a.findProof(deps(o, a), o, p);
      return proof ? signedView(a, o, p, proof) : ({phase: 'idle'} as SetupView);
    }).then(
      view => set(k, view),
      e => set(k, {phase: 'unreadable', message: `The signed setup journal could not be read, so setup is paused: ${e instanceof Error ? e.message : 'unknown error'}`}),
    );
    // Revision changes start a new unsigned draft; the proof lookup is by owner and policy.
  }, [key, policy?.revision]);

  const view = state && state.key === key ? state.view : null;
  const say = (k: string, text: string) => {if (live(k)) setNotice({key: k, text});};

  /** Polls a submitted setup for up to a minute. Only `finalized` refreshes the policy as funded. */
  async function settle(a: Adapter, o: string, k: string, proof: SignedSetup, context: SetupContext, first?: SetupState) {
    set(k, {phase: 'confirming', proof});
    const still = () => current(o) && live(k);
    let s = first ?? (await a.checkContractSetup(deps(o, a), context, proof, still));
    const until = Date.now() + POLL_LIMIT_MS;
    while (s.status === 'submitted' && Date.now() < until && still()) {
      await wait(POLL_MS);
      s = await a.checkContractSetup(deps(o, a), context, proof, still);
    }
    if (s.status === 'finalized') {
      set(k, {phase: 'finalized', proof, state: s, context});
      await reload(o).catch(() => {});
      return;
    }
    if (s.status === 'absent') {
      set(k, {phase: 'absent', proof, state: s, context});
      say(k, 'This setup expired without deployment. The original signed proof stays saved on this device. Start a new draft to try again.');
      return;
    }
    set(k, {phase: 'signed', proof, context});
    say(k, s.status === 'submitted'
      ? 'Setup is not finalized yet. Check again; the saved transaction is never replaced.'
      : s.status === 'archived'
        ? 'The server reports this setup as archived, so it cannot be deployed. The signed setup stays saved on this device.'
        : 'The server has not recorded the signed setup. Send the same transaction again; its signature and effect cannot change.');
  }

  return {
    view: policyId => (policy?.id === policyId ? view : null),
    notice: notice && notice.key === key ? notice.text : null,
    back: () => {if (view?.phase === 'prepared') set(key, {phase: 'idle'});},
    hasProof: async p => {const a = await adapter(); return !!(await a.findProof(deps(owner, a), owner, p));},
    discard: async () => {
      if (!policy || !key) return;
      const p=policy,k=key;
      await run('cancel',async o => {
        const a=await adapter();
        await a.discardContractDraft(deps(o,a),o,p,()=>current(o)&&live(k)&&latest.current?.revision===p.revision&&latest.current?.status==='draft');
      });
    },
    prepare: async () => {
      if (!policy || !key || view?.phase !== 'idle') return;
      const k = key, p = policy;
      setNotice(null);
      await run('setup', async o => {
        if(contractSetupPaused(p.network))throw new Error('New contract setup is temporarily paused. Existing signed proof recovery remains available.');
        const a = await adapter();
        try {
          const {setup} = await a.prepareContractSetup(deps(o, a), o, p);
          set(k, {phase: 'prepared', setup});
        } catch (e) {
          // A proof found here wins over everything else.
          const proof = await a.findProof(deps(o, a), o, p).catch(() => null);
          if (proof) set(k, await signedView(a, o, p, proof));
          throw new Error(`${e instanceof Error ? e.message : 'The setup could not be prepared.'} Nothing was signed or sent.`);
        }
      });
    },
    sign: async () => {
      if (!policy || !key || view?.phase !== 'prepared') return;
      const k = key, p = policy, setup = view.setup;
      setNotice(null);
      await run('setup', async o => {
        if(contractSetupPaused(p.network))throw new Error('New contract setup is temporarily paused. Existing signed proof recovery remains available.');
        const a = await adapter();
        const still = () => current(o) && live(k);
        set(k, {phase: 'signing'});
        let proof: SignedSetup | null = null;
        try {
          const outcome = await a.signContractSetup(deps(o, a), o, setup, checked => signSetupTransaction(o, checked), still, () => (live(k) ? latest.current : null));
          proof = outcome.proof;
          const context: SetupContext = {policyId: setup.policyId, revision: setup.revision, requestId: setup.requestId, draft: setup.draft, binding: setup.binding, deployment: setup.deployment};
          if (!outcome.submitted) {
            set(k, {phase: 'signed', proof, context, unconfirmed: outcome.error});
            return;
          }
          await settle(a, o, k, proof, context, outcome.state);
        } catch (e) {
          proof ??= await a.findProof(deps(o, a), o, p).catch(() => null);
          if (proof) {
            set(k, await signedView(a, o, p, proof));
            throw new Error(`${e instanceof Error ? e.message : 'Setup stopped.'} The signed transaction is saved on this device. Check its status before anything else.`);
          }
          // Prepared terms that no longer match the policy are never offered for signing again.
          set(k, {phase: 'idle'});
          throw new Error(isUserRefusal(e) ? 'Signature declined. Nothing was sent.' : `${e instanceof Error ? e.message : 'Setup stopped.'} Nothing was sent.`);
        }
      });
    },
    check: async () => {
      if (!key || (view?.phase !== 'signed' && view?.phase !== 'absent' && view?.phase !== 'finalized')) return;
      const k = key, proof = view.proof, context = view.context;
      if (!context) return;
      setNotice(null);
      await run('setup-check', async o => {
        try {
          await settle(await adapter(), o, k, proof, context);
        } catch (e) {
          set(k, {phase: 'signed', proof, context});
          throw new Error(`${e instanceof Error ? e.message : 'The status check failed.'} The signed transaction is still saved.`);
        }
      });
    },
    resend: async () => {
      if (!key || view?.phase !== 'signed' || !view.context) return;
      const k = key, proof = view.proof, context = view.context;
      setNotice(null);
      await run('setup-resend', async o => {
        try {
          const a = await adapter();
          const done = await a.resendContractSetup(deps(o, a), o, context, () => current(o) && live(k), () => (live(k) ? latest.current : null));
          await settle(a, o, k, done.proof, context, done.state);
        } catch (e) {
          set(k, {phase: 'signed', proof, context});
          throw new Error(`${e instanceof Error ? e.message : 'The resend failed.'} The signed transaction is still saved. Check its status before anything else.`);
        }
      });
    },
  };
}
