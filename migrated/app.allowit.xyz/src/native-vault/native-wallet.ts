import {Transaction} from '@solana/web3.js';
import type {SolanaSignTransactionFeature} from '@solana/wallet-standard-features';
import {connectAccount, isUserRefusal, transactionWallet} from '../wallet/wallet';

/** Sign only. Exact message/signature verification and durable storage precede backend submission. */
export async function signNativeOwner(owner: string, transaction: Transaction, current: () => boolean): Promise<Transaction> {
  if (!current()) throw new Error('The selected policy or owner changed before signing.');
  const wallet = transactionWallet(owner);
  const feature = wallet.features['solana:signTransaction'] as SolanaSignTransactionFeature['solana:signTransaction'] | undefined;
  if (!feature?.supportedTransactionVersions.includes('legacy')) throw new Error('Use a wallet that can sign a legacy Solana transaction without sending it.');
  const account = await connectAccount(wallet, owner);
  if (!current() || account.address !== owner || !account.chains.includes('solana:devnet') || !account.features.includes('solana:signTransaction')) throw new Error('Select the signed-in owner and Solana Devnet. In Phantom, enable Settings → Developer Settings → Testnet Mode. Nothing was submitted.');
  let output;
  try {[output] = await feature.signTransaction({account, chain: 'solana:devnet', transaction: Uint8Array.from(transaction.serialize({requireAllSignatures: false, verifySignatures: false}))});}
  catch (error) {throw new Error(isUserRefusal(error) ? 'You declined the Devnet transaction. Nothing was submitted; the same preparation is kept. Check Phantom Testnet Mode and retry when ready.' : 'The wallet could not sign this Devnet transaction. Check the selected owner and Phantom Settings → Developer Settings → Testnet Mode. No transaction was submitted by this page.', {cause: error});}
  if (!(output?.signedTransaction instanceof Uint8Array)) throw new Error('The wallet returned no signed transaction. Nothing was submitted.');
  // Do not discard signed bytes after an account/page change: the lifecycle must journal them before any send check.
  return Transaction.from(output.signedTransaction);
}
