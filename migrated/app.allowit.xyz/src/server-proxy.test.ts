import {describe, expect, it, vi} from 'vitest';
import {apiTarget, proxyRequest, RUST_ONLY_ROUTE, type ProxyEnvironment} from '../server-proxy/transport';
import {mockRequest} from '../server-proxy/contract-mock';

const base: ProxyEnvironment = {ALLOWIT_API_MODE: 'rust', ALLOWIT_BACKEND_ORIGIN: 'https://rust.example.com', ALLOWIT_BACKEND_ALLOWED_ORIGINS: 'https://rust.example.com'};
const request = (path = '/api/proxy?route=micro/answer', init: RequestInit = {}) => new Request('https://front.example.com' + path, init);

describe('frontend API transport v1', () => {
  it.each([
    ['POST', '/api/native/deploy/prepare', 165_000],
    ['POST', '/api/proxy?route=native%2Fdeploy%2Fprepare&attempt=1', 165_000],
    ['POST', '/api/native/owner/submit', 105_000],
    ['POST', '/api/native/deploy/prepare-extra', 105_000],
    ['GET', '/api/native/deploy/prepare', 105_000],
  ])('sets the upstream deadline for %s %s', async (method, path, milliseconds) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const send = vi.fn<typeof fetch>(async () => Response.json({}));
      expect((await proxyRequest(request(path, {method}), base, send)).status).toBe(200);
      expect(timeout.mock.calls).toEqual([[milliseconds]]);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it('preserves exact JSON bytes, identity and original authority without synthesizing an owner', async () => {
    const body = '{"requestId":"-fixed","answer":true,"amount":"0.000001"}\n';
    const send = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://rust.example.com/api/micro/answer?opaque=a%2Bb');
      const h = new Headers(init?.headers);
      expect(h.get('origin')).toBe('https://front.example.com');
      expect(h.get('authorization')).toBe('Bearer agent-capability');
      expect(h.get('cookie')).toBe('__Host-allowit=opaque');
      expect(h.get('x-forwarded-origin')).toBeNull();
      expect(h.get('host')).toBeNull();
      expect(h.get('x-vercel-protection-bypass')).toBe('server-only');
      expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(body);
      expect(init?.redirect).toBe('manual');
      return Response.json({error: 'Owner session required.'}, {status: 403});
    });
    const reply = await proxyRequest(request('/api/proxy?route=micro/answer&opaque=a%2Bb', {method: 'POST', headers: {Origin: 'https://front.example.com', Authorization: 'Bearer agent-capability', Cookie: '__Host-allowit=opaque; _vercel_jwt=provider-secret; arbitrary=not-forwarded', 'X-Forwarded-Origin': 'https://trusted.example', 'X-Vercel-Protection-Bypass': 'caller', 'Content-Type': 'application/json'}, body}), {...base, ALLOWIT_BACKEND_PROTECTION_BYPASS: 'server-only'}, send);
    expect(reply.status).toBe(403);
    expect(await reply.json()).toEqual({error: 'Owner session required.'});
    expect(reply.headers.get('x-allowit-transport')).toBe('rust-v1');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('matches the Engine body limit only for a signed Stellar owner submission', async () => {
    const body = 'x'.repeat(192 * 1024);
    const send = vi.fn<typeof fetch>(async (_url, init) => {
      expect((init?.body as Uint8Array).byteLength).toBe(body.length);
      return Response.json({ok:true});
    });
    const post = (path: string, value: string) => proxyRequest(request(path, {method:'POST', body:value}), base, send);
    expect((await post('/api/native/owner/submit', body)).status).toBe(200);
    expect((await post('/api/native/owner/submit', body + 'x')).status).toBe(413);
    expect((await post('/api/native/owner/prepare', body)).status).toBe(413);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['solana','solana:devnet','local:dev'])('checks the displayed %s owner and forwards the same cookie snapshot exactly once', async network => {
    const input = request('/api/policy-template/save', {method:'POST', headers:{cookie:'allowit_session=owner-A', 'X-AllowIt-Expected-Owner':`${network}:ownerA`}, body:'{}'});
    const send = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get('cookie')).toBe('allowit_session=owner-A');
      expect(new Headers(init?.headers).get('x-allowit-expected-owner')).toBeNull();
      if (String(url).endsWith('/api/session')) {
        input.headers.set('cookie','allowit_session=owner-B');
        return Response.json({session:{network,address:'ownerA'}});
      }
      return Response.json({saved:true});
    });
    expect((await proxyRequest(input,base,send)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(['save','delete','respond'])('rejects a cookie owner mismatch before the %s mutation', async operation => {
    const send = vi.fn<typeof fetch>(async () => Response.json({session:{network:'solana',address:'ownerB'}}));
    const path=operation==='respond'?'/api/agent/respond':'/api/policy-template/'+operation;
    const response=await proxyRequest(request(path,{method:'POST',headers:{cookie:'allowit_session=owner-B','X-AllowIt-Expected-Owner':'solana:ownerA'},body:'{}'}),base,send);
    expect(response.status).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0][0])).toBe('https://rust.example.com/api/session');
  });

  it('forwards distinct host-only cookies and skill downloads, never internal secrets or Location', async () => {
    const headers = new Headers({'content-type': 'text/markdown', 'content-disposition': 'attachment; filename="SKILL.md"', 'x-vercel-protection-bypass': 'secret'});
    headers.append('set-cookie', '__Host-allowit=new; Path=/; Secure; HttpOnly; SameSite=Lax');
    headers.append('set-cookie', '__Host-allowit-local=local; Path=/; Secure; HttpOnly; SameSite=Lax');
    headers.append('set-cookie', '_vercel_jwt=not-forwarded; Path=/; Secure');
    const reply = await proxyRequest(request('/api/harness/owner/policy/skill?interface=cli'), base, async () => new Response('# Skill\n', {headers}));
    expect(reply.headers.getSetCookie()).toEqual([
      '__Host-allowit=new; Path=/; Secure; HttpOnly; SameSite=Lax',
      '__Host-allowit-local=local; Path=/; Secure; HttpOnly; SameSite=Lax',
    ]);
    expect(reply.headers.get('content-disposition')).toContain('SKILL.md');
    expect(reply.headers.get('x-vercel-protection-bypass')).toBeNull();
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(await reply.text()).toBe('# Skill\n');
  });

  it.each([
    {ALLOWIT_BACKEND_ORIGIN: 'http://169.254.169.254'},
    {ALLOWIT_BACKEND_ORIGIN: 'https://user:password@rust.example.com'},
    {ALLOWIT_BACKEND_ORIGIN: 'https://rust.example.com/untrusted'},
    {ALLOWIT_BACKEND_ORIGIN: 'https://front.example.com', ALLOWIT_BACKEND_ALLOWED_ORIGINS: 'https://front.example.com'},
    {ALLOWIT_BACKEND_ALLOWED_ORIGINS: 'https://different.example.com'},
    {ALLOWIT_BACKEND_ORIGIN: 'http://127.0.0.1:8080', ALLOWIT_BACKEND_ALLOWED_ORIGINS: 'http://127.0.0.1:8080', ALLOWIT_PROXY_ALLOW_LOOPBACK: '1', VERCEL: '1'},
  ])('rejects unsafe or unpaired backend configuration before forwarding', async overrides => {
    const send = vi.fn<typeof fetch>();
    expect((await proxyRequest(request(), {...base, ...overrides}, send)).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['http://api:8080', 'http://allowit-api.railway.internal:8080'])('allows only an explicitly paired server-private origin: %s', async origin => {
    const send = vi.fn<typeof fetch>(async url => {expect(String(url)).toBe(origin + '/api/health'); return Response.json({status: 'ok'});});
    const env = {...base, ALLOWIT_BACKEND_ORIGIN: origin, ALLOWIT_BACKEND_ALLOWED_ORIGINS: origin, ALLOWIT_PRIVATE_API_ORIGIN: origin};
    expect((await proxyRequest(request('/api/health'), env, send)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    {ALLOWIT_BACKEND_ORIGIN: 'http://api:8080', ALLOWIT_BACKEND_ALLOWED_ORIGINS: 'http://api:8080'},
    {ALLOWIT_PRIVATE_API_ORIGIN: 'http://api:8080', ALLOWIT_BACKEND_ORIGIN: 'http://other:8080', ALLOWIT_BACKEND_ALLOWED_ORIGINS: 'http://other:8080'},
    {ALLOWIT_PRIVATE_API_ORIGIN: 'http://api:8080', ALLOWIT_BACKEND_ORIGIN: 'http://api:8080', ALLOWIT_BACKEND_ALLOWED_ORIGINS: 'https://other.example'},
    ...['http://169.254.169.254', 'http://127.0.0.1:8080', 'http://other.internal:8080', 'http://api:8080/path', 'http://user:pass@api:8080', 'http://api:8080?host=other', 'http://api:8080#other'].map(origin => ({ALLOWIT_PRIVATE_API_ORIGIN: origin, ALLOWIT_BACKEND_ORIGIN: origin, ALLOWIT_BACKEND_ALLOWED_ORIGINS: origin})),
    {ALLOWIT_PRIVATE_API_ORIGIN: 'http://api:8080', ALLOWIT_BACKEND_ORIGIN: 'http://api:8080', ALLOWIT_BACKEND_ALLOWED_ORIGINS: 'http://api:8080', VERCEL: '1'},
  ])('fails closed for unpaired or unsafe private transport configuration', async overrides => {
    const send = vi.fn<typeof fetch>();
    expect((await proxyRequest(request(), {...base, ...overrides}, send)).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies and traversal without forwarding', async () => {
    const send = vi.fn<typeof fetch>();
    expect((await proxyRequest(request(undefined, {method: 'POST', body: 'x'.repeat(65_537)}), base, send)).status).toBe(413);
    expect(() => apiTarget(request('/api/proxy?route=../health'), base.ALLOWIT_BACKEND_ORIGIN!)).toThrow();
    expect(() => apiTarget(request('/api/proxy?route=health&route=auth/verify'), base.ALLOWIT_BACKEND_ORIGIN!)).toThrow();
    expect((await proxyRequest(request('/api/proxy?route=../health'), base, send)).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects provider HTML without serving it from the app origin', async () => {
    const reply = await proxyRequest(request(), base, async () => new Response('<script>provider</script>', {headers: {'content-type': 'text/html'}}));
    expect(reply.status).toBe(502);
    expect(reply.headers.get('content-type')).toContain('application/json');
  });

  it('never follows redirects or retries uncertain backend failures', async () => {
    const send = vi.fn<typeof fetch>(async () => new Response(null, {status: 307, headers: {location: 'https://other.example.com/steal'}}));
    const reply = await proxyRequest(request(undefined, {method: 'POST', body: '{"requestId":"same"}'}), base, send);
    expect(reply.status).toBe(502);
    expect(reply.headers.get('location')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    const lost = vi.fn<typeof fetch>(async () => {throw new Error('secret backend URL detail');});
    const uncertain = await proxyRequest(request(), base, lost);
    expect(await uncertain.json()).toEqual({error: 'Backend reply unavailable. Recover with the same request identity.'});
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Rust transport is not configured', async () => {
    const send = vi.fn<typeof fetch>();
    expect((await proxyRequest(request(), {}, send)).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it('bounds a stalled body before any backend work', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn<typeof fetch>();
      const body = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array([1]));}});
      const pending = proxyRequest(request(undefined, {method: 'POST', body, duplex: 'half'} as RequestInit), base, send);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).status).toBe(408);
      expect(send).not.toHaveBeenCalled();
    } finally {vi.useRealTimers();}
  });

  it('keeps fixtures isolated from live authority and unavailable in Production', async () => {
    const env = {ALLOWIT_API_MODE: 'mock', VERCEL_ENV: 'preview'};
    expect(await mockRequest(request('/api/proxy?route=health'), env).json()).toEqual({status: 'ok', mode: 'transport-fixture', authority: 'none'});
    expect(mockRequest(request(undefined, {method: 'POST', body: '{}'}), env).status).toBe(501);
    expect(mockRequest(request('/api/proxy?route=health'), {...env, VERCEL_ENV: 'production'}).status).toBe(503);
    expect(mockRequest(request('/api/proxy?route=health'), {ALLOWIT_API_MODE: 'mock', VERCEL: '1'}).status).toBe(503);
    expect(mockRequest(request('/api/proxy?route=native/prepare'), env).status).toBe(404);
  });

  it('forwards signed owner answers to Rust only, byte for byte, with no fixture or legacy fallback', async () => {
    const body = '{"kind":"paysh","policyId":"p_1","requestId":"r_1","decisionId":"d_1","signature":"' + 'A'.repeat(86) + '=="}';
    const send = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://rust.example.com/api/owner/requests/answer');
      expect(new Headers(init?.headers).get('cookie')).toBe('__Host-allowit=owner');
      expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(body);
      return Response.json({kind: 'paysh', policyId: 'p_1', requestId: 'r_1', status: 'owner_approved', approved: true});
    });
    const reply = await proxyRequest(request('/api/proxy?route=owner/requests/answer', {method: 'POST', headers: {cookie: '__Host-allowit=owner; other=x', 'content-type': 'application/json'}, body}), base, send);
    expect(reply.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await proxyRequest(request('/api/proxy?route=owner/requests'), {...base, ALLOWIT_API_MODE: 'go'}, send)).status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1);
    const env = {ALLOWIT_API_MODE: 'mock', VERCEL_ENV: 'preview'};
    expect(mockRequest(request('/api/proxy?route=owner/requests'), env).status).toBe(404);
    expect(mockRequest(request('/api/proxy?route=owner/requests/answer', {method: 'POST', body}), env).status).toBe(501);
    for (const path of ['/api/owner', '/api/owner/requests', '/api/owner/requests/challenge', '/api/owner?x=1']) expect(RUST_ONLY_ROUTE.test(path)).toBe(true);
    for (const path of ['/api/owners', '/api/micro/requests/answer', '/api/session']) expect(RUST_ONLY_ROUTE.test(path)).toBe(false);
  });
});
