import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

// Run inside the remote source-build stage, never in the production container.
// This suite verifies UI signing boundaries with intercepted HTTP/wallet fixtures.
// It does not establish Devnet settlement, live Phantom behavior or provider delivery.
const revision = process.env.SOURCE_COMMIT;
assert.match(revision ?? '', /^[a-f0-9]{40}$/, 'An exact source revision is required');

const environment = Object.fromEntries(['PATH', 'HOME', 'PLAYWRIGHT_BROWSERS_PATH', 'SOURCE_COMMIT'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
environment.CI = '1';
function run(command, args) {
  const result = spawnSync(command, args, {stdio: 'inherit', env: environment});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' validation failed (exit ' + result.status + ', signal ' + result.signal + ')');
}

run('pnpm', ['run', 'check']);
run('pnpm', ['run', 'build']);
run(process.execPath, ['scripts/build-frontend-server.mjs']);
assert.equal(readFileSync('dist/revision.txt', 'utf8').trim(), revision, 'Built revision differs from source');
run('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.native-policy.config.ts', '--reporter', 'line']);
assert.equal(readFileSync('dist/revision.txt', 'utf8').trim(), revision, 'Validated revision changed');
console.log(JSON.stringify({event: 'allowit-frontend-validated', revision, checks: ['check', 'build', 'native-policy-desktop-mobile'], evidence: 'synthetic-ui-not-chain-settlement'}));
