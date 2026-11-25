/** Remember the signature of the step with `hash`. */
export declare function remember(hash: string, signature: Uint8Array): void;
/** The signature of the step with `hash`, as base58 text, or null when this browser never saw its signed bytes. */
export declare function signatureOf(hash: string): string | null;
