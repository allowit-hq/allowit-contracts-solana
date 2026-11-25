/**
 * The owner's browser wallet, through the Wallet Standard: Phantom, Solflare, Backpack and every other wallet that
 * registers itself with the page. The rail asks a wallet for three things: its account, the signature of a text
 * message and the signature of one transaction. It checks each answer against the bytes that it asked to sign.
 */
import { unbase64 } from './bytes.js';
/** A connected wallet account on one network. */
export interface Connected {
    address: string;
    signMessage(message: string): Promise<string>;
    signTransaction(unsigned: Uint8Array): Promise<Uint8Array>;
}
/** Asks a wallet of the page for access on `network` and returns its account. */
export declare function connect(network: string): Promise<Connected>;
/** The account of the wallet on `network`. */
export declare const connectWallet: (network: string) => Promise<string>;
/** The signature of `address` over the text `message`, as base64 text. */
export declare const signWalletMessage: (message: string, address: string, network: string) => Promise<string>;
/**
 * The owner's signature of one transaction. `message` is the exact message that the owner reviewed. The wallet gets
 * the transaction without a signature and must return that message with a valid signature of `owner`: a wallet that
 * changed the transaction, such as by adding an instruction, is refused, and nothing is sent. Returns the signed
 * transaction as base64 text.
 */
export declare function signWalletTransaction(message: Uint8Array, owner: string, network: string): Promise<string>;
export { unbase64 };
