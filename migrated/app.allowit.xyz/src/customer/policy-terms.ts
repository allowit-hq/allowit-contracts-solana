import type {AgentPolicy} from './storage';
import {isAddress} from '@solana/kit';

export const actionOptions=[
 {value:'transfer',label:'Transfer funds'},
 {value:'research',label:'Purchase research'},
 {value:'buy_asset',label:'Buy approved assets'},
 {value:'swap_tokens',label:'Swap tokens'},
 {value:'get_allocations',label:'Read allocations'},
 {value:'redeem_allocations',label:'Redeem allocations'},
] as const;
export const defaultActions=['transfer','research'];
export const lines=(value:string)=>[...new Set(value.split(/[\n,]/u).map(x=>x.trim()).filter(Boolean))];
export type RestrictionField='actions'|'services'|'recipients';
const scopeName=/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u;
export function restrictionErrors(p:AgentPolicy):Partial<Record<RestrictionField,string>>{
 const errors:Partial<Record<RestrictionField,string>>={};
 const actions=[...new Set(p.actions??defaultActions)],services=lines(p.services),recipients=lines(p.recipients??'');
 if(!actions.length)errors.actions='Choose at least one permitted action.';
 else if(actions.length>12)errors.actions='Choose at most 12 permitted actions.';
 else if(actions.some(action=>!scopeName.test(action)))errors.actions='A saved action is invalid. Choose permitted actions from the list.';
 const invalidService=services.find(service=>!scopeName.test(service));
 if(services.length>12)errors.services='Approved services: enter at most 12 services.';
 else if(invalidService)errors.services=`Approved services: “${invalidService}” is not a valid service identifier. Use a value such as research.example, with each service on a new line.`;
 const invalidRecipient=recipients.find(recipient=>!isAddress(recipient));
 if(recipients.length>12)errors.recipients='Approved recipients: enter at most 12 wallet addresses.';
 else if(invalidRecipient)errors.recipients=`Approved recipients: “${invalidRecipient}” is not a valid Solana wallet address. Paste the full address, with each wallet on a new line.`;
 return errors;
}
export const decimal=(value:number)=>value.toFixed(6).replace(/\.?0+$/u,'')||'0';
export function policyTerms(p:AgentPolicy){return {
 budget:decimal(p.budget),perAction:decimal(p.perAction),reviewAbove:decimal(p.reviewAbove),reserve:decimal(p.reserve),
 network:p.network??'solana:devnet',assets:p.assets,actions:[...new Set(p.actions??defaultActions)],
 services:lines(p.services),recipients:lines(p.recipients??''),expiresAt:p.expiresAt?new Date(p.expiresAt).toISOString():'',
};}
export type PolicyCompilation={source:string;sourceHash:string;workflow:{id:string;label:string;description:string}[]};
export type PolicyBinding={id:string;revision:number;sourceHash:string;version:number};
export class PolicyRequestError extends Error {
 constructor(public readonly status:number,message:string){super(message);this.name="PolicyRequestError";}
}
export async function policyRequest<T>(operation:string,input:unknown,expectedOwner?:string):Promise<T>{
 const response=await fetch('/api/policy-template/'+operation,{method:'POST',headers:{'Content-Type':'application/json',...(expectedOwner?{'X-AllowIt-Expected-Owner':expectedOwner}:{})},credentials:'same-origin',body:JSON.stringify(input),signal:AbortSignal.timeout(20000)});
 const data=await response.json();
 if(!response.ok)throw new PolicyRequestError(response.status,data.error??'The policy could not be checked. Retry shortly.');
 return data as T;
}
export async function bindPolicy(id:string,version:number,p:AgentPolicy,previous?:PolicyBinding,expectedOwner?:string){
 return policyRequest<PolicyBinding>('save',{id,version,previousRevision:previous?.revision??0,name:p.name,instructions:p.instructions,terms:policyTerms(p)},expectedOwner);
}


export type RegisteredTemplate={id:string;revision:number;sourceHash:string;templateVersion:number;title:string;originalIntent:string;terms:ReturnType<typeof policyTerms>;status:'draft'|'active'|'cancelling'|'cancelled';language:string};
export async function readRegisteredTemplate(id:string,expectedOwner:string):Promise<RegisteredTemplate>{
 const response=await fetch('/api/micro/policies',{headers:{'X-AllowIt-Expected-Owner':expectedOwner},credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000)});
 const data=await response.json();
 if(!response.ok)throw new PolicyRequestError(response.status,data.error??'The registered policy could not be read. Retry before continuing.');
 const policy=Array.isArray(data.policies)?data.policies.find((p:RegisteredTemplate)=>p?.id===id):undefined;
 const lists=['assets','actions','services','recipients'];
 const validTerms=policy?.terms&&['budget','perAction','reviewAbove','reserve','network','assets','actions','services','recipients','expiresAt'].every(key=>lists.includes(key)?Array.isArray(policy.terms[key])&&policy.terms[key].every((v:unknown)=>typeof v==='string'):typeof policy.terms[key]==='string');
 if(!policy||policy.language!=='allowit-rust-v1'||!validTerms||typeof policy.title!=='string'||typeof policy.originalIntent!=='string'||typeof policy.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(policy.sourceHash)||!Number.isSafeInteger(policy.revision)||policy.revision<1||!Number.isSafeInteger(policy.templateVersion)||policy.templateVersion<1||!['draft','active','cancelling','cancelled'].includes(policy.status))throw new Error('The registered policy could not be reconciled. Your draft is kept.');
 return policy;
}
export function matchesRegisteredTemplate(server:RegisteredTemplate,value:AgentPolicy,version:number):boolean{
 const terms=policyTerms(value);
 return server.templateVersion===version&&server.title===value.name&&server.originalIntent===value.instructions&&server.sourceHash===value.compiled?.sourceHash&&Object.entries(terms).every(([key,expected])=>JSON.stringify(server.terms[key as keyof typeof terms])===JSON.stringify(expected));
}
