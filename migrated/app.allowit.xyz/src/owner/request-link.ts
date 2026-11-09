import type {Network} from '../wallet/networks';

export interface RequestLink {network:Network;owner:string;policy:string;request:string}
export function readRequestLink(search:string):RequestLink|null {
 const query=new URLSearchParams(search);
 const network=query.get('network'),owner=query.get('owner'),policy=query.get('policy'),request=query.get('request');
 if(!['local:dev','solana:devnet','solana:testnet','solana:mainnet'].includes(network??''))return null;
 if(!owner||!policy||!request||![owner,policy,request].every(value=>/^[A-Za-z0-9_-]{1,100}$/.test(value)))return null;
 if((network==='local:dev')!==owner.startsWith('local_'))return null;
 return {network:network as Network,owner,policy,request};
}

/**
 * Focus return after the review dialog has unmounted. Closing always returns focus to the network picker. The picker can
 * still be disabled then, for example while an answer's refresh runs, so focus waits on main and moves on once the picker
 * is enabled. If the user moves focus meanwhile, it stays where they put it; later polls and renders never move it.
 * Each step runs on a frame from `returnFocus`, after native dialog close has restored its own focus.
 */
export type ReviewFocus='closed'|'parked';
export function reviewFocus(state:ReviewFocus,onMain:boolean,pickerEnabled:boolean):{focus:'picker'|'main'|null;next:ReviewFocus|null} {
 if(state==='parked'&&!onMain)return {focus:null,next:null};
 if(pickerEnabled)return {focus:'picker',next:null};
 return {focus:state==='closed'?'main':null,next:'parked'};
}

/**
 * One pending focus return per page, on the next frame. Scheduling a return drops the one still pending, so a drawer's
 * return can never run after a dialog that closed later scheduled its own. The handle cancels only its own return.
 */
export function focusReturn(frame:(run:()=>void)=>number,cancelFrame:(id:number)=>void) {
 let pending=0;
 return (run:()=>void)=>{
  if(pending)cancelFrame(pending);
  const id=pending=frame(()=>{
   if(pending!==id)return;
   pending=0;
   run();
  });
  return ()=>{
   if(pending!==id)return;
   cancelFrame(id);
   pending=0;
  };
 };
}
export const returnFocus=focusReturn(run=>requestAnimationFrame(run),id=>cancelAnimationFrame(id));
