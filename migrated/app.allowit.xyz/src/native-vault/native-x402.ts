import {PublicKey} from '@solana/web3.js';
import type {MicroPolicy} from '../micro/micro-contracts';
import {sourceWhitelist} from '../paysh/source-whitelist';
import {decimal, MAX_LIMIT_UNITS, units, type BoundNativeX402Service, type NativeConfig, type NativeX402Service} from './native-contracts';
import {recipientTokenAccount} from './native-recipient';

const SERVICE_KEYS = ['id', 'name', 'resourceUrl', 'recipient', 'action', 'maxAmount', 'network', 'scheme'] as const;
const BOUND_KEYS = [...SERVICE_KEYS, 'tokenAccount'] as const;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const printable = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

/** Strictly parses a trusted descriptor. Unknown fields are rejected so they cannot acquire unreviewed meaning. */
export function parseNativeX402Service(value: unknown): NativeX402Service | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value as Record<string, unknown>, SERVICE_KEYS)) return null;
  const service = value as Record<(typeof SERVICE_KEYS)[number], unknown>;
  if (typeof service.id !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,63}$/.test(service.id)
    || !printable(service.name, 120) || !printable(service.action, 100)
    || service.network !== 'solana:devnet' || service.scheme !== 'allowit-native'
    || typeof service.resourceUrl !== 'string' || service.resourceUrl.length > 2048 || typeof service.recipient !== 'string'
    || typeof service.maxAmount !== 'string') return null;
  try {
    const resource = new URL(service.resourceUrl);
    const recipient = new PublicKey(service.recipient);
    const amount = units(service.maxAmount);
    if (resource.protocol !== 'https:' || resource.username || resource.password || resource.search || resource.hash || service.resourceUrl.includes('?') || service.resourceUrl.includes('#') || resource.href !== service.resourceUrl
      || recipient.toBase58() !== service.recipient || !PublicKey.isOnCurve(recipient.toBytes()) || amount <= 0n || amount > MAX_LIMIT_UNITS
      || decimal(amount) !== service.maxAmount) return null;
  } catch {return null;}
  return Object.fromEntries(SERVICE_KEYS.map(key => [key, service[key]])) as unknown as NativeX402Service;
}

export function parseNativeX402Services(value: unknown): NativeX402Service[] | null {
  if (!Array.isArray(value) || value.length > 1) return null;
  const parsed = value.map(parseNativeX402Service);
  if (parsed.some(service => !service) || new Set(parsed.map(service => service!.id)).size !== parsed.length) return null;
  return parsed as NativeX402Service[];
}

export function parseBoundNativeX402Service(value: unknown, mint: string): BoundNativeX402Service | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, BOUND_KEYS)) return null;
  const parsed = parseNativeX402Service(Object.fromEntries(SERVICE_KEYS.map(key => [key, raw[key]])));
  if (!parsed) return null;
  try {
    if (raw.tokenAccount !== recipientTokenAccount(parsed.recipient, mint)) return null;
  } catch {return null;}
  return {...parsed, tokenAccount: raw.tokenAccount as string};
}

export function sameNativeX402Service(value: unknown, expected: NativeX402Service, mint: string): value is BoundNativeX402Service {
  const parsed = parseBoundNativeX402Service(value, mint);
  return !!parsed && SERVICE_KEYS.every(key => parsed[key] === expected[key]);
}

/** A native x402 selection exists only when the compiled source exactly names one advertised ID/recipient pair. */
export function selectedNativeX402Service(source: Pick<MicroPolicy, 'code'>, config: Pick<NativeConfig, 'x402Services'> | null): NativeX402Service | null {
  if (!config) return null;
  const saved = sourceWhitelist(source.code);
  if (saved.length !== 1) return null;
  return config.x402Services.find(service => service.id === saved[0].id && service.recipient === saved[0].recipient) ?? null;
}
