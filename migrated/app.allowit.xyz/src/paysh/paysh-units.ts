import {isStellarReceipt, parseStellarReceipt, stellarReceiptHeight, type StellarOperationReceipt} from '@allowit/engine/stellar/receipt';
export type {StellarOperationReceipt} from '@allowit/engine/stellar/receipt';
/**
 * Exact integer units and native receipts, without the Solana SDK. The ordinary workspace loads this module at startup;
 * the setup adapter, which needs `@solana/web3.js`, is loaded only when a contract-wallet setup opens.
 */

export class ContractError extends Error {}
const fail = (field: string, what = 'is missing or invalid') => new ContractError(`The PaySH backend response field ${field} ${what}.`);
const DECIMAL = /^(0|[1-9]\d*)$/;
const U64_MAX = 0xffffffffffffffffn;

/** u64 from a JSON number (safe integers only) or a decimal string. Returned as a decimal string. */
export const u64 = (value: unknown, field: string): string => {
  const s = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === 'string' && DECIMAL.test(value) ? value : null;
  if (s === null || BigInt(s) > U64_MAX) throw fail(field, 'is not an unsigned 64-bit integer');
  return s;
};

/** Base units as an exact decimal in an asset with `places` decimals. */
export function scaled(value: bigint | string, places: number): string {
  const n = BigInt(value), base = 10n ** BigInt(places);
  const fraction = (n % base).toString().padStart(places, '0').replace(/0+$/, '');
  return (n / base).toString() + (fraction ? '.' + fraction : '');
}
/** Lamports as Testnet SOL, exact. */
export const sol = (lamports: bigint | string) => scaled(lamports, 9);
/** Six-decimal test-token base units, exact. */
export const token6 = (units: bigint | string) => scaled(units, 6);

export type ReceiptAction = {type: 'swap'; amountInLamports: string; minOutUsdc: string} | {type: 'pay'; amountUsdc: string};
export interface SolanaOperationReceipt {signature: string; requestHash: string; challengeHash: string; invocationIndex: number; finalizedSlot: string; action: ReceiptAction}

export type OperationReceipt = SolanaOperationReceipt | StellarOperationReceipt;

const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(field);
  return value as Record<string, unknown>;
};
const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || !value || value.length > max) throw fail(field);
  return value;
};
function receiptAction(value: unknown, field: string): ReceiptAction {
  const a = record(value, field);
  if (a.type === 'swap') return {type: 'swap', amountInLamports: u64(a.amountInLamports, `${field}.amountInLamports`), minOutUsdc: u64(a.minOutUsdc, `${field}.minOutUsdc`)};
  if (a.type === 'pay') return {type: 'pay', amountUsdc: u64(a.amountUsdc, `${field}.amountUsdc`)};
  throw fail(`${field}.type`);
}
export function parseReceipt(value: unknown, field: string): OperationReceipt {
  const q = record(value, field);
  if(isStellarReceipt(q))return parseStellarReceipt(q,field,u64,fail);
  const index = q.invocationIndex;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 0xffffffff) throw fail(`${field}.invocationIndex`);
  return {signature: text(q.signature, `${field}.signature`, 100), requestHash: text(q.requestHash, `${field}.requestHash`, 128), challengeHash: text(q.challengeHash, `${field}.challengeHash`, 128), invocationIndex: index, finalizedSlot: u64(q.finalizedSlot, `${field}.finalizedSlot`), action: receiptAction(q.action, `${field}.action`)};
}
/** A receipt counts as finalized only with a positive finalized slot. */
export const receiptFinalized = (r: {chain?:'stellar';finalizedSlot?:string;finalizedLedger?:string}) => {
  const native=stellarReceiptHeight(r);
  return BigInt(native ? native.value??'0' : r.finalizedSlot??'0') > 0n;
};
