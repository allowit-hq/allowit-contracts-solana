import {canonicalUnsigned, decimal, units} from './native-contracts';

export type WithdrawCheck = {ok: true; amount: string; all: boolean} | {ok: false; error: string};

/** Checks an owner's partial withdrawal against the vault's current base-unit balance. */
export function checkWithdraw(input: string, balance: string | null | undefined): WithdrawCheck {
  if (!canonicalUnsigned(balance)) return {ok: false, error: 'The vault balance could not be read. Check vault status and try again.'};
  const value = input.trim();
  if (!value) return {ok: false, error: 'Enter an amount to withdraw.'};
  let requested: bigint;
  try {requested = units(value);} catch {return {ok: false, error: 'Use a USDC amount with at most six decimal places.'};}
  if (requested <= 0n) return {ok: false, error: 'Enter an amount above 0.'};
  const available = BigInt(balance);
  if (requested > available) return {ok: false, error: `The vault holds ${decimal(available)} USDC. Enter at most that amount.`};
  return {ok: true, amount: decimal(requested), all: requested === available};
}

/** The total remaining USDC across vault balances, skipping any that could not be read. */
export function totalRemaining(balances: readonly (string | null | undefined)[]): string {
  return decimal(balances.reduce((sum, balance) => canonicalUnsigned(balance) ? sum + BigInt(balance) : sum, 0n));
}
