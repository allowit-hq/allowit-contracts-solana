import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
test('production CSP admits only the fixed chain origins',()=>{
 const config=JSON.parse(readFileSync(new URL('../../vercel.json',import.meta.url),'utf8'));
 const values=config.headers.flatMap(rule=>rule.headers).filter(header=>header.key.toLowerCase()==='content-security-policy').map(header=>header.value);
 assert.ok(values.length);
 for(const value of values){const connect=value.split(';').map(s=>s.trim()).find(s=>s.startsWith('connect-src '));assert.deepEqual(connect.split(/\s+/).slice(1).sort(),["'self'",'https://api.testnet.solana.com','https://horizon-testnet.stellar.org'].sort());}
});
