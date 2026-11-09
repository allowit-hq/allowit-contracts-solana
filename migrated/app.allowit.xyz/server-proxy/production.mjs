import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import {dirname, extname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {proxyRequest} from './transport.js';

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
}));
const SPA = new Set(['/', '/index.html', '/allowances', '/tempo', '/devnet-demo']);
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://api.devnet.solana.com https://api.testnet.solana.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export function frontendOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ALLOWIT_FRONTEND_ORIGIN must be the exact public HTTPS origin');
  }
  return url.origin;
}

/** Inspect the raw request target before WHATWG URL normalization can remove dot segments. */
export function requestPath(target) {
  if (typeof target !== 'string' || target.length > 8192 || !target.startsWith('/') || target.startsWith('//')) throw new Error('Invalid path');
  const raw = target.split('?', 1)[0];
  if (/%(?:2f|5c)/i.test(raw)) throw new Error('Invalid path');
  const path = decodeURIComponent(raw);
  if (/[\u0000-\u0020\u007f\\%#]/.test(path) || path.includes('//') || path.split('/').some(part => part.startsWith('.'))) throw new Error('Invalid path');
  return path;
}
function inside(root, file) {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(path);
}
function plain(res, status, message) {
  res.writeHead(status, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
  res.end(message);
}

/** The production wrapper reuses the same bounded, allowlisted Rust proxy as Vercel. */
export async function createFrontendServer({distDir, env, send = fetch}) {
  const origin = frontendOrigin(env.ALLOWIT_FRONTEND_ORIGIN);
  if (env.ALLOWIT_API_MODE !== 'rust') throw new Error('Production requires ALLOWIT_API_MODE=rust');
  const root = await realpath(distDir);
  if (!(await stat(join(root, 'index.html'))).isFile()) throw new Error('Build the frontend before starting the server');
  const proxyEnv = Object.freeze({...env, ALLOWIT_PROXY_ALLOW_LOOPBACK: '0'});
  const active = new Set();
  const server = createServer({maxHeaderSize: 16_384}, (req, res) => {
    for (const [name, value] of Object.entries(SECURITY)) res.setHeader(name, value);
    void handle(req, res).catch(() => {
      if (!res.headersSent) plain(res, 500, 'The request could not be completed.');
      else res.destroy();
    });
  });

  async function handle(req, res) {
    let path;
    try {path = requestPath(req.url);} catch {plain(res, 400, 'Invalid request path.'); return;}
    if (path === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {plain(res, 405, 'Method not allowed.'); return;}
      const body = JSON.stringify({status: 'ok', service: 'allowit-frontend', revision: env.ALLOWIT_FRONTEND_REVISION || 'unknown'});
      res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (path === '/api' || path.startsWith('/api/')) {
      const controller = new AbortController();
      active.add(controller);
      const abort = () => controller.abort();
      const disconnect = () => {if (!res.writableFinished) abort();};
      req.once('aborted', abort);
      res.once('close', disconnect);
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
        const request = new Request(new URL(req.url, origin), {method: req.method, headers, body, signal: controller.signal, duplex: 'half'});
        const response = await proxyRequest(request, proxyEnv, send);
        res.statusCode = response.status;
        response.headers.forEach((value, name) => {if (name !== 'set-cookie') res.setHeader(name, value);});
        const cookies = response.headers.getSetCookie();
        if (cookies.length) res.setHeader('set-cookie', cookies);
        if (!response.body) res.end();
        else await pipeline(Readable.fromWeb(response.body), res);
      } finally {
        active.delete(controller);
        req.off('aborted', abort);
        res.off('close', disconnect);
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {plain(res, 405, 'Method not allowed.'); return;}
    const route = path.length > 1 ? path.replace(/\/$/, '') : path;
    if (route === '/policies' || route === '/policies.html') {
      const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      res.writeHead(route === '/policies.html' ? 308 : 307, {location: '/' + search, 'cache-control': 'no-store'});
      res.end();
      return;
    }
    const selected = SPA.has(route) ? '/index.html' : path;
    const type = TYPES.get(extname(selected).toLowerCase());
    if (!type) {plain(res, 404, 'Not found.'); return;}
    let file, info;
    try {
      file = await realpath(resolve(root, '.' + selected));
      if (!inside(root, file)) {plain(res, 404, 'Not found.'); return;}
      info = await stat(file);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {plain(res, 404, 'Not found.'); return;}
      throw error;
    }
    if (!info.isFile()) {plain(res, 404, 'Not found.'); return;}
    const immutable = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(selected);
    res.writeHead(200, {'content-type': type, 'content-length': String(info.size), 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'});
    if (req.method === 'HEAD') res.end();
    else await pipeline(createReadStream(file), res);
  }
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  return {server, async shutdown(graceMs = 10_000) {
    if (!server.listening) return;
    await new Promise((resolveShutdown, reject) => {
      const deadline = setTimeout(() => {
        for (const controller of active) controller.abort();
        server.closeAllConnections();
      }, graceMs);
      deadline.unref();
      server.close(error => {
        clearTimeout(deadline);
        if (error) reject(error); else resolveShutdown();
      });
      server.closeIdleConnections();
    });
  }};
}

async function start() {
  const port = Number(process.env.PORT || '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const app = await createFrontendServer({
    distDir: process.env.ALLOWIT_DIST_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../dist'),
    env: process.env,
  });
  await new Promise((resolveListen, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '0.0.0.0', resolveListen);
  });
  console.log('Allowit frontend listening on port ' + port);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void app.shutdown().catch(() => {process.exitCode = 1;});
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(() => {console.error('Allowit frontend could not start. Check its public origin, port and build output.'); process.exitCode = 1;});
}
