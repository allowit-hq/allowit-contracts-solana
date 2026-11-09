import {afterEach, describe, expect, it, vi} from 'vitest';
import {backendCookies, localServiceProxy, sandboxProxy} from '../../server-proxy/local-sandbox';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('one app, separate network destinations', () => {
  it('does not let a URL opt a production build into the local chain', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_ALLOWIT_LOCAL_SANDBOX', '1');
    vi.stubGlobal('window', {location: {hostname: '127.0.0.1', search: '?native=1&network=solana:localnet'}});
    const r = await import('./runtime-network');
    expect(r.localSandboxEnabled).toBe(false);
  });
});

describe('backend session isolation on one origin', () => {
  const cookies = 'session=public; allowit_sandbox_session=local; local_session=anonymous; allowit_sandbox_local_session=sandbox-anonymous';
  it('sends only public cookies to the public backend', () => {
    expect(backendCookies(cookies, false)).toBe('session=public; local_session=anonymous');
  });
  it('does not forward session or bearer credentials to the local signer and receipt viewer', () => {
    const events: Record<string, (...args: any[]) => void> = {};
    localServiceProxy('http://127.0.0.1:5189').configure!({on: (name: string, fn: (...args: any[]) => void) => { events[name] = fn; }} as never, {});
    const upstream = {removeHeader: vi.fn()};
    events.proxyReq(upstream);
    expect(upstream.removeHeader.mock.calls).toEqual([['cookie'], ['authorization']]);
  });
  it('sends only sandbox cookies to the sandbox under their original names', () => {
    expect(backendCookies(cookies, true)).toBe('session=local; local_session=sandbox-anonymous');
    expect(backendCookies('session=public', true)).toBe('');
  });
  it('namespaces outgoing sandbox cookies, including deletions, without changing their flags', () => {
    const events: Record<string, (...args: any[]) => void> = {};
    sandboxProxy('http://127.0.0.1:8082', true).configure!({on: (name: string, fn: (...args: any[]) => void) => { events[name] = fn; }} as never, {});
    const response = {headers: {'set-cookie': ['session=local; Path=/api; HttpOnly; SameSite=Strict', 'local_session=; Max-Age=0']}};
    events.proxyRes(response);
    expect(response.headers['set-cookie']).toEqual(['allowit_sandbox_session=local; Path=/; HttpOnly; SameSite=Strict', 'allowit_sandbox_local_session=; Max-Age=0; Path=/']);
  });
});
