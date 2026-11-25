/**
 * The signature of each signed step that this browser has seen, by the step's hash. A step is named by the hash of
 * its message, which exists before anyone signs; the network names a transaction by its first signature. The rail
 * remembers the signature when it reads signed bytes, so a later question about the hash alone can be answered. The
 * memory is a convenience: without it the rail gives no answer, and the workflow keeps the step saved.
 */
import { base58, unbase58 } from './bytes.js';
const PREFIX = 'allowit-solana:signature:';
const seen = new Map();
const storage = () => {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    }
    catch {
        return null;
    }
};
/** Remember the signature of the step with `hash`. */
export function remember(hash, signature) {
    if (!/^[0-9a-f]{64}$/.test(hash) || signature.length !== 64 || signature.every(byte => byte === 0))
        return;
    const text = base58(signature);
    seen.set(hash, text);
    try {
        storage()?.setItem(PREFIX + hash, text);
    }
    catch { /* The memory of this page is enough for this run. */ }
}
/** The signature of the step with `hash`, as base58 text, or null when this browser never saw its signed bytes. */
export function signatureOf(hash) {
    if (!/^[0-9a-f]{64}$/.test(hash))
        return null;
    let text = seen.get(hash) ?? null;
    try {
        text ??= storage()?.getItem(PREFIX + hash) ?? null;
    }
    catch { /* No stored value. */ }
    return text !== null && unbase58(text, 64) ? text : null;
}
