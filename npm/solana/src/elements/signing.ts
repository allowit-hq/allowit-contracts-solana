import {base64, unbase64} from '../bytes.js';
import {address, canSign, readMessage, readWire} from '../message.js';
import {assets, canonicalNetwork} from '../networks.js';
import {APPROVE_POLICY, SET_UP_WALLET, approvalMessage, installationOf, messageHash, ownerStepsOf, plainDecimal, policyApproval, setupOf, stepsHold, type OwnerStepsFacts} from '../native-wallet.js';
import {reviewAnswer} from '../review-answer.js';
import {remember} from '../signatures.js';
import {base, emit, expiry, h, type Data} from './base.js';
import {formatUnits, link} from './display.js';

type Failure = {code: string; message: string};
const failure = (error: unknown, code: string): Failure => ({code: String((error as {code?: unknown})?.code ?? code), message: error instanceof Error ? error.message : String(error)});
const sol = (lamports: bigint) => `${formatUnits(lamports.toString(), 9)} SOL`;

/**
 * An owner step. For a transaction, `payload` is the base64 text of its message and `hash` the SHA-256 of that
 * message; for a policy approval, `payload` is the base64 text of the approval message.
 */
export interface OwnerStep {action: string; payload: string; hash: string; expiresAt: number; explorer?: string | null}
export function ownerStep(value: unknown): OwnerStep | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const expiresAt = Number(v.expiresAt ?? v.expires_at);
  if (typeof v.action !== 'string' || typeof v.payload !== 'string' || typeof v.hash !== 'string' || !/^[0-9a-f]{64}$/.test(v.hash)
    || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.payload) || v.payload.length > 400_000) return null;
  return {action: v.action, payload: v.payload, hash: v.hash, expiresAt, explorer: typeof v.explorer === 'string' ? v.explorer : null};
}

/**
 * The message of a transaction step, or null: the payload must be a legacy message that only its fee payer signs and
 * whose hash is the hash of the reviewed step. The owner signs nothing else.
 */
export function stepMessage(step: OwnerStep): {bytes: Uint8Array; owner: string; parsed: NonNullable<ReturnType<typeof readMessage>>} | null {
  const bytes = unbase64(step.payload, 2_048);
  const parsed = bytes ? readMessage(bytes) : null;
  return bytes && parsed && parsed.signers === 1 && messageHash(bytes) === step.hash ? {bytes, owner: parsed.keys[0], parsed} : null;
}

/**
 * What each owner step does, in the owner's words, for steps that `ownerStepsOf` read: every step acts on the wallet
 * of the roles that the memo names, and an approval names only that wallet's delegate.
 */
export function describe(facts: OwnerStepsFacts, network: string): string[] {
  const listed = assets(network).find(a => a.id === facts.mint);
  const amount = (value: bigint, decimals: number) => listed && listed.decimals === decimals
    ? `${plainDecimal(value, listed.decimals)} ${listed.symbol}` : `${value} base units of the token ${facts.mint}`;
  return [...facts.steps.map(step => {
    switch (step.kind) {
      case 'approve': return `Let the wallet's agent and the server spend up to ${amount(step.allowance, step.decimals)} from the wallet ${facts.wallet}. This replaces the earlier allowance and moves no tokens.`;
      case 'stop': return `Stop the wallet ${facts.wallet}: the agent and the server can pay nothing until you approve an allowance again.`;
      // The destination is the one that the request named; this page cannot tell whose account it is.
      case 'recover': return `Move ${amount(step.amount, step.decimals)} from the wallet ${facts.wallet} to the token account ${step.to}.`;
      case 'close': return `Close the empty wallet ${facts.wallet}. Its deposit returns to your account.`;
    }
  }), 'A note that names this request.'];
}

/** CAIP-122 sign-in text: the first line names this site, the second line is the signing account. */
export function signInMessageFor(message: string, account: string, host: string): boolean {
  const lines = message.split('\n');
  return lines.length > 2 && lines[0].startsWith(`${host} wants you to sign in with your `) && lines[0].endsWith(' account:') && lines[1] === account;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const node = h('button', {type: 'button'}, text) as HTMLButtonElement;
  node.addEventListener('click', onClick);
  return node;
}

export function walletSignInElement() {
  return class extends base() {
    render(): void {
      const {network} = (this.data ?? {}) as Data;
      const id = canonicalNetwork(network);
      const status = h('p', {class: 'status', role: 'status'});
      const pending = (this.data as Data | undefined)?.message;
      // Two phases: without a message the element only connects and reports the address; with the
      // server's address-bound message it signs that message.
      const go = button(typeof pending === 'string' ? 'Approve the sign-in message' : 'Sign in with a Solana wallet', async () => {
        const message = (this.data as Data | undefined)?.message;
        go.disabled = true; status.textContent = 'Waiting for the wallet…';
        try {
          if (!id || (message != null && typeof message !== 'string')) throw Object.assign(new Error('The sign-in request is invalid.'), {code: 'invalid'});
          const {connectWallet, signWalletMessage} = await import('../wallet.js');
          const account = await connectWallet(id);
          if (message == null) {
            status.textContent = '';
            emit(this, 'allowit-signed-in', {address: account});
            return;
          }
          if (!signInMessageFor(message, account, location.host)) throw Object.assign(new Error('The sign-in message does not match this site and account. Nothing was signed.'), {code: 'invalid'});
          const signature = await signWalletMessage(message, account, id);
          status.textContent = '';
          emit(this, 'allowit-signed-in', {address: account, signature});
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
          emit(this, 'allowit-error', failure(error, 'wallet'));
        } finally {go.disabled = false;}
      });
      go.disabled = !id;
      this.replaceChildren(go, status);
    }
  };
}

export function ownerSignElement() {
  return class extends base() {
    render(): void {
      const data = (this.data ?? {}) as Data;
      const id = canonicalNetwork(data.network), step = ownerStep(data.step);
      const summary = Array.isArray(data.summary) ? data.summary as {label?: unknown; value?: unknown}[] : [];
      const invalid = () => this.replaceChildren(h('p', {class: 'invalid'}, 'This owner step is invalid.'));
      if (!id || !step) {invalid(); return;}
      const rows = summary.flatMap(row => [h('dt', {}, String(row.label ?? '')), h('dd', {}, String(row.value ?? ''))]);
      const cancel = button('Cancel', () => emit(this, 'allowit-cancel'));
      const status = h('p', {class: 'status', role: 'status'});
      const named = typeof data.owner === 'string' && canSign(data.owner) ? data.owner : null;
      const expired = () => Object.assign(new Error('This owner step expired. Prepare it again.'), {code: 'expired'});
      /** A signing button: it runs `sign`, reports the signed payload, and shows a failure as the wallet states it. */
      const signer = (label: string, sign: () => Promise<string>) => {
        const node = button(label, async () => {
          node.disabled = true; status.textContent = 'Waiting for the wallet…';
          try {
            if (step.expiresAt <= Date.now() / 1000) throw expired();
            const signedPayload = await sign();
            status.textContent = 'Signed.';
            emit(this, 'allowit-signed', {signedPayload, hash: step.hash});
          } catch (error) {
            status.textContent = error instanceof Error ? error.message : String(error);
            emit(this, 'allowit-error', failure(error, 'sign'));
          } finally {node.disabled = false;}
        });
        return node;
      };
      if (step.action === APPROVE_POLICY) {
        // This step signs a message, never a transaction: the owner's approval of the exact source and values of
        // one policy on one wallet. Only an approval message of this network is signed, and the owner reads what it
        // names. `data.expected` binds it to the policy that the page reviewed and to the installation of the request:
        // its wallet, agent and server, which the approval must name.
        const message = approvalMessage(step), fields = policyApproval(message, id);
        const expected = data.expected && typeof data.expected === 'object' ? data.expected as Record<string, unknown> : null;
        const stated = installationOf(expected);
        const differs = (key: 'policyId' | 'sourceHash' | 'paramsHash') => expected?.[key] !== undefined && expected[key] !== fields?.[key];
        if (message === null || !fields || !stated || differs('policyId') || differs('sourceHash') || differs('paramsHash')
          || fields.wallet !== stated.wallet || fields.fields.agent !== stated.agent || fields.fields.server !== stated.server) {invalid(); return;}
        rows.push(h('dt', {}, 'Wallet'), h('dd', {}, link(id, 'address', fields.wallet, fields.wallet)));
        rows.push(h('dt', {}, 'Agent'), h('dd', {}, link(id, 'address', stated.agent, stated.agent)));
        rows.push(h('dt', {}, 'Server'), h('dd', {}, link(id, 'address', stated.server, stated.server)));
        rows.push(h('dt', {}, 'Policy source hash'), h('dd', {class: 'mono'}, fields.sourceHash));
        rows.push(h('dt', {}, 'Values hash'), h('dd', {class: 'mono'}, fields.paramsHash));
        rows.push(h('dt', {}, 'What you sign'), h('dd', {}, 'A message that approves this policy for the wallet. The server then checks every payment of your agent against it. It moves no funds.'));
        const sign = signer('Sign the approval', async () => {
          const {connectWallet, signWalletMessage} = await import('../wallet.js');
          return signWalletMessage(message, named ?? await connectWallet(id), id);
        });
        this.replaceChildren(h('dl', {class: 'owner-step'}, ...rows), h('div', {class: 'actions'}, sign, cancel), status);
        return;
      }
      // Every other step is a transaction that only the owner signs, with the hash of the reviewed step.
      const tx = stepMessage(step);
      if (!tx || (named !== null && named !== tx.owner)) {invalid(); return;}
      if (step.action === SET_UP_WALLET) {
        // The owner reads what this step sets up before the wallet opens: the agent's wallet, its delegate, the token
        // that it holds and the allowance. Any other transaction under this action is refused.
        const setup = setupOf(tx.bytes, tx.parsed);
        const token = setup ? assets(id).find(a => a.id === setup.mint && a.decimals === setup.decimals) : undefined;
        if (!setup || !token) {invalid(); return;}
        rows.push(h('dt', {}, 'Wallet'), h('dd', {}, link(id, 'address', setup.wallet, setup.wallet)));
        rows.push(h('dt', {}, 'Agent'), h('dd', {}, link(id, 'address', setup.agent, setup.agent)));
        rows.push(h('dt', {}, 'Token'), h('dd', {}, `${token.symbol}, mint `, link(id, 'address', setup.mint, setup.mint)));
        rows.push(h('dt', {}, 'Allowance'), h('dd', {}, `Your agent and the server may spend up to ${plainDecimal(setup.allowance, token.decimals)} ${token.symbol} from the wallet, only together. This step moves no ${token.symbol}: send ${token.symbol} to the wallet address to fund it. The wallet is your own token account, and only you can stop it, take the ${token.symbol} back or close it.`));
        rows.push(h('dt', {}, 'You pay'), h('dd', {}, setup.deposits > 0n
          ? `${sol(setup.deposits)} that the network locks in the accounts that this step opens, and the network fee of ${sol(5_000n)}. Closing the wallet returns the deposit of its token account.`
          : `The network fee of ${sol(5_000n)}. The accounts of this wallet exist already.`));
      } else {
        // Every other transaction is owner steps on the wallet that its memo names, and nothing else. That wallet, its
        // agent and its server must be the installation of the request, `data.expected`: the memo's own roles prove
        // nothing, since the wallet's address leaves the server out.
        const steps = ownerStepsOf(tx.bytes, tx.parsed, id);
        if (!steps || !stepsHold(steps, data.expected)) {invalid(); return;}
        rows.push(h('dt', {}, 'Wallet'), h('dd', {}, link(id, 'address', steps.wallet, steps.wallet)));
        rows.push(h('dt', {}, 'Agent'), h('dd', {}, link(id, 'address', steps.agent, steps.agent)));
        rows.push(h('dt', {}, 'Server'), h('dd', {}, link(id, 'address', steps.server, steps.server)));
        rows.push(h('dt', {}, 'What you sign'), h('dd', {}, h('ul', {}, ...describe(steps, id).map(line => h('li', {}, line)))));
        rows.push(h('dt', {}, 'You pay'), h('dd', {}, `The network fee of ${sol(5_000n)}.`));
      }
      rows.push(h('dt', {}, 'Expires'), h('dd', {}, expiry(step.expiresAt)));
      const sign = signer('Sign in wallet', async () => {
        const {connectWallet, signWalletTransaction} = await import('../wallet.js');
        const owner = named ?? await connectWallet(id);
        if (owner !== tx.owner) throw Object.assign(new Error('The wallet account is not the owner of this step. Nothing was signed.'), {code: 'wallet_wrong_account'});
        const signedPayload = await signWalletTransaction(tx.bytes, owner, id);
        const signed = readWire(unbase64(signedPayload) ?? new Uint8Array());
        if (signed) remember(step.hash, signed.signatures[0]);
        return signedPayload;
      });
      this.replaceChildren(h('dl', {class: 'owner-step'}, ...rows), h('div', {class: 'actions'}, sign, cancel), status);
    }
  };
}

/**
 * Signs the owner's answer to a held request with the wallet's message signature. It signs only an owner review
 * answer message of this network, with the account `owner`, and shows the fields of the message that it signs.
 */
export function ownerAnswerElement() {
  return class extends base() {
    render(): void {
      const data = (this.data ?? {}) as Data;
      // The text that was validated and shown is the text that the wallet signs: a later change of `data` is not.
      const message = typeof data.message === 'string' ? data.message : null;
      const owner = typeof data.owner === 'string' ? data.owner : '';
      const id = canonicalNetwork(data.network), fields = reviewAnswer(message);
      if (!id || message === null || !fields || fields.network !== id || !canSign(owner)) {
        this.replaceChildren(h('p', {class: 'invalid'}, 'This answer is invalid.'));
        return;
      }
      const rows = [
        h('dt', {}, 'Answer'), h('dd', {}, fields.answer === 'allow' ? 'Allow this one request' : 'Deny this one request'),
        h('dt', {}, 'Request'), h('dd', {}, `${fields.operation} ${fields.amount}`),
        h('dt', {}, 'To'), h('dd', {class: 'mono'}, fields.to),
        h('dt', {}, 'Policy'), h('dd', {}, fields.policy),
        ...(fields.question !== undefined ? [h('dt', {}, 'Question'), h('dd', {}, fields.question)] : [h('dt', {}, 'Lookup'), h('dd', {}, fields.lookup ?? '')]),
        h('dt', {}, 'Score'), h('dd', {}, fields.score),
        h('dt', {}, 'Snapshot'), h('dd', {class: 'mono'}, fields.snapshot),
      ];
      const status = h('p', {class: 'status', role: 'status'});
      const sign = button('Sign the answer', async () => {
        sign.disabled = true; status.textContent = 'Waiting for the wallet…';
        try {
          const {connectWallet, signWalletMessage} = await import('../wallet.js');
          const account = await connectWallet(id);
          if (account !== owner) throw Object.assign(new Error('The wallet account is not the owner of this policy. Nothing was signed.'), {code: 'mismatch'});
          const signature = await signWalletMessage(message, account, id);
          status.textContent = 'Signed.';
          emit(this, 'allowit-signed', {signature, answer: fields.answer, snapshot: fields.snapshot});
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
          emit(this, 'allowit-error', failure(error, 'sign'));
        } finally {sign.disabled = false;}
      });
      const cancel = button('Cancel', () => emit(this, 'allowit-cancel'));
      this.replaceChildren(h('dl', {class: 'owner-step'}, ...rows), h('div', {class: 'actions'}, sign, cancel), status);
    }
  };
}

/** Checks an installation's shape and identities, and reports the result. The host keeps the server checks. */
export function bindingReviewElement() {
  return class extends base() {
    render(): void {
      const data = (this.data ?? {}) as Data;
      const id = canonicalNetwork(data.network);
      const installation = (data.installation ?? {}) as Record<string, unknown>;
      const owner = typeof installation.owner === 'string' ? installation.owner : '';
      const wallet = typeof installation.wallet === 'string' ? installation.wallet : '';
      const ok = !!id && installation.network === id && canSign(owner) && !!address(wallet)
        && /^[a-f0-9]{64}$/.test(String(installation.sourceHash)) && installation.state === 'installed';
      const rows = [
        h('dt', {}, 'Wallet'), h('dd', {}, id && wallet ? link(id, 'address', wallet, wallet) : wallet),
        h('dt', {}, 'Owner'), h('dd', {}, id && owner ? link(id, 'address', owner, owner) : owner),
        h('dt', {}, 'Result'), h('dd', {}, ok ? 'The installation matches this network and policy source.' : 'The installation does not match.'),
      ];
      this.replaceChildren(h('dl', {class: 'binding-review'}, ...rows));
      queueMicrotask(() => emit(this, 'allowit-verified', {ok, detail: ok ? 'installed' : 'mismatch'}));
    }
  };
}

export {base64};
