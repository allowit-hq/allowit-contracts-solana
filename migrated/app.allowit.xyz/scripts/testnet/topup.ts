import {getWallets} from '@wallet-standard/app';
import type {Wallet,WalletAccount} from '@wallet-standard/base';
import {
  address,blockhash,compileTransaction,compileTransactionMessage,
  createTransactionMessage,getCompiledTransactionMessageEncoder,getTransactionEncoder,
  pipe,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
} from '@solana/kit';
import {getMintToCheckedInstruction,TOKEN_PROGRAM_ADDRESS} from '@solana-program/token';
import {signTestnetTransaction,type PhantomSigningProvider} from '../../src/wallet/testnet-wallet-signing';
import {configuredAddresses} from './config';
import {receiptState} from './pending';
import {readOperation,withOperationLock} from './operation';

const RPC='https://api.testnet.solana.com';
const GENESIS='4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';
const MINT=configuredAddresses('mint')[0];
const AUTHORITY=configuredAddresses('authority')[0];
const RECIPIENTS=configuredAddresses('recipient',true);
const TOP_UP=1_000_000_000n; // 1,000 test units at six decimals, for each recipient.
const pendingKey=`allowit.testnet-topup.${MINT}`;
let storedKey=pendingKey;
const root=document.querySelector<HTMLElement>('#topup-root')!;
root.innerHTML=`<style>
  :root{font-family:Manrope,system-ui,sans-serif;color:#171715;background:#fafaf7}
  *{box-sizing:border-box}body{margin:0}main{max-width:760px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:clamp(30px,5vw,44px);line-height:1.1;margin:18px 0}p{line-height:1.55}
  .muted{color:#65655f}.card{border:1px solid #ddddda;border-radius:18px;padding:20px;margin:22px 0;background:#fff}
  dl{display:grid;grid-template-columns:150px 1fr;gap:12px;margin:0}dt{color:#65655f}dd{margin:0;overflow-wrap:anywhere}
  button{font:inherit;padding:11px 17px;margin:8px 8px 0 0;border:1px solid #c8c8c4;border-radius:999px;background:#fff;color:#171715;cursor:pointer}
  button.primary{background:#171715;color:#fff;border-color:#171715}button:disabled{opacity:.5;cursor:not-allowed}
  a{color:inherit}code{font-family:ui-monospace,monospace;font-size:13px;overflow-wrap:anywhere}
  #status{min-height:2em}#status.error{color:#b82f27}
  @media(max-width:560px){dl{grid-template-columns:1fr;gap:3px}dd{margin-bottom:10px}}
</style>
<a href="/">← Allowit</a>
<h1>Пополнение Testnet-токена</h1>
<p>Добавить по <strong>1 000 тестовых токенов</strong> каждому указанному получателю. Это тестовый токен в Solana Testnet, а не настоящий USDC в Mainnet. Для выпуска нужна подпись кошелька с правом mint.</p>
<div class="card"><dl>
  <dt>Сеть</dt><dd>Solana Testnet</dd>
  <dt>Mint</dt><dd><code>${MINT}</code></dd>
  <dt>Кошелёк с правом выпуска</dt><dd><code>${AUTHORITY}</code></dd>
  ${RECIPIENTS.map((recipient,index)=>`<dt>Получатель ${index+1}</dt><dd><code>${recipient}</code> · +1 000</dd>`).join('')}
</dl></div>
<div id="wallets"></div>
<button id="prepare" disabled>Проверить и подготовить</button>
<div id="summary"></div>
<button id="submit" class="primary" hidden>Подписать и отправить</button>
<button id="verify" hidden>Проверить подтверждение</button>
<p id="status" role="status" aria-live="polite"></p>`;

const walletsEl=document.querySelector<HTMLElement>('#wallets')!;
const prepareButton=document.querySelector<HTMLButtonElement>('#prepare')!;
const submitButton=document.querySelector<HTMLButtonElement>('#submit')!;
const verifyButton=document.querySelector<HTMLButtonElement>('#verify')!;
const summary=document.querySelector<HTMLElement>('#summary')!;
const status=document.querySelector<HTMLElement>('#status')!;
type Recipient={owner:string;account:string;before:bigint};
type Prepared={recipients:Recipient[];fee:number;build:()=>Promise<{transaction:Uint8Array;lastValidBlockHeight:number;fee:number}>};
type Pending={signature:string;lastValidBlockHeight:number;recipients:{owner:string;account:string;before:string}[]};
let wallet:Wallet|undefined;
let account:WalletAccount|undefined;
let prepared:Prepared|undefined;
let pending:Pending|undefined;
let busy=false;
let recoveryBlocked=false;
const base64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));
const units=(n:bigint)=>`${n/1_000_000n}.${String(n%1_000_000n).padStart(6,'0')}`.replace(/\.0+$/,'');
function message(error:unknown){
  if(error&&typeof error==='object'&&'message' in error){
    const code='code' in error&&(typeof error.code==='number'||typeof error.code==='string')?` (код ${error.code})`:'';
    return `${String(error.message)}${code}`;
  }
  return String(error);
}
function say(value:string,error=false){status.textContent=value;status.classList.toggle('error',error)}
function buttons(){prepareButton.disabled=busy||!account||!!pending||recoveryBlocked;submitButton.disabled=busy||!!pending||recoveryBlocked;verifyButton.disabled=busy;walletsEl.querySelectorAll('button').forEach(button=>button.disabled=busy||!!pending||recoveryBlocked)}
function clearPending(){localStorage.removeItem(storedKey);pending=undefined;prepared=undefined;submitButton.hidden=true;verifyButton.hidden=true;summary.replaceChildren()}
function restorePending(){
  try{
    const saved=readOperation<Pending>(pendingKey,(value):value is Pending=>{
      const s=value as Pending|null;
      return !!s&&typeof s.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s.signature)&&Number.isSafeInteger(s.lastValidBlockHeight)&&s.lastValidBlockHeight>0&&Array.isArray(s.recipients)&&s.recipients.length>0&&s.recipients.every(item=>!!address(item.owner)&&!!address(item.account)&&typeof item.before==='string'&&/^[0-9]+$/.test(item.before));
    },pendingKey+'.');
    if(pending&&!saved){prepared=undefined;submitButton.hidden=true;summary.replaceChildren()}
    pending=saved?.value;storedKey=saved?.key??pendingKey;recoveryBlocked=false;verifyButton.hidden=!pending;
    if(pending)say(`Сохранена операция ${pending.signature}. Проверьте подтверждение перед новой попыткой.`);
  }catch(error){recoveryBlocked=true;say(message(error),true)}
  buttons();
}
function requireNoPending(){restorePending();if(pending||recoveryBlocked)throw new Error('Сохранённая операция требует проверки перед новой отправкой.')}
async function rpc<T>(method:string,params:unknown[]):Promise<T>{
  const response=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok||data.error)throw new Error(`${method}: ${data.error?message(data.error):response.status}`);
  return data.result as T;
}
async function inspect(owners:readonly string[]=RECIPIENTS):Promise<Recipient[]>{
  if(await rpc<string>('getGenesisHash',[])!==GENESIS)throw new Error('RPC отвечает из другой сети.');
  const mint=await rpc<{value:{owner:string;data:{parsed:{type:string;info:{decimals:number;mintAuthority:string}}}}|null}>('getAccountInfo',[MINT,{encoding:'jsonParsed',commitment:'finalized'}]);
  if(mint.value?.owner!==TOKEN_PROGRAM_ADDRESS||mint.value.data.parsed.type!=='mint'||mint.value.data.parsed.info.decimals!==6||mint.value.data.parsed.info.mintAuthority!==AUTHORITY)throw new Error('Mint или право выпуска изменились.');
  return Promise.all(owners.map(async owner=>{
    const result=await rpc<{value:{pubkey:string;account:{owner:string;data:{parsed:{type:string;info:{owner:string;mint:string;state:string;tokenAmount:{amount:string}}}}}}[]}>('getTokenAccountsByOwner',[owner,{mint:MINT},{encoding:'jsonParsed',commitment:'finalized'}]);
    const matches=result.value.filter(item=>item.account.owner===TOKEN_PROGRAM_ADDRESS&&item.account.data.parsed.type==='account'&&item.account.data.parsed.info.owner===owner&&item.account.data.parsed.info.mint===MINT&&item.account.data.parsed.info.state==='initialized');
    if(matches.length!==1)throw new Error(`Ожидался один активный токен-счёт для ${owner}. Найдено: ${matches.length}.`);
    return {owner,account:matches[0].pubkey,before:BigInt(matches[0].account.data.parsed.info.tokenAmount.amount)};
  }));
}
async function simulate(bytes:Uint8Array,sigVerify=false){
  const result=await rpc<{value:{err:unknown}}>('simulateTransaction',[base64(bytes),{encoding:'base64',sigVerify,commitment:'confirmed'}]);
  if(result.value.err)throw new Error(`Solana отклонила транзакцию: ${JSON.stringify(result.value.err)}`);
}
async function connect(selected:Wallet){
  if(busy||pending||recoveryBlocked)return;
  try{
    busy=true;wallet=undefined;account=undefined;buttons();prepared=undefined;summary.replaceChildren();submitButton.hidden=true;say(`Подключаю ${selected.name}…`);
    const feature=selected.features['standard:connect'] as {connect:()=>Promise<{accounts:readonly WalletAccount[]}>}|undefined;
    if(!feature)throw new Error('Кошелёк не поддерживает подключение.');
    const connected=await feature.connect();
    const chosen=connected.accounts.find(item=>item.address===AUTHORITY);
    if(!chosen)throw new Error(`Выберите кошелёк с правом выпуска: ${AUTHORITY}.`);
    if(!chosen.chains.includes('solana:testnet'))throw new Error('Включите Solana Testnet в кошельке.');
    wallet=selected;account=chosen;say(`Подключён ${selected.name}: ${AUTHORITY}`);
  }catch(error){say(`Подключение ${selected.name}: ${message(error)}`,true)}finally{busy=false;buttons()}
}
function listWallets(){
  walletsEl.replaceChildren();
  const found=getWallets().get().filter(item=>item.features['standard:connect']&&(item.features['solana:signTransaction']||item.name==='Phantom'));
  if(!found.length){walletsEl.textContent='Кошелёк в этом браузере не найден. Откройте страницу в браузере с Phantom или Solflare.';return}
  for(const item of found){const button=document.createElement('button');button.textContent=`Подключить ${item.name}`;button.addEventListener('click',()=>void connect(item));walletsEl.append(button)}
  buttons();
}
listWallets();getWallets().on('register',listWallets);

prepareButton.addEventListener('click',()=>void (async()=>{
  if(!account||busy||pending||recoveryBlocked)return;
  try{
    busy=true;buttons();prepared=undefined;submitButton.hidden=true;summary.replaceChildren();say('Проверяю mint, счета и симуляцию…');
    const recipients=await inspect();
    const authority=address(AUTHORITY);
    const authoritySigner={address:authority,signTransactions:async()=>{throw new Error('Подтвердите подпись в кошельке.')}};
    const build=async()=>{
      const latest=await rpc<{value:{blockhash:string;lastValidBlockHeight:number}}>('getLatestBlockhash',[{commitment:'confirmed'}]);
      const txMessage=pipe(createTransactionMessage({version:'legacy'}),
        item=>setTransactionMessageFeePayer(authority,item),
        item=>setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(latest.value.blockhash),lastValidBlockHeight:BigInt(latest.value.lastValidBlockHeight)},item),
        item=>appendTransactionMessageInstructions(recipients.map(recipient=>getMintToCheckedInstruction({mint:address(MINT),token:address(recipient.account),mintAuthority:authoritySigner,amount:TOP_UP,decimals:6})),item));
      const feeResult=await rpc<{value:number|null}>('getFeeForMessage',[base64(new Uint8Array(getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(txMessage)))),{commitment:'confirmed'}]);
      if(feeResult.value===null)throw new Error('Не удалось рассчитать комиссию.');
      return {transaction:new Uint8Array(getTransactionEncoder().encode(compileTransaction(txMessage))),lastValidBlockHeight:latest.value.lastValidBlockHeight,fee:feeResult.value};
    };
    const built=await build();
    await simulate(built.transaction);
    const balance=await rpc<{value:number}>('getBalance',[AUTHORITY,{commitment:'confirmed'}]);
    if(balance.value<built.fee)throw new Error('Недостаточно Testnet SOL для комиссии.');
    prepared={recipients,fee:built.fee,build};
    const card=document.createElement('div');card.className='card';
    const facts=document.createElement('dl');
    for(const [index,recipient] of recipients.entries()){
      const label=document.createElement('dt');label.textContent=`Получатель ${index+1}`;
      const value=document.createElement('dd');value.textContent=`${units(recipient.before)} → ${units(recipient.before+TOP_UP)} тестовых токенов`;
      facts.append(label,value);
    }
    const feeLabel=document.createElement('dt');feeLabel.textContent='Комиссия';
    const feeValue=document.createElement('dd');feeValue.textContent=`${(built.fee/1e9).toFixed(9)} Testnet SOL`;
    facts.append(feeLabel,feeValue);card.append(facts);summary.replaceChildren(card);
    submitButton.hidden=false;say('Симуляция прошла. Проверьте суммы и подтвердите выпуск в кошельке.');
  }catch(error){say(`Подготовка Testnet: ${message(error)}`,true)}finally{busy=false;buttons()}
})());

async function verify(){
  if(!pending)return;
  const current=pending;
  const {state,status}=await receiptState(rpc,current.signature,current.lastValidBlockHeight);
  if(state==='pending'){say('Окончательное подтверждение пока не найдено. Не отправляйте вторую транзакцию; проверьте снова позже.');return}
  if(state==='failed'){clearPending();throw new Error(`Транзакция окончательно отклонена: ${JSON.stringify(status?.err)}. Подпись ${current.signature}`)}
  if(state==='expired'){
    clearPending();say(`Срок транзакции истёк; в истории она не найдена. Можно подготовить новую попытку. Подпись ${current.signature}.`);return;
  }
  // Finalized settlement is conclusive even if balances later change.
  clearPending();
  const recipients=await inspect(current.recipients.map(item=>item.owner));
  for(const old of current.recipients){
    const now=recipients.find(item=>item.owner===old.owner&&item.account===old.account);
    if(!now||now.before<BigInt(old.before)+TOP_UP)throw new Error(`Транзакция подтверждена, но баланс ${old.owner} ниже ожидаемого. Подпись ${current.signature}`);
  }
  say(`Готово: на каждый кошелёк добавлено по 1 000 тестовых токенов. Подпись ${current.signature}.`);
  verifyButton.hidden=true;
}
submitButton.addEventListener('click',()=>void withOperationLock(pendingKey,async()=>{
  if(!prepared||!wallet||!account||busy||pending||recoveryBlocked)return;
  let stage='Подготовка Testnet';
  try{
    requireNoPending();busy=true;buttons();say('Повторно проверяю балансы и подготавливаю свежую транзакцию…');
    const current=await inspect();
    if(current.some((item,index)=>item.account!==prepared!.recipients[index].account||item.before!==prepared!.recipients[index].before))throw new Error('Баланс или счёт изменился. Подготовьте операцию заново.');
    const fresh=await prepared.build();
    if(fresh.fee>prepared.fee)throw new Error('Комиссия выросла. Подготовьте операцию заново.');
    await simulate(fresh.transaction);
    const phantom=(window as unknown as {phantom?:{solana?:PhantomSigningProvider}}).phantom?.solana;
    stage=`Подпись ${wallet.name}`;say(`Ожидаю подпись ${wallet.name}…`);
    requireNoPending();
    const signed=await signTestnetTransaction(wallet,account,fresh.transaction,phantom);
    stage='Проверка подписанной транзакции';
    await simulate(signed.transaction,true);
    stage='Сохранение операции';
    requireNoPending();
    pending={signature:signed.signature,lastValidBlockHeight:fresh.lastValidBlockHeight,recipients:prepared.recipients.map(item=>({owner:item.owner,account:item.account,before:item.before.toString()}))};
    try{localStorage.setItem(pendingKey,JSON.stringify(pending))}catch{pending=undefined;throw new Error('Не удалось сохранить статус. Транзакция не отправлена.')}
    stage='Отправка Testnet';submitButton.hidden=true;verifyButton.hidden=false;say('Отправляю подписанную транзакцию…');
    const sent=await rpc<string>('sendTransaction',[base64(signed.transaction),{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:3}]);
    if(sent!==signed.signature)throw new Error('RPC вернул другую подпись. Проверьте сохранённую транзакцию.');
    stage='Подтверждение Testnet';await verify();
  }catch(error){say(`${stage}: ${message(error)}${pending?' Проверьте подтверждение перед новой попыткой.':''}`,true)}finally{busy=false;buttons()}
}).catch(error=>say(message(error),true)));
verifyButton.addEventListener('click',()=>void withOperationLock(pendingKey,async()=>{if(busy)return;try{restorePending();if(recoveryBlocked)return;busy=true;buttons();await verify()}catch(error){say(message(error),true)}finally{busy=false;buttons()}}).catch(error=>say(message(error),true)));
window.addEventListener('storage',event=>{if(event.key===null||event.key===pendingKey||event.key.startsWith(pendingKey+'.'))restorePending()});
restorePending();
