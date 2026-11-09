import {describe, expect, it} from 'vitest';
import {Buffer} from 'buffer';
import {Keypair, PublicKey, Transaction} from '@solana/web3.js';
import {checkedReturnTransaction, delegatePolicyAccount, delegateSourceAccount, returnInstructions} from './delegate-wallet-intent';
import type {DelegateConfig, DelegateGrant, DelegateReturnPreparation} from './delegate-contracts';

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const delegate = '87fX2a7BbnbJJKu4orKh6KriX3USZz9L8t593S1PnYZL';
const grantId = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX';
const blockhash = mint;

function setup(options: {sponsor?: boolean} = {}) {
  const owner = Keypair.generate().publicKey.toBase58();
  const sponsor = options.sponsor === false ? undefined : Keypair.generate();
  const config: DelegateConfig = {
    ready: true, network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', displayNetwork: 'solana:devnet', genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    mint, delegate, decimals: 6, tokenProgram: TOKEN.toBase58(), ...(sponsor ? {setupFeePayer: sponsor.publicKey.toBase58()} : {}),
  };
  const grant: DelegateGrant = {
    id: grantId, owner, network: config.network, displayNetwork: config.displayNetwork, genesisHash: config.genesisHash,
    mint, delegate, sourceAccount: delegatePolicyAccount(owner, grantId), source: 'immutable source', intent: 'research',
    sourceHash: 'a'.repeat(64), irHash: 'b'.repeat(64), memo: `allowit-grant-v1:${'c'.repeat(64)}`,
    commitmentHash: 'c'.repeat(64), commitmentBytesBase64: 'e30=', policyAccount: true,
    budgetUnits: '1000', remainingUnits: '1000', reservedUnits: '0', spentUnits: '0',
    status: 'prepared', expiresAt: 4_102_444_800, revision: 1, parentGrantId: null, policyId: 'policy-one', children: [], receipts: [],
  };
  return {owner, sponsor, config, grant, feePayer: sponsor?.publicKey.toBase58() ?? owner};
}
const wire = (tx: Transaction) => Buffer.from(tx.serialize({requireAllSignatures: false, verifySignatures: false})).toString('base64');

function returned(s: ReturnType<typeof setup>, units = 640n, rentPayer = s.feePayer, extra: Partial<DelegateReturnPreparation> = {}): DelegateReturnPreparation {
  const grant = {...s.grant, status: 'revoked' as const, memo: `allowit-return-v1:${s.grant.commitmentHash}`};
  const tx = new Transaction({feePayer: new PublicKey(s.feePayer), recentBlockhash: blockhash}).add(...returnInstructions(grant, units, rentPayer));
  if (s.sponsor) tx.partialSign(s.sponsor);
  return {
    grantId, preparationId: 'return-one', action: 'return', transactionBase64: wire(tx), feePayer: s.feePayer,
    sourceAccount: s.grant.sourceAccount, fundingAccount: delegateSourceAccount(s.owner, mint), mint, genesisHash: s.config.genesisHash,
    returnUnits: units.toString(), rentPayer, memo: `allowit-return-v1:${s.grant.commitmentHash}`, lastValidBlockHeight: 123, ...extra,
  };
}

describe('policy token accounts', () => {
  

  it('return every reviewed unit to the main account and the rent to its depositor', () => {
    for (const sponsored of [true, false]) {
      const s = setup({sponsor: sponsored});
      const revoked = {...s.grant, status: 'revoked' as const};
      expect(checkedReturnTransaction(s.config, revoked, s.owner, returned(s))).toBeInstanceOf(Transaction);
      expect(checkedReturnTransaction(s.config, revoked, s.owner, returned(s, 0n))).toBeInstanceOf(Transaction);
      // Rent goes back only to the owner or this deployment's setup fee payer.
      const stranger = Keypair.generate().publicKey.toBase58();
      expect(() => checkedReturnTransaction(s.config, revoked, s.owner, returned(s, 640n, stranger))).toThrow(/rent refund/);
      // A sponsor that paid this grant's approval stays a valid refund address after the deployment changes sponsors.
      expect(checkedReturnTransaction(s.config, revoked, s.owner, returned(s, 640n, stranger), stranger)).toBeInstanceOf(Transaction);
      // The stated amount must be the transaction's amount.
      expect(() => checkedReturnTransaction(s.config, revoked, s.owner, returned(s, 640n, s.feePayer, {returnUnits: '641'}))).toThrow(/changes the return amount/);
      expect(() => checkedReturnTransaction(s.config, revoked, s.owner, returned(s, 640n, s.feePayer, {fundingAccount: stranger}))).toThrow(/your USDC account/);
      // Nothing is returned before the allowance is revoked.
      expect(() => checkedReturnTransaction(s.config, s.grant, s.owner, returned(s))).toThrow(/Nothing was signed/);
    }
  });
});
