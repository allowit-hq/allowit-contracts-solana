/**
 * What the SDK's owner workflows read from Solana and check with its keys: Core's `OwnerChain` contract. The SDK holds
 * the workflows, their journal and their recovery rules; these hooks build, send and read Solana transactions and
 * check Solana signatures.
 *
 * A step is named by the SHA-256 of its message. The network names a transaction by its signature, which the rail
 * remembers from the signed bytes that it reads (`signatures.ts`).
 */
import type {OwnerChain} from '@allowit/core';
import {base58, unbase64} from './bytes.js';
import {readWire} from './message.js';
import {canonicalNetwork} from './networks.js';
import {approvalHolds, approvalSignedBy, approvalStep, checkAsset, messageHash, policyApproval, prepareSetup, sendSetup,
  signedSetupOf, walletConfiguration, walletOwner, type PolicyApproval} from './native-wallet.js';
import {blockhashValid, status, type Send} from './rpc.js';
import {remember, signatureOf} from './signatures.js';

/**
 * The record of the step with `hash`: its slot and whether it succeeded once the finalized bank holds it, `'missing'`
 * when the node holds no transaction of its signature, and null without a clear answer: a transaction that is not
 * finalized yet, a node that cannot be read, or a hash whose signed bytes this browser never saw.
 */
export async function transaction(network: string, hash: string, send?: Send): ReturnType<OwnerChain['transaction']> {
  const signature = canonicalNetwork(network) ? signatureOf(hash) : null;
  if (!signature) return null;
  const seen = await status(network, signature, send).catch(() => null);
  if (!seen) return null;
  if (!seen.status) return 'missing';
  return seen.status.finalized ? {hash, ledger: seen.status.slot, successful: !seen.status.failed} : null;
}

/**
 * For signed bytes past their time bound: the slot when they ran successfully, or null when they can never take
 * effect. They can never take effect when the finalized bank holds them as failed, or when their blockhash is no
 * longer valid at the finalized bank and a node at that bank or past it holds no transaction of their signature.
 * Anything else throws, and the SDK keeps the step: a transaction that is not finalized, a blockhash that is still
 * valid, or a node that is behind.
 */
export async function expiredRecord(network: string, hash: string, signedPayload: string, send?: Send): Promise<{ledger: number} | null> {
  const signed = canonicalNetwork(network) ? readWire(unbase64(signedPayload) ?? new Uint8Array()) : null;
  if (!signed || messageHash(signed.message) !== hash || signed.signatures[0].every(byte => byte === 0)) throw new Error('The signed bytes are not the step of this hash.');
  remember(hash, signed.signatures[0]);
  // The blockhash is read first: once it is invalid at a finalized bank, no later block can hold the transaction.
  const lapsed = await blockhashValid(network, signed.parsed.blockhash, send);
  const seen = await status(network, base58(signed.signatures[0]), send);
  if (seen.status) {
    if (!seen.status.finalized) throw new Error('The transaction is not finalized yet.');
    return seen.status.failed ? null : {ledger: seen.status.slot};
  }
  if (lapsed.valid) throw new Error('The transaction can still run: its blockhash is valid.');
  if (seen.at < lapsed.at) throw new Error('The node that read the signature is behind the finalized bank.');
  return null;
}

/** The hooks of the SDK's owner workflows. */
export const ownerChain: OwnerChain = Object.freeze({
  transaction: (network: string, hash: string) => transaction(network, hash),
  expiredRecord: (network: string, hash: string, signedPayload: string) => expiredRecord(network, hash, signedPayload),
  /**
   * A Native wallet: one owner signature opens it and approves its delegate. The SDK keeps the signed setup in its
   * journal and decides when to send it again or replace it.
   */
  keypairSetup: Object.freeze({
    prepare: (input: Parameters<NonNullable<OwnerChain['keypairSetup']>['prepare']>[0]) => prepareSetup(input),
    read: (signedPayload: string, network: string) => {
      const setup = signedSetupOf(signedPayload, network);
      return setup && {hash: setup.hash, owner: setup.owner, wallet: setup.wallet, agent: setup.agent, server: setup.server, validUntil: setup.validUntil, asset: setup.asset, amount: setup.amount};
    },
    checkAsset,
    send: (network: string, signedPayload: string, hash: string): Promise<number | null> => sendSetup(network, signedPayload, hash),
    configuration: walletConfiguration,
  }),
  /** The owner's approval of a Native policy: one message signature, and no transaction. */
  approval: Object.freeze({
    read: (message: unknown, network: string): PolicyApproval | null => policyApproval(message, network),
    /** `installation` is the installation of `wallet` that the host states: its agent and server. Without it, no approval holds. */
    holds: (fields: unknown, wallet: string, reviewed: Parameters<typeof approvalHolds>[2], installation?: Parameters<typeof approvalHolds>[3]): boolean =>
      approvalHolds(fields as PolicyApproval, wallet, reviewed, installation),
    step: (message: string) => approvalStep(message),
    walletOwner: (network: string, wallet: string) => walletOwner(network, wallet),
    signedBy: approvalSignedBy,
  }),
});
