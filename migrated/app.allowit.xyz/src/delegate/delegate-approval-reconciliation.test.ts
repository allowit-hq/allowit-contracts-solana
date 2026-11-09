import {afterEach,describe,expect,it,vi} from 'vitest';
import {reconcileSavedApproval,type ApprovalOutcome,type ApprovalRetryBudget} from './delegate-approval-reconciliation';
import type {SavedDelegateProof} from './delegate-proof';

const proof={preparation:{preparationId:'original-preparation'},proof:{grantId:'grant',preparationId:'original-preparation',operation:'approve',signature:'original-signature',signedTransactionBase64:'exact-signed-bytes'}} as SavedDelegateProof;
afterEach(()=>vi.useRealTimers());

describe('automatic exact approval reconciliation',()=>{
 it('replays a definitive result across readiness changes without resubmitting',async()=>{
  const budget:ApprovalRetryBudget={attempts:0},states:ApprovalOutcome[]=[],submit=vi.fn(async()=>{return {status:'failed' as const,message:'Original proof changed'};});
  const input={proof,budget,isCurrent:()=>true,submit,onState:(state:ApprovalOutcome)=>states.push(state)};
  await reconcileSavedApproval(input);states.length=0;await reconcileSavedApproval(input);
  expect(submit).toHaveBeenCalledTimes(1);expect(states).toEqual([{status:'failed',message:'Original proof changed'}]);
 });
 it('ignores an in-flight response and stops retrying after the owner or policy changes',async()=>{
  let current=true,finish!:(value:ApprovalOutcome)=>void;const states:ApprovalOutcome[]=[];
  const work=reconcileSavedApproval({proof,isCurrent:()=>current,submit:()=>new Promise(resolve=>{finish=resolve;}),onState:state=>states.push(state)});
  current=false;finish({status:'active',message:'Old owner response'});await work;
  expect(states.some(state=>state.status==='active')).toBe(false);
 });
});
