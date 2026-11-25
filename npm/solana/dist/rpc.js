/**
 * The reads and the one send that the rail asks a Solana RPC node. Every read is of the finalized bank: an owner
 * workflow settles a step only from what can no longer change. A reply of another shape is an error, never a value.
 */
import { base58, unbase64 } from './bytes.js';
import { address } from './message.js';
import { rpcUrl } from './networks.js';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** One JSON-RPC call. Throws on a transport failure, an error reply or a reply without a result. */
export async function call(network, method, params, send = fetch, timeoutMs = 15_000) {
    const url = rpcUrl(network);
    if (!url)
        throw new Error('Select a supported Solana network.');
    const response = await send(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs),
    });
    const body = response.ok ? await response.json() : null;
    if (!object(body) || body.error !== undefined || !('result' in body)) {
        const reason = object(body) && object(body.error) && typeof body.error.message === 'string' ? `: ${body.error.message}` : '';
        throw Object.assign(new Error(`The Solana RPC node refused ${method}${reason}`), { rpc: object(body) ? body.error : null });
    }
    return body.result;
}
const FINALIZED = { commitment: 'finalized' };
/** The account at `at` in the finalized bank, or null when there is none. */
export async function account(network, at, send) {
    const result = await call(network, 'getAccountInfo', [at, { encoding: 'base64', ...FINALIZED }], send);
    if (!object(result) || !('value' in result))
        throw new Error('The Solana RPC node gave no account answer.');
    if (result.value === null)
        return null;
    const value = result.value;
    const data = object(value) && Array.isArray(value.data) && value.data[1] === 'base64' ? unbase64(value.data[0], 16_384) : null;
    if (!object(value) || !count(value.lamports) || !address(value.owner) || !data)
        throw new Error('The Solana RPC node gave an unreadable account.');
    return { lamports: BigInt(value.lamports), owner: value.owner, data };
}
/** The deposit that keeps an account of `length` bytes, in lamports. */
export async function deposit(network, length, send) {
    const result = await call(network, 'getMinimumBalanceForRentExemption', [length, FINALIZED], send);
    if (!count(result) || result === 0)
        throw new Error('The Solana RPC node gave no deposit.');
    return BigInt(result);
}
/** A blockhash of the finalized bank. */
export async function recentBlockhash(network, send) {
    const result = await call(network, 'getLatestBlockhash', [FINALIZED], send);
    const value = object(result) ? result.value : null;
    if (!object(value) || !address(value.blockhash))
        throw new Error('The Solana RPC node gave no blockhash.');
    return value.blockhash;
}
/** The status of `signature` with the node's whole history, and the slot of the bank that answered. */
export async function status(network, signature, send) {
    const result = await call(network, 'getSignatureStatuses', [[signature], { searchTransactionHistory: true }], send);
    const at = object(result) && object(result.context) ? result.context.slot : null;
    const list = object(result) ? result.value : null;
    if (!count(at) || !Array.isArray(list) || list.length !== 1)
        throw new Error('The Solana RPC node gave no signature status.');
    const [value] = list;
    if (value === null)
        return { at, status: null };
    if (!object(value) || !count(value.slot) || value.slot === 0)
        throw new Error('The Solana RPC node gave an unreadable signature status.');
    return { at, status: { slot: value.slot, finalized: value.confirmationStatus === 'finalized', failed: value.err !== null && value.err !== undefined } };
}
/** Whether `blockhash` can still carry a transaction into a block after the finalized bank, and that bank's slot. */
export async function blockhashValid(network, blockhash, send) {
    const result = await call(network, 'isBlockhashValid', [blockhash, FINALIZED], send);
    const at = object(result) && object(result.context) ? result.context.slot : null;
    if (!object(result) || !count(at) || typeof result.value !== 'boolean')
        throw new Error('The Solana RPC node gave no blockhash answer.');
    return { at, valid: result.value };
}
/** Sends signed transaction bytes as base64 text. The node simulates them on the finalized bank first. */
export async function sendRaw(network, wireBase64, send) {
    const result = await call(network, 'sendTransaction', [wireBase64, { encoding: 'base64', preflightCommitment: 'finalized' }], send, 30_000);
    if (typeof result !== 'string')
        throw new Error('The Solana RPC node gave no signature.');
    return result;
}
export { base58 };
