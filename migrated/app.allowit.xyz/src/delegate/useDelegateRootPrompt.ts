import {useCallback,useEffect,useRef,useState} from 'react';
import {request} from '../api';
import {checkedRootAccess,type RootAccessResponse} from './delegate-root-access';
import type {DelegateConfig,DelegateGrant} from './delegate-contracts';

interface Input {key:string;grant:DelegateGrant|null;config:DelegateConfig|null;principal:string;isCurrent:()=>boolean}
type Prompt={key:string;epoch:number;status:'loading'|'ready'|'error';grantId:string;token?:string;error?:string};

/** Root access is reissued on demand, held only in RAM, and never creates a child or moves an allowance. */
export default function useDelegateRootPrompt(input:Input){
 const live=useRef(input);live.current=input;
 const binding=useRef({key:input.key,epoch:0});
 if(binding.current.key!==input.key)binding.current={key:input.key,epoch:binding.current.epoch+1};
 const mounted=useRef(true),inFlight=useRef<{key:string;epoch:number;promise:Promise<void>}|null>(null);
 const [state,setState]=useState<Prompt|null>(null);
 const load=useCallback(()=>{
  const captured=live.current,{key,epoch}=binding.current;
  if(!key||!captured.grant||!captured.config||!captured.isCurrent())return Promise.resolve();
  if(inFlight.current?.key===key&&inFlight.current.epoch===epoch)return inFlight.current.promise;
  const valid=()=>mounted.current&&binding.current.key===key&&binding.current.epoch===epoch&&live.current.key===key&&live.current.isCurrent();
  setState({key,epoch,grantId:captured.grant.id,status:'loading'});
  const promise=(async()=>{
   try{
    const value=await request<RootAccessResponse>('delegate/access',{grantId:captured.grant!.id},{expectedOwner:captured.principal});
    if(!valid())return;
    const token=await checkedRootAccess(captured.config!,captured.grant!,value);
    if(valid())setState({key,epoch,grantId:captured.grant!.id,status:'ready',token});
   }catch(error){if(valid())setState({key,epoch,grantId:captured.grant!.id,status:'error',error:error instanceof Error?error.message:'The agent prompt could not be prepared.'});}
   finally{if(inFlight.current?.key===key&&inFlight.current.epoch===epoch)inFlight.current=null;}
  })();
  inFlight.current={key,epoch,promise};return promise;
 },[]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;binding.current.epoch++;inFlight.current=null;};},[]);
 useEffect(()=>{setState(null);if(input.key)void load();},[input.key,load]);
 const prompt=input.key&&state?.key===input.key&&state.epoch===binding.current.epoch&&input.isCurrent()?state:null;
 return {prompt,retry:load,invalidate:()=>{binding.current.epoch++;inFlight.current=null;const value=live.current;setState(value.key&&value.grant?{key:value.key,epoch:binding.current.epoch,grantId:value.grant.id,status:'error',error:'Access was hidden while stopping. Check the grant before retrying.'}:null);},isCurrent:()=>!!prompt&&prompt.status==='ready'&&mounted.current&&binding.current.key===prompt.key&&binding.current.epoch===prompt.epoch&&live.current.isCurrent()};
}
