import {checkedDelegateConfig,verifyDelegateGrant} from './delegate-wallet-intent';
import {displayDelegateAmount,type DelegateConfig,type DelegateGrant} from './delegate-contracts';

export interface RootAccessResponse {grant:DelegateGrant;config:DelegateConfig;capability:string;grantId:string}
/** A root token may be shown only beside the exact already approved root. */
export async function checkedRootAccess(config:DelegateConfig,grant:DelegateGrant,value:RootAccessResponse):Promise<string>{
 if(!value||!value.grant||!value.config||grant.parentGrantId!==null||grant.status!=='active'||grant.expiresAt*1000<=Date.now()
  ||value.grantId!==grant.id||value.grant.id!==grant.id||value.grant.parentGrantId!==null||value.grant.status!=='active'
  ||value.grant.commitmentHash!==grant.commitmentHash||config.ready!==true||value.config.ready!==true
  ||typeof value.capability!=='string'||!value.capability||value.capability.length>4096||/\s/.test(value.capability))throw new Error('The agent prompt does not match this active approved root.');
 const token=value.capability.split('.');
 if(token.length!==4||token[0]!=='dlg1'||token[1]!==grant.owner||token[2]!==grant.id||!/^rh1_[A-Za-z0-9_-]{43}$/.test(token[3]))throw new Error('The agent prompt token belongs to a different root or owner.');
 checkedDelegateConfig(value.config,grant.displayNetwork);
 for(const field of ['network','displayNetwork','genesisHash','mint','delegate','decimals','tokenProgram'] as const){
  if(value.config[field]!==config[field])throw new Error('The agent prompt belongs to another network or allowance.');
 }
 await verifyDelegateGrant(config,grant,grant.owner);
 await verifyDelegateGrant(value.config,value.grant,grant.owner);
 if(value.grant.expiresAt*1000<=Date.now())throw new Error('The approved root has expired.');
 return value.capability;
}

export function rootAgentPrompt(grant:DelegateGrant,token:string,origin:string):string{
 return `# Allowit agent prompt\n\nFollow this approved request:\n${grant.intent}\n\nThis token has root scope for policy ${grant.policyId}, revision ${grant.revision}.\nShared cap: ${displayDelegateAmount(grant.budgetUnits)} USDC (${grant.budgetUnits} integer base units). All agents and requests share this cap.\nExpires: ${new Date(grant.expiresAt*1000).toISOString()}.\nNetwork: ${grant.displayNetwork}; mint: ${grant.mint}.\nGrant: ${grant.id}; commitment: ${grant.commitmentHash}.\n\n## Approved policy constraints\n\n\`\`\`rust\n${grant.source}\n\`\`\`\n\n## Make requests\n\nUse only this Allowit API origin: ${origin}. Do not send the bearer token to a provider or any other origin.\nFirst GET ${origin}/api/delegate/config?network=${encodeURIComponent(grant.displayNetwork)} to discover registered services, their exact IDs, methods and maximum amounts. Use only a service allowed by the approved policy. Obtain required merchant input through public documentation or an unpaid HTTP 402 response. Catalog entries publish their input contract: when input.format is path-query-body, send input with path, query and body fields as documented by that entry; legacy services retain their original input format. Never supply an endpoint URL, recipient, mint, network or payment header. A null maxAmountUnits with amountLimit approved-grant means the approved policy and remaining shared grant cap the charge; it does not mean the request is free.\n\nPOST ${origin}/api/delegate/pay\nAuthorization: Bearer ${token}\nContent-Type: application/json\n\n{"requestId":"<unique-id>","serviceId":"<registered-service-id>","input":{}}\n\nPOST ${origin}/api/delegate/status with the same bearer token and {"requestId":"<same-id>"}. If payment status is unknown, retry the SAME requestId with the EXACT same input; never create a replacement request for an unknown settlement.\n\nEvery payment remains subject to the original approved policy, expiry and shared budget. Do not ask for the owner's private key or wallet signature. A policy check alone is not payment or provider delivery.\n`;
}
