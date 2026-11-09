import {useCallback,useEffect,useRef,useState} from 'react';
import type {Wallet} from '@wallet-standard/base';
import type {AppController,Session,Theme} from './contracts';
import {request} from './api';
import {onPref,writePref} from './shared-prefs';
import {connectAccount,signChallenge,solanaWallets,walletRegistry,rememberSessionWallet,type EventsFeature} from './wallet/wallet';
import {walletSignInResponse} from './wallet/wallet-signin';
function saved(key:string){try{return localStorage.getItem(key);}catch{return null;}}
function save(key:string,value:string){try{localStorage.setItem(key,value);}catch{/* Private browsing can disable storage. */}}
function savedTheme():Theme{const t=saved('allowit.theme');return t==='light'||t==='dark'?t:'auto';}
function signInError(error:unknown):string{
 const message=error instanceof Error?error.message:'The wallet could not complete sign-in.';
 const code=typeof error==='object'&&error!==null?(error as {code?:unknown}).code:undefined;
 return (typeof code==='number'||typeof code==='string')&&String(code)?`${message} (wallet code ${code})`:message;
}
export type AuthController=Pick<AppController,'session'|'loading'|'busy'|'error'|'notice'|'theme'|'wallets'|'setTheme'|'dismissError'|'refresh'|'signIn'|'cancelSignIn'|'signOut'>;
export default function useApp():AuthController{
 const [session,setSession]=useState<Session|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[theme,setTheme]=useState<Theme>(savedTheme),[wallets,setWallets]=useState<Wallet[]>(solanaWallets);
 const lock=useRef(false),operationId=useRef(0),activeWallet=useRef<Wallet|null>(null),offWallet=useRef<(()=>void)|null>(null),generation=useRef(0),pendingAccountLoss=useRef(false),mounted=useRef(true);
 const current=(g:number)=>mounted.current&&g===generation.current;
 // `expected` is the account that just signed in; any other session address is refused rather than applied.
 const refresh=useCallback(async(expected?:string)=>{const g=generation.current;if(pendingAccountLoss.current||saved('allowit.pendingLogout')==='1'){await request('auth/logout',{});if(mounted.current&&g===generation.current){pendingAccountLoss.current=false;save('allowit.pendingLogout','');offWallet.current?.();offWallet.current=null;activeWallet.current=null;rememberSessionWallet(null);save('allowit.wallet','');}}const data=await request<{session:Session|null}>('session');if(mounted.current&&g===generation.current){if(expected!==undefined&&data.session?.address!==expected){setSession(null);await request('auth/logout',{}).catch(()=>{});throw new Error('The server session is for another account. Sign in again.');}setSession(data.session);}},[]);
 const clearWallet=()=>{offWallet.current?.();offWallet.current=null;activeWallet.current=null;rememberSessionWallet(null);};
 async function accountLost(message="Wallet access changed. Sign in again with the account you want to use."){
  const g=++generation.current;pendingAccountLoss.current=true;save('allowit.pendingLogout','1');
  // Hide the previous identity immediately. In-flight responses cannot restore it.
  setSession(null);setLoading(true);setError(null);
  try{await request('auth/logout',{});if(current(g)){clearWallet();save('allowit.wallet','');pendingAccountLoss.current=false;save('allowit.pendingLogout','');setNotice(message);await refresh();}}
  catch{if(current(g))setError('Session recovery could not finish. Reload the workspace to retry before continuing.');}
  finally{if(current(g)){setLoading(false);}}
 }
 function watch(wallet:Wallet,address:string){clearWallet();activeWallet.current=wallet;rememberSessionWallet(wallet,address);const events=wallet.features['standard:events'] as EventsFeature|undefined;offWallet.current=events?.on('change',props=>{if(props.accounts&&!props.accounts.some(a=>a.address===address))void accountLost();})??null;}
 useEffect(()=>{mounted.current=true;refresh().catch(e=>mounted.current&&setError(e.message)).finally(()=>mounted.current&&setLoading(false));return()=>{mounted.current=false;offWallet.current?.();};},[refresh]);
 useEffect(()=>{const update=()=>setWallets(solanaWallets());const a=walletRegistry().on('register',update),b=walletRegistry().on('unregister',update);update();return()=>{a();b();};},[]);
 // Wallet Standard exposes authorized accounts, not a universal selected-account
 // event. Restore monitoring without prompting; losing authorization signs out.
 useEffect(()=>{if(!session||session.network==='stellar'||activeWallet.current||offWallet.current)return;const wallet=wallets.find(w=>w.name===saved('allowit.wallet'));if(wallet)watch(wallet,session.address);},[session,wallets]);
 useEffect(()=>{const q=matchMedia('(prefers-color-scheme: dark)');const apply=()=>{document.documentElement.dataset.theme=theme==='auto'?(q.matches?'dark':'light'):theme;};apply();q.addEventListener('change',apply);writePref('allowit.theme',theme);return()=>q.removeEventListener('change',apply);},[theme]);
 // One theme for the whole site: a switch on another page or tab applies here at once.
 useEffect(()=>onPref('allowit.theme',v=>setTheme(v==='light'||v==='dark'?v:'auto')),[]);
 useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(null),4500);return()=>clearTimeout(t);},[notice]);
 useEffect(()=>{if(session?.network!=='stellar')return;let live=true;let stop:(()=>void)|undefined;void import('./vendors/stellar/stellar-wallet').then(({watchStellarAccount})=>{if(live)stop=watchStellarAccount(session.address,()=>{void accountLost();});});return()=>{live=false;stop?.();};},[session?.address,session?.network]);
 useEffect(()=>{if(!session)return;const delay=Math.min(2147483647,Math.max(0,Date.parse(session.expiresAt)-Date.now()));const t=setTimeout(()=>{void accountLost('Your session expired. Sign in again to restore your workspace.');},delay);return()=>clearTimeout(t);},[session]);
 async function run<T>(name:string,fn:(g:number)=>Promise<T>,message?:string):Promise<T|null>{if(lock.current)return null;if((pendingAccountLoss.current||saved('allowit.pendingLogout')==='1')&&name!=='refresh'){setError('A previous sign-out needs to finish. Reload the workspace to retry.');return null;}lock.current=true;const operation=++operationId.current;setBusy(name);setError(null);const g=generation.current;try{const result=await fn(g);if(!current(g))return null;if(message)setNotice(message);return result;}catch(e){if(current(g))setError(name==='signin'?signInError(e):e instanceof Error?e.message:'Something could not be saved. Try again.');return null;}finally{if(operation===operationId.current){lock.current=false;if(mounted.current)setBusy(null);}}}
 function cancelSignIn(){if(busy!=='signin'||!lock.current)return;generation.current++;operationId.current++;lock.current=false;setBusy(null);setError(null);setNotice('Wallet connection cancelled. You can try again.');}
 async function signOut(){await run('signout',async()=>{await request('auth/logout',{});generation.current++;const wallet=activeWallet.current;clearWallet();save('allowit.wallet','');setSession(null);if(wallet?.features['standard:disconnect']){try{await (wallet.features['standard:disconnect'] as {disconnect:()=>Promise<void>}).disconnect();}catch{/* Server logout succeeded. */}}await refresh().catch(e=>setError(e.message));setNotice('Signed out.');});}
 async function signIn(name:string){await run('signin',async g=>{
  const wallet=wallets.find(w=>w.name===name);if(!wallet)throw new Error('The wallet is no longer available. Open or unlock it and try again.');
  const attempt=new AbortController();
  const interrupted=()=>attempt.abort(new Error('Sign-in was interrupted when this page was left. Close any pending wallet request, then sign in again.'));
  window.addEventListener('pagehide',interrupted);
  let stop:(()=>void)|undefined;
  let valid=true;
  const check=()=>{attempt.signal.throwIfAborted();if(!valid||!current(g))throw new Error('Wallet access changed during sign-in. Start again.');};
  try{
   const account=await walletSignInResponse(()=>connectAccount(wallet),wallet.name,'connection',attempt.signal);
   check();
   const events=wallet.features['standard:events'] as EventsFeature|undefined;
   stop=events?.on('change',props=>{if(props.accounts&&!props.accounts.some(a=>a.address===account.address)){valid=false;attempt.abort(new Error('Wallet access changed during sign-in. Start again.'));}});
   const c=await request<{id:string;message:string;address:string;origin?:string}>('auth/challenge',{address:account.address});
   check();
   // Sign only a challenge for this exact account and this page's origin.
   if(!c||c.address!==account.address||c.origin!==location.origin||typeof c.message!=='string')throw new Error('The sign-in challenge belongs to another account or site. Nothing was signed.');
   const signature=await walletSignInResponse(()=>signChallenge(wallet,account,c.message),wallet.name,'signature',attempt.signal);check();
   setBusy('verifying');
   const data=await request<{session:Session}>('auth/verify',{id:c.id,message:c.message,address:account.address,signature});
   // The session must be the account that signed; checked again after the reply, before it is applied.
   if(data?.session?.address!==account.address&&!attempt.signal.aborted&&valid&&current(g)){await request('auth/logout',{}).catch(()=>{});throw new Error(data?.session?'The server returned a session for another account. Sign in again.':'Wallet access changed during sign-in. Start again.');}
   if(attempt.signal.aborted||!valid||!current(g)){
    // Verification may already have set a cookie. Keep recovery pending if logout fails.
    pendingAccountLoss.current=true;save('allowit.pendingLogout','1');
    await request('auth/logout',{});
    pendingAccountLoss.current=false;save('allowit.pendingLogout','');
    throw attempt.signal.reason??new Error('Wallet access changed during sign-in. Start again.');
   }
   // Commit the new wallet listener only after server verification succeeds.
   generation.current++;watch(wallet,account.address);save('allowit.wallet',wallet.name);setSession(data.session);const confirmed=await refresh(account.address).then(()=>true,e=>{if(current(g+1)){clearWallet();save('allowit.wallet','');setError(e.message);}return false;});if(confirmed)setNotice('Signed in. No spending permission was requested.');
  }finally{stop?.();window.removeEventListener('pagehide',interrupted);}
 });}
 return {session,loading,busy,error,notice,theme,wallets:wallets.map(w=>({name:w.name,icon:w.icon})),setTheme,dismissError:()=>setError(null),refresh:async()=>{await run('refresh',()=>refresh());},signIn,cancelSignIn,signOut};
}
