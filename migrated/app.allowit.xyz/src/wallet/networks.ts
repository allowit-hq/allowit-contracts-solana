import {isStellarNetwork} from '@allowit/engine/stellar/runtime';
import type {StellarNetwork} from '@allowit/engine/stellar/stellar-wallet';
export type Network='solana:mainnet'|'solana:testnet'|'solana:devnet'|'local:dev'|'solana:localnet'|'tempo:testnet'|'tempo:localnet'|StellarNetwork;
export const isTempoNetwork=(network:string):network is 'tempo:testnet'|'tempo:localnet'=>network==='tempo:testnet'||network==='tempo:localnet';
import {readRequestLink} from '../owner/request-link';
import {localSandboxEnabled,privateLocalnetEnabled} from './runtime-network';
export interface NetworkConfig {id:Network;label:string;mint:string;allocationEnabled:boolean}
export const NETWORKS:NetworkConfig[]=[{id:'solana:mainnet',label:'Mainnet',mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',allocationEnabled:false},{id:'solana:testnet',label:'Testnet',mint:'',allocationEnabled:false},{id:'solana:devnet',label:'Devnet',mint:'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',allocationEnabled:false},{id:'local:dev',label:'Local dev',mint:'',allocationEnabled:true}];
if (privateLocalnetEnabled) NETWORKS.push({id:'solana:localnet',label:'Local Solana',mint:'',allocationEnabled:false});
/** Additional test networks remain available in explicit loopback development tools. */
export const testnetLauncher=()=>import.meta.env.DEV&&['127.0.0.1','localhost'].includes(window.location.hostname)&&(import.meta.env.VITE_TESTNET_ONLY==='1'||window.location.port==='5195');
export function availableNetworks(networks:NetworkConfig[],delegated:readonly string[]=[]):NetworkConfig[]{
 if(networks.length&&networks.every(n=>isStellarNetwork(n.id)))return networks.filter(n=>isStellarNetwork(n.id));
 if(testnetLauncher())return networks.filter(n=>n.id==='solana:testnet');
 // Network selection is a preference, separate from the server's funding/runtime availability.
 const choices=[...networks,...NETWORKS.filter(n=>(n.id==='solana:devnet'||n.id==='solana:mainnet')&&!networks.some(value=>value.id===n.id)).map(n=>({...n,allocationEnabled:false}))];
 return localSandboxEnabled||privateLocalnetEnabled?choices:choices.filter(n=>n.id==='solana:devnet'||n.id==='solana:mainnet'||delegated.includes(n.id));
}
export function savedNetwork():Network {
 const networks=availableNetworks(NETWORKS),linked=readRequestLink(window.location.search);
 if(linked&&networks.some(n=>n.id===linked.network))return linked.network;
 try{const n=localStorage.getItem('allowit.network');if(networks.some(v=>v.id===n))return n as Network;}catch{/* Storage optional. */}
 return testnetLauncher()?'solana:testnet':'solana:devnet';
}
