import {readFileSync} from 'node:fs';
import type {Plugin, ProxyOptions} from 'vite';

const SANDBOX_COOKIE_PREFIX = 'allowit_sandbox_';
const DEVNET_COOKIE_PREFIX = 'allowit_devnet_';
type IsolatedBackend = boolean | 'devnet';
const cookiePrefix = (isolated: IsolatedBackend) => isolated === true ? SANDBOX_COOKIE_PREFIX : isolated === 'devnet' ? DEVNET_COOKIE_PREFIX : null;

/** The RAM signer and receipt viewer use no backend session or bearer capability. */
export function localServiceProxy(target: string): ProxyOptions {
  return {target, configure(proxy) {
    proxy.on('proxyReq', upstream => {
      upstream.removeHeader('cookie');
      upstream.removeHeader('authorization');
    });
  }};
}

/** Keep the two backend sessions distinct even when both are accessed from one browser origin. */
export function backendCookies(header: string | undefined, sandbox: IsolatedBackend): string {
  const prefix = cookiePrefix(sandbox);
  return (header ?? '').split(';').map(value => value.trim()).filter(Boolean).flatMap(value => {
    const local = value.startsWith(SANDBOX_COOKIE_PREFIX) || value.startsWith(DEVNET_COOKIE_PREFIX);
    if (prefix) return value.startsWith(prefix) ? [value.slice(prefix.length)] : [];
    return local ? [] : [value];
  }).join('; ');
}

export function sandboxProxy(target: string, sandbox: IsolatedBackend): ProxyOptions {
  const prefix = cookiePrefix(sandbox);
  const routePrefix = sandbox === 'devnet' ? '/__devnet' : '/__sandbox';
  return {
    target,
    ...(prefix ? {rewrite: (path: string) => path.replace(new RegExp(`^${routePrefix}(?=\\/api\\/)`), '')} : {}),
    configure(proxy) {
      proxy.on('proxyReq', (upstream, request) => {
        const cookies = backendCookies(request.headers.cookie, sandbox);
        if (cookies) upstream.setHeader('cookie', cookies);
        else upstream.removeHeader('cookie');
      });
      if (prefix) proxy.on('proxyRes', response => {
        const cookies = response.headers['set-cookie'];
        if (cookies) response.headers['set-cookie'] = cookies.map(cookie => {
          const scoped = /;\s*Path=/i.test(cookie) ? cookie.replace(/;\s*Path=[^;]*/i, '; Path=/') : cookie + '; Path=/';
          return prefix + scoped;
        });
      });
    },
  };
}

/** Only inject the local signer when the owner explicitly opens Local Solana. No source rewriting. */
export function localWalletPlugin(path: string): Plugin {
  return {
    name: 'allowit-local-wallet',
    apply: 'serve',
    resolveId(id) { if (id === 'virtual:local-wallet') return '\0local-wallet'; },
    load(id) { if (id === '\0local-wallet') return readFileSync(path, 'utf8'); },
    transformIndexHtml(html, context) {
      const params = new URL(context.originalUrl ?? '/', 'http://127.0.0.1').searchParams;
      if (params.get('native') !== '1' || params.get('network') !== 'solana:localnet') return html;
      return [{tag: 'script', attrs: {type: 'module', src: '/@id/virtual:local-wallet'}, injectTo: 'head-prepend'}];
    },
  };
}
