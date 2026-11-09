import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {request as httpRequest} from 'node:http';
import {buildFrontendServer} from '../build-frontend-server.mjs';

let temporary, distDir, createFrontendServer;
const env = {
  ALLOWIT_API_MODE: 'rust',
  ALLOWIT_FRONTEND_ORIGIN: 'https://front.example',
  ALLOWIT_BACKEND_ORIGIN: 'https://backend.example',
  ALLOWIT_BACKEND_ALLOWED_ORIGINS: 'https://backend.example',
  ALLOWIT_FRONTEND_REVISION: '1'.repeat(40),
};
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'allowit-frontend-test-'));
  distDir = join(temporary, 'dist');
  await mkdir(join(distDir, 'assets'), {recursive: true});
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Allowit</title>');
  await writeFile(join(distDir, 'assets/app-12345678.js'), 'export const app = true;\n');
  await writeFile(join(temporary, 'private.txt'), 'outside the public build');
  await symlink(join(temporary, 'private.txt'), join(distDir, 'outside.txt'));
  const runtime = join(temporary, 'runtime');
  await buildFrontendServer(runtime);
  ({createFrontendServer} = await import(pathToFileURL(join(runtime, 'production.mjs')).href));
});
after(async () => {if (temporary) await rm(temporary, {recursive: true, force: true});});

async function start(t, options = {}) {
  const app = await createFrontendServer({distDir, env, ...options});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.shutdown(50));
  return {...app, port: app.server.address().port};
}
function request(port, path, {method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({host: '127.0.0.1', port, path, method, headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('serves existing SPA routes, immutable assets, HEAD and legacy redirects', async t => {
  const app = await start(t);
  for (const path of ['/', '/allowances', '/tempo', '/devnet-demo?policy=kept']) {
    const response = await request(app.port, path);
    assert.equal(response.status, 200, path);
    assert.match(response.body, /Allowit/);
    assert.equal(response.headers['cache-control'], 'no-cache');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.match(response.headers['content-security-policy'], /https:\/\/api.devnet.solana.com/);
  }
  const asset = await request(app.port, '/assets/app-12345678.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type'], /javascript/);
  assert.match(asset.headers['cache-control'], /immutable/);
  const head = await request(app.port, '/assets/app-12345678.js', {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(asset.body)));
  const redirect = await request(app.port, '/policies?policy=kept');
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.location, '/?policy=kept');
  assert.equal((await request(app.port, '/policies.html')).status, 308);
});

test('rejects ambiguous paths before normalization and never serves outside dist', async t => {
  const app = await start(t);
  for (const path of ['/../private.txt', '/%2e%2e/private.txt', '/assets%2fapp-12345678.js',
    '/assets\\app.js', '//other.example/file', '/api/%2e%2e/health',
    '/%252e%252e/private.txt', '/.env', '/%00']) {
    assert.equal((await request(app.port, path)).status, 400, path);
  }
  for (const path of ['/outside.txt', '/missing.js', '/unknown', '/assets/']) {
    assert.equal((await request(app.port, path)).status, 404, path);
  }
  assert.equal((await request(app.port, '/', {method: 'POST'})).status, 405);
});

test('same-origin API proxy preserves exact bodies, allowed cookies, Origin and idempotency', async t => {
  const calls = [];
  const app = await start(t, {send: async (url, init) => {
    calls.push({url: String(url), init});
    const headers = new Headers({'content-type': 'application/json'});
    headers.append('set-cookie', '__Host-allowit=session; Path=/; Secure; HttpOnly; SameSite=Lax');
    headers.append('set-cookie', 'tracking=drop; Path=/');
    return new Response('{"submitted":false}', {headers});
  }});
  const body = '{"requestId":"stable-key","amount":"1000"}';
  const response = await request(app.port, '/api/proxy?route=native%2Fsubmit&network=solana%3Adevnet', {
    method: 'POST', body, headers: {
      origin: 'https://front.example', 'content-type': 'application/json', authorization: 'Bearer test-capability',
      cookie: '__Host-allowit=session; tracking=drop', 'idempotency-key': 'stable-key',
      'x-forwarded-host': 'untrusted.example',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://backend.example/api/native/submit?network=solana%3Adevnet');
  assert.equal(Buffer.from(calls[0].init.body).toString(), body);
  assert.equal(calls[0].init.headers.get('origin'), 'https://front.example');
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer test-capability');
  assert.equal(calls[0].init.headers.get('idempotency-key'), 'stable-key');
  assert.equal(calls[0].init.headers.get('cookie'), '__Host-allowit=session');
  assert.equal(calls[0].init.headers.get('x-forwarded-host'), null);
  assert.deepEqual(response.headers['set-cookie'], ['__Host-allowit=session; Path=/; Secure; HttpOnly; SameSite=Lax']);
});

test('expected owner precheck shares the captured cookie and blocks mutation on mismatch', async t => {
  const calls = [];
  const app = await start(t, {send: async (url, init) => {
    calls.push({url: String(url), init});
    return Response.json({session: {network: 'solana:devnet', address: 'OtherOwner'}});
  }});
  const response = await request(app.port, '/api/native/submit', {method: 'POST', body: '{}', headers: {
    'content-type': 'application/json', cookie: '__Host-allowit=session',
    'x-allowit-expected-owner': 'solana:devnet:ExpectedOwner',
  }});
  assert.equal(response.status, 409);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://backend.example/api/session');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.get('cookie'), '__Host-allowit=session');
});

test('production cannot enable loopback, self proxy, private HTTP or unsafe upstream responses', async t => {
  let calls = 0;
  for (const origin of ['http://backend.example', 'https://backend.railway.internal', 'http://127.0.0.1:8080', 'https://front.example']) {
    const app = await start(t, {env: {...env, ALLOWIT_BACKEND_ORIGIN: origin, ALLOWIT_BACKEND_ALLOWED_ORIGINS: origin, ALLOWIT_PROXY_ALLOW_LOOPBACK: '1'},
      send: async () => {calls++; return Response.json({});}});
    assert.equal((await request(app.port, '/api/health')).status, 503, origin);
  }
  assert.equal(calls, 0);
  const app = await start(t, {send: async () => {
    calls++;
    return calls === 1 ? new Response(null, {status: 302, headers: {location: 'https://other.example'}})
      : new Response('<html>not JSON</html>', {headers: {'content-type': 'text/html'}});
  }});
  assert.equal((await request(app.port, '/api/health')).status, 502);
  assert.equal((await request(app.port, '/api/health')).status, 502);
  assert.equal((await request(app.port, '/api/native/submit', {method: 'POST', body: 'x'.repeat(65_537)})).status, 413);
  assert.equal(calls, 2);
});

test('startup requires an explicit public HTTPS origin and refuses mock mode', async () => {
  for (const value of [undefined, 'http://front.example', 'https://user:pass@front.example', 'https://front.example/path']) {
    await assert.rejects(createFrontendServer({distDir, env: {...env, ALLOWIT_FRONTEND_ORIGIN: value}}));
  }
  await assert.rejects(createFrontendServer({distDir, env: {...env, ALLOWIT_API_MODE: 'mock'}}), /requires/);
});
