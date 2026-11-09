import {useRef} from 'react';
import './solana-network-switch.css';

const NETWORKS=[{id:'solana:devnet',label:'Devnet'},{id:'solana:mainnet',label:'Mainnet'}] as const;

/** Selects only the network of future policies; it never moves funds or rewrites an existing policy. */
export default function SolanaNetworkSwitch({network,disabled,onChange,describedBy}:{network:string;disabled:boolean;onChange:(network:string)=>void;describedBy?:string}){
 const buttons=useRef<(HTMLButtonElement|null)[]>([]);
 return <div className="net solana-network-switch" role="group" aria-label="Network for new policies" aria-describedby={describedBy}>
  {NETWORKS.map((item,index)=><button key={item.id} ref={element=>{buttons.current[index]=element;}} type="button" className="solana-network-option" aria-pressed={network===item.id} disabled={disabled} onClick={()=>{if(network!==item.id)onChange(item.id);}} onKeyDown={event=>{
   if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
   event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:1-index;
   buttons.current[next]?.focus();if(NETWORKS[next].id!==network)onChange(NETWORKS[next].id);
  }}>{item.label}</button>)}
 </div>;
}
