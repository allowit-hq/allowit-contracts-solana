import {test,expect} from '@playwright/test';

// Public fixture addresses; RPC is intercepted in tests that need it.
const address='11111111111111111111111111111111';
const key=`allowit.testnet-topup.${address}.${address}`;
test('failed Phantom reconnect reports its stage and code and clears the previous account',async({page})=>{
  await page.addInitScript(address=>{
    let connected=false;
    const account={address,publicKey:new Uint8Array(32),chains:['solana:testnet'],features:[]};
    const wallet={version:'1.0.0',name:'Phantom',icon:'data:image/svg+xml;base64,',chains:['solana:testnet'],
      get accounts(){return connected?[account]:[]},
      features:{'standard:connect':{version:'1.0.0',connect:async()=>{
        if(connected)throw {message:'Unexpected error',code:-32603};
        connected=true;return {accounts:[account]};
      }}},
    };
    window.addEventListener('wallet-standard:app-ready',event=>(event as CustomEvent).detail.register(wallet));
  },address);
  await page.goto(`/topup.html?mint=${address}&authority=${address}&recipient=${address}`);
  await page.getByRole('button',{name:'Подключить Phantom'}).click();
  await expect(page.locator('#prepare')).toBeEnabled();
  await page.getByRole('button',{name:'Подключить Phantom'}).click();
  await expect(page.getByRole('status')).toHaveText('Подключение Phantom: Unexpected error (код -32603)');
  await expect(page.locator('#prepare')).toBeDisabled();
  await expect(page.locator('#submit')).toBeHidden();
});

for(const outcome of ['settled','failed','expired','confirmed','rpc-error','stale-index','history-found'] as const){
  test(`saved topup: ${outcome}`,async({page})=>{
    const calls:string[]=[];
    await page.addInitScript(({key,address})=>localStorage.setItem(key,JSON.stringify({signature:'1'.repeat(88),lastValidBlockHeight:100,recipients:[{owner:address,account:address,before:'0'}]})),{key,address});
    await page.route('https://api.testnet.solana.com',async route=>{
      const {method}=route.request().postDataJSON();calls.push(method);
      if(outcome==='rpc-error')return route.fulfill({json:{jsonrpc:'2.0',id:1,error:{message:'RPC unavailable'}}});
      let result:unknown;
      switch(method){
        case 'getBlockHeight':result=101;break;
        case 'getSlot':result=200;break;
        case 'getSignatureStatuses':result={context:{slot:outcome==='stale-index'?199:200},value:[['expired','history-found'].includes(outcome)?null:{confirmationStatus:outcome==='confirmed'?'confirmed':'finalized',err:outcome==='failed'?{InstructionError:[0,'error']}:null}]};break;
        case 'getTransaction':result=outcome==='history-found'?{slot:190}:null;break;
        // Fail the optional post-settlement balance check. Finality still clears pending.
        case 'getGenesisHash':return route.fulfill({json:{jsonrpc:'2.0',id:1,error:{message:'Balance read unavailable'}}});
        default:throw new Error(`Unexpected RPC method: ${method}`);
      }
      await route.fulfill({json:{jsonrpc:'2.0',id:1,result}});
    });
    await page.goto(`/topup.html?mint=${address}&authority=${address}&recipient=${address}`);
    const verify=page.getByRole('button',{name:'Проверить подтверждение',exact:true});
    await verify.click();
    await expect(page.getByRole('status')).not.toContainText('Сохранена операция');
    const cleared=['settled','failed','expired'].includes(outcome);
    expect(await page.evaluate(key=>localStorage.getItem(key),key)).toEqual(cleared?null:expect.any(String));
    if(cleared)await expect(verify).toBeHidden();else await expect(verify).toBeEnabled();
    expect(calls).not.toContain('sendTransaction');
  });
}

test('missing public configuration cannot expose a signing action',async({page})=>{
  await page.goto('/topup.html');
  await expect(page.locator('main')).toContainText('Настройте Testnet-инструмент');
  await expect(page.getByRole('button')).toHaveCount(0);
});
