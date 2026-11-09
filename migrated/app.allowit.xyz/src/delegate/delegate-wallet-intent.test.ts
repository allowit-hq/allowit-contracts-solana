import {describe, expect, it} from 'vitest';
import {Buffer} from 'buffer';
import {ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction} from '@solana/web3.js';
import type {Wallet, WalletAccount} from '@wallet-standard/base';
import {ed25519} from '@noble/curves/ed25519.js';
import {checkedDelegateTransaction, delegateSourceAccount, delegateInstructions, signDelegateOwner, verifyDelegateGrant} from './delegate-wallet-intent';
import {type DelegateConfig, type DelegateGrant, type DelegatePreparation} from './delegate-contracts';
import {rememberSessionWallet, walletRegistry} from '../wallet/wallet';
import {sha256Hex} from '../runtime/hash';

// Public-address fixtures for unsigned packet validation; signing fixtures below use offline generated keys.
const owner = '11111111111111111111111111111111';
const mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const delegate = '87fX2a7BbnbJJKu4orKh6KriX3USZz9L8t593S1PnYZL';
const config: DelegateConfig = {
  ready: true, network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', displayNetwork: 'solana:devnet', genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mint, delegate, decimals: 6, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};
const grant: DelegateGrant = {
  id: 'grant-one', owner, network: config.network, displayNetwork: config.displayNetwork, genesisHash: config.genesisHash,
  mint, delegate, sourceAccount: delegateSourceAccount(owner, mint), source: 'immutable source', intent: 'research',
  sourceHash: 'a'.repeat(64), irHash: 'b'.repeat(64), memo: `allowit-grant-v1:${'c'.repeat(64)}`,
  commitmentHash: 'c'.repeat(64), commitmentBytesBase64: 'e30=',
  budgetUnits: '1250000', remainingUnits: '1250000', reservedUnits: '0', spentUnits: '0',
  status: 'prepared', expiresAt: 4_102_444_800, revision: 1, parentGrantId: null, policyId: 'policy-one', children: [], receipts: [],
};

function prepared(kind: 'approve' | 'revoke' = 'approve', change?: (tx: Transaction) => void): DelegatePreparation {
  const tx = new Transaction({feePayer: new PublicKey(owner), recentBlockhash: mint})
    .add(...delegateInstructions(grant, kind));
  change?.(tx);
  return {
    grantId: grant.id, preparationId: 'preparation-one', memo: grant.memo, action: kind, feePayer: owner,
    sourceAccount: grant.sourceAccount, mint, delegate, budgetUnits: grant.budgetUnits,
    genesisHash: config.genesisHash, lastValidBlockHeight: 123,
    transactionBase64: Buffer.from(tx.serialize({requireAllSignatures: false, verifySignatures: false})).toString('base64'),
  };
}

// Offline Wallet Standard boundary: real generated Ed25519 keys, no RPC or submission.
async function signingFixture(action: 'approve' | 'revoke', options: {
  network?: 'solana:mainnet' | 'solana:devnet'; sponsor?: boolean; legacy?: boolean;
  noMemoSigner?: boolean; missingMemoSignature?: boolean; corruptMemoSignature?: boolean; walletProtection?: boolean;
  changeMessage?: (tx: Transaction) => void; corruptSignature?: 'owner' | 'sponsor';
} = {}) {
  const signer = Keypair.generate(), owner = signer.publicKey.toBase58();
  const sponsor = options.sponsor ? Keypair.generate() : undefined;
  const memoSigner = !options.sponsor && !options.legacy && !options.noMemoSigner ? Keypair.generate() : undefined;
  const mainnet = options.network !== 'solana:devnet';
  const genesisHash = mainnet ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : config.genesisHash;
  const cfg: DelegateConfig = {...config, network: `solana:${genesisHash.slice(0, 32)}`, genesisHash,
    displayNetwork: mainnet ? 'solana:mainnet' : 'solana:devnet',
    mint: mainnet ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' : mint,
    ...(sponsor ? {setupFeePayer: sponsor.publicKey.toBase58()} : {}),
  };
  const sourceHash = await sha256Hex(new TextEncoder().encode(grant.source));
  const sourceAccount = delegateSourceAccount(owner, cfg.mint);
  const commitment = {version: 1, grantId: grant.id, owner, network: cfg.network, genesisHash,
    mint: cfg.mint, sourceTokenAccount: sourceAccount, delegate, budgetUnits: grant.budgetUnits,
    sourceHash, irHash: grant.irHash, intentHash: await sha256Hex(new TextEncoder().encode(grant.intent)),
    expiresAt: grant.expiresAt, revision: grant.revision, policyId: grant.policyId};
  const bytes = Buffer.from(JSON.stringify(commitment));
  const commitmentHash = await sha256Hex(bytes);
  const reviewed: DelegateGrant = {...grant, owner, network: cfg.network, displayNetwork: cfg.displayNetwork,
    genesisHash, mint: cfg.mint, sourceAccount, sourceHash, commitmentHash,
    commitmentBytesBase64: bytes.toString('base64'), memo: `allowit-grant-v1:${commitmentHash}`};
  const instructions = delegateInstructions(reviewed, action).filter(ix => !options.legacy || !ix.programId.equals(ComputeBudgetProgram.programId));
  if (memoSigner) {
    const memo = instructions[instructions.length - 1];
    instructions[instructions.length - 1] = new TransactionInstruction({programId: memo.programId, data: memo.data,
      keys: [{pubkey: memoSigner.publicKey, isSigner: true, isWritable: false}]});
  }
  const unsigned = new Transaction({feePayer: sponsor?.publicKey ?? signer.publicKey, recentBlockhash: mint}).add(...instructions);
  if (sponsor) unsigned.partialSign(sponsor);
  if (memoSigner) {
    unsigned.partialSign(memoSigner);
    const signature = unsigned.signatures.find(entry => entry.publicKey.equals(memoSigner.publicKey))!;
    if (options.missingMemoSignature) signature.signature = null;
    if (options.corruptMemoSignature) signature.signature![0] ^= 1;
  }
  const preparation: DelegatePreparation = {...prepared(action), genesisHash, mint: cfg.mint,
    sourceAccount, memo: reviewed.memo, feePayer: cfg.setupFeePayer ?? owner,
    ...(memoSigner ? {memoSigner: memoSigner.publicKey.toBase58()} : {}),
    transactionBase64: unsigned.serialize({requireAllSignatures: false, verifySignatures: false}).toString('base64')};
  const account: WalletAccount = {address: owner, publicKey: signer.publicKey.toBytes(),
    chains: [cfg.displayNetwork], features: ['solana:signMessage', 'solana:signTransaction']};
  let signingRequests = 0;
  const wallet = {version: '1.0.0', name: 'Offline allowance signer', icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    chains: [cfg.displayNetwork], accounts: [account], features: {
      'standard:connect': {version: '1.0.0', connect: async () => ({accounts: [account]})},
      'solana:signMessage': {version: '1.0.0', signMessage: async (...inputs: {message: Uint8Array}[]) => inputs.map(({message}) => ({
        signedMessage: message, signature: ed25519.sign(message, signer.secretKey.subarray(0, 32)), signatureType: 'ed25519',
      }))},
      'solana:signTransaction': {version: '1.0.0', supportedTransactionVersions: ['legacy'],
        signTransaction: async (...inputs: {transaction: Uint8Array}[]) => inputs.map(({transaction}) => {
          signingRequests++;
          const signed = Transaction.from(transaction);
          // Phantom can add its fee settings when the app supplies no compute budget.
          if (!signed.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId))
            && !signed.signatures.some(entry => entry.signature !== null)) {
            signed.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units: 100_000}),
              ComputeBudgetProgram.setComputeUnitPrice({microLamports: 0}));
          }
          if (options.walletProtection && !signed.signatures.some(entry => entry.signature !== null)) {
            signed.add(new TransactionInstruction({programId: SystemProgram.programId, keys: [], data: Buffer.from([1])}));
          }
          options.changeMessage?.(signed);
          signed.partialSign(signer);
          const invalid = options.corruptSignature === 'owner' ? owner : options.corruptSignature === 'sponsor' ? cfg.setupFeePayer : undefined;
          const signature = signed.signatures.find(entry => entry.publicKey.toBase58() === invalid)?.signature;
          if (signature) signature[0] ^= 1;
          return {signedTransaction: Uint8Array.from(signed.serialize({requireAllSignatures: false, verifySignatures: false}))};
        })},
    }} satisfies Wallet;
  const unregister = walletRegistry().register(wallet);
  rememberSessionWallet(wallet, owner);
  return {config: cfg, grant: reviewed, owner, preparation, memoSigner: memoSigner?.publicKey.toBase58(), signingRequests: () => signingRequests,
    dispose: () => {rememberSessionWallet(null); unregister();}};
}

describe('delegated owner transaction boundary', () => {
  it.each(['missingMemoSignature', 'corruptMemoSignature'] as const)('refuses %s before opening the wallet', async failure => {
    const f = await signingFixture('approve', {[failure]: true});
    try {
      await expect(signDelegateOwner(f.config, f.grant, f.owner, 'approve', f.preparation, () => true)).rejects.toThrow(/Memo.*signature/);
      expect(f.signingRequests()).toBe(0);
    } finally {f.dispose();}
  });

  it('rejects a wallet message change even when its replacement has a valid owner signature', async () => {
    const f = await signingFixture('approve', {changeMessage: tx => {tx.recentBlockhash = delegate;}});
    try {
      await expect(signDelegateOwner(f.config, f.grant, f.owner, 'approve', f.preparation, () => true)).rejects.toThrow(/wallet changed the reviewed transaction\./);
    } finally {f.dispose();}
  });

  it.each(['owner', 'sponsor'] as const)('rejects an invalid %s signature even when the message is unchanged', async corruptSignature => {
    const f = await signingFixture('approve', {sponsor: true, corruptSignature});
    try {
      await expect(signDelegateOwner(f.config, f.grant, f.owner, 'approve', f.preparation, () => true)).rejects.toThrow(/wallet returned an invalid signature\./);
    } finally {f.dispose();}
  });

  it('rejects a hidden SOL transfer even if the server echoes the same grant fields', () => {
    const changed = prepared('approve', tx => tx.add(SystemProgram.transfer({
      fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(delegate), lamports: 1,
    })));
    expect(() => checkedDelegateTransaction(config, grant, owner, 'approve', changed)).toThrow();
  });

  it('rejects an approval above the reviewed allocation', () => {
    const changed = prepared('approve', tx => {tx.instructions[2].data.writeBigUInt64LE(1_250_001n, 1);});
    expect(() => checkedDelegateTransaction(config, grant, owner, 'approve', changed)).toThrow();
  });

  it('rejects network, owner, delegate, source, genesis and decimal mismatches', () => {
    const changes: Partial<DelegateConfig>[] = [
      {network: 'solana:mainnet'}, {genesisHash: mint}, {delegate: mint}, {mint: delegate}, {decimals: 9},
    ];
    for (const change of changes) expect(() => checkedDelegateTransaction({...config, ...change}, grant, owner, 'approve', prepared())).toThrow();
    expect(() => checkedDelegateTransaction(config, grant, delegate, 'approve', prepared())).toThrow();
    expect(() => checkedDelegateTransaction(config, {...grant, sourceAccount: mint}, owner, 'approve', prepared())).toThrow();
  });

  it('revoke has no transfer or fresh allowance instruction', () => {
    const checked = checkedDelegateTransaction(config, grant, owner, 'revoke', prepared('revoke'));
    expect([...checked.instructions[2].data]).toEqual([5]);
    expect(checked.instructions[2].keys.map(key => key.pubkey.toBase58())).toEqual([grant.sourceAccount, owner]);
    expect(() => checkedDelegateTransaction(config, grant, owner, 'revoke', prepared('approve'))).toThrow();
  });

  it('refuses an unknown fee payer and a sponsor without its valid signature', () => {
    const unknownPayer = prepared('approve', tx => {tx.feePayer = new PublicKey(delegate);});
    expect(() => checkedDelegateTransaction(config, grant, owner, 'approve', unknownPayer)).toThrow();
    const sponsored = {...unknownPayer, feePayer: delegate};
    expect(() => checkedDelegateTransaction({...config, setupFeePayer: delegate}, grant, owner, 'approve', sponsored)).toThrow(/sponsor/);
  });

  it('checks both exact source bytes and decoded commitment terms', async () => {
    const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), value => value.toString(16).padStart(2, '0')).join('');
    const sourceHash = await digest(grant.source);
    const commitment = {
      version: 1, grantId: grant.id, owner, network: grant.network, genesisHash: grant.genesisHash,
      mint, sourceTokenAccount: grant.sourceAccount, delegate, budgetUnits: Number(grant.budgetUnits),
      sourceHash, irHash: grant.irHash, intentHash: await digest(grant.intent),
      expiresAt: grant.expiresAt, revision: grant.revision, policyId: grant.policyId,
    };
    const bytes = JSON.stringify(commitment), commitmentHash = await digest(bytes);
    const valid = {...grant, sourceHash, commitmentHash, commitmentBytesBase64: Buffer.from(bytes).toString('base64'), memo: `allowit-grant-v1:${commitmentHash}`};
    await expect(verifyDelegateGrant(config, valid, owner)).resolves.toBeUndefined();
    const nullParentBytes = JSON.stringify({...commitment, parentGrantId: null});
    const nullParentHash = await digest(nullParentBytes);
    await expect(verifyDelegateGrant(config, {...valid, commitmentHash: nullParentHash, commitmentBytesBase64: Buffer.from(nullParentBytes).toString('base64'), memo: `allowit-grant-v1:${nullParentHash}`}, owner)).rejects.toThrow(/parent/);
    await expect(verifyDelegateGrant(config, {...valid, source: `${valid.source}\nchanged`}, owner)).rejects.toThrow(/source/);
    const alteredBytes = JSON.stringify({...commitment, budgetUnits: '9999999'});
    const alteredHash = await digest(alteredBytes);
    await expect(verifyDelegateGrant(config, {...valid, commitmentHash: alteredHash, commitmentBytesBase64: Buffer.from(alteredBytes).toString('base64'), memo: `allowit-grant-v1:${alteredHash}`}, owner)).rejects.toThrow(/budget/);
  });
});
