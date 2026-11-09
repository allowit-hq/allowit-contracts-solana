import type {NativeOwnerContext} from './native-owner-context';
import {settledOperation, supersededOwner, type Operation} from './native-contracts';
import {vaultPhase} from './native-vault';

type Context = Pick<NativeOwnerContext, 'current' | 'api' | 'journal' | 'lifecycle' | 'attachment'>;
interface Options {progress?: (phase: string) => void; checks?: number; pause?: () => Promise<void>}
export interface ReturnProgress {total:number;returned:number;unused:number;currentTitle:string;phase:string}
export const returnSummary=(value:ReturnProgress)=>`Remaining USDC returned from ${value.returned} ${value.returned===1?'vault':'vaults'}.${value.unused?` ${value.unused} unfunded ${value.unused===1?'policy stopped':'policies stopped'}.`:''}`;

/** Stop at the first unconfirmed return; another vault never reuses that liability or owner signature. */
export async function returnNativeBatch<T extends {title:string}>(policies:readonly T[], options:{current:()=>boolean;open:(policy:T)=>Promise<Context>;progress:(value:ReturnProgress)=>void;afterEach:()=>Promise<void>}) {
  const value:ReturnProgress={total:policies.length,returned:0,unused:0,currentTitle:'',phase:'preparing'};
  const assertCurrent=()=>{if(!options.current())throw new Error('The wallet or workspace changed. Review the remaining returns before retrying.');};
  for(const policy of policies){
    assertCurrent();value.currentTitle=policy.title;value.phase='preparing';options.progress({...value});
    try{
      const ctx=await options.open(policy);assertCurrent();
      const outcome=await returnNativeFunds(ctx,{progress:phase=>{if(options.current()){value.phase=phase;options.progress({...value});}}});
      assertCurrent();if(outcome==='returned')value.returned++;else value.unused++;
      options.progress({...value});await options.afterEach();
    }catch(error){throw new Error(`${returnSummary(value)} Stopped at “${policy.title}”: ${error instanceof Error?error.message:'The return could not finish.'} Server spending remains stopped. Remaining returns are incomplete.`);}
  }
  assertCurrent();value.currentTitle='';value.phase='completed';options.progress({...value});
  return value;
}

/** An owner click may recover the exact original close; only finalized closure completes a refund. */
export async function returnNativeFunds(ctx: Context, options: Options = {}): Promise<'returned' | 'unused'> {
  const {policy, executionBinding: {owner}} = ctx.attachment;
  const current = () => {if (!ctx.current()) throw new Error('The wallet or workspace changed. Review the remaining returns before retrying.');};
  const read = async () => {
    current();
    const reply = await ctx.api.state(policy, owner, true);
    const records = await ctx.journal.entries();
    current();
    return {reply, records, phase: vaultPhase(reply.state, records, reply.operations)};
  };
  current();
  await ctx.lifecycle.recoverPending(policy, owner, ctx.current);
  let observed = await read();
  if (observed.phase.phase === 'closed') return 'returned';
  if (!observed.reply.state) {
    const unsignedSetup = await ctx.journal.read('prepared-deploy') ?? await ctx.journal.read('preparing-deploy');
    if (!unsignedSetup && observed.phase.phase === 'draft' && observed.reply.operations.every(op => op.status === 'failed')) return 'unused';
    throw new Error('The original setup or vault result is unresolved. Check this policy card before returning funds; no replacement transaction was signed.');
  }
  const prior = observed.records.find(record => record.method === 'close' && record.status !== 'failed' && !settledOperation(record) && !supersededOwner(record, observed.records));
  let operation: Operation;
  if (prior) {
    options.progress?.('checking');
    operation = await ctx.lifecycle.replay(prior.id, policy, owner);
  } else {
    current();
    operation = await ctx.lifecycle.submit(policy, owner, 'close', {instanceSlot: observed.reply.state.instanceSlot}, undefined, options.progress);
  }
  const pause = options.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 2500)));
  for (let attempt = 0; attempt < (options.checks ?? 12); attempt++) {
    current();
    observed = await read();
    if (observed.phase.phase === 'closed') return 'returned';
    if (operation.status === 'failed') throw new Error('The return transaction failed. Server spending remains stopped; retry from this policy card.');
    if (settledOperation(operation)) throw new Error('The original close is finalized, but closure of the current vault is not confirmed. Check this policy card.');
    if (operation.blockhashExpired) throw new Error('The original return has expired with an unresolved result. Review its saved proof and authorize any additional return on this policy card.');
    options.progress?.('checking');
    await pause();
    current();
    operation = await ctx.lifecycle.recover(operation.id, policy, owner);
  }
  // Observe the final recovery before stopping the queue; never replace its signed proof.
  observed = await read();
  if (observed.phase.phase === 'closed') return 'returned';
  throw new Error('The return is awaiting finality. Its original proof is saved. Check this policy card or retry the remaining returns; no second transaction is needed.');
}
