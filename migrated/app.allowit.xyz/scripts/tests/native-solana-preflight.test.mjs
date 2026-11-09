import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatNativeSolanaPreflight,
  nativeSolanaPreflight,
  runNativeSolanaPreflightCli,
} from '../native-solana-preflight.mjs';

const revision = 'a'.repeat(40);
const sourceBundle = '793db01595fbcb15503914744e49b45f470e9ca1d2805aceadeac00a0d843fc7';
const publicValues = {
  mint: 'FezWPm3UEFa4nbF76D45V3gg9eZzhSxfw3tUES1Gr3o1',
  executor: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
  authority: 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf',
  policy: '7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9',
  policyData: 'grJ8DRwQZNVoMm7RH61r9dprwNqyKCsNCzVajqGnnAZ',
  custody: 'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os',
};

function metadata(network = 'solana:devnet') {
  return {
    health: {status: 'ok', mode: 'policy-runtime', revision},
    'native/config': {
      network,
      rpcUrl: network === 'solana:devnet' ? 'https://api.devnet.solana.com' : 'https://api.testnet.solana.com',
      mint: publicValues.mint,
      executor: publicValues.executor,
      authority: publicValues.authority,
      deployment: {
        network,
        sourceBundle,
        policy: publicValues.policy,
        policyData: publicValues.policyData,
        custody: publicValues.custody,
      },
    },
    'native/release': {
      profile: 'solana-native-v2',
      network,
      serverRevision: revision,
      release: {
        contractRevision: '622f8b8054b4a8c533ae9ebd4978c48f7ea9c628',
        sourceBundle,
        sources: {'policy.rs': 'pub fn execute() {}', 'policy_api.rs': 'pub struct Context {}'},
        artifacts: [
          {name: 'allowit_policy.so', bytes: 1696, sha256: 'cb55e2015dbc437cce58a53727c947cd1d8db75453623c5e53a4e4ea15b40dde'},
          {name: 'allowit_vault.so', bytes: 110680, sha256: '92e1849f9072fb0c342b8cd4513faa5e575b77ee903397dde1fe06bb0f3fcae0'},
        ],
      },
    },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
}

function fixtureFetch(values = metadata()) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url: String(url), options});
    const route = new URL(url).pathname.replace(/^\/api\//, '');
    assert.ok(Object.hasOwn(values, route), `unexpected route ${route}`);
    return jsonResponse(values[route]);
  };
  return {calls, fetchImpl};
}

test('preflight uses only three credential-free public GETs and reports metadata, not acceptance', async () => {
  const {calls, fetchImpl} = fixtureFetch();
  const result = await nativeSolanaPreflight({origin: 'https://preview.example/', fetchImpl});
  assert.deepEqual(result, {
    network: 'solana:devnet',
    serverRevision: revision,
    contractRevision: '622f8b8054b4a8c533ae9ebd4978c48f7ea9c628',
    artifactCount: 2,
    pinnedReleaseMetadataMatched: true,
    chainVerification: false,
  });
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/api/health',
    '/api/native/config',
    '/api/native/release',
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.body, undefined);
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'manual');
    assert.deepEqual(call.options.headers, {Accept: 'application/json'});
    assert.equal('Authorization' in call.options.headers, false);
    assert.equal('Cookie' in call.options.headers, false);
  }
  const output = formatNativeSolanaPreflight(result);
  assert.match(output, /metadata-only prerequisites present for solana:devnet/);
  assert.match(output, /Not deployment compatibility, readiness, or acceptance/);
  assert.match(output, /Not checked: chain identity, deployed bytes, immutability, balances, signatures, receipts, or finality/);
  assert.doesNotMatch(output, /\bready\b|chain verified|finalized/i);
  for (const value of [...Object.values(publicValues), sourceBundle]) assert.equal(output.includes(value), false);
});

test('401, 403, and 503 are explicit blockers and response bodies are never echoed or read', async () => {
  for (const [status, message] of [
    [401, /requires authentication; this preflight does not send credentials/],
    [403, /is forbidden; make the public endpoint available instead of bypassing protection/],
    [503, /native Solana service or configuration is unavailable/],
  ]) {
    let errorBodyRead = false;
    const values = metadata();
    const fetchImpl = async url => {
      const route = new URL(url).pathname.replace(/^\/api\//, '');
      if (route === 'health') return jsonResponse(values.health);
      return {
        status,
        headers: new Headers({'content-type': 'application/json'}),
        async text() {
          errorBodyRead = true;
          return '{"secret":"must-not-appear"}';
        },
      };
    };
    let stderr = '';
    const exit = await runNativeSolanaPreflightCli(['https://preview.example'], {
      fetchImpl,
      stdout: {write() { throw new Error('success output must not be written'); }},
      stderr: {write(value) { stderr += value; }},
    });
    assert.equal(exit, 1);
    assert.match(stderr, message);
    assert.equal(stderr.includes('must-not-appear'), false);
    assert.equal(errorBodyRead, false);
  }
});

test('preflight fails closed on network, revision, source-bundle, address, and artifact skew', async t => {
  const cases = [
    {
      name: 'different configured network',
      change: values => { values['native/config'].network = 'solana:testnet'; },
      message: /not configured for solana:devnet/,
    },
    {
      name: 'different server revisions',
      change: values => { values['native/release'].serverRevision = 'b'.repeat(40); },
      message: /different server revisions/,
    },
    {
      name: 'different source bundles',
      change: values => { values['native/release'].release.sourceBundle = 'b'.repeat(64); },
      message: /sourceBundle values do not match/,
    },
    {
      name: 'configured source bundle is not pinned',
      change: values => { values['native/config'].deployment.sourceBundle = 'b'.repeat(64); },
      message: /sourceBundle does not match this checkout's pinned native release metadata/,
    },
    {
      name: 'RPC metadata is not public HTTPS',
      change: values => { values['native/config'].rpcUrl = 'http://127.0.0.1:8899'; },
      message: /not a credential-free public HTTPS URL/,
    },
    {
      name: 'invalid public identity',
      change: values => { values['native/config'].authority = 'not-a-public-key'; },
      message: /native\/config\.authority is missing or invalid/,
    },
    {
      name: 'missing vault artifact pin',
      change: values => { values['native/release'].release.artifacts.pop(); },
      message: /artifacts do not match this checkout's pinned native release metadata/,
    },
    {
      name: 'changed contract revision',
      change: values => { values['native/release'].release.contractRevision = 'b'.repeat(40); },
      message: /does not match this checkout's pinned native release metadata/,
    },
    {
      name: 'changed artifact bytes',
      change: values => { values['native/release'].release.artifacts[1].bytes += 1; },
      message: /artifacts do not match this checkout's pinned native release metadata/,
    },
    {
      name: 'changed artifact hash',
      change: values => { values['native/release'].release.artifacts[0].sha256 = 'b'.repeat(64); },
      message: /artifacts do not match this checkout's pinned native release metadata/,
    },
    {
      name: 'extra artifact',
      change: values => { values['native/release'].release.artifacts.push({name: 'extra.so', bytes: 1, sha256: 'b'.repeat(64)}); },
      message: /artifacts do not match this checkout's pinned native release metadata/,
    },
    {
      name: 'simulation health',
      change: values => { values.health.mode = 'simulation'; },
      message: /not the canonical policy runtime/,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const values = metadata();
      scenario.change(values);
      const {fetchImpl} = fixtureFetch(values);
      await assert.rejects(
        nativeSolanaPreflight({origin: 'https://preview.example', fetchImpl}),
        scenario.message,
      );
    });
  }
});
