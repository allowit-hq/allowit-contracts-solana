import {afterEach,expect,it,vi} from 'vitest';
import {resetAllowanceObservation, withAllowanceSigningLock} from './allowance-coordination';
afterEach(()=>{resetAllowanceObservation('scope');vi.unstubAllGlobals();});
it('serializes the complete signing operation across clients using the same owner lock',async()=>{
 let tail=Promise.resolve();const request=vi.fn((_name:string,run:()=>Promise<void>)=>{const next=tail.then(run);tail=next;return next;});
 vi.stubGlobal('navigator',{locks:{request}});
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const order:string[]=[];
 const first=withAllowanceSigningLock('network','owner',async()=>{order.push('first');await gate;order.push('saved');});
 const second=withAllowanceSigningLock('network','owner',async()=>{order.push('second');});
 await Promise.resolve();expect(order).toEqual(['first']);release();await Promise.all([first,second]);
 expect(order).toEqual(['first','saved','second']);expect(request.mock.calls.map(call=>call[0])).toEqual(['allowit.allowance:network:owner','allowit.allowance:network:owner']);
});
it('does not call a wallet operation without cross-tab coordination',async()=>{
 vi.stubGlobal('navigator',{});const run=vi.fn();await expect(withAllowanceSigningLock('network','owner',run)).rejects.toThrow('Nothing was signed');expect(run).not.toHaveBeenCalled();
});
