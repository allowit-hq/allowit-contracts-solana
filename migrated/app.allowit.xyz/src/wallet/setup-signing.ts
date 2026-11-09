import type {SolanaSignTransactionFeature} from '@solana/wallet-standard-features';
import type {CheckedSetup} from '../paysh/paysh-wallet-intent';
import {connectAccount, transactionWallet} from './wallet';
import {isPayshNetwork} from '../paysh/paysh-contracts';

const TESTNET = 'solana:testnet';

/**
 * Sign-only owner signature for a checked contract-wallet setup. It never calls `signAndSendTransaction`: the wallet
 * returns signed bytes, the caller verifies and journals them, and the server broadcasts. A wallet error here means
 * nothing was sent.
 */
export async function signSetupTransaction(owner: string, checked: CheckedSetup): Promise<Uint8Array> {
  const network = checked.network ?? TESTNET;
  if (!isPayshNetwork(network)) throw new Error('This setup network is not enabled. Nothing was sent.');
  const wallet = transactionWallet(owner);
  const feature = wallet.features['solana:signTransaction'] as SolanaSignTransactionFeature['solana:signTransaction'] | undefined;
  if (!feature) throw new Error('This wallet cannot sign a transaction without sending it. Use a wallet with transaction signing, such as Phantom or Solflare.');
  if (!feature.supportedTransactionVersions.includes(checked.version)) throw new Error(`This wallet cannot sign ${checked.version === 0 ? 'version 0' : 'legacy'} Solana transactions.`);
  const account = await connectAccount(wallet, owner);
  if (account.address !== owner || !account.chains.includes(network) || !account.features.includes('solana:signTransaction')) throw new Error(`Select the signed-in account and enable ${network === TESTNET ? 'Solana Testnet' : 'Local Solana'} in your wallet, then retry.`);
  const [output] = await feature.signTransaction({account, chain: network, transaction: Uint8Array.from(checked.wire)});
  if (!(output?.signedTransaction instanceof Uint8Array)) throw new Error('The wallet returned no signed transaction. Nothing was sent.');
  return output.signedTransaction;
}
