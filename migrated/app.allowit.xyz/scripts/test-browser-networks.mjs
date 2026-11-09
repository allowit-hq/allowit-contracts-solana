import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');
// Current-server acceptance is the default. Historical Solana suites remain explicit until their migration.
// Testnet approval stays disabled: the browser cases use public fixture mints, never RPC calls.
const result = spawnSync(process.execPath, [cli, 'test', ...(process.argv.length > 2 ? process.argv.slice(2) : ['tests/server-session.spec.ts'])], {
  stdio: 'inherit',
  env: {...process.env, SOLANA_TESTNET_TOKEN_MINT: ''},
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
