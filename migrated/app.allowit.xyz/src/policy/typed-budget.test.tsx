import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import PolicyDefinition from './PolicyDefinition';
import TypedBudgets, {budgetDisplay} from './TypedBudgets';
import {currentView, parseTypedMetadata, typedKey, validateTypedMetadata, type BudgetView, type TypedPolicyInput, type TypedView} from './typed-metadata';
import {executionFixture, paymentFixture, type TypedFixturePolicy} from './typed-fixtures';
import type {MicroPolicy} from '../micro/micro-contracts';

/**
 * Budget facts come from the genuine compiler fixtures. The asset metadata below is SYNTHETIC host data for UI tests
 * only: the symbols and network are labels chosen here, and the IDs reuse the fixture's synthetic genesis and mint.
 */
type Policy = TypedFixturePolicy & {network?: string; assetMetadata?: unknown};
type Budget = Record<string, any>;
const GENESIS = '09'.repeat(32);
const MINT_HEX = '16'.repeat(32);
const NATIVE_ID = `native:solana:${GENESIS}`;
const TOKEN_ID = `token:solana:${GENESIS}:${MINT_HEX}:contract`;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(hex: string) {
  let n = BigInt('0x' + hex), out = '';
  while (n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(hex.match(/^(00)*/)![0].length / 2) + out;
}
const MINT = base58(MINT_HEX);
const nativeMeta = () => ({assetId: NATIVE_ID, decimals: 9, symbol: 'SOL', network: 'solana:testnet', kind: 'native'});
const tokenMeta = () => ({assetId: TOKEN_ID, decimals: 6, symbol: 'TST', network: 'solana:testnet', kind: 'token', mint: MINT});
const withMeta = (p: TypedFixturePolicy, meta: unknown = [nativeMeta(), tokenMeta()], network = 'solana:testnet'): Policy => ({...p, network, assetMetadata: meta});
const budgets = (p: Policy) => p.typedBudgetRequirements as Budget[];

const budgetOf = (p: TypedPolicyInput): BudgetView => {
  const v = parseTypedMetadata(p);
  if (v.state !== 'typed') throw new Error(`expected typed, got ${JSON.stringify(v)}`);
  return v.budget;
};
const checked = (p: TypedPolicyInput) => {
  const b = budgetOf(p);
  if (b.state !== 'checked') throw new Error(`expected checked budget, got ${JSON.stringify(b)}`);
  return b;
};
const assetsUnavailable = (p: TypedPolicyInput) => {
  const b = checked(p);
  expect(b.assets.state).toBe('unavailable');
  return b.assets.state === 'unavailable' ? b.assets.reason : '';
};
const textOf = (html: string) => html.replace(/<[^>]+>/g, '|').replace(/&amp;/g, '&').replace(/\|+/g, '|');
const budgetsHtml = (p: TypedPolicyInput) => renderToStaticMarkup(<TypedBudgets view={budgetOf(p)} />);
const definitionHtml = (p: Policy, typed?: TypedView) => renderToStaticMarkup(<PolicyDefinition policy={p as unknown as MicroPolicy} typed={typed} />);

describe('exact amounts', () => {
  it('keep u64 amounts above 2^53 exact with and without asset metadata (locally derived)', () => {
    const p = withMeta(executionFixture());
    Object.assign(budgets(p)[0], {totalBudgetUnits: '18446744073709551615', maxDebitUnits: '9007199254740993', maxFeeUnits: '9007199254740992'});
    expect(checked(p).budgets[0].maxDebitUnits).toBe('9007199254740993');
    const text = textOf(budgetsHtml(p));
    expect(text).toContain('|Total budget|18,446,744,073.709551615 SOL|');
    expect(text).toContain('|Per run debit|at most 9,007,199.254740993 SOL|');
    expect(text).toContain('|Per run fees|at most 9,007,199.254740992 SOL|');
    const bare = textOf(budgetsHtml({...p, assetMetadata: undefined}));
    expect(bare).toContain('|Total budget|18,446,744,073,709,551,615 base units|');
    expect(bare).toContain('|Per run debit|at most 9,007,199,254,740,993 base units|');
  });

  it.each([
    ['a JSON number', 50000000],
    ['a value above u64', '18446744073709551616'],
    ['a leading zero', '050000000'],
    ['a sign', '+50000000'],
    ['a fraction', '0.5'],
    ['an empty string', ''],
  ])('make budget details unavailable for %s (locally derived)', (_, value) => {
    const p = executionFixture() as Policy;
    budgets(p)[0].totalBudgetUnits = value;
    expect(budgetOf(p).state).toBe('unavailable');
  });

  it.each([
    ['decimals above 18', {decimals: 19}],
    ['fractional decimals', {decimals: 9.5}],
    ['string decimals', {decimals: '9'}],
    ['a non-canonical asset ID', {assetId: `native:solana:${'AB'.repeat(32)}`}],
    ['a token ID without contract suffix', {assetId: `token:solana:${GENESIS}:${MINT_HEX}`}],
    ['an operation outside the typed calls', {operation: 'allowit::payment_request_cap'}],
    ['a budget ID with a control', {budgetId: 'native\nbudget'}],
    ['an extra field', {symbol: 'SOL'}],
  ])('make budget details unavailable for %s (locally derived)', (_, patch) => {
    const p = executionFixture() as Policy;
    Object.assign(budgets(p)[0], patch);
    expect(budgetOf(p).state).toBe('unavailable');
  });

  it('rejects a missing field, a repeated budget call and one budget ID with two totals (locally derived)', () => {
    const missing = executionFixture() as Policy;
    delete budgets(missing)[0].maxFeeUnits;
    expect(budgetOf(missing).state).toBe('unavailable');
    const repeated = executionFixture() as Policy;
    budgets(repeated).push({...budgets(repeated)[0]});
    expect(budgetOf(repeated).state).toBe('unavailable');
    const twoTotals = paymentFixture() as Policy;
    Object.assign(budgets(twoTotals)[0], {budgetId: 'native-budget', assetId: NATIVE_ID, decimals: 9, totalBudgetUnits: '1'});
    expect(budgetOf(twoTotals).state).toBe('unavailable');
  });
});

describe('host asset metadata', () => {
  it('fails closed to exact identity and scale on a precision mismatch (locally derived)', () => {
    const p = withMeta(executionFixture());
    budgets(p)[0].decimals = 6;
    expect(assetsUnavailable(p)).toBe('asset decimals differ from the budget decimals');
    const text = textOf(budgetsHtml(p));
    expect(text).toContain(`|Asset details unavailable|${NATIVE_ID}|Scale|6 decimals|Total budget|50,000,000 base units|`);
    expect(text).not.toContain('SOL');
  });

  it.each([
    ['a mint that differs from the asset ID', () => [nativeMeta(), {...tokenMeta(), mint: base58('17'.repeat(32))}]],
    ['a mint that is not base58', () => [nativeMeta(), {...tokenMeta(), mint: MINT.slice(0, -1) + '0'}]],
    ['a missing token mint', () => [nativeMeta(), {...tokenMeta(), mint: undefined}]],
    ['a native asset with a mint', () => [{...nativeMeta(), mint: MINT}, tokenMeta()]],
    ['native decimals other than 9', () => [{...nativeMeta(), decimals: 6}, tokenMeta()]],
    ['token decimals other than 6', () => [nativeMeta(), {...tokenMeta(), decimals: 9}]],
    ['a kind that differs from the asset ID', () => [{...nativeMeta(), kind: 'token'}, tokenMeta()]],
    ['a network that differs from the policy', () => [{...nativeMeta(), network: 'solana:devnet'}, tokenMeta()]],
    ['a non-canonical network', () => [{...nativeMeta(), network: 'testnet'}, tokenMeta()]],
    ['an unrecognized symbol', () => [{...nativeMeta(), symbol: 'S\nO\nL'}, tokenMeta()]],
    ['an unsorted list', () => [tokenMeta(), nativeMeta()]],
    ['a duplicate identity', () => [nativeMeta(), nativeMeta(), tokenMeta()]],
    ['a second genesis hash', () => [nativeMeta(), {...tokenMeta(), assetId: `token:solana:${'0a'.repeat(32)}:${MINT_HEX}:contract`}]],
    ['an extra field', () => [{...nativeMeta(), priceUsd: '1'}, tokenMeta()]],
    ['a non-list', () => ({[NATIVE_ID]: nativeMeta()})],
  ])('removes every asset label for %s (locally derived)', (_, meta) => {
    const raw = meta();
    const list = Array.isArray(raw) ? raw.map(m => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined))) : raw;
    const p = withMeta(paymentFixture(), list);
    assetsUnavailable(p);
    const text = textOf(budgetsHtml(p));
    expect(text.match(/Asset details unavailable/g)).toHaveLength(2);
    expect(text).not.toMatch(/SOL|TST|USDC/);
    expect(text).toContain('|Total budget|5,000 base units|');
  });
});

describe('typed budget calls and the current source', () => {
  it('shows Budget details unavailable when the source no longer hashes to its source hash, and keeps the full code', async () => {
    const p = withMeta(executionFixture());
    p.code = p.code.replace('Burn is not allowed', 'Burn is not permitted');
    const view = await validateTypedMetadata(p);
    expect(view).toEqual({state: 'invalid', reason: 'source hash does not match the policy code'});
    const html = definitionHtml(p, view);
    expect(textOf(html)).toContain('|Budget details unavailable|');
    expect(html).not.toMatch(/Total budget|policy-budget"/);
    expect(html).toContain('Policy code — complete source');
    expect(html).toContain('Burn is not permitted');
  });

  it('never shows a stored result for a changed source, budget, metadata or network', async () => {
    const p = withMeta(paymentFixture());
    const key = typedKey(p);
    const stored = {key, view: await validateTypedMetadata(p)};
    expect(currentView(stored, key, false).state).toBe('typed');
    const changes: ((q: Policy) => void)[] = [
      q => (q.code += ' '),
      q => (budgets(q)[0].maxDebitUnits = '999'),
      q => ((q.assetMetadata as Budget[])[0].symbol = 'ABC'),
      q => (q.network = 'solana:devnet'),
    ];
    for (const change of changes) {
      const q = structuredClone(p);
      change(q);
      expect(currentView(stored, typedKey(q), false)).toEqual({state: 'pending'});
    }
    expect(budgetDisplay({state: 'pending'}, p.typedBudgetRequirements)).toEqual({state: 'absent'});
  });
});
