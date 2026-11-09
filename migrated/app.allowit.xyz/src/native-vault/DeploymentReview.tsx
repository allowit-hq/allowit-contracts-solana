import {useEffect, useMemo, useRef, useState} from 'react';
import type {MicroController} from '../micro/micro-contracts';
import {request} from '../api';
import PolicyCode from '../policy/PolicyCode';
import SpendingSetupHead from '../policy/SpendingSetup';
import AccountIdentity from '../wallet/AccountIdentity';
import {checkDeploymentContext, checkDeploymentRequest, checkKnownDeployment, checkUnsignedDeployment, CLI_NEW_VAULT_RETIRED, deploymentJournal, isRetiredVaultSetup, parseDeploymentHandoff, verifyDeploymentReview, verifyDeploymentRetry, verifySavedDeployment} from './deployment-handoff';
import {deploymentDisplayBinding, deploymentTransactionUrl} from './deployment-review-view';
import {loadNativeConfig, NativePolicyAPI, NativePolicyLifecycle} from './native-api';
import {settledOperation, type NativeConfig, type Operation} from './native-contracts';
import {BrowserJournal} from './native-journal';
import {storageKey} from './native-vault';
import {signNativeOwner} from './native-wallet';

const journalFor = (config: NativeConfig, owner: string, policyId: string) => new BrowserJournal([storageKey(config), owner, policyId].join(':'));
const validateWith = (api: NativePolicyAPI) => async (policy: import('./native-contracts').Policy) => (await api.call<{policy: import('./native-contracts').Policy}>('native/validate', {policy})).policy;

/** CLI intent uses the same native owner checks, wallet signer and durable proof journal. */
export default function DeploymentReview({c, fragment, close}: {c: MicroController; fragment: string; close: () => void}) {
  const parsed = useMemo(() => {
    try {return {handoff: parseDeploymentHandoff(fragment), error: ''};}
    catch (error) {return {handoff: null, error: error instanceof Error ? error.message : 'The deployment link is invalid.'};}
  }, [fragment]);
  const handoff = parsed.handoff;
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const snapshot = useRef({session: c.auth.session, network: c.network});
  snapshot.current = {session: c.auth.session, network: c.network};
  const generation = useRef(0);
  const locked = useRef(false);
  const [view, setView] = useState<{config: NativeConfig | null; checking: boolean; error: string; operation: Operation | null; signedProof: boolean}>({config: null, checking: true, error: '', operation: null, signedProof: false});
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const session = c.auth.session;
  // Display only, derived after the backend checks set view.config.
  const binding = useMemo(() => deploymentDisplayBinding(handoff, view.config), [handoff, view.config]);
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {mounted.current = false; generation.current++; element?.close();};
  }, []);
  useEffect(() => {
    const epoch = ++generation.current;
    let live = true;
    let signedProof = false;
    setConsent(false);
    setView({config: null, checking: true, error: '', operation: null, signedProof: false});
    if (!handoff) {setView(v => ({...v, checking: false})); return;}
    void (async () => {
      try {
        const config = await loadNativeConfig();
        const expectedOwner = handoff.owner;
        class ReviewAPI extends NativePolicyAPI {
          override call<T>(path: string, body?: unknown): Promise<T> {
            if (!live || epoch !== generation.current) return Promise.reject(new Error('The selected owner or network changed.'));
            return request<T>(path, body, {expectedOwner: 'solana:' + expectedOwner});
          }
        }
        const api = new ReviewAPI(config);
        checkDeploymentContext(handoff, session, c.network, config);
        const originalJournal = journalFor(config, handoff.owner, handoff.policy.id);
        const journal = deploymentJournal(originalJournal, handoff.requestId, handoff.retryPreparationOf);
        const saved = await journal.read('request-' + handoff.requestId);
        signedProof = !!saved && typeof saved.signedBytes === 'string';
        // Recovery observes the original signed proof. It never prepares, signs or resubmits it.
        const lifecycle = new NativePolicyLifecycle(api, originalJournal, async () => {throw new Error('Opening a link cannot request a wallet signature.');});
        let operation: Operation | null = null;
        if (saved && typeof saved.signedBytes === 'string') {
          await verifySavedDeployment(handoff, config, saved, validateWith(api));
          await api.verifyRelease(true);
          operation = await lifecycle.recover(handoff.requestId, handoff.policy, handoff.owner);
        } else {
          // New vaults name the agent's own key. A CLI link can only continue a vault this server already holds.
          await checkKnownDeployment(handoff, api);
          await verifyDeploymentReview(handoff, session, c.network, api, validateWith(api));
          await checkDeploymentRequest(originalJournal, handoff.requestId, handoff.retryPreparationOf);
          await verifyDeploymentRetry(handoff, api);
          await checkUnsignedDeployment(handoff, api);
        }
        if (live && mounted.current && epoch === generation.current) setView({config, checking: false, error: '', operation, signedProof});
      } catch (error) {
        if (live && mounted.current && epoch === generation.current) setView({config: null, checking: false, error: isRetiredVaultSetup(error) && !signedProof ? CLI_NEW_VAULT_RETIRED : error instanceof Error ? error.message : 'The deployment could not be checked.', operation: null, signedProof});
      }
    })();
    return () => {live = false;};
  }, [handoff, session?.address, session?.network, c.network]);
  const perform = async (mode: 'sign' | 'replay' = 'sign') => {
    if (!handoff || !view.config || locked.current || view.checking || (mode === 'sign' && !consent)) return;
    if (mode === 'replay' && (!view.operation || ['settled', 'failed'].includes(view.operation.status) || view.operation.blockhashExpired)) return;
    const config = view.config, epoch = generation.current, expectedOwner = handoff.owner;
    const current = () => mounted.current && generation.current === epoch
      && snapshot.current.session?.address === handoff.owner
      && ['solana', 'solana:devnet'].includes(snapshot.current.session?.network ?? '')
      && snapshot.current.network === 'solana:devnet';
    locked.current = true;
    setBusy(true);
    setView(v => ({...v, error: ''}));
    try {
      class ScopedAPI extends NativePolicyAPI {
        override call<T>(path: string, body?: unknown): Promise<T> {
          if (!current()) return Promise.reject(new Error('The selected owner or network changed. The saved proof stays unchanged.'));
          return request<T>(path, body, {expectedOwner: 'solana:' + expectedOwner});
        }
      }
      const api = new ScopedAPI(config);
      checkDeploymentContext(handoff, snapshot.current.session, snapshot.current.network, config);
      const originalJournal = journalFor(config, handoff.owner, handoff.policy.id);
      const journal = mode === 'sign' ? deploymentJournal(originalJournal, handoff.requestId, handoff.retryPreparationOf) : originalJournal;
      const lifecycle = new NativePolicyLifecycle(api, journal, (transaction, role) => {
        if (mode === 'replay') throw new Error('Recovery cannot request another wallet signature.');
        if (role !== 'owner') throw new Error('Only the policy owner may sign this deployment.');
        return signNativeOwner(handoff.owner, transaction, current);
      });
      let operation: Operation;
      if (mode === 'replay') {
        await verifySavedDeployment(handoff, config, await originalJournal.read('request-' + handoff.requestId), validateWith(api));
        await api.verifyRelease(true);
        operation = await lifecycle.replay(handoff.requestId, handoff.policy, handoff.owner);
      } else {
        await verifyDeploymentReview(handoff, snapshot.current.session, snapshot.current.network, api, validateWith(api));
        await verifyDeploymentRetry(handoff, api);
        await checkUnsignedDeployment(handoff, api);
        if (!current()) throw new Error('The selected owner or network changed. Nothing was signed.');
        await checkKnownDeployment(handoff, api);
        await api.save(handoff.policy);
        operation = await lifecycle.submit(handoff.policy, handoff.owner, 'deploy', {amount: handoff.amount, ...(handoff.retryPreparationOf ? {retryPreparationOf: handoff.retryPreparationOf} : {})}, handoff.requestId);
      }
      if (operation.id !== handoff.requestId) throw new Error('The deployment returned a different request identity. Keep the original CLI link and saved proof.');
      if (current()) {setView(v => ({...v, operation, signedProof: true})); setConsent(false);}
    } catch (error) {
      const saved = await journalFor(config, handoff.owner, handoff.policy.id).read('request-' + handoff.requestId).catch(() => null);
      if (current()) setView(v => ({...v, signedProof: v.signedProof || (!!saved && typeof saved.signedBytes === 'string'), error: mode === 'sign' && isRetiredVaultSetup(error) ? CLI_NEW_VAULT_RETIRED : error instanceof Error ? error.message : 'The deployment could not be completed. Keep the original link and request ID.'}));
    } finally {locked.current = false; if (mounted.current) setBusy(false);}
  };
  const errors = [parsed.error, view.error].filter(Boolean);
  const finalized = view.operation && settledOperation(view.operation);
  const failed = view.operation?.status === 'failed';
  const expired = view.operation?.blockhashExpired === true;
  const transactionUrl = deploymentTransactionUrl(handoff, view.operation);
  return <dialog className="request-review" ref={dialog} aria-labelledby="deployment-review-title" onCancel={event => {if (busy) event.preventDefault();}} onClose={() => {if (mounted.current && !dialog.current?.open) close();}}>
    <div className="request-review-head"><h2 id="deployment-review-title">Review and sign</h2><button type="button" className="btn btn-sm" disabled={busy} onClick={() => dialog.current?.close()}>Close</button></div>
    {errors.map(error => <p className="field-error" role="alert" key={error}>{error}</p>)}
    {handoff && session?.address !== handoff.owner ? <button type="button" className="btn" disabled={!!c.auth.busy} onClick={() => void c.auth.signOut()}>Switch wallet</button> : null}
    {handoff ? <div className="stack contract-funding">
      <SpendingSetupHead intro="Review this policy and funding before approving the deployment in your wallet." network="Solana Devnet" currentStep={finalized ? 2 : 1}/>
      <p className="small">{handoff.policy.prompt}</p>
      <p className="account-identity-sr">Account icons and shortened addresses are visual aids. Each full address is read with its account.</p>
      <dl className="facts">
        <div><dt>Funding</dt><dd>{handoff.amount} USDC</dd></div>
        <div><dt>Daily vault ceiling (UTC day)</dt><dd>{handoff.policy.dailyLimit} USDC</dd></div>
        <div><dt>Action limit</dt><dd>{handoff.policy.actionLimit} USDC</dd></div>
        <div><dt>Owner</dt><dd><AccountIdentity address={handoff.owner} network={handoff.network} label="Owner"/></dd></div>
        <div><dt>Executor</dt><dd><AccountIdentity address={handoff.wallet.executor} network={handoff.network} label="Executor"/></dd></div>
        {handoff.policy.payDiscovery ? <div><dt>PaySH discovery</dt><dd>Enabled</dd></div> : null}
        {handoff.policy.semanticRequired ? <div><dt>Semantic review</dt><dd>Required</dd></div> : null}
      </dl>
      <details className="native-details"><summary>Setup details and policy binding</summary>
        <dl className="facts">
          <div><dt>Token mint</dt><dd><AccountIdentity address={handoff.wallet.mint} network={handoff.network} label="Token mint" kind="token"/></dd></div>
          <div><dt>Authority</dt><dd><AccountIdentity address={handoff.wallet.authority} network={handoff.network} label="Authority"/></dd></div>
          {binding ? <>
            <div><dt>{finalized ? 'Vault' : 'Vault (after deployment)'}</dt><dd><AccountIdentity address={binding.vault} network={handoff.network} label="Vault"/></dd></div>
            <div><dt>Policy program</dt><dd><AccountIdentity address={binding.policy} network={handoff.network} label="Policy program" kind="program"/></dd></div>
            <div><dt>Custody program</dt><dd><AccountIdentity address={binding.custody} network={handoff.network} label="Custody program" kind="program"/></dd></div>
          </> : null}
        </dl>
        <dl className="facts" aria-label="Technical IDs">
          <div><dt>Policy ID</dt><dd className="mono tempo-wrap">{handoff.policy.id}</dd></div>
          <div><dt>Request ID</dt><dd className="mono tempo-wrap">{handoff.requestId}</dd></div>
          {handoff.retryPreparationOf ? <div><dt>Replaces request</dt><dd className="mono tempo-wrap">{handoff.retryPreparationOf}</dd></div> : null}
          <div><dt>Intent digest</dt><dd className="mono tempo-wrap">{handoff.intentDigest}</dd></div>
        </dl>
        <PolicyCode code={handoff.policy.rust} label="Policy source"/>
      </details>
      {view.checking ? <p className="small muted" role="status">Checking deployment…</p> : null}
      {view.operation ? <p className="small" role="status">{finalized ? 'Deployment confirmed.' : failed ? 'The original deployment failed. Create a new request in the CLI to retry.' : expired ? 'The signed deployment remains unresolved. Preserve its original proof and check its chain status before authorizing another operation.' : 'The deployment is not confirmed. Keep the original link and request ID.'}{transactionUrl ? <> <a href={transactionUrl} target="_blank" rel="noreferrer">View transaction</a></> : null}</p> : null}
      {view.operation && !finalized && !failed && !expired ? <div className="btn-row"><button type="button" className="btn" disabled={busy || view.checking || !view.config} onClick={() => void perform('replay')}>Retry saved transaction</button></div> : null}
      {view.signedProof && !view.operation && !view.checking ? <p className="small muted">An original signed proof is saved. Reload this link to check its status.</p> : null}
      {!view.operation && !view.signedProof ? <><label className="tempo-consent"><input type="checkbox" checked={consent} disabled={busy || view.checking || !view.config} onChange={event => setConsent(event.target.checked)}/>I authorize this deployment on Solana Devnet.</label><div className="btn-row"><button type="button" className="btn btn-primary" disabled={busy || view.checking || !view.config || !consent || !!c.busy} onClick={() => void perform()}>{busy ? 'Signing…' : 'Approve and sign once'}</button></div></> : null}
    </div> : null}
  </dialog>;
}
