import {generateKeyPairSync,sign} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const selectedExample=process.argv.find(a=>a.startsWith('--example='))?.slice('--example='.length);
if(selectedExample&&!['operating','green'].includes(selectedExample))throw Error('Choose --example=operating or green.');
const examplesOnly=process.argv.includes('--examples-only')||!!selectedExample;
const origin=process.argv[2];if(!origin?.startsWith('https://'))throw new Error('Pass the explicit HTTPS preview URL.');const network=process.argv[3]??'solana:devnet';let cookie='';
async function call(path,body,expected=200){const r=await fetch(origin+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});for(const c of r.headers.getSetCookie())cookie=c.split(';')[0];const data=await r.json();if(r.status!==expected)throw new Error(`${path}: expected ${expected}, got ${r.status}: ${data.error??'unexpected response'}`);return data;}
function checkConsumerCopy(p){if(/\b(?:Gemini|mock|preview|sample|demo|engine)\b/i.test(p.title+' '+p.explanation))throw new Error('Policy copy includes implementation labels.');}
const policyModule=await WebAssembly.compile(await readFile(new URL('../runtime/policywasm/allowit_sdk.wasm',import.meta.url)));
async function policyRequest(request){
 const {exports:e}=await WebAssembly.instantiate(policyModule);
 const input=new TextEncoder().encode(JSON.stringify(request));
 const pointer=e.alloc(input.length);new Uint8Array(e.memory.buffer,pointer,input.length).set(input);
 const packed=e.process(pointer,input.length),start=Number(packed>>32n),length=Number(packed&0xffffffffn);
 const output=JSON.parse(new TextDecoder().decode(new Uint8Array(e.memory.buffer,start,length)));e.dealloc(pointer,input.length);e.dealloc(start,length);
 if(!output.ok)throw Error(output.error?.message??'Policy compilation or evaluation failed');
 return output;
}
async function checkCompiledPolicy(p){
 const {policy}=await policyRequest({operation:'compile',source:p.code});
 if(policy.source_hash!==p.sourceHash||policy.ir_hash!==p.irHash||policy.language!==p.language||policy.limit!==p.limit||!policy.workflow?.length)throw Error('Generated source does not match its compiler hashes, cap and workflow.');
}
const health=await call('health');await call('micro/policies',undefined,401);
const {publicKey,privateKey}=generateKeyPairSync('ed25519');const pk=publicKey.export({type:'spki',format:'der'}).subarray(-32);const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+pk.toString('hex')),address='';while(n){address=alphabet[Number(n%58n)]+address;n/=58n;}for(const b of pk){if(b)break;address='1'+address;}
const c=await call('auth/challenge',{address});await call('auth/verify',{id:c.id,message:c.message,address,signature:sign(null,Buffer.from(c.message),privateKey).toString('base64')});
let p;
if(!examplesOnly){
const created=await call('micro/generate',{network,prompt:'Let my research agent spend 100 USDC total, no more than 10 USDC per purchase. Only allow research actions.'});p=created.policies.find(p=>p.id===created.selectedId);if(p.network!==network||p.limit!=='100'||p.language!=='allowit-rust-v1'||!p.workflow?.length||!p.sourceHash)throw new Error('Generated policy did not retain the cap, Rust source and workflow.');
await checkCompiledPolicy(p);
checkConsumerCopy(p);
const revised=await call('micro/revise',{id:p.id,revision:p.revision,prompt:'Reduce the total cap to 50 USDC and preserve the per-purchase cap.'});p=revised.policies.find(q=>q.id===p.id);if(p.network!==network||p.limit!=='50'||p.revision!==2)throw new Error('Revision lost the cap.');
await checkCompiledPolicy(p);
checkConsumerCopy(p);
await call('micro/allocation/prepare',{id:p.id,revision:p.revision,amount:'51',token:'USDC'},400);await call('micro/handoff',{id:p.id,revision:p.revision},400);await call('micro/allocation/cancel',{id:p.id,revision:p.revision});
}
const examples=[];
if(process.argv.includes('--examples')||examplesOnly){
 async function evaluate(source,prompt,runtime,confidence={}){
  const output=await policyRequest({operation:'evaluate',source,profile:'oracle',context:{original_intent:prompt,runtime_context:runtime,amount_units:1000000,allocation_units:500000000,spent_units:0,action:'invest',merchant:'fund.example',recipient:'11111111111111111111111111111111',token:'USDC',network,now:Math.floor(Date.now()/1000),answers:{},confidence}});return output.decision;
 }
 const cases=[
  {key:'operating',name:'Operating evidence',prompt:'Let my investment agent spend 300 USDC total, at most 75 USDC per purchase. Only allow invest actions. Avoid hype: require the proposed investment case to be supported by operating results, not social momentum. Decline weak cases and ask me if the evidence is mixed.',semantic:true},
  {key:'green',name:'Green investments',prompt:'Let my investment agent spend 500 USDC total, at most 100 USDC per purchase. Only allow invest actions. Prefer investments with independently supported environmental benefits, but never sacrifice more than 1 percentage point in estimated annual return. Runtime JSON provides candidate_yield_bps and benchmark_yield_bps. Decline if that return gap is exceeded; ask me only when the environmental evidence is unclear.',semantic:true,green:true}
 ];
 for(const spec of cases.filter(x=>!selectedExample||x.key===selectedExample)){
  const result=await call('micro/generate',{network,prompt:spec.prompt});const policy=result.policies.find(x=>x.id===result.selectedId);checkConsumerCopy(policy);
  if(policy.language!=='allowit-rust-v1'||!policy.workflow?.length||policy.network!==network)throw Error(spec.name+': missing Rust workflow or saved network');
  await checkCompiledPolicy(policy);
  if(spec.semantic&&!policy.calls.some(x=>['semantic','check_preference'].includes(x.name.split('::').at(-1))))throw Error(spec.name+': preference check is missing');
  if(spec.green){
   const beyond=await evaluate(policy.code,spec.prompt,{candidate_yield_bps:700,benchmark_yield_bps:850});
   if(beyond.outcome!=='fail'||beyond.code==='SEMANTIC_EVIDENCE_REQUIRED')throw Error('The return limit must reject before a preference assessment');
   const within=await evaluate(policy.code,spec.prompt,{candidate_yield_bps:800,benchmark_yield_bps:850});
   if(within.code!=='SEMANTIC_EVIDENCE_REQUIRED')throw Error('An affordable green investment must request preference evidence');
  }
  await call('micro/allocation/cancel',{id:policy.id,revision:policy.revision});examples.push(spec.name);console.log('Hosted Rust example checked: '+spec.name);
 }
}
await call('auth/logout',{});
console.log(JSON.stringify({origin,network,revision:health.revision,policyRuntime:health.policyRuntimeHash,examples,authentication:'real Ed25519',language:p?.language??health.policyLanguage,workflow:'present',revisionTurns:examplesOnly?0:2,consumerCopy:'passed',capBinding:examplesOnly?'not run':'passed',prematureHandoff:examplesOnly?'not run':'rejected',draftCancellation:'passed',onChain:'not tested; ephemeral account is unfunded'},null,2));
