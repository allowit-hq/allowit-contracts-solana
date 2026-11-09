import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {sha256} from '@noble/hashes/sha256';

export const MAX_ALLOWED_SERVICES = 8;
/** Exact IDs: never trim, case-fold or normalize a service identity. */
export function serviceIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ALLOWED_SERVICES || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(id)) || new Set(value).size !== value.length) {
    throw new Error('Choose between one and eight unique registered services.');
  }
  return [...value] as string[];
}
export const sameServiceIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
const hash = (domain: string, ...parts: Uint8Array[]) => Buffer.from(sha256(Buffer.concat([Buffer.from(`${domain}\0`, 'utf8'), ...parts])));
/** Matches the program's v2 leaf and sorted-pair Merkle commitment. */
export function serviceAllowlistRoot(ids: readonly string[], config: {network: string; usdcMint: string; vendorUsdc: string}): string {
  if (!ids.length) return '00'.repeat(32);
  const exact = serviceIds(ids);
  const accounts = [config.network, config.usdcMint, config.vendorUsdc].map(k => new PublicKey(k).toBuffer());
  let level: Buffer[] = exact.map(id => hash('allowit-paysh-leaf-v2', ...accounts, hash('allowit-paysh-service-v2', Buffer.from(id, 'utf8')))).sort(Buffer.compare);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const pair = [level[i], level[i + 1] ?? level[i]].sort(Buffer.compare);
      next.push(hash('allowit-paysh-node-v2', ...pair));
    }
    level = next;
  }
  return level[0].toString('hex');
}
