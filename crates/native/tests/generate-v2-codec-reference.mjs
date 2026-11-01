// Fixture authoring only. This uses the official Solana web3.js codec and is
// never imported or launched by the Rust library.
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = createRequire(new URL('../../../native/index.mjs', import.meta.url))('@solana/web3.js');

const key = n => new PublicKey(new Uint8Array(32).fill(n));
const owner = Keypair.fromSeed(new Uint8Array(32).fill(1));
const executor = Keypair.fromSeed(new Uint8Array(32).fill(2));
const authority = Keypair.fromSeed(new Uint8Array(32).fill(3));
const mint = key(4), vault = key(5), vaultToken = key(6), policy = key(7);
const policyData = key(8), custody = key(9), blockhash = key(10), recipient = key(11);
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const ownerToken = PublicKey.findProgramAddressSync(
  [owner.publicKey.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ataProgram,
)[0];
const u64 = value => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
};
const ix = (data, keys) => new TransactionInstruction({programId: custody, keys, data});
const meta = (pubkey, isWritable = false, isSigner = false) => ({pubkey, isWritable, isSigner});
const budgets = limit => [
  ComputeBudgetProgram.setComputeUnitLimit({units: limit}),
  ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1n}),
];
const ata = (address, tokenOwner) => new TransactionInstruction({
  programId: ataProgram,
  keys: [
    meta(owner.publicKey, true, true), meta(address, true), meta(tokenOwner), meta(mint),
    meta(SystemProgram.programId), meta(tokenProgram),
  ],
  data: Buffer.from([1]),
});

const initialize = Buffer.concat([
  Buffer.from([0]), Buffer.alloc(32, 0xaa),
  Buffer.from('793db01595fbcb15503914744e49b45f470e9ca1d2805aceadeac00a0d843fc7', 'hex'),
  Buffer.from('cb55e2015dbc437cce58a53727c947cd1d8db75453623c5e53a4e4ea15b40dde', 'hex'),
  u64(5_000_000), u64(1_000_000),
]);
const setupInstructions = [
  ...budgets(400_000), ata(vaultToken, vault),
  ix(initialize, [
    meta(vault, true), meta(owner.publicKey, true, true), meta(mint), meta(vaultToken),
    meta(policy), meta(executor.publicKey), meta(SystemProgram.programId), meta(policyData),
    meta(authority.publicKey),
  ]),
  ix(Buffer.concat([Buffer.from([1]), u64(100_000)]), [
    meta(vault, true), meta(owner.publicKey, false, true), meta(ownerToken, true),
    meta(vaultToken, true), meta(mint), meta(tokenProgram),
  ]),
  ix(Buffer.concat([Buffer.from([2, 1]), u64(0)]), [
    meta(vault, true), meta(owner.publicKey, false, true), meta(policy), meta(policyData),
  ]),
];
const setup = new Transaction({feePayer: owner.publicKey, recentBlockhash: blockhash.toBase58()})
  .add(...setupInstructions);
setup.sign(owner);

const transfer = Buffer.concat([
  Buffer.from([4]), u64(500_000), u64(4), u64(7), u64(100), Buffer.alloc(32, 0xbb), u64(19),
]);
const execute = new Transaction({feePayer: executor.publicKey, recentBlockhash: blockhash.toBase58()})
  .add(
    ...budgets(300_000),
    ix(transfer, [
      meta(vault, true), meta(executor.publicKey, false, true), meta(vaultToken, true),
      meta(recipient, true), meta(mint), meta(tokenProgram), meta(policy), meta(policyData),
      meta(authority.publicKey, false, true),
    ]),
  );
execute.partialSign(authority);
const executePartial = execute.serialize({requireAllSignatures: false, verifySignatures: true});
execute.partialSign(executor);
const executeSigned = execute.serialize({requireAllSignatures: true, verifySignatures: true});

await writeFile(new URL('./v2-codec-reference.json', import.meta.url), JSON.stringify({
  source: '@solana/web3.js 1.98.4',
  setup: {
    payer: owner.publicKey.toBase58(),
    message: setup.serializeMessage().toString('base64'),
    signed: setup.serialize().toString('base64'),
    bytes: setup.serialize().length,
  },
  execute: {
    payer: executor.publicKey.toBase58(),
    authority: authority.publicKey.toBase58(),
    message: execute.serializeMessage().toString('base64'),
    partial: executePartial.toString('base64'),
    signed: executeSigned.toString('base64'),
    bytes: executeSigned.length,
  },
}, null, 2) + '\n');
