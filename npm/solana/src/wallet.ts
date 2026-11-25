/**
 * The owner's browser wallet, through the Wallet Standard: Phantom, Solflare, Backpack and every other wallet that
 * registers itself with the page. The rail asks a wallet for three things: its account, the signature of a text
 * message and the signature of one transaction. It checks each answer against the bytes that it asked to sign.
 */
import {base58, base64, equal, unbase64, utf8} from './bytes.js';
import {readWire, verify} from './message.js';
import {cluster} from './networks.js';

interface StandardAccount {address: string; publicKey: Uint8Array; chains: readonly string[]; features: readonly string[]}
interface StandardWallet {name: string; chains: readonly string[]; accounts: readonly StandardAccount[]; features: Record<string, Record<string, unknown>>}
const NEEDS = ['standard:connect', 'solana:signMessage', 'solana:signTransaction'] as const;

/** Every wallet that has registered with this page. Wallets that load later announce themselves the same way. */
function registered(): StandardWallet[] {
  const found: StandardWallet[] = [];
  if (typeof window === 'undefined') return found;
  const api = Object.freeze({register: (...wallets: StandardWallet[]) => {found.push(...wallets); return () => {};}});
  const listen = (event: Event) => {
    const offer = (event as CustomEvent<unknown>).detail;
    if (typeof offer === 'function') offer(api);
  };
  window.addEventListener('wallet-standard:register-wallet', listen);
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {detail: api}));
  } finally {
    window.removeEventListener('wallet-standard:register-wallet', listen);
  }
  return found;
}

const unavailable = (message: string) => Object.assign(new Error(message), {code: 'wallet_unavailable'});

/** A connected wallet account on one network. */
export interface Connected {address: string; signMessage(message: string): Promise<string>; signTransaction(unsigned: Uint8Array): Promise<Uint8Array>}

/** Asks a wallet of the page for access on `network` and returns its account. */
export async function connect(network: string): Promise<Connected> {
  const name = cluster(network);
  if (!name) throw new Error('Select a supported Solana network.');
  const chain = `solana:${name}`;
  const wallet = registered().find(w => w.chains.includes(chain) && NEEDS.every(feature => typeof w.features[feature] === 'object'));
  if (!wallet) throw unavailable(`No Solana wallet in this browser offers ${chain}. Install or unlock a wallet such as Phantom, and select ${name}.`);
  const feature = <T>(key: string, method: string) => wallet.features[key][method] as T;
  const granted = await feature<() => Promise<{accounts: readonly StandardAccount[]}>>('standard:connect', 'connect')();
  const account = granted.accounts.find(a => a.chains.includes(chain)) ?? null;
  if (!account || base58(Uint8Array.from(account.publicKey)) !== account.address) throw unavailable(`The wallet gave no account on ${chain}.`);
  const connected: Connected = {
    address: account.address,
    async signMessage(message: string): Promise<string> {
      const bytes = utf8(message);
      const [out] = await feature<(input: unknown) => Promise<{signedMessage: Uint8Array; signature: Uint8Array}[]>>('solana:signMessage', 'signMessage')({account, message: bytes});
      const signature = Uint8Array.from(out?.signature ?? []);
      // A wallet that signed other bytes than the message, or with another key, signed nothing of use.
      if (!out || !equal(Uint8Array.from(out.signedMessage), bytes) || !verify(account.address, bytes, signature))
        throw Object.assign(new Error('The wallet did not sign this message with this account.'), {code: 'wallet_signing_failed'});
      return base64(signature);
    },
    async signTransaction(unsigned: Uint8Array): Promise<Uint8Array> {
      const [out] = await feature<(input: unknown) => Promise<{signedTransaction: Uint8Array}[]>>('solana:signTransaction', 'signTransaction')({account, transaction: unsigned, chain});
      if (!out) throw Object.assign(new Error('The wallet returned no transaction.'), {code: 'wallet_signing_failed'});
      return Uint8Array.from(out.signedTransaction);
    },
  };
  return connected;
}

/**
 * The wallet's account on `network`, which must be `address`. The wallet is asked each time: it answers without a
 * prompt once the owner has granted access, and an account that the owner changed since is noticed.
 */
async function accountOf(address: string, network: string): Promise<Connected> {
  const wallet = await connect(network);
  if (wallet.address !== address) throw Object.assign(new Error('The wallet account changed. Select the owner account in the wallet.'), {code: 'wallet_wrong_account'});
  return wallet;
}

/** The account of the wallet on `network`. */
export const connectWallet = async (network: string): Promise<string> => (await connect(network)).address;
/** The signature of `address` over the text `message`, as base64 text. */
export const signWalletMessage = async (message: string, address: string, network: string): Promise<string> => (await accountOf(address, network)).signMessage(message);

/**
 * The owner's signature of one transaction. `message` is the exact message that the owner reviewed. The wallet gets
 * the transaction without a signature and must return that message with a valid signature of `owner`: a wallet that
 * changed the transaction, such as by adding an instruction, is refused, and nothing is sent. Returns the signed
 * transaction as base64 text.
 */
export async function signWalletTransaction(message: Uint8Array, owner: string, network: string): Promise<string> {
  const wallet = await accountOf(owner, network);
  const {wire} = await import('./message.js');
  const signed = readWire(await wallet.signTransaction(wire([new Uint8Array(64)], message)));
  if (!signed || signed.signatures.length !== 1 || !equal(signed.message, message))
    throw Object.assign(new Error('The wallet returned another transaction than the reviewed one. Nothing was sent. Some wallets add their own instructions; turn that off or use another wallet.'), {code: 'wallet_signed_other_transaction'});
  if (!verify(owner, message, signed.signatures[0]))
    throw Object.assign(new Error('The wallet signed with another account than the owner. Nothing was sent.'), {code: 'wallet_wrong_account'});
  return base64(wire(signed.signatures, message));
}

export {unbase64};
