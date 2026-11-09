import {DISPLAY_LIMITS, type AssetDetails, type BudgetView, type SolanaNetwork, type TypedBudgetRequirement, type TypedRequirement, type TypedSignature} from './typed-metadata';

/**
 * Checks for compiler budget requirements and host asset metadata. Budget facts are shown only when every requirement
 * passes; asset labels only when the whole metadata list passes. Amounts stay canonical u64 decimal strings: a JSON
 * number is rejected, never converted. Nothing is inferred from the asset ID, the network or a funding token.
 */

const U64 = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = 18446744073709551615n;
const OPERATION = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;
const safeText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && new TextEncoder().encode(v).length <= max && !UNSAFE_TEXT.test(v);
const NATIVE_ID = /^native:solana:([0-9a-f]{64})$/;
const TOKEN_ID = /^token:solana:([0-9a-f]{64}):([0-9a-f]{64}):contract$/;
const NETWORKS: ReadonlySet<string> = new Set<SolanaNetwork>(['solana:mainnet', 'solana:testnet', 'solana:devnet']);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BUDGET_KEYS = ['operation', 'budgetId', 'assetId', 'decimals', 'totalBudgetUnits', 'maxDebitUnits', 'maxFeeUnits'];
const ASSET_KEYS = ['assetId', 'decimals', 'symbol', 'network', 'kind', 'mint'];

class Reject extends Error {}
const fail = (reason: string): never => {
  throw new Reject(reason);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const absent = (v: unknown) => v === undefined || v === null;
const keysOnly = (o: Record<string, unknown>, allowed: readonly string[], required: readonly string[], what: string) => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${what} has unexpected field ${k}`);
  for (const k of required) if (!Object.hasOwn(o, k)) fail(`${what} has no ${k}`);
};
const list = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) fail(`${what} is not a list`);
  if ((v as unknown[]).length > DISPLAY_LIMITS.budgets) fail(`${what} exceeds ${DISPLAY_LIMITS.budgets} entries`);
  return v as unknown[];
};
const units = (v: unknown, what: string): string =>
  typeof v === 'string' && U64.test(v) && BigInt(v) <= U64_MAX ? v : fail(`${what} is not a canonical u64 decimal string`);
const decimals = (v: unknown, what: string): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 18 ? v : fail(`${what} is not an integer from 0 to 18`));
/** Genesis hash, and the mint for a token, of a canonical asset ID. */
export function assetIdParts(id: unknown): {kind: 'native' | 'token'; genesis: string; mint?: string} | null {
  if (typeof id !== 'string') return null;
  const native = NATIVE_ID.exec(id);
  if (native) return {kind: 'native', genesis: native[1]};
  const token = TOKEN_ID.exec(id);
  return token ? {kind: 'token', genesis: token[1], mint: token[2]} : null;
}

/** Base58 to lowercase hex, or null for any character outside the alphabet. Leading `1`s are zero bytes. */
export function base58Hex(text: string): string | null {
  let n = 0n;
  for (const ch of text) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  const zeros = text.length - text.replace(/^1+/, '').length;
  const body = n === 0n ? '' : n.toString(16);
  return '00'.repeat(zeros) + (body.length % 2 ? '0' : '') + body;
}

function parseBudgets(value: unknown, requirements: readonly TypedRequirement[], signatures: ReadonlyMap<string, TypedSignature>): TypedBudgetRequirement[] {
  const called = new Set(requirements.map(r => r.operation));
  const guards = new Set([...called].filter(op => signatures.get(op)?.effect === 'budget_guard'));
  const seen = new Set<string>();
  const byBudget = new Map<string, TypedBudgetRequirement>();
  const byAsset = new Set<string>();
  const raw = list(value, 'budget requirements');
  if(raw.length > 16) fail('budget requirements exceed the SDK limit');
  const budgets = raw.map((r): TypedBudgetRequirement => {
    if (!isObject(r)) return fail('budget requirement is not an object');
    keysOnly(r, BUDGET_KEYS, BUDGET_KEYS, 'budget requirement');
    const {operation, budgetId, assetId} = r;
    if (typeof operation !== 'string' || operation.length > DISPLAY_LIMITS.operationLength || !OPERATION.test(operation)) return fail('budget operation is not a path');
    if (!called.has(operation)) fail('budget operation is not a typed call in this policy');
    const effect = signatures.get(operation)?.effect;
    if (effect !== undefined && effect !== 'budget_guard') fail('budget operation is not a budget guard');
    if (!safeText(budgetId, 128)) return fail('budget ID is not bounded safe text');
    if (!assetIdParts(assetId)) fail('budget asset ID is not canonical');
    const budget = {
      operation,
      budgetId,
      assetId: assetId as string,
      decimals: decimals(r.decimals, 'budget decimals'),
      totalBudgetUnits: units(r.totalBudgetUnits, 'total budget'),
      maxDebitUnits: units(r.maxDebitUnits, 'per run debit'),
      maxFeeUnits: units(r.maxFeeUnits, 'per run fees'),
    };
    const key = JSON.stringify([operation, budgetId]);
    if (seen.has(key)) fail('budget requirements repeat an operation and budget ID');
    seen.add(key);
    if(BigInt(budget.totalBudgetUnits) === 0n || BigInt(budget.maxDebitUnits) + BigInt(budget.maxFeeUnits) === 0n || BigInt(budget.maxDebitUnits) + BigInt(budget.maxFeeUnits) > BigInt(budget.totalBudgetUnits)) fail('budget ceilings differ from the compiler bounds');
    if(byAsset.has(budget.assetId)) fail('budget requirements repeat an exact asset');
    byAsset.add(budget.assetId);
    // The SDK requires distinct budget IDs and exact assets.
    const earlier = byBudget.get(budgetId);
    if (earlier) fail('one budget ID has different totals or assets');
    byBudget.set(budgetId, budget);
    return budget;
  });
  for (const op of guards) if (!budgets.some(b => b.operation === op)) fail('a typed budget call has no budget requirement');
  return budgets;
}

function parseAssets(value: unknown, network: unknown, budgets: readonly TypedBudgetRequirement[]): ReadonlyMap<string, AssetDetails> {
  if (typeof network !== 'string' || !NETWORKS.has(network)) fail('policy network has no Solana asset metadata');
  const assets = list(value, 'asset metadata').map((a): AssetDetails => {
    if (!isObject(a)) return fail('asset metadata entry is not an object');
    keysOnly(a, ASSET_KEYS, ASSET_KEYS.slice(0, 5), 'asset metadata entry');
    const parts = assetIdParts(a.assetId);
    if (!parts) return fail('asset metadata ID is not canonical');
    if (a.kind !== parts.kind) fail('asset kind differs from its asset ID');
    if (a.network !== network) fail('asset network differs from the policy network');
    if (!safeText(a.symbol, 64)) fail('asset symbol is not recognized');
    const places = decimals(a.decimals, 'asset decimals');
    if (parts.kind === 'native') {
      if (places !== 9) fail('native asset decimals are not 9');
      if (Object.hasOwn(a, 'mint')) fail('native asset has a mint');
    } else {
      if (places !== 6) fail('token asset decimals are not 6');
      if (typeof a.mint !== 'string' || a.mint.length > 44 || base58Hex(a.mint) !== parts.mint) fail('token mint differs from its asset ID');
    }
    return {assetId: a.assetId as string, decimals: places, symbol: a.symbol as string, network: network as SolanaNetwork, kind: parts.kind, ...(parts.kind === 'token' ? {mint: a.mint as string} : {})};
  });
  for (let i = 1; i < assets.length; i++) {
    const [a, b] = [assets[i - 1], assets[i]];
    if (a.assetId > b.assetId || (a.assetId === b.assetId && a.decimals >= b.decimals)) fail('asset metadata is not sorted or repeats an asset');
  }
  // One network has one genesis hash.
  if (new Set(assets.map(a => assetIdParts(a.assetId)!.genesis)).size > 1) fail('asset metadata spans more than one genesis hash');
  const byId = new Map(assets.map(a => [a.assetId, a] as const));
  for (const b of budgets) {
    const asset = byId.get(b.assetId);
    if (asset && asset.decimals !== b.decimals) fail('asset decimals differ from the budget decimals');
  }
  return byId;
}

/**
 * Budget facts for checked typed workflow metadata. A failure here never changes the workflow typing: the budget shows
 * as unavailable, and invalid asset metadata only removes asset labels.
 */
export function parseBudgetView(input: {typedBudgetRequirements?: unknown; assetMetadata?: unknown; network?: unknown}, requirements: readonly TypedRequirement[], signatures: ReadonlyMap<string, TypedSignature>): BudgetView {
  let budgets: TypedBudgetRequirement[];
  try {
    if (absent(input.typedBudgetRequirements)) {
      const guarded = requirements.some(r => signatures.get(r.operation)?.effect === 'budget_guard');
      return guarded ? {state: 'unavailable', reason: 'typed budget calls have no budget requirements'} : {state: 'absent'};
    }
    budgets = parseBudgets(input.typedBudgetRequirements, requirements, signatures);
  } catch (error) {
    if (error instanceof Reject) return {state: 'unavailable', reason: error.message};
    throw error;
  }
  if (absent(input.assetMetadata)) return {state: 'checked', budgets, assets: {state: 'unavailable', reason: 'asset metadata was not provided'}};
  try {
    return {state: 'checked', budgets, assets: {state: 'checked', byId: parseAssets(input.assetMetadata, input.network, budgets)}};
  } catch (error) {
    if (error instanceof Reject) return {state: 'checked', budgets, assets: {state: 'unavailable', reason: error.message}};
    throw error;
  }
}
