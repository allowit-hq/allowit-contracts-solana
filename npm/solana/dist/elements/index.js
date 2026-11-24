import { addressElement, amountElement, explorerLinkElement, receiptElement } from './display.js';
import { bindingReviewElement, ownerAnswerElement, ownerSignElement, walletSignInElement } from './signing.js';
/** Element tags by kind. Every tag has the `allowit-solana-` prefix. */
export const ELEMENTS = Object.freeze({
    address: 'allowit-solana-address',
    'explorer-link': 'allowit-solana-explorer-link',
    amount: 'allowit-solana-amount',
    'wallet-sign-in': 'allowit-solana-wallet-sign-in',
    'owner-sign': 'allowit-solana-owner-sign',
    'owner-answer': 'allowit-solana-owner-answer',
    receipt: 'allowit-solana-receipt',
    'binding-review': 'allowit-solana-binding-review',
});
const FACTORIES = {
    address: addressElement,
    'explorer-link': explorerLinkElement,
    amount: amountElement,
    'wallet-sign-in': walletSignInElement,
    'owner-sign': ownerSignElement,
    'owner-answer': ownerAnswerElement,
    receipt: receiptElement,
    'binding-review': bindingReviewElement,
};
/** Registers every element once. A host without custom elements (a server or a test) gets no change. */
export function defineElements() {
    if (typeof customElements === 'undefined')
        return;
    for (const [kind, tag] of Object.entries(ELEMENTS)) {
        if (!customElements.get(tag))
            customElements.define(tag, FACTORIES[kind]());
    }
}
