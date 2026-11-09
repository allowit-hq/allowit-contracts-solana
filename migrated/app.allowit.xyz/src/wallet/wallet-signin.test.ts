import {afterEach, describe, expect, it, vi} from 'vitest';
import {SIGN_IN_RESPONSE_MS, walletSignInResponse} from './wallet-signin';

afterEach(() => vi.useRealTimers());
describe('wallet authentication waiting', () => {
  it('unblocks a hung provider and never consumes its late response', async () => {
    vi.useFakeTimers();
    let respond!: (value: string) => void;
    const next = vi.fn();
    const result = walletSignInResponse(() => new Promise<string>(resolve => { respond = resolve; }), 'Phantom', 'connection', new AbortController().signal).then(next);
    const rejected = expect(result).rejects.toThrow('Phantom did not respond to the connection request');
    await vi.advanceTimersByTimeAsync(SIGN_IN_RESPONSE_MS);
    await rejected;
    respond('late account');
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never opens a wallet for an already invalid attempt', async () => {
    const attempt = new AbortController();
    attempt.abort(new Error('Account changed'));
    const start = vi.fn(async () => 'signature');
    await expect(walletSignInResponse(start, 'Phantom', 'signature', attempt.signal)).rejects.toThrow('Account changed');
    expect(start).not.toHaveBeenCalled();
  });
});
