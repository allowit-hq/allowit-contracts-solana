/** Element tags by kind. Every tag has the `allowit-solana-` prefix. */
export declare const ELEMENTS: Readonly<{
    readonly address: "allowit-solana-address";
    readonly 'explorer-link': "allowit-solana-explorer-link";
    readonly amount: "allowit-solana-amount";
    readonly 'wallet-sign-in': "allowit-solana-wallet-sign-in";
    readonly 'owner-sign': "allowit-solana-owner-sign";
    readonly 'owner-answer': "allowit-solana-owner-answer";
    readonly receipt: "allowit-solana-receipt";
    readonly 'binding-review': "allowit-solana-binding-review";
}>;
/** Registers every element once. A host without custom elements (a server or a test) gets no change. */
export declare function defineElements(): void;
