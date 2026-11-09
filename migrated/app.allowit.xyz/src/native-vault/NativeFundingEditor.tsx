import {useId, useState} from 'react';
import type {MicroController, MicroPolicy} from '../micro/micro-contracts';

/** Explicitly saves the exact USDC deposit for setup; typing alone never changes the draft, and its rules stay as written. */
export default function NativeFundingEditor({c,policy,blocked}:{c:MicroController;policy:MicroPolicy;blocked:boolean}) {
  const id = useId();
  const saved = policy.fundingRequest?.amount ?? '';
  const [amount,setAmount]=useState(saved),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const value = amount.trim();
  const save=async()=>{
    if(blocked||saving||!value||value===saved)return;
    setError('');
    setSaving(true);
    try {if(!await c.setFunding(value))setError('The funding amount was not saved. Review the policy error and retry.');}
    catch(e) {setError(e instanceof Error?e.message:'The funding amount could not be saved.');}
    finally {setSaving(false);}
  };
  return <form id="native-funding-amount" className="native-funding-editor" onSubmit={e=>{e.preventDefault();void save();}}>
    <div className="native-funding-input">
      <input id={id} className="input mono" inputMode="decimal" aria-label="Funding amount in USDC" aria-describedby={`${id}-hint`} value={amount} disabled={blocked||saving} autoComplete="off" spellCheck={false} placeholder="0.05" onChange={e=>{setAmount(e.target.value);setError('');}}/>
      <span aria-hidden="true">USDC</span>
      <button type="submit" className="btn" disabled={blocked||saving||!value||value===saved}>{saving?'Saving…':'Save'}</button>
    </div>
    <span className="native-fact-note" id={`${id}-hint`}>Deposited when you sign setup. Daily and per-action limits never exceed this policy or 50 USDC a day.</span>
    {error?<p className="error-line" role="alert">{error}</p>:null}
  </form>;
}
