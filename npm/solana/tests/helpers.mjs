// What the tests of this package share: the crate's vectors and a fake RPC node.
import {readFileSync} from 'node:fs';

export const v = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
export const roles = {owner: v.owner, mint: v.mint, agent: v.agent, server: v.server};
export const USDC = {symbol: 'USDC', issuer: v.mint};
export const found = value => value === 'ready' ? 'ready' : 'nothing' in value ? {nothing: BigInt(value.nothing)} : {funded: BigInt(value.funded)};

/** A fake RPC node: `answers` maps a method to its result, or to a function of the params. */
export function node(answers, asked = []) {
  return async (url, init) => {
    const {method, params} = JSON.parse(init.body);
    asked.push({url, method, params});
    const answer = answers[method];
    if (answer === undefined) return {ok: true, json: async () => ({error: {message: `no ${method}`}})};
    const result = typeof answer === 'function' ? answer(params) : answer;
    return {ok: true, json: async () => (result instanceof Error ? {error: {message: result.message}} : {result})};
  };
}

/**
 * A refill step as an attacker that prepares owner steps could make it: one `ApproveChecked` of 7 USDC and a memo,
 * with `account` as the token account, `delegate` as the delegate and `memo` as the memo. The defaults are the crate's
 * own refill step.
 */
export async function forgedRefill({account = v.tokenAccount, delegate = v.delegate, memo} = {}) {
  const {base64, concat, u64, unbase64, utf8} = await import('../dist/bytes.js');
  const {compile, instructionsOf, messageBytes, readMessage} = await import('../dist/message.js');
  const {MEMO_PROGRAM, TOKEN_PROGRAM} = await import('../dist/native-wallet.js');
  const real = instructionsOf(readMessage(unbase64(v.refill.message)));
  const meta = (address, writable = false, signer = false) => ({address, signer, writable});
  return base64(messageBytes(compile([
    {program: TOKEN_PROGRAM, accounts: [meta(account, true), meta(v.mint), meta(delegate), meta(v.owner, false, true)], data: concat([13], u64(7_000_000n), [6])},
    {program: MEMO_PROGRAM, accounts: [], data: memo === undefined ? real[1].data : utf8(memo)},
  ], v.owner, v.blockhash)));
}
