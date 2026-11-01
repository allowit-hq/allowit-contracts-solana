// Test fixture authoring only. The Rust library never imports or launches JS.
// Run from this repository after npm ci --prefix native.
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {Keypair,PublicKey,Transaction}=createRequire(new URL('../../../native/index.mjs',import.meta.url))('@solana/web3.js');
import {NativePolicySDK,RELEASE,digest,LOADER} from '../../../native/index.mjs';
import {intentFor,validateRecord} from '../../../native/lifecycle.mjs';
import {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction} from '../../../native/token.mjs';
const owner=Keypair.fromSeed(new Uint8Array(32).fill(7)),executor=Keypair.fromSeed(new Uint8Array(32).fill(8));
const key=n=>new PublicKey(new Uint8Array(32).fill(n));
const deployment={network:'solana:testnet',sourceBundle:RELEASE.sourceBundle,policy:key(2).toBase58(),policyData:PublicKey.findProgramAddressSync([key(2).toBuffer()],LOADER)[0].toBase58(),custody:key(4).toBase58()};
const sdk=new NativePolicySDK({deployment,mint:key(3).toBase58(),executor:executor.publicKey.toBase58()});
const policy=await sdk.generate('Spend up to 5 test tokens per day');policy.instance='00000000-0000-4000-8000-000000000000';
policy.id=await digest(new TextEncoder().encode(JSON.stringify({instance:policy.instance,profile:policy.profile,network:policy.network,prompt:policy.prompt,dailyLimit:policy.dailyLimit,payDiscovery:policy.payDiscovery,sourceBundle:policy.sourceBundle})));
const b=sdk.publicBinding(policy,owner.publicKey.toBase58()),records=[];
for(const method of ['deploy','fund','execute','revoke','tune','withdraw']){
 const options=['fund','execute','tune','withdraw'].includes(method)?{amount:'1'}:{};if(method==='execute')options.recipient=owner.publicKey.toBase58();
 const ownerATA=getAssociatedTokenAddressSync(key(3),owner.publicKey);let instructions;
 switch(method){
 case 'deploy':instructions=[createAssociatedTokenAccountIdempotentInstruction(owner.publicKey,new PublicKey(b.tokenAccount),new PublicKey(b.vault),key(3)),sdk.instruction(b,'initialize',{vaultId:policy.id,dailyLimit:5000000n}),sdk.instruction(b,'approve',{approved:true,revision:0n})];break;
 case 'fund':instructions=[sdk.instruction(b,'deposit',{amount:1000000n,source:ownerATA.toBase58()})];break;
 case 'execute':instructions=[sdk.instruction(b,'transfer',{amount:1000000n,destination:options.recipient,nonce:'0',revision:'1'})];break;
 case 'revoke':instructions=[sdk.instruction(b,'approve',{approved:false,revision:'1'})];break;
 case 'tune':instructions=[sdk.instruction(b,'tune',{amount:1000000n,revision:'1'})];break;
 case 'withdraw':instructions=[createAssociatedTokenAccountIdempotentInstruction(owner.publicKey,ownerATA,owner.publicKey,key(3)),sdk.instruction(b,'withdraw',{amount:1000000n,destination:ownerATA.toBase58()})];break;
 }
 const tx=new Transaction({feePayer:method==='execute'?executor.publicKey:owner.publicKey,blockhash:key(9).toBase58(),lastValidBlockHeight:100}).add(...instructions);tx.sign(method==='execute'?executor:owner);
 const signature=tx.signatures[0].signature; // No private key material in fixtures.
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+signature.toString('hex')),encoded='';while(n){encoded=alphabet[Number(n%58n)]+encoded;n/=58n;}for(const x of signature){if(x)break;encoded='1'+encoded;}
 records.push({id:'reference-'+method,intent:intentFor(sdk,policy,owner.publicKey.toBase58(),method,options),method,status:'uncertain',signature:encoded,signedBytes:tx.serialize().toString('base64'),blockhash:key(9).toBase58(),lastValidBlockHeight:100,nonce:'0',revision:'1',transactionUrl:sdk.transactionURL(encoded)});
}
for(const record of records)validateRecord(sdk,policy,owner.publicKey.toBase58(),record);
await writeFile(new URL('./reference.json',import.meta.url),JSON.stringify({source:'AllowIt-sdk native/index.mjs + lifecycle.mjs at 1f89d6975aca9038de4465601d0d68e7f75c3868; @solana/web3.js 1.98.4',config:{network:'solana:testnet',mint:key(3).toBase58(),executor:executor.publicKey.toBase58(),deployment},owner:owner.publicKey.toBase58(),policy,records},null,2)+'\n');
