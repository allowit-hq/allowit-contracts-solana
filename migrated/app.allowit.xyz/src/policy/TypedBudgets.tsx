import type {AssetDetails, BudgetView, TypedBudgetRequirement, TypedView} from './typed-metadata';
import {NETWORKS} from '../wallet/networks';
import {scaled} from '../paysh/paysh-units';
import {readableDecimal} from '../wallet/amount-format';

/**
 * Compiler budget facts from the checked typed view of the current source. Each budget stays in its own asset: no sum,
 * conversion or ratio across assets. Amounts are scaled only with checked host metadata for the exact asset ID and
 * scale; otherwise they stay exact base units beside the exact asset ID. Facts are neutral text, never red or green.
 */

const short = (text: string) => (text.length > 12 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text);
const networkName = (id: string) => NETWORKS.find(n => n.id === id)?.label ?? id;

/** What the definition shows: nothing, an unavailable note, or checked budgets. Pending and absent show nothing. */
export function budgetDisplay(typed: TypedView | undefined, budgetField: unknown): BudgetView {
  if (!typed || typed.state === 'absent' || typed.state === 'pending') return {state: 'absent'};
  if (typed.state === 'invalid') return budgetField === undefined || budgetField === null ? {state: 'absent'} : {state: 'unavailable', reason: typed.reason};
  return typed.budget;
}

function Budget({budget, asset}: {budget: TypedBudgetRequirement; asset?: AssetDetails}) {
  const amount = (units: string) => (asset ? `${readableDecimal(scaled(units, asset.decimals))} ${asset.symbol}` : `${readableDecimal(units)} base units`);
  return (
    <dl className="facts policy-budget" aria-label={`Budget ${budget.budgetId}`}>
      <div><dt>Budget</dt><dd>{budget.budgetId} · {budget.operation}</dd></div>
      <div>
        <dt>Asset</dt>
        {asset ? (
          <dd title={budget.assetId}>
            {asset.symbol}, {asset.kind}, {networkName(asset.network)}
            {asset.mint ? <> · <span title={asset.mint}>{short(asset.mint)}</span></> : null}
          </dd>
        ) : (
          <dd>
            <span className="policy-budget-unavailable">Asset details unavailable</span>
            <span className="policy-budget-id">{budget.assetId}</span>
          </dd>
        )}
      </div>
      {asset ? null : <div><dt>Scale</dt><dd>{budget.decimals} decimals</dd></div>}
      <div><dt>Total budget</dt><dd>{amount(budget.totalBudgetUnits)}</dd></div>
      <div><dt>Per run debit</dt><dd>at most {amount(budget.maxDebitUnits)}</dd></div>
      <div><dt>Per run fees</dt><dd>at most {amount(budget.maxFeeUnits)}</dd></div>
    </dl>
  );
}

export default function TypedBudgets({view}: {view: BudgetView}) {
  if (view.state === 'absent') return null;
  if (view.state === 'unavailable') return <p className="small policy-budgets-unavailable" role="note">Budget details unavailable</p>;
  const assets = view.assets.state === 'checked' ? view.assets.byId : null;
  return (
    <section className="policy-budgets" aria-label="Budgets">
      {view.budgets.map(b => {
        const asset = assets?.get(b.assetId);
        return <Budget key={`${b.operation}\u0000${b.budgetId}`} budget={b} asset={asset && asset.decimals === b.decimals ? asset : undefined} />;
      })}
      <p className="small muted">Per run limits cover one complete admitted run, all its transfers and fees together. Total budget is the persistent limit across runs.</p>
    </section>
  );
}
