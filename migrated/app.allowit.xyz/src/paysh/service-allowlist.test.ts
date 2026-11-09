import {describe, expect, it} from 'vitest';
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {chainConfig, deployment, OWNER, policy, REQUEST_ID, v0Message} from './fixtures/paysh-setup';
import {associatedAddress, checkedSetup, decodeConfig, encodeConfig, expectedInstructions, NATIVE_MINT, policyAddress, solCustody} from './paysh-wallet-intent';
import {parseDraft, type PreparedSetup} from './paysh-contracts';
import {profile} from './fixtures/paysh-setup';
import {serviceAllowlistRoot} from './service-allowlist';

const ids = ['solana-foundation/google/airquality', 'provider/weather', 'provider/maps'];
function setup() {
  const account = policyAddress(deployment.program, OWNER, policy.id, 2);
  const config = {...chainConfig, serviceAllowlistRoot: serviceAllowlistRoot(ids, chainConfig), vaultUsdc: associatedAddress(account, new PublicKey(deployment.usdcMint)).toBase58(), vaultWsol: associatedAddress(account, NATIVE_MINT).toBase58()};
  const approved = {...policy, policyAddress: account.toBase58(), allowedServiceIds: [...ids]};
  const configBytes = encodeConfig(config).toString('base64');
  const message = Buffer.from(v0Message(expectedInstructions(deployment, OWNER, config, config.allocationLamports)));
  const prepared: PreparedSetup = {requestId: REQUEST_ID, policy: approved, config, configBytes, message: message.toString('base64'), unsignedTransaction: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64'), allocationLamports: config.allocationLamports, accounts: {owner: OWNER, policy: account.toBase58(), solCustody: solCustody(deployment.program, account, 2).toBase58()}};
  const draft = {draftId: policy.id, policy: approved, profile, configBytes, title: profile.title, explanation: profile.explanation, methods: ['execute(request)']};
  return {prepared, draft};
}

describe('v2 per-policy service allowlist', () => {
  it('matches the shared Rust v2 three-service root vector', () => {
    const address = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
    expect(serviceAllowlistRoot(['api/service-0', 'api/service-1', 'api/service-2'], {network: address(1), usdcMint: address(2), vendorUsdc: address(3)})).toBe('9c57710e1365ed2325f169c0cd464af63e495c6bc04ecae197a8a75de9665627');
  });
  it('roundtrips v2 bytes and checks the independently approved list before wallet signing', () => {
    const {prepared, draft} = setup();
    expect(Buffer.from(prepared.configBytes, 'base64').length).toBe(593);
    expect(decodeConfig(encodeConfig(prepared.config))).toEqual(prepared.config);
    expect(checkedSetup(deployment, draft, OWNER, REQUEST_ID, prepared).version).toBe(0);
    expect(parseDraft(draft).policy.allowedServiceIds).toEqual(ids);
    const changed = {...prepared.policy, allowedServiceIds: [ids[0], 'evil/service']};
    expect(() => checkedSetup(deployment, {...draft, policy: changed}, OWNER, REQUEST_ID, {...prepared, policy: changed})).toThrow(/allowlist/);
    expect(() => parseDraft({...draft, policy: changed})).toThrow(/allowed services/);
    expect(() => checkedSetup(deployment, {...draft, policy: {...prepared.policy, allowedServiceIds: undefined}}, OWNER, REQUEST_ID, prepared)).toThrow(/version/);
    expect(prepared.accounts.policy).not.toBe(policy.policyAddress);
  });
});
