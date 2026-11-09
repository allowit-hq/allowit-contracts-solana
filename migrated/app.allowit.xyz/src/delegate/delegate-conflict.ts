import {ApiError} from '../api';
import type {DelegateGrant} from './delegate-contracts';

/** Public owner-session facts about the allowance actually installed on a source account. */
export interface DelegateAllowanceConflict {
 owner:string;network:string;genesisHash:string;mint:string;sourceAccount:string;currentDelegate:string;
 blockingGrantId?:string;blockingPolicyId?:string;blockingPolicyTitle?:string;offchainStopped?:boolean;
}
export interface DelegateConflictNotice {policyId:string;message:string;details:DelegateAllowanceConflict|null}
const legacyConflicts=new Set([
 "Revoke the source account's existing delegate before creating a replacement grant.",
 'The source account has another delegate.',
 'The source delegate changed. Refusing to revoke another grant.',
]);
export function isDelegateAllowanceConflict(error:unknown):error is ApiError {
 return error instanceof ApiError&&(['DELEGATE_ALLOWANCE_CONFLICT','DELEGATE_ALLOWANCE_RECOVERY_PENDING'].includes(error.code)||legacyConflicts.has(error.message));
}
export function readDelegateAllowanceConflict(error:unknown,owner:string):DelegateAllowanceConflict|null {
 if(!isDelegateAllowanceConflict(error)||!error.details||typeof error.details!=='object')return null;
 const value=error.details as Record<string,unknown>;
 const required=['owner','network','genesisHash','mint','sourceAccount','currentDelegate'] as const;
 if(required.some(key=>typeof value[key]!=='string'||!value[key]||value[key].length>128)||value.owner!==owner)return null;
 const result:DelegateAllowanceConflict={owner,network:value.network as string,genesisHash:value.genesisHash as string,mint:value.mint as string,sourceAccount:value.sourceAccount as string,currentDelegate:value.currentDelegate as string};
 for(const key of ['blockingGrantId','blockingPolicyId','blockingPolicyTitle'] as const){
  if(value[key]!==undefined){if(typeof value[key]!=='string'||!value[key]||value[key].length>(key==='blockingPolicyTitle'?512:128))return null;result[key]=value[key];}
 }
 if(value.offchainStopped!==undefined){if(typeof value.offchainStopped!=='boolean')return null;result.offchainStopped=value.offchainStopped;}
 return result;
}
/** A title or policy ID alone cannot authorize navigation to a different grant. */
export function blockingDelegateGrant(conflict:DelegateAllowanceConflict|null,grants:readonly DelegateGrant[]):DelegateGrant|null {
 if(!conflict?.blockingGrantId||!conflict.blockingPolicyId)return null;
 const matches=grants.filter(grant=>grant.parentGrantId===null&&grant.id===conflict.blockingGrantId&&grant.policyId===conflict.blockingPolicyId&&grant.owner===conflict.owner&&grant.network===conflict.network&&grant.genesisHash===conflict.genesisHash&&grant.mint===conflict.mint&&grant.sourceAccount===conflict.sourceAccount&&grant.delegate===conflict.currentDelegate);
 return matches.length===1?matches[0]:null;
}
