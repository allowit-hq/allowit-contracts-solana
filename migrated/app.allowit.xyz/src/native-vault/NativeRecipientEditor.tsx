import {useId, useState} from 'react';
import type {MicroController, MicroPolicy} from '../micro/micro-contracts';
import {recipientTokenAccount} from './native-recipient';

/** Explicitly saves a source-bound rule; typing or browsing alone never changes spending authority. */
export default function NativeRecipientEditor({c,policy,blocked}:{c:MicroController;policy:MicroPolicy;blocked:boolean}) {
  const id = useId();
  const ownWallet = c.auth.session?.address ?? '';
  const [destination,setDestination]=useState<'self'|'custom'>(ownWallet ? 'self' : 'custom');
  const [customWallet,setCustomWallet]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false);
  const wallet = destination === 'self' ? ownWallet : customWallet;
  const testNetwork=policy.network!=='solana:mainnet';
  const save=async()=>{
    if(blocked||saving)return;
    setError('');
    try {
      recipientTokenAccount(wallet.trim(),policy.mint);
      setSaving(true);
      if(!await c.setRecipient(wallet.trim()))setError('The recipient was not saved. Review the policy error and retry.');
    } catch(e) {setError(e instanceof Error?e.message:'The recipient could not be saved.');}
    finally {setSaving(false);}
  };
  return <div id="native-payment-destination" className="form-stack native-recipient">
    <fieldset className="native-destinations" disabled={blocked||saving} aria-describedby={`${id}-hint`}>
      <legend>Limit payments to one wallet</legend>
      <p className="small muted" id={`${id}-hint`}>Optionally restrict payments to one recipient. Your other policy rules stay unchanged.</p>
      {ownWallet ? <label className="native-destination">
        <input type="radio" name={`${id}-destination`} value="self" checked={destination==='self'} onChange={()=>{setDestination('self');setError('');}} />
        <span><strong>My connected wallet</strong><span className="small muted">Receive {testNetwork?'test ':''}payments yourself.</span></span>
      </label> : null}
      <label className="native-destination">
        <input type="radio" name={`${id}-destination`} value="custom" checked={destination==='custom'} onChange={()=>{setDestination('custom');setError('');}} />
        <span><strong>Another wallet</strong><span className="small muted">Choose a different recipient.</span></span>
      </label>
      {destination==='custom' ? <label className="native-custom-wallet">Recipient wallet<input className="input mono" aria-label="Recipient wallet address" value={customWallet} autoComplete="off" spellCheck={false} placeholder="Solana wallet address" onChange={e=>{setCustomWallet(e.target.value);setError('');}}/><span className="small muted">Use the wallet address, not a token-account address.</span></label> : <details className="native-wallet-address"><summary>View connected wallet address</summary><span className="mono">{ownWallet}</span></details>}
    </fieldset>
    <p className="small muted">Adds this destination to your policy. Saving moves no tokens.</p>
    {error?<p className="error-line" role="alert">{error}</p>:null}
    <button type="button" className="btn btn-primary" disabled={blocked||saving||!wallet.trim()} onClick={()=>void save()}>{saving?'Saving destination…':'Save payment destination'}</button>
  </div>;
}
