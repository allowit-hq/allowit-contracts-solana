import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import type {MicroPolicy, WorkflowNode} from '../micro/micro-contracts';
import {units, type NativeConfig, type NativeX402Service} from './native-contracts';
import {sourceWhitelist} from '../paysh/source-whitelist';

export interface RecipientBinding {kind: 'wallet-ata'; wallet: string; tokenAccount: string; mint: string; network: 'solana:devnet'}
type Source = Pick<MicroPolicy, 'code' | 'workflow'>;
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/** Classic SPL ATA, not Token-2022. A recipient wallet is an ordinary on-curve public key. */
export function recipientTokenAccount(wallet: string, mint: string): string {
  const owner = new PublicKey(wallet), token = new PublicKey(mint);
  if (!PublicKey.isOnCurve(owner.toBytes()) || owner.toBase58() !== wallet || token.toBase58() !== mint) throw new Error('Use an ordinary recipient wallet address.');
  return PublicKey.findProgramAddressSync([Buffer.from(owner.toBytes()), TOKEN.toBuffer(), token.toBuffer()], ATA)[0].toBase58();
}
function steps(source: Source, name: string): WorkflowNode[] {
  const nodes = source.workflow.filter(n => n.kind === 'function' && n.name === name);
  if (nodes.some(n => !Number.isSafeInteger(n.start) || !Number.isSafeInteger(n.end) || n.start < 0 || n.end <= n.start || source.code.slice(n.start, n.end) !== n.source)) throw new Error('The selected policy source projection changed. Reload the saved revision.');
  return nodes;
}
/** UI cross-check of the compiler projection; the server independently verifies unconditional IR guards. */
export function sourceRecipient(source: Source, service?: Pick<NativeX402Service, 'id' | 'recipient'> | null): string;
export function sourceRecipient(source: Source, service: Pick<NativeX402Service, 'id' | 'recipient'> | null | undefined, optional: true): string | undefined;
export function sourceRecipient(source: Source, service?: Pick<NativeX402Service, 'id' | 'recipient'> | null, optional = false): string | undefined {
  const nodes = steps(source, 'require_recipient');
  if (service) {
    const saved = sourceWhitelist(source.code);
    if (saved.length !== 1 || saved[0].id !== service.id || saved[0].recipient !== service.recipient) throw new Error('The saved x402 service recipient differs from the selected service. Remove the service or revise the policy before setup.');
    // The compiler projects this server-authored conditional as one custom node.
    // Verify its whole guard, source offsets and saved pair before deriving an ATA.
    const inner = `if !allowit::is_one_of(&ctx.merchant, &[${JSON.stringify(service.id)}])? {\n        return allowit::fail("Service is not on the owner's whitelist");\n    }\n    if allowit::is_one_of(&ctx.merchant, &[${JSON.stringify(service.id)}])? {\n        allowit::require_recipient(&ctx.recipient, ${JSON.stringify(saved[0].recipient)})?;\n    }`;
    const marker = '// AllowIt service whitelist: start';
    const from = source.code.indexOf(marker) + marker.length, to = source.code.indexOf('// AllowIt service whitelist: end');
    const start = source.code.indexOf(inner, from), end = start + inner.length;
    const custom = source.workflow.filter(n => n.kind === 'custom' && n.source === inner);
    if (source.code.slice(from, to).trim() !== inner || custom.length !== 1 || custom[0].start !== start || custom[0].end !== end || source.code.slice(start, end) !== custom[0].source) throw new Error('The saved x402 service source projection changed. Reload the saved revision before setup.');
    if (nodes.length || /\brequire_recipient\s*\(/.test(source.code.slice(0, start) + source.code.slice(end))) throw new Error('The policy has another recipient rule outside the x402 service. Remove the service or revise the policy before setup.');
    return saved[0].recipient;
  }
  if (!nodes.length && optional) return undefined;
  if (nodes.length !== 1 || nodes[0].arguments.length !== 1) throw new Error('Save a policy with one exact recipient wallet before setup.');
  return nodes[0].arguments[0];
}
export function sourceLimit(source: Source, name: 'cap_per_transaction' | 'set_cap_per_day'): bigint | null {
  const nodes = steps(source, name);
  if (!nodes.length) return null;
  const values = nodes.map(n => {
    if (n.arguments.length !== 2 || n.arguments[1] !== 'USDC') throw new Error('The selected policy has an unsupported token limit.');
    const value = units(n.arguments[0]);
    if (value <= 0n) throw new Error('The selected policy has an invalid spending limit.');
    return value;
  });
  return values.reduce((a, b) => a < b ? a : b);
}
export function checkedRecipient(value: unknown, config: Pick<NativeConfig, 'network' | 'mint'>, expectedWallet?: string): RecipientBinding {
  const b = value as RecipientBinding | null;
  if (!b || b.kind !== 'wallet-ata' || b.network !== config.network || b.network !== 'solana:devnet' || b.mint !== config.mint
    || typeof b.wallet !== 'string' || typeof b.tokenAccount !== 'string' || (expectedWallet !== undefined && b.wallet !== expectedWallet)
    || b.tokenAccount !== recipientTokenAccount(b.wallet, config.mint)) throw new Error('The recipient wallet, token account or Devnet USDC binding changed.');
  return {kind: 'wallet-ata', wallet: b.wallet, tokenAccount: b.tokenAccount, mint: b.mint, network: b.network};
}
export function sameRecipient(actual: unknown, expected: RecipientBinding | undefined): boolean {
  if (!expected) return actual === undefined || actual === null;
  const b = actual as RecipientBinding | null;
  return !!b && (['kind', 'wallet', 'tokenAccount', 'mint', 'network'] as const).every(k => b[k] === expected[k]);
}

/** The explicit editor may only insert one recipient guard; every prior source byte and funding rule stays intact. */
export function checkedRecipientRevision(before: MicroPolicy, after: MicroPolicy | undefined, wallet: string): MicroPolicy {
  if (!after || after.id !== before.id || after.network !== before.network || after.token !== before.token || after.mint !== before.mint
    || !!after.fundingRequest !== !!before.fundingRequest || after.fundingRequest?.amount !== before.fundingRequest?.amount || after.fundingRequest?.token !== before.fundingRequest?.token || after.status !== 'draft' || after.nativeExecution)
    throw new Error('The recipient edit changed the policy identity, funding or native binding. Refresh before continuing.');
  if (after.code === before.code && after.revision === before.revision && after.sourceHash === before.sourceHash && sourceRecipient(after) === wallet) return after;
  const insertion = '\n    allowit::require_recipient(&ctx.recipient, ' + JSON.stringify(wallet) + ')?;\n';
  const at = after.code.indexOf(insertion);
  if (after.revision !== before.revision + 1 || !/^[0-9a-f]{64}$/.test(after.sourceHash) || after.sourceHash === before.sourceHash
    || at < 0 || after.code.indexOf(insertion, at + insertion.length) !== -1 || after.code.slice(0, at) + after.code.slice(at + insertion.length) !== before.code
    || sourceRecipient(after) !== wallet) throw new Error('The recipient edit did not preserve the original policy source exactly. No vault was set up.');
  return after;
}
