import {expect, it} from 'vitest';
import {checkWithdraw} from './native-withdraw';

it('a partial withdrawal stays within the vault balance', () => {
  expect(checkWithdraw('2.5', '9000000')).toEqual({ok: true, amount: '2.5', all: false});
  expect(checkWithdraw(' 9 ', '9000000')).toEqual({ok: true, amount: '9', all: true});
  expect(checkWithdraw('9.000001', '9000000')).toEqual({ok: false, error: 'The vault holds 9 USDC. Enter at most that amount.'});
  expect(checkWithdraw('0', '9000000').ok).toBe(false);
  expect(checkWithdraw('', '9000000').ok).toBe(false);
  expect(checkWithdraw('1.1234567', '9000000').ok).toBe(false);
  expect(checkWithdraw('-1', '9000000').ok).toBe(false);
  expect(checkWithdraw('1', null).ok).toBe(false);
});
