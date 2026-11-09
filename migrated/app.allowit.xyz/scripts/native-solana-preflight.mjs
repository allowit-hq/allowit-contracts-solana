import path from 'node:path';
import {pathToFileURL} from 'node:url';
import PINNED_RELEASE from '../tests/fixtures/native-release.json' with {type: 'json'};

const DEFAULT_NETWORK = 'solana:devnet';
const NETWORKS = new Set(['solana:devnet', 'solana:testnet']);
const PROFILE = 'solana-native-v2';
const MAX_RESPONSE_BYTES = 512 * 1024;
const PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function blocker(message) {
  return new Error(message);
}

function explicitOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw blocker('Pass one explicit HTTPS preview origin.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw blocker('Pass one explicit HTTPS preview origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname ||
    !['', '/'].includes(url.pathname)
  ) {
    throw blocker('Pass an HTTPS origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw blocker(`${label} returned invalid public metadata.`);
  }
  return value;
}

function string(value, label, pattern) {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    throw blocker(`${label} is missing or invalid.`);
  }
  return value;
}

function statusBlocker(route, status) {
  if (status === 401) {
    return blocker(`${route} requires authentication; this preflight does not send credentials or bypass access control.`);
  }
  if (status === 403) {
    return blocker(`${route} is forbidden; make the public endpoint available instead of bypassing protection.`);
  }
  if (status === 503) {
    return blocker(`${route} reports that the native Solana service or configuration is unavailable.`);
  }
  if (status >= 300 && status < 400) {
    return blocker(`${route} redirected; this preflight does not follow authentication or deployment redirects.`);
  }
  return blocker(`${route} returned HTTP ${status}.`);
}

async function publicGet(origin, route, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(new URL(`/api/${route}`, origin), {
      method: 'GET',
      headers: {Accept: 'application/json'},
      body: undefined,
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw blocker(`${route} could not be reached with the bounded public GET.`);
  }
  if (response.status < 200 || response.status >= 300) throw statusBlocker(route, response.status);
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw blocker(`${route} did not return JSON public metadata.`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw blocker(`${route} returned oversized public metadata.`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw blocker(`${route} returned oversized public metadata.`);
  }
  try {
    return object(JSON.parse(text), route);
  } catch (error) {
    if (error?.message?.startsWith(`${route} returned`)) throw error;
    throw blocker(`${route} returned malformed JSON public metadata.`);
  }
}

function validateHealth(value) {
  if (value.status !== 'ok' || value.mode !== 'policy-runtime') {
    throw blocker('health is not the canonical policy runtime.');
  }
  return string(value.revision, 'health.revision', /^[0-9a-f]{7,64}$/i);
}

function validateConfig(value, network) {
  if (value.network !== network) throw blocker(`native/config is not configured for ${network}.`);
  const rpc = string(value.rpcUrl, 'native/config.rpcUrl');
  let rpcUrl;
  try {
    rpcUrl = new URL(rpc);
  } catch {
    throw blocker('native/config.rpcUrl is not a valid public HTTPS URL.');
  }
  if (rpcUrl.protocol !== 'https:' || rpcUrl.username || rpcUrl.password || rpcUrl.search || rpcUrl.hash) {
    throw blocker('native/config.rpcUrl is not a credential-free public HTTPS URL.');
  }
  const deployment = object(value.deployment, 'native/config.deployment');
  if (deployment.network !== network) {
    throw blocker(`native/config deployment network does not match ${network}.`);
  }
  const sourceBundle = string(deployment.sourceBundle, 'native/config.deployment.sourceBundle', /^[0-9a-f]{64}$/i);
  if (sourceBundle !== PINNED_RELEASE.sourceBundle) {
    throw blocker('native/config sourceBundle does not match this checkout\'s pinned native release metadata.');
  }
  const addresses = {
    mint: value.mint,
    executor: value.executor,
    authority: value.authority,
    policy: deployment.policy,
    policyData: deployment.policyData,
    custody: deployment.custody,
  };
  for (const [name, address] of Object.entries(addresses)) {
    string(address, `native/config.${name}`, PUBLIC_KEY);
  }
  if (addresses.authority === addresses.executor) {
    throw blocker('native/config authority and executor must be distinct.');
  }
  return {sourceBundle};
}

function validateRelease(value, network, healthRevision, configuredSourceBundle) {
  if (value.profile !== PROFILE || value.network !== network) {
    throw blocker(`native/release is not the Solana native-v2 profile for ${network}.`);
  }
  const serverRevision = string(value.serverRevision, 'native/release.serverRevision', /^[0-9a-f]{7,64}$/i);
  if (serverRevision !== healthRevision) {
    throw blocker('health and native/release came from different server revisions.');
  }
  const release = object(value.release, 'native/release.release');
  const contractRevision = string(release.contractRevision, 'native/release.contractRevision', /^[0-9a-f]{40}$/i);
  const sourceBundle = string(release.sourceBundle, 'native/release.sourceBundle', /^[0-9a-f]{64}$/i);
  if (sourceBundle !== configuredSourceBundle) {
    throw blocker('native/config and native/release sourceBundle values do not match.');
  }
  if (contractRevision !== PINNED_RELEASE.contractRevision || sourceBundle !== PINNED_RELEASE.sourceBundle) {
    throw blocker('native/release does not match this checkout\'s pinned native release metadata.');
  }
  const sources = object(release.sources, 'native/release.sources');
  for (const name of ['policy.rs', 'policy_api.rs']) string(sources[name], `native/release.sources.${name}`);
  if (!Array.isArray(release.artifacts) || release.artifacts.length !== PINNED_RELEASE.artifacts.length) {
    throw blocker('native/release artifacts do not match this checkout\'s pinned native release metadata.');
  }
  for (const [index, candidate] of release.artifacts.entries()) {
    const artifact = object(candidate, 'native/release artifact');
    const name = string(artifact.name, 'native/release artifact name');
    const sha256 = string(artifact.sha256, 'native/release artifact sha256', /^[0-9a-f]{64}$/i);
    const expected = PINNED_RELEASE.artifacts[index];
    if (name !== expected.name || artifact.bytes !== expected.bytes || sha256 !== expected.sha256) {
      throw blocker('native/release artifacts do not match this checkout\'s pinned native release metadata.');
    }
  }
  return {serverRevision, contractRevision, artifactCount: release.artifacts.length};
}

export async function nativeSolanaPreflight({
  origin,
  network = DEFAULT_NETWORK,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  const base = explicitOrigin(origin);
  if (!NETWORKS.has(network)) throw blocker('Choose --network solana:devnet or solana:testnet.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw blocker('Choose a preflight timeout from 1 to 60000 milliseconds.');
  }
  const health = await publicGet(base, 'health', fetchImpl, timeoutMs);
  const healthRevision = validateHealth(health);
  const config = validateConfig(await publicGet(base, 'native/config', fetchImpl, timeoutMs), network);
  const release = validateRelease(
    await publicGet(base, 'native/release', fetchImpl, timeoutMs),
    network,
    healthRevision,
    config.sourceBundle,
  );
  return {
    network,
    serverRevision: release.serverRevision,
    contractRevision: release.contractRevision,
    artifactCount: release.artifactCount,
    pinnedReleaseMetadataMatched: true,
    chainVerification: false,
  };
}

function shortRevision(value) {
  return value.slice(0, 12);
}

export function formatNativeSolanaPreflight(result) {
  return [
    `Native Solana preflight: metadata-only prerequisites present for ${result.network}.`,
    `Server ${shortRevision(result.serverRevision)}; contract ${shortRevision(result.contractRevision)}; ${result.artifactCount} release artifact pins present.`,
    'Not deployment compatibility, readiness, or acceptance. Not checked: chain identity, deployed bytes, immutability, balances, signatures, receipts, or finality.',
  ].join('\n');
}

function cliInput(argv) {
  let origin = '';
  let network = DEFAULT_NETWORK;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--network') {
      if (index + 1 >= argv.length) throw blocker('Choose --network solana:devnet or solana:testnet.');
      network = argv[index + 1];
      index += 1;
    } else if (!origin) {
      origin = argument;
    } else {
      throw blocker('Pass one explicit HTTPS preview origin and an optional --network value.');
    }
  }
  if (!origin) throw blocker('Pass one explicit HTTPS preview origin.');
  if (!NETWORKS.has(network)) throw blocker('Choose --network solana:devnet or solana:testnet.');
  return {origin, network};
}

export async function runNativeSolanaPreflightCli(
  argv,
  {fetchImpl = fetch, stdout = process.stdout, stderr = process.stderr, timeoutMs = 15_000} = {},
) {
  try {
    const {origin, network} = cliInput(argv);
    const result = await nativeSolanaPreflight({origin, network, fetchImpl, timeoutMs});
    stdout.write(`${formatNativeSolanaPreflight(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`Native Solana preflight blocked: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runNativeSolanaPreflightCli(process.argv.slice(2));
}
