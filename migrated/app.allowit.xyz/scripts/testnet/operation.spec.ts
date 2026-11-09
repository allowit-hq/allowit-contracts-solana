import {test,expect} from '@playwright/test';

const address='11111111111111111111111111111111';
const other='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const key=`allowit.testnet-topup.${address}`;
const receipt={signature:'1'.repeat(88),lastValidBlockHeight:100,recipients:[{owner:address,account:address,before:'0'}]};

test('settled mint receipt survives changed supply and reload with copy available',async({page})=>{
  const key=`allowit.testnet-mint.${address}`;
  const calls:string[]=[];
  await page.addInitScript(({key,address})=>{
    if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({mint:address,ata:address,signature:'1'.repeat(88),lastValidBlockHeight:100}));
  },{key,address});
  await page.route('https://api.testnet.solana.com',async route=>{
    const {method}=route.request().postDataJSON();calls.push(method);
    const results:Record<string,unknown>={
      getBlockHeight:101,getSlot:200,
      getSignatureStatuses:{context:{slot:200},value:[{confirmationStatus:'finalized',err:null}]},
      getAccountInfo:{value:{owner:other,data:{parsed:{type:'mint',info:{decimals:6,mintAuthority:address,freezeAuthority:null,supply:'999000000000'}}}}},
    };
    if(!(method in results))throw new Error(`Unexpected RPC method: ${method}`);
    await route.fulfill({json:{result:results[method]}});
  });
  await page.goto(`/token-setup.html?owner=${address}`);await page.locator('#verify').click();
  await expect(page.locator('#copy')).toBeVisible();
  expect(JSON.parse((await page.evaluate(key=>localStorage.getItem(key),key))!).settled).toBe(true);
  calls.length=0;await page.reload();
  await expect(page.locator('#copy')).toBeVisible();await expect(page.locator('#verify')).toBeHidden();
  await expect(page.getByRole('status')).toContainText('При создании выпущено 100');
  expect(calls).toEqual([]);
});

test('settled topup checks receipt recipients instead of current URL recipients',async({page})=>{
  const inspected:string[]=[];
  await page.addInitScript(({key,receipt})=>localStorage.setItem(key,JSON.stringify(receipt)),{key,receipt});
  await page.route('https://api.testnet.solana.com',async route=>{
    const {method,params}=route.request().postDataJSON();
    const results:Record<string,unknown>={
      getBlockHeight:101,getSlot:200,
      getSignatureStatuses:{context:{slot:200},value:[{confirmationStatus:'finalized',err:null}]},
      getGenesisHash:'4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
      getAccountInfo:{value:{owner:other,data:{parsed:{type:'mint',info:{decimals:6,mintAuthority:address}}}}},
      getTokenAccountsByOwner:{value:[{pubkey:address,account:{owner:other,data:{parsed:{type:'account',info:{owner:address,mint:address,state:'initialized',tokenAmount:{amount:'1000000000'}}}}}}]},
    };
    if(method==='getTokenAccountsByOwner')inspected.push(params[0]);
    if(!(method in results))throw new Error(`Unexpected RPC method: ${method}`);
    await route.fulfill({json:{result:results[method]}});
  });
  await page.goto(`/topup.html?mint=${address}&authority=${address}&recipient=${other}`);await page.locator('#verify').click();
  await expect(page.getByRole('status')).toContainText('Готово:');
  expect(inspected).toEqual([address]);
  expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBeNull();
});

test('pending propagates to already-open tabs and cannot be bypassed by recipient changes',async({page,context})=>{
  await context.route('https://api.testnet.solana.com',route=>route.abort());
  await page.goto(`/topup.html?mint=${address}&authority=${address}&recipient=${address}`);
  const second=await context.newPage();
  await second.goto(`/topup.html?mint=${address}&authority=${address}&recipient=${other}`);
  await expect(second.locator('#verify')).toBeHidden();
  await page.evaluate(({key,receipt})=>localStorage.setItem(key,JSON.stringify(receipt)),{key,receipt});
  await expect(second.locator('#verify')).toBeVisible();
  await expect(second.getByRole('status')).toContainText('Сохранена операция');
  // Older recipient-scoped records remain a guard even for a different recipient.
  await page.evaluate(({key,receipt})=>{localStorage.removeItem(key);localStorage.setItem(key+'.legacy-recipient',JSON.stringify(receipt))},{key,receipt});
  await second.reload();
  await expect(second.locator('#verify')).toBeVisible();
  await page.evaluate(({key,receipt})=>localStorage.setItem(key,JSON.stringify(receipt)),{key,receipt});
  await expect(second.getByRole('status')).toContainText('несколько сохранённых операций');
  await expect(second.locator('#submit')).toBeDisabled();
});

test('repeated same-tab actions share the in-flight operation and can retry after failure',async({page})=>{
  await page.goto('/topup.html');
  const result=await page.evaluate(async modulePath=>{
    const {withOperationLock}=await import(modulePath);
    let calls=0;
    let release!:()=>void;
    const waiting=new Promise<void>(resolve=>{release=resolve});
    const first=withOperationLock('repeat-test',async()=>{calls++;await waiting;throw new Error('Wallet declined')});
    const repeated=withOperationLock('repeat-test',async()=>{calls++});
    release();
    const outcomes=await Promise.allSettled([first,repeated]);
    const callsBeforeRetry=calls;
    await withOperationLock('repeat-test',async()=>{calls++});
    return {callsBeforeRetry,calls,outcomes:outcomes.map(item=>item.status==='rejected'?item.reason.message:item.status)};
  },'/operation.ts');
  expect(result).toEqual({callsBeforeRetry:1,calls:2,outcomes:['Wallet declined','Wallet declined']});
});

test('exclusive operation lock prevents another tab from entering signing or reconciliation',async({page,context})=>{
  await page.goto('/topup.html');
  const second=await context.newPage();await second.goto('/topup.html');
  await page.evaluate(async modulePath=>{
    const {withOperationLock}=await import(modulePath);
    const state=window as unknown as {releaseOperation:()=>void;lockReady:boolean};
    void withOperationLock('test-mint',async()=>{state.lockReady=true;await new Promise<void>(resolve=>{state.releaseOperation=resolve})});
  },'/operation.ts');
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {lockReady:boolean}).lockReady)).toBe(true);
  const blocked=await second.evaluate(async modulePath=>{
    const {withOperationLock}=await import(modulePath);
    try{await withOperationLock('test-mint',async()=>{});return false}catch{return true}
  },'/operation.ts');
  expect(blocked).toBe(true);
  await page.evaluate(()=>(window as unknown as {releaseOperation:()=>void}).releaseOperation());
  await expect.poll(()=>second.evaluate(async modulePath=>{
    const {withOperationLock}=await import(modulePath);
    try{await withOperationLock('test-mint',async()=>{});return true}catch{return false}
  },'/operation.ts')).toBe(true);
});

for(const outcome of ['failed','expired','confirmed','rpc-error','stale-index','history-found'] as const){
  test(`mint receipt: ${outcome}`,async({page})=>{
    const key=`allowit.testnet-mint.${address}`;
    const calls:string[]=[];
    await page.addInitScript(({key,address})=>localStorage.setItem(key,JSON.stringify({mint:address,ata:address,signature:'1'.repeat(88),lastValidBlockHeight:100})),{key,address});
    await page.route('https://api.testnet.solana.com',async route=>{
      const {method}=route.request().postDataJSON();calls.push(method);
      if(outcome==='rpc-error')return route.fulfill({json:{error:{message:'unavailable'}}});
      let result:unknown;
      switch(method){
        case 'getBlockHeight':result=101;break;
        case 'getSlot':result=200;break;
        case 'getSignatureStatuses':result={context:{slot:outcome==='stale-index'?199:200},value:[['expired','history-found'].includes(outcome)?null:{confirmationStatus:outcome==='confirmed'?'confirmed':'finalized',err:outcome==='failed'?{InstructionError:[0,'error']}:null}]};break;
        case 'getTransaction':result=outcome==='history-found'?{slot:190}:null;break;
        case 'getAccountInfo':result={value:null};break;
        default:throw new Error(`Unexpected RPC method: ${method}`);
      }
      await route.fulfill({json:{result}});
    });
    await page.goto(`/token-setup.html?owner=${address}`);
    await page.locator('#verify').click();
    await expect(page.getByRole('status')).not.toContainText('Сохранена предыдущая попытка');
    expect(await page.evaluate(key=>localStorage.getItem(key),key)).toEqual(['failed','expired'].includes(outcome)?null:expect.any(String));
    expect(calls).not.toContain('sendTransaction');
  });
}
