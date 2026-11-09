import {getWallets} from '@wallet-standard/app';
import type {Wallet,WalletAccount} from '@wallet-standard/base';
import {
  address,blockhash,compileTransaction,createTransactionMessage,generateKeyPairSigner,
  getCompiledTransactionMessageEncoder,getTransactionEncoder,partiallySignTransaction,
  pipe,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,compileTransactionMessage,
} from '@solana/kit';
import {getCreateAccountInstruction} from '@solana-program/system';
import {
  findAssociatedTokenPda,getCreateAssociatedTokenInstruction,getInitializeMintInstruction,
  getMintSize,getMintToInstruction,TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {signTestnetTransaction,type PhantomSigningProvider} from '../../src/wallet/testnet-wallet-signing';
import {configuredAddresses} from './config';
import {receiptState} from './pending';
import {readOperation,withOperationLock} from './operation';

const RPC='https://api.testnet.solana.com';
const GENESIS='4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';
const OWNER=configuredAddresses('owner')[0];
const MINT_AMOUNT=100_000_000n; // 100 test units at six decimal places.
const root=document.querySelector<HTMLElement>('#setup-root')!;
root.innerHTML=`<style>
  :root{font-family:Manrope,system-ui,sans-serif;color:#111110;background:#fafaf7}
  *{box-sizing:border-box}body{margin:0}main{max-width:720px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:clamp(30px,5vw,48px);line-height:1.08;margin:16px 0 24px}p{line-height:1.55}
  .muted{color:#64645f}.facts{border-top:1px solid #aaa;padding-top:16px;margin-top:26px}
  dt{color:#64645f;font-size:14px;margin-top:14px}dd{margin:3px 0 0;overflow-wrap:anywhere}
  button{font:inherit;padding:11px 16px;margin:12px 8px 0 0;border:1px solid #111110;background:#111110;color:white;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}a{color:#ba2d22}code{font-family:ui-monospace,monospace}
  #status{padding:12px 0;min-height:2em}#status.error{color:#ba2d22}
</style>
<a href="/">← Allowit</a>
<h1>Токен для Testnet</h1>
<p>Создать отдельный SPL mint с шестью знаками после запятой и выпустить 100 тестовых единиц на ваш кошелёк. Это не Circle USDC и не имеет стоимости в Mainnet.</p>
<p class="muted">Сеть: Solana Testnet. Плательщик и право дополнительного выпуска: <code>${OWNER}</code>. Право заморозки не создаётся. Новый ключ mint живёт только в памяти этой страницы и будет удалён при закрытии вкладки.</p>
<div id="wallets"></div>
<button id="prepare" disabled>Подготовить транзакцию</button>
<div id="summary"></div>
<button id="submit" hidden>Подтвердить создание в кошельке</button>
<button id="verify" hidden>Проверить подтверждение</button>
<button id="copy" hidden>Скопировать адрес mint</button>
<p id="status" role="status" aria-live="polite"></p>`;
const walletsEl=document.querySelector<HTMLElement>('#wallets')!;
const prepareButton=document.querySelector<HTMLButtonElement>('#prepare')!;
const submitButton=document.querySelector<HTMLButtonElement>('#submit')!;
const verifyButton=document.querySelector<HTMLButtonElement>('#verify')!;
const copyButton=document.querySelector<HTMLButtonElement>('#copy')!;
const summary=document.querySelector<HTMLElement>('#summary')!;
const status=document.querySelector<HTMLElement>('#status')!;
let wallet:Wallet|undefined;
let account:WalletAccount|undefined;
type Prepared={mint:string;ata:string;rent:number;fee:number;build:()=>Promise<{transaction:Uint8Array;lastValidBlockHeight:number;fee:number}>};
type Pending={mint:string;ata:string;signature:string;lastValidBlockHeight:number;settled?:true};
let prepared:Prepared|undefined;
let pending:Pending|undefined;
let busy=false;
let recoveryBlocked=false;
const pendingKey=`allowit.testnet-mint.${OWNER}`;
const base64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));

function say(message:string,error=false){status.textContent=message;status.classList.toggle('error',error)}
async function rpc<T>(method:string,params:unknown[]):Promise<T>{
  const response=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok||data.error)throw new Error(`${method}: ${data.error?.message??response.status}${data.error?.data?.err?` (${JSON.stringify(data.error.data.err)})`:''}`);
  return data.result as T;
}
function formatError(error:unknown){
  if(error&&typeof error==='object'&&'message' in error)return `${String(error.message)}${'code' in error?` (код ${error.code})`:''}`;
  return 'Операция не удалась.';
}
function reset(){prepared=undefined;submitButton.hidden=true;copyButton.hidden=true;summary.replaceChildren()}
function showSettled(receipt:Pending){
  prepared=undefined;submitButton.hidden=true;verifyButton.hidden=true;copyButton.hidden=false;
  say(`Создание Testnet mint ${receipt.mint} подтверждено. При создании выпущено 100 тестовых токенов. Подпись ${receipt.signature}.`);
}
function restorePending(){
  try{
    const saved=readOperation<Pending>(pendingKey,(value):value is Pending=>{
      const s=value as Pending|null;
      return !!s&&!!address(s.mint)&&!!address(s.ata)&&typeof s.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s.signature)&&Number.isSafeInteger(s.lastValidBlockHeight)&&s.lastValidBlockHeight>0&&(s.settled===undefined||s.settled===true);
    });
    if(pending&&!saved)reset();
    pending=saved?.value;recoveryBlocked=false;verifyButton.hidden=!pending;
    if(pending?.settled)showSettled(pending);
    else if(pending)say(`Сохранена предыдущая попытка. Mint: ${pending.mint}. Нажмите «Проверить подтверждение».`);
  }catch(error){recoveryBlocked=true;say(formatError(error),true)}
  updateButtons();
}
function requireNoPending(){restorePending();if(pending||recoveryBlocked)throw new Error('Сохранённая операция требует проверки перед новой отправкой.')}
function clearPending(){localStorage.removeItem(pendingKey);pending=undefined;verifyButton.hidden=true;reset()}
function updateButtons(){
  prepareButton.disabled=busy||!!pending||!account||recoveryBlocked;
  submitButton.disabled=busy||!!pending||recoveryBlocked;
  verifyButton.disabled=busy;
  walletsEl.querySelectorAll('button').forEach(button=>button.disabled=busy||!!pending||recoveryBlocked);
}
async function simulate(transaction:Uint8Array,sigVerify=false){
  const result=await rpc<{value:{err:unknown}}>('simulateTransaction',[base64(transaction),{encoding:'base64',sigVerify,commitment:'confirmed'}]);
  if(result.value.err)throw new Error(`Solana отклонила симуляцию: ${JSON.stringify(result.value.err)}`);
}

async function connect(selected:Wallet){
  if(busy||pending||recoveryBlocked)return;
  try{
    busy=true;updateButtons();reset();wallet=undefined;account=undefined;say('Подключаю кошелёк…');
    const feature=selected.features['standard:connect'] as {connect:()=>Promise<{accounts:readonly WalletAccount[]}>}|undefined;
    if(!feature)throw new Error('Кошелёк не поддерживает подключение.');
    const connected=await feature.connect();
    const selectedAccount=connected.accounts.find(item=>item.address===OWNER);
    if(!selectedAccount)throw new Error(`Выберите кошелёк ${OWNER}, на котором есть Testnet SOL.`);
    if(!selectedAccount.chains.includes('solana:testnet'))throw new Error('Включите Solana Testnet в кошельке.');
    wallet=selected;account=selectedAccount;prepareButton.disabled=false;
    say(`Подключён ${selected.name}: ${OWNER}`);
  }catch(error){say(formatError(error),true)}finally{busy=false;updateButtons()}
}

function listWallets(){
  walletsEl.replaceChildren();
  const available=getWallets().get().filter(item=>item.features['standard:connect']&&(item.features['solana:signTransaction']||item.name==='Phantom'));
  if(!available.length){walletsEl.textContent='Кошелёк в этом браузере не найден. Откройте эту страницу в браузере с Phantom или Solflare.';return}
  for(const candidate of available){
    const button=document.createElement('button');button.textContent=`Подключить ${candidate.name}`;
    button.addEventListener('click',()=>void connect(candidate));walletsEl.append(button);
  }
  updateButtons();
}
listWallets();
getWallets().on('register',listWallets);

prepareButton.addEventListener('click',()=>void (async()=>{
  if(!account||busy||pending||recoveryBlocked)return;
  try{
    busy=true;updateButtons();reset();say('Проверяю сеть и моделирую транзакцию…');
    const owner=address(account.address);
    // Instruction builders mark the wallet as a required signer. The wallet signs
    // the serialized transaction itself after the owner confirms it below.
    const ownerSigner={address:owner,signTransactions:async()=>{throw new Error('Use the wallet approval flow.')}};
    const genesis=await rpc<string>('getGenesisHash',[]);
    if(genesis!==GENESIS)throw new Error('RPC отвечает из другой сети.');
    const mint=await generateKeyPairSigner(); // Memory only; never exported or written to disk.
    const ata=(await findAssociatedTokenPda({owner,mint:mint.address,tokenProgram:TOKEN_PROGRAM_ADDRESS}))[0];
    const mintRent=await rpc<number>('getMinimumBalanceForRentExemption',[getMintSize()]);
    const ataRent=await rpc<number>('getMinimumBalanceForRentExemption',[165]);
    const build=async()=>{
      const latest=await rpc<{value:{blockhash:string;lastValidBlockHeight:number}}>('getLatestBlockhash',[{commitment:'confirmed'}]);
      const message=pipe(createTransactionMessage({version:'legacy'}),
      item=>setTransactionMessageFeePayer(owner,item),
      item=>setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(latest.value.blockhash),lastValidBlockHeight:BigInt(latest.value.lastValidBlockHeight)},item),
      item=>appendTransactionMessageInstructions([
        getCreateAccountInstruction({payer:ownerSigner,newAccount:mint,lamports:mintRent,space:getMintSize(),programAddress:TOKEN_PROGRAM_ADDRESS}),
        getInitializeMintInstruction({mint:mint.address,decimals:6,mintAuthority:owner,freezeAuthority:null}),
        getCreateAssociatedTokenInstruction({payer:ownerSigner,ata,owner,mint:mint.address,tokenProgram:TOKEN_PROGRAM_ADDRESS}),
        getMintToInstruction({mint:mint.address,token:ata,mintAuthority:owner,amount:MINT_AMOUNT}),
      ],item));
      const fee=await rpc<{value:number|null}>('getFeeForMessage',[btoa(String.fromCharCode(...getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message)))),{commitment:'confirmed'}]);
      if(fee.value===null)throw new Error('Не удалось рассчитать комиссию. Подготовьте транзакцию заново.');
      const partial=await partiallySignTransaction([mint.keyPair],compileTransaction(message));
      return {transaction:new Uint8Array(getTransactionEncoder().encode(partial)),lastValidBlockHeight:latest.value.lastValidBlockHeight,fee:fee.value};
    };
    const built=await build();
    await simulate(built.transaction);
    const balance=await rpc<{value:number}>('getBalance',[OWNER,{commitment:'confirmed'}]);
    const total=mintRent+ataRent+built.fee;
    if(balance.value<total)throw new Error(`Недостаточно Testnet SOL: нужно ${(total/1e9).toFixed(9)} SOL.`);
    prepared={mint:mint.address,ata,rent:mintRent+ataRent,fee:built.fee,build};
    const facts=document.createElement('dl');facts.className='facts';
    for(const [label,value] of [
      ['Сеть','Solana Testnet'],['Кошелёк и плательщик',OWNER],['Новый mint',mint.address],
      ['Получатель',OWNER],['Выпуск','100 тестовых токенов, 6 decimals'],
      ['Арендный депозит',`${((mintRent+ataRent)/1e9).toFixed(9)} Testnet SOL`],
      ['Комиссия',`${(built.fee/1e9).toFixed(9)} Testnet SOL`],
      ['Симуляция','Пройдена'],
    ]){const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=value;facts.append(dt,dd)}
    summary.replaceChildren(facts);submitButton.hidden=false;say('Проверьте параметры и подтвердите транзакцию в кошельке.');
  }catch(error){say(formatError(error),true)}finally{busy=false;updateButtons()}
})());

async function verify(){
  if(!pending)return;
  const current=pending;
  if(current.settled){showSettled(current);return}
  try{
    const {state,status:result}=await receiptState(rpc,current.signature,current.lastValidBlockHeight);
    if(state==='pending'){say(`Подтверждение пока не найдено. Новая попытка заблокирована до проверки. Подпись: ${current.signature}`);return}
    if(state==='expired'){
      const mint=await rpc<{value:unknown}>('getAccountInfo',[current.mint,{commitment:'finalized'}]);
      if(mint.value!==null)throw new Error('Mint найден либо RPC не подтвердил его отсутствие. Повторите проверку позже.');
      clearPending();say('Срок транзакции истёк, mint не создан. Можно подготовить новую попытку.');return;
    }
    if(state==='failed'){clearPending();throw new Error(`Транзакция окончательно отклонена: ${JSON.stringify(result?.err)}`)}
    const mintInfo=await rpc<{value:{owner:string;data:{parsed:{type:string;info:{decimals:number;mintAuthority:string;freezeAuthority:string|null;supply:string}}}}|null}>('getAccountInfo',[current.mint,{encoding:'jsonParsed',commitment:'finalized'}]);
    const info=mintInfo.value?.data.parsed.info;
    if(mintInfo.value?.owner!==TOKEN_PROGRAM_ADDRESS||mintInfo.value.data.parsed.type!=='mint'||info?.decimals!==6||info.mintAuthority!==OWNER||info.freezeAuthority!==null)throw new Error('Транзакция завершена, но параметры mint не совпали с ожидаемыми.');
    // Supply and recipient balances may legitimately change after creation.
    const settled:Pending={...current,settled:true};
    localStorage.setItem(pendingKey,JSON.stringify(settled));pending=settled;showSettled(settled);
  }catch(error){say(formatError(error),true)}
}
submitButton.addEventListener('click',()=>void withOperationLock(pendingKey,async()=>{
  if(!prepared||!wallet||!account||busy||pending||recoveryBlocked)return;
  let stage='Подготовка';
  try{
    requireNoPending();busy=true;updateButtons();say('Обновляю срок транзакции и проверяю симуляцию…');
    if(await rpc<string>('getGenesisHash',[])!==GENESIS)throw new Error('RPC отвечает из другой сети.');
    const existing=await rpc<{value:unknown}>('getAccountInfo',[prepared.mint,{commitment:'confirmed'}]);
    if(existing.value)throw new Error('Этот mint уже существует. Повторный выпуск остановлен.');
    const fresh=await prepared.build();
    if(fresh.fee>prepared.fee)throw new Error('Комиссия увеличилась. Подготовьте транзакцию заново, чтобы увидеть новую сумму.');
    await simulate(fresh.transaction);
    stage='Подпись в кошельке';say('Симуляция пройдена. Ожидаю подпись в кошельке…');
    const phantom=(window as unknown as {phantom?:{solana?:PhantomSigningProvider}}).phantom?.solana;
    requireNoPending();
    const signed=await signTestnetTransaction(wallet,account,fresh.transaction,phantom);
    stage='Проверка подписанной транзакции';say('Подпись получена. Проверяю её в Testnet…');
    await simulate(signed.transaction,true);
    stage='Сохранение статуса';
    requireNoPending();
    pending={mint:prepared.mint,ata:prepared.ata,signature:signed.signature,lastValidBlockHeight:fresh.lastValidBlockHeight};
    // Public receipt only. Persist before sending so a timeout/reload cannot
    // silently turn an unknown outcome into a second token creation.
    try{localStorage.setItem(pendingKey,JSON.stringify(pending))}catch{pending=undefined;throw new Error('Не удалось сохранить статус. Транзакция не отправлена.')}
    verifyButton.hidden=false;submitButton.hidden=true;
    stage='Отправка в Testnet';say('Отправляю подписанную транзакцию в Testnet…');
    const sent=await rpc<string>('sendTransaction',[base64(signed.transaction),{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:3}]);
    if(sent!==signed.signature)throw new Error('RPC вернул другую подпись. Проверьте подтверждение сохранённой транзакции.');
    say(`Отправлено. Подпись ${signed.signature}. Проверяю подтверждение…`);
    await verify();
  }catch(error){say(`${stage}: ${formatError(error)}${pending?' Нажмите «Проверить подтверждение» перед новой попыткой.':''}`,true);verifyButton.hidden=!pending}
  finally{busy=false;updateButtons()}
}).catch(error=>say(formatError(error),true)));
verifyButton.addEventListener('click',()=>void withOperationLock(pendingKey,async()=>{if(busy)return;restorePending();if(recoveryBlocked)return;busy=true;updateButtons();try{await verify()}finally{busy=false;updateButtons()}}).catch(error=>say(formatError(error),true)));
copyButton.addEventListener('click',()=>void (async()=>{
  if(!pending)return;
  try{await navigator.clipboard.writeText(pending.mint);say('Адрес mint скопирован. Используйте его в настройках Testnet-токена Allowit.')}catch(error){say(formatError(error),true)}
})());
window.addEventListener('storage',event=>{if(event.key===null||event.key===pendingKey)restorePending()});
restorePending();
