import {chainExplorerUrl} from '../wallet/chain-explorer';
import type {DeploymentHandoff} from './deployment-handoff';
import type {Binding, NativeConfig, Operation} from './native-contracts';
import {nativeBinding} from './native-wallet-intent';

/**
 * Display only: the vault PDA and the deployment's policy and custody program IDs for the review rows. A binding error
 * hides those rows, never the review, and nothing here takes part in signing or recovery checks.
 */
export function deploymentDisplayBinding(handoff: DeploymentHandoff | null, config: NativeConfig | null): Binding | null {
  if (!handoff || !config) return null;
  try {return nativeBinding(config, handoff.policy, handoff.owner);} catch {return null;}
}

/** The link comes from the operation's own signature on the handoff's network, never from a backend-supplied URL. */
export function deploymentTransactionUrl(handoff: DeploymentHandoff | null, operation: Pick<Operation, 'signature'> | null): string | null {
  return handoff && operation?.signature ? chainExplorerUrl('tx', operation.signature, handoff.network) : null;
}
