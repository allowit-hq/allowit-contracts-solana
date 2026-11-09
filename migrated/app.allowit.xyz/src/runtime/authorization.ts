import type {TypedView} from '../policy/typed-metadata';
import {budgetDisplay} from '../policy/TypedBudgets';
import {scaled} from '../paysh/paysh-units';
import {certificateAmount} from '../wallet/amount-format';

/**
 * The certificate figure of a budget authorization policy, from the checked typed budget view only. One budget with
 * checked asset details for its exact asset ID and scale shows its total in that symbol. Several assets show a count,
 * never a sum. Anything less certain shows a count or a plain state; no symbol, unit or amount is inferred.
 */
export interface AuthorizationFigure {figure: string; token: string}

export function authorizationFigure(typed: TypedView | undefined, budgetField: unknown): AuthorizationFigure {
  if (typed?.state === 'pending') return {figure: 'Checking budget', token: ''};
  const view = budgetDisplay(typed, budgetField);
  if (view.state === 'unavailable') return {figure: 'Budget details unavailable', token: ''};
  if (view.state === 'absent' || !view.budgets.length) return {figure: 'No budget yet', token: ''};
  const assets = new Set(view.budgets.map(b => b.assetId));
  if (assets.size > 1) return {figure: `${assets.size} asset budgets`, token: ''};
  if (view.budgets.length === 1 && view.assets.state === 'checked') {
    const [b] = view.budgets;
    const asset = view.assets.byId.get(b.assetId);
    if (asset && asset.decimals === b.decimals) return {figure: `${certificateAmount(scaled(b.totalBudgetUnits, b.decimals))} ${asset.symbol}`, token: asset.symbol};
  }
  return {figure: view.budgets.length === 1 ? '1 budget' : `${view.budgets.length} budgets`, token: ''};
}

/** The one-sentence admitted-kind fact, from the stated list only. */
export function admittedSentence(kinds: readonly string[] | undefined): string | null {
  if (!kinds) return null;
  const words = kinds.map(k => (k === 'execution-request' ? 'native requests' : 'HTTP requests'));
  return words.length ? `This policy admits ${words.join(' and ')}.` : 'No request kind is admitted.';
}
