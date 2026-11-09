import {lazy, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';
import './sign-in.css';
import './policy/policy-glass.css';
import {ADK_OWNER_FRAGMENT} from '@allowit/stellar/stellar-fragments';

/**
 * The allowance view serves `/` and `/allowances`, where owner review links also land. Earlier setup links (`?paysh=1`,
 * `/devnet-demo`) open the allowance view without signing anything. The former native vault page (`?native=1`) is
 * retired: its links open the policies view, whose settings now hold the PaySH whitelist and discovery.
 */
const url = new URL(window.location.href);
const adk = url.hash.startsWith(ADK_OWNER_FRAGMENT) && /^\/(?:allowances\/?)?$/.test(url.pathname);
const tempo = !adk && (url.searchParams.get('chain') === 'tempo' || /^\/tempo\/?$/.test(url.pathname));
const stellar = adk || url.searchParams.get('chain') === 'stellar';
const earlier = url.searchParams.has('paysh') || url.pathname.replace(/\/+$/, '') === '/devnet-demo';
if (earlier) {
  url.searchParams.delete('paysh');
  url.pathname = '/allowances';
  window.history.replaceState(null, '', url);
} else if (!adk && !tempo && url.searchParams.has('native')) {
  url.searchParams.delete('native');
  url.searchParams.delete('network');
  url.hash = '';
  window.history.replaceState(null, '', url);
}
// Shared styles load with the entry; each chain loads only its own view.
const App = lazy(() => import('./App'));
try {
  const theme = localStorage.getItem('allowit.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* The view also supports browsers without local storage. */ }
createRoot(document.getElementById('root')!).render(
  <Suspense fallback={<div className="app-loading" role="status">Loading Allowit…</div>}><App earlierLink={earlier} chain={tempo ? 'tempo' : stellar ? 'stellar' : 'solana'} /></Suspense>,
);
