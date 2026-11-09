import {Buffer} from 'buffer';
import type {MicroPolicy} from '../micro/micro-contracts';
import {DELEGATED_PROFILE, hasDelegatedAuthority, runtimeOf} from '../runtime/runtime';
import {delegateUnits, type DelegateConfig, type DelegateGrant} from './delegate-contracts';

export const delegatePolicyKey = (p:MicroPolicy|null) => p ? JSON.stringify([p.id,p.revision,p.code,p.sourceHash,p.irHash,p.originalIntent,p.network,p.mint,p.runtime,p.delegatedExecution]) : '';
export const delegateTerminal = (g:DelegateGrant) => g.status === 'revoked';
/** Walk saved ancestry, including nested children; malformed cycles never create a match. */
export function delegateBelongsTo(grants:readonly DelegateGrant[],grantId:string,rootId:string){
  const seen=new Set<string>();let id:string|null=grantId;
  while(id&&!seen.has(id)){if(id===rootId)return true;seen.add(id);id=grants.find(g=>g.id===id)?.parentGrantId??null;}
  return false;
}
export const delegateStatus = (g:DelegateGrant|null, checking=false) => checking ? 'Checking allowance' : !g ? 'Draft' : ({draft:'Draft',prepared:'Review approval',activation_pending:'Approval pending',active:g.expiresAt*1000<=Date.now()?'Expired · allowance retained':'Ready',revocation_pending:'Revoke pending',revoked:'Revoked',failed:'Check allowance'}[g.status]);
export const delegateAperture = (view:DelegatePolicyView):'open'|'closed'|'draft' => view.ready?'open':view.grant&&(['active','revoked','revocation_pending','failed'].includes(view.grant.status))?'closed':'draft';

/** Each old grant supplies its own chain facts. A current deployment never rewrites an older grant's network. */
export function delegateGrantConfig(grant:DelegateGrant, current:DelegateConfig|null):DelegateConfig {
  if (grant.config) return grant.config;
  if (current && current.network===grant.network && current.genesisHash===grant.genesisHash && current.mint===grant.mint && current.displayNetwork===grant.displayNetwork) return {...current,delegate:grant.delegate};
  return {ready:false,recoveryAvailable:true,network:grant.network,displayNetwork:grant.displayNetwork,genesisHash:grant.genesisHash,mint:grant.mint,delegate:grant.delegate,decimals:6,tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'};
}

export interface DelegatePolicyView {marked:boolean;bound:boolean;grant:DelegateGrant|null;error:string|null;editable:boolean;ready:boolean;status:string}
/** Exact source/intent identity; no title, latest prompt, balance or active MicroPolicy status can stand in for it. */
export function delegatePolicyView(policy:MicroPolicy, owner:string, grants:readonly DelegateGrant[], loaded:boolean, paymentReady:boolean):DelegatePolicyView {
  const marked=hasDelegatedAuthority(policy), roots=grants.filter(g=>g.parentGrantId===null&&g.owner===owner&&g.policyId===policy.id);
  const r=runtimeOf(policy), raw=policy.delegatedExecution;
  const grant=raw&&typeof raw==='object'?roots.find(g=>g.id===raw.grantId)??null:roots.find(g=>g.revision===policy.revision)??null;
  let error:string|null=null;
  if(marked && (r.state!=='typed'||r.runtime.fundingMode!=='spl-delegate'||r.runtime.wallet.profile!==DELEGATED_PROFILE)) error='The delegated wallet profile is unreadable. Existing grants remain available for revocation.';
  if(raw!==undefined){
    try{
      if(!raw||typeof raw!=='object'||raw.version!==1||!grant)throw new Error();
      const expected={grantId:grant.id,owner,policyId:policy.id,revision:policy.revision,sourceHash:policy.sourceHash,irHash:policy.irHash,displayNetwork:policy.network,network:grant.network,genesisHash:grant.genesisHash,mint:grant.mint,sourceAccount:grant.sourceAccount,delegate:grant.delegate,budgetUnits:grant.budgetUnits,expiresAt:grant.expiresAt,commitmentHash:grant.commitmentHash};
      for(const [k,v] of Object.entries(expected))if((raw as unknown as Record<string,unknown>)[k]!==v)throw new Error();
      const commitment=JSON.parse(Buffer.from(grant.commitmentBytesBase64,'base64').toString('utf8')) as {intentHash?:unknown};
      if(typeof raw.intentHash!=='string'||raw.intentHash!==commitment.intentHash||grant.source!==policy.code||grant.sourceHash!==policy.sourceHash||grant.irHash!==policy.irHash||grant.revision!==policy.revision||typeof policy.originalIntent!=='string'||grant.intent!==policy.originalIntent||grant.displayNetwork!==policy.network||grant.mint!==policy.mint)throw new Error();
      delegateUnits(raw.budgetUnits);
    }catch{error=loaded?'The saved allowance is bound to a different or unreadable policy snapshot. Review its retained grant before changing anything.':'Checking the saved allowance binding…';}
  }else if(grant)error='The grant is retained. Refresh the policy to verify its durable binding before approving.';
  const bound=raw!==undefined||roots.length>0;
  const ready=marked&&!error&&!!raw&&!!grant&&loaded&&paymentReady&&grant.status==='active'&&grant.expiresAt*1000>Date.now();
  const status=error?'Check allowance':!loaded?'Checking allowance':grant?.status==='active'&&grant.expiresAt*1000>Date.now()&&!paymentReady?'Payments unavailable':delegateStatus(grant);
  return {marked,bound,grant,error,editable:marked&&loaded&&!bound&&!error,ready,status};
}
