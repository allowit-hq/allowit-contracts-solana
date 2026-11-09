import type {Wallet, WalletAccount} from '@wallet-standard/base';
import type {OwnerSigner} from './owner-requests';
import {connectAccount, signChallenge, transactionWallet} from '../wallet/wallet';

/**
 * Route adapters for the shared owner inbox. Each one only signs the exact message as an owner the route has already
 * verified through `auth/verify`; the inbox checks the server session before and after every signature.
 */

/** Main workspace: the wallet session from `useApp`. Local dev has no wallet owner and gets no signer. */
export function sessionSigner(owner: string, currentOwner: () => string): OwnerSigner {
  return {
    owner,
    current: () => currentOwner() === owner,
    sign: async message => {
      const wallet = transactionWallet(owner);
      const account = await connectAccount(wallet, owner);
      if (account.address !== owner || currentOwner() !== owner) throw new Error('Select the signed-in owner in your wallet, then answer again.');
      return signChallenge(wallet, account, message);
    },
  };
}

/** Native Testnet and PaySH: the wallet link that route sets only after its own `auth/verify` succeeded. */
export function linkSigner(link: {wallet: Wallet; account: WalletAccount}, currentLink: () => {wallet: Wallet; account: WalletAccount} | null): OwnerSigner {
  const owner = link.account.address;
  const current = () => {
    const now = currentLink();
    return !!now && now.wallet === link.wallet && now.account.address === owner;
  };
  return {
    owner,
    current,
    sign: async message => {
      if (!current() || !link.account.features.includes('solana:signMessage')) throw new Error('Connect the owner wallet with message signing, then answer again.');
      return signChallenge(link.wallet, link.account, message);
    },
  };
}
