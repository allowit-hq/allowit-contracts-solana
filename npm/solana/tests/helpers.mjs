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
