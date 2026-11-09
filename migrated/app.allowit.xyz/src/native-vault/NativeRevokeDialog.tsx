import {useId, useRef, useState} from 'react';
import {Wallet} from 'lucide-react';
import {Spinner} from '../shell/Shell';
import RevokeDialog, {type RevokeCopy, type RevokeRun} from '../policy/RevokeDialog';
import {decimal, finalizedSlot, settledOperation, type PublicOperation} from './native-contracts';
import {checkWithdraw} from './native-withdraw';
import type {NativeFundingModel} from './NativeFunding';

export type {RevokeRun};

type Admission = {ok: true; mode: 'new' | 'continue' | 'additional' | 'retry'} | {ok: false; blocker: {method: string}};

const link = (signature: string) => 'https://explorer.solana.com/tx/' + encodeURIComponent(signature) + '?cluster=devnet';
const COPY: RevokeCopy = {
  token: 'USDC', network: 'Devnet',
  returnText: 'Stop agent spending, return all remaining USDC to your wallet and close the vault in one wallet transaction. Account rent is returned too.',
  stopText: 'Revokes the vault’s spending approval. Remaining USDC stays in the vault until you withdraw it or close the vault.',
  returnedText: 'Everything left in the vault is back in your wallet, and the vault is closed. Its account rent was returned too.',
  keptUntil: 'until you withdraw it or close the vault',
  stopLabel: 'Revoke vault',
};

interface Props {
  /** Opened by the policy's close button in the list, or by Continue in the page's status section. */
  open: boolean;
  onClose: () => void;
  m: NativeFundingModel;
  /** The vault is still being read: the dialog is open, its balance and actions are not ready yet. */
  reading?: boolean;
  disabled: boolean;
  /** Whether a full return (close) may start now, and how. */
  returnAdmission: Admission;
  returnLabel: string;
  /** The action in progress or just finished, kept by the page so the dialog outlives the vault it closed. */
  run: RevokeRun | null;
  setRun: (run: RevokeRun | null) => void;
  /** Done after a result; `returned` is true when nothing is left in the vault. */
  onFinished: (returned: boolean) => void;
}

/** The shared revoke dialog for a native Solana vault, which can also withdraw part of its balance. */
export default function NativeRevokeDialog({open, onClose, m, disabled, reading = false, returnAdmission, returnLabel, run, setRun, onFinished}: Props) {
  const [amount, setAmount] = useState('');
  const [notice, setNotice] = useState('');
  // The model as last rendered, read after an action resolves.
  const latest = useRef(m);
  latest.current = m;
  const id = useId();
  const state = m.reply?.state ?? null;
  const balance = state?.balance ?? null;
  const shownBalance = balance === null ? null : decimal(balance);
  const busy = !!m.busy;
  const check = checkWithdraw(amount, balance);
  const empty = balance === '0';
  const running = run?.ok === null;
  // Withdrawing everything closes the vault instead, in the same single signature, so no empty vault is left behind.
  const closesVault = check.ok && check.all && returnAdmission.ok;
  // Every action shows its progress, then a result that says what reached the wallet, or that nothing moved.
  const start = async (method: RevokeRun['method'], amountOut: string | null, action: () => Promise<boolean>) => {
    setNotice('');
    const before = shownBalance;
    const prior = m.reply?.operations ?? [];
    const priorIds = prior.map(op => op.id), priorFinal = prior.filter(op => settledOperation(op) || op.status === 'failed').map(op => op.id);
    setRun({method, amount: amountOut, before, ok: null, error: '', priorIds, priorFinal});
    const ok = await action();
    // Let the model's final read render before reading its error.
    await new Promise(resolve => setTimeout(resolve, 0));
    setRun({method, amount: amountOut, before, ok, error: ok ? '' : latest.current.error || 'The action did not complete.', priorIds, priorFinal});
    if (ok) setAmount('');
  };
  const withdraw = async () => {
    if (!check.ok) return;
    if (closesVault) return returnAll();
    await start('withdraw', check.amount, () => m.withdraw(check.amount));
  };
  const returnAll = () => start('close', shownBalance, () => m.returnFunds(returnAdmission.ok && returnAdmission.mode === 'additional'));
  const stop = () => start('revoke', null, () => m.revoke(m.retryRevoke ?? undefined));
  const ops = m.reply?.operations ?? [];
  // The operation this action produced or completed: never one already finished when it started.
  // A finalized candidate wins, then a new one over an earlier attempt, so a dropped attempt never stands in for it.
  const slotOf = (op: PublicOperation) => finalizedSlot(op.finalizedSlot) ?? -1n;
  const resultOf = (r: RevokeRun) => ops.filter(op => op.method === r.method && !r.priorFinal.includes(op.id))
    .sort((a, b) => Number(settledOperation(b)) - Number(settledOperation(a))
      || Number(r.priorIds.includes(a.id)) - Number(r.priorIds.includes(b.id))
      || (slotOf(b) > slotOf(a) ? 1 : slotOf(b) < slotOf(a) ? -1 : 0))[0];
  const vaultGone = !m.reply?.state || m.reply.state.balance === '0';
  const finish = () => {const returned = !!run?.ok && (run.method === 'close' || vaultGone); setRun(null); onFinished(returned);};
  const close = () => {if (busy || running) return; if (run && run.ok !== null) finish(); else onClose();};
  const op = run && run.ok !== null ? resultOf(run) : undefined;
  // A closed vault is final for a return even before its own operation record is refreshed.
  const final = (!!op && settledOperation(op)) || (run?.method === 'close' && m.status === 'Funds returned');
  const outcome = run && run.ok !== null ? {final, expired: !final && !!op && op.blockhashExpired === true, link: op?.signature ? link(op.signature) : undefined} : undefined;
  const partial = <section className="native-revoke-option" aria-labelledby={`${id}-withdraw`}>
    <div className="native-revoke-option-head">
      <span className="native-revoke-icon" aria-hidden="true"><Wallet size={16} /></span>
      <h3 id={`${id}-withdraw`}>Withdraw part</h3>
    </div>
    <p>Return an amount to your wallet. The policy stays active and the agent can spend what remains within its limits.</p>
    <form className="native-withdraw" onSubmit={event => {event.preventDefault(); void withdraw();}}>
      <label htmlFor={`${id}-amount`} className="native-revoke-label">Amount, USDC</label>
      <div className="native-withdraw-row">
        <div className="native-amount" data-invalid={!!amount && !check.ok}>
          <input id={`${id}-amount`} className="mono" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} disabled={disabled || empty || !state}
            aria-invalid={!!amount && !check.ok} aria-describedby={`${id}-amount-hint`} onChange={event => setAmount(event.target.value)} />
          <span className="native-amount-unit" aria-hidden="true">USDC</span>
          <button type="button" className="native-amount-max" disabled={disabled || empty || shownBalance === null} onClick={() => setAmount(shownBalance ?? '')}>Max</button>
        </div>
        <button type="submit" className="btn" disabled={disabled || !check.ok}>{m.busy === 'withdrawing' || (closesVault && m.busy === 'returning') ? <Spinner /> : null}{closesVault ? 'Withdraw all and close' : 'Withdraw'}</button>
      </div>
      <p id={`${id}-amount-hint`} className={amount && !check.ok ? 'field-error' : 'native-revoke-hint'}>{amount && !check.ok ? check.error : closesVault ? 'This is the whole balance: the vault closes and returns everything, including its account rent.' : check.ok && check.all ? 'This withdraws the whole balance and leaves an empty vault.' : empty ? 'The vault is empty.' : 'Your wallet confirms the withdrawal.'}</p>
    </form>
  </section>;
  return <RevokeDialog open={open} onOpen={() => {setNotice(''); setAmount(''); setRun(null);}} onClosed={onClose} requestClose={close}
    copy={COPY} busy={busy} phase={m.busy} reading={reading} balance={shownBalance} run={run} outcome={outcome} vaultGone={vaultGone} partial={partial}
    returnAll={{label: returnLabel, blocker: returnAdmission.ok ? undefined : `Recover the original ${returnAdmission.blocker.method} operation before returning USDC.`, disabled: disabled || !state || !returnAdmission.ok, spinning: m.busy === 'returning', run: () => void returnAll()}}
    stop={{label: m.retryRevoke ? 'Retry expired unsigned revoke' : undefined, disabled: disabled || m.status === 'Revoked' || !state, spinning: m.busy === 'revoke', run: () => void stop()}}
    notice={notice} error={m.error} onDone={finish} onRetry={() => setRun(null)} />;
}
