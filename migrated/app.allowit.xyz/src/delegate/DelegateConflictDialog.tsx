import {useEffect,useId,useRef} from 'react';
import type {DelegateGrant} from './delegate-contracts';
import {blockingDelegateGrant,type DelegateConflictNotice} from './delegate-conflict';
import {DelegateWalletRecovery} from './DelegateSections';
import type {DelegateWorkspace} from './useDelegateWorkspace';
import '../policy/revoke-policies.css';

export default function DelegateConflictDialog({notice,grants,busy,dismiss,review,workspace,network,completed}:{notice:DelegateConflictNotice|null;grants:readonly DelegateGrant[];busy:boolean;dismiss:()=>void;review:(grant:DelegateGrant|null)=>void;workspace:DelegateWorkspace;network:string;completed:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),opener=useRef<HTMLElement|null>(null),id=useId();
 const blocker=notice?blockingDelegateGrant(notice.details,grants):null;
 useEffect(()=>{
  const element=dialog.current;
  if(notice&&!element?.open){opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;element?.showModal();}
  else if(!notice&&element?.open)element.close();
 },[notice]);
 useEffect(()=>()=>dialog.current?.close(),[]);
 const close=()=>{if(!busy)dismiss();};
 const closed=()=>{const target=opener.current;if(target?.isConnected&&!(target as HTMLButtonElement).disabled)target.focus();};
 return <dialog ref={dialog} className="revoke-policies-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onClose={closed} onCancel={event=>{event.preventDefault();close();}} onClick={event=>{if(event.target!==event.currentTarget)return;const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}}>
  <h2 id={`${id}-title`}>{blocker?'Finish closing the earlier policy':'An existing allowance blocks this policy'}</h2>
  <p id={`${id}-description`}>{blocker?`"${blocker.title??blocker.policyId}" still has a USDC allowance on this account. Finish revoking it before approving the new policy.`:'An earlier allowance or unfinished revocation blocks this policy. Review the wallet account and finish closing it here, even if the earlier policy is missing.'}</p>
  <p className="small muted">Your new policy stays saved. Tokens remain in your wallet.</p>
  {notice?<DelegateWalletRecovery workspace={workspace} network={network} onCompleted={completed}/>:null}
  <div className="btn-row revoke-policies-actions">
   <button type="button" className="btn" autoFocus disabled={busy} onClick={close}>Back to new policy</button>
   <button type="button" className="btn" disabled={busy} onClick={()=>review(blocker)}>{blocker?'Review earlier policy':'Review policies'}</button>
  </div>
 </dialog>;
}
