import {ApiError} from '../api';
import type {SavedDelegateProof} from './delegate-proof';

export interface ApprovalOutcome {status:'checking'|'pending'|'active'|'failed'|'unavailable'|'deferred';message:string}
/** Kept per exact signed proof, outside effects, so refreshes and StrictMode cannot renew the retry budget. */
export interface ApprovalRetryBudget {attempts:number;nextAttemptAt?:number;lastUnavailable?:boolean;lastError?:string;final?:ApprovalOutcome}
interface Input {
 proof:SavedDelegateProof;
 isCurrent:()=>boolean;
 submit:(proof:SavedDelegateProof)=>Promise<ApprovalOutcome>;
 onState:(state:ApprovalOutcome)=>void;
 budget?:ApprovalRetryBudget;
}
const delays=[2_000,4_000,8_000];
const wait=(milliseconds:number)=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds));

/** Reconcile only the original signed packet. Preparation, signing and replacement are deliberately absent. */
export async function reconcileSavedApproval(input:Input):Promise<void>{
 const budget=input.budget??{attempts:0},started=Date.now();let announced=false;
 if(budget.final){if(input.isCurrent())input.onState(budget.final);return;}
 while(input.isCurrent()&&budget.attempts<4){
  if(budget.final){input.onState(budget.final);return;}
  if(Date.now()-started>=60_000){
   input.onState({status:'unavailable',message:'Automatic approval checking paused. The original signed proof is retained; wallet status continues to refresh automatically.'});return;
  }
  const remaining=(budget.nextAttemptAt??0)-Date.now();
  if(remaining>0){await wait(Math.min(remaining,250));continue;}
  if(!announced){input.onState({status:'checking',message:'Checking the saved approval automatically. No new wallet signature is needed.'});announced=true;}
  let outcome:ApprovalOutcome,unavailable=false;
  try{outcome=await input.submit(input.proof);}catch(error){outcome={status:'pending',message:error instanceof ApiError&&error.status>0?`${error.message} The original signed proof is retained.`:error instanceof ApiError&&error.status===0?'The approval service could not be reached. The original signed proof is retained.':'The saved approval could not be checked. The original signed proof is retained.'};unavailable=true;}
  if(outcome.status==='deferred'){await wait(250);continue;}
  budget.lastUnavailable=unavailable;budget.lastError=unavailable?outcome.message:undefined;
  budget.attempts++;
  if(outcome.status!=='pending'){
   if(outcome.status==='failed'||outcome.status==='active')budget.final=outcome;
   if(input.isCurrent())input.onState(outcome);return;
  }
  budget.nextAttemptAt=Date.now()+(delays[budget.attempts-1]??0);
  if(!input.isCurrent())return;
  input.onState(outcome);announced=false;
 }
 if(budget.final){if(input.isCurrent())input.onState(budget.final);return;}
 if(input.isCurrent())input.onState({status:budget.lastUnavailable?'unavailable':'pending',message:budget.lastUnavailable
  ?`${budget.lastError??'The approval service is unavailable. The original signed proof is retained.'} Wallet status continues to refresh automatically.`
  :'Approval is still unconfirmed. The original signed proof is retained; wallet status continues to refresh automatically.'});
}
