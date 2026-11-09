import {describe,it,expect} from 'vitest';
import {readRequestLink} from './request-link';
describe('owner request links',()=>{
 it('rejects missing identities, invalid routes and mismatched auth scopes',()=>{
  for(const query of ['?network=solana:devnet','?network=evil&owner=abc&policy=p&request=r','?network=solana:testnet&owner=local_abc&policy=p&request=r','?network=local:dev&owner=wallet&policy=p&request=r','?network=solana:devnet&owner=wallet&policy=%3Cscript%3E&request=r'])expect(readRequestLink(query)).toBeNull();
 });
});
