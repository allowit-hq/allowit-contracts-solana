import type {AllowanceRecoveryView} from './allowance-recovery';

const paused='Automatic status checks have paused. Use Check allowance status to continue; no new signature is needed.';
interface Observation {until:number;attempts:number;nextAt:number;result?:Promise<AllowanceRecoveryView>;failed:boolean;pending:boolean}
const observations=new Map<string,Observation>();
/** Visible panels share one bounded, read-only observation stream for the same authority. */
export function observeAllowance(scope:string,read:()=>Promise<AllowanceRecoveryView>,now=Date.now()):Promise<AllowanceRecoveryView>{
 let state=observations.get(scope);
 if(!state){state={until:now+180_000,attempts:0,nextAt:0,failed:false,pending:false};observations.set(scope,state);}
 if(state.failed||now>=state.until||state.attempts>=36&&now>=state.nextAt)return Promise.reject(new Error(paused));
 if(state.result&&(state.pending||now<state.nextAt))return state.result;
 state.attempts++;state.nextAt=now+5000;state.pending=true;
 const current=state;
 current.result=Promise.resolve().then(read).catch(error=>{current.failed=true;throw error;}).finally(()=>{current.pending=false;});
 return current.result;
}
export function resetAllowanceObservation(scope:string):void {observations.delete(scope);}
/** The lock includes preparation, wallet signing and durable proof retention. */
export async function withAllowanceSigningLock<T>(network:string,owner:string,run:()=>Promise<T>):Promise<T>{
 if(!navigator.locks)throw new Error('This browser cannot coordinate wallet signing across tabs. Use a browser with Web Locks. Nothing was signed.');
 return navigator.locks.request(`allowit.allowance:${network}:${owner}`,run);
}
