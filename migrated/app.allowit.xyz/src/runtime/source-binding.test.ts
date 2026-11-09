import {describe, expect, it} from 'vitest';
import {Buffer} from 'buffer';
import {encodeConfig} from '../paysh/paysh-wallet-intent';
import {parseDraft} from '../paysh/paysh-contracts';
import {chainConfig, OWNER} from '../paysh/fixtures/paysh-setup';
import {bindingInstanceId, checkBindingConfig, checkSourceBinding, configCommitment, CONFIG_LENGTH, parseSourceBinding, sha256Hex} from './source-binding';
import {boundSetup, contractRuntime, INTENT, SOURCE} from './fixtures/bound-setup';

/**
 * Cross-language encoding vector, copied from the backend agreement. Encoding only: its IR and config hashes are
 * explicit placeholders, not an admitted policy, and it is not evidence that any source compiled.
 */
const VECTOR = {
  source: 'use allowit::v1::prelude::*;\nstruct PolicyParams { limit: u64 }\nfn new() -> PolicyParams { PolicyParams { limit: 1000 } }\nasync fn _execute(ctx: &Context, params: &PolicyParams) -> PolicyResult {\n    allowit::cap_per_transaction(ctx.amount_units, &ctx.token, params.limit, "USDC", 6)?;\n    Ok(())\n}\n',
  originalIntent: 'Use Toronto air quality for today.\nKeep café context unchanged.',
  binding: {
    version: 1,
    owner: 'owner-public-key',
    sourceHash: '10b30c67499a410b356d905ed638ce8c451d87505e0ed34e53291fa74532ac12',
    irHash: '1c2329fb352263fc9f3b5cdd734fd043dc1af90933a9ac15712c1bf04eab7c8e',
    originalIntentHash: 'de24aa21386d50fe635c8eb84ba48c543f50536dd29297566bed14cd8206bbf7',
    revision: 1,
    nonce: '0101010101010101010101010101010101010101010101010101010101010101',
    walletKind: 'contract-wallet',
    walletProfile: 'solana-paysh-v1',
    configCommitment: 'ede2144620bb5e4c1d58a04943266f3fa3cd09946df5499086d7651905312fb0',
  },
  expectedInstanceId: '7b5d50e6062af479e73f6cbfb9f760d368ce1b66f47e750b4dc10f60fe08f15b',
} as const;

describe('source binding encoding (cross-language vector)', () => {
  const binding = parseSourceBinding(VECTOR.binding);

  it('hashes the ordered fields to the agreed instance ID', async () => {
    expect(await bindingInstanceId(binding)).toBe('7b5d50e6062af479e73f6cbfb9f760d368ce1b66f47e750b4dc10f60fe08f15b');
  });
});

describe('config commitment', () => {
  const bytes = encodeConfig(chainConfig);

  it('zeroes only the instance ID and derived vault bytes, on a copy', async () => {
    expect(bytes.length).toBe(CONFIG_LENGTH);
    const before = Buffer.from(bytes);
    const base = await configCommitment(bytes);
    expect(Buffer.compare(bytes, before)).toBe(0);
    const masked = Buffer.from(bytes);
    masked.fill(0, 0, 32);
    masked.fill(0, 192, 256);
    expect(base).toBe(await sha256Hex(masked));
    for (const at of [0, 31, 192, 223, 224, 255]) {
      const edited = Buffer.from(bytes); edited[at] ^= 1;
      expect(await configCommitment(edited), `byte ${at}`).toBe(base);
    }
    for (const at of [32, 64, 191, 256, 400, CONFIG_LENGTH - 1]) {
      const edited = Buffer.from(bytes); edited[at] ^= 1;
      expect(await configCommitment(edited), `byte ${at}`).not.toBe(base);
    }
  });
});

describe('binding against the current policy', () => {
  it('bounds the signed period cap by compiled token6 totals and exact provider ceilings', async () => {
    const s = await boundSetup({allowedServiceIds: ['weather/current', 'weather/forecast'], maxPaymentUsdcPerPeriod: '2000'});
    const draft = parseDraft(s.draft);
    // A deployment may narrow the compiled total before the owner reviews it.
    await expect(checkSourceBinding(s.binding, s.micro({limit: '0.003'}), OWNER, draft)).resolves.toBeUndefined();
    for (const limit of ['0.001', '0.0020001', '-1', '1e3', '18446744073709.551616']) {
      await expect(checkSourceBinding(s.binding, s.micro({limit}), OWNER, draft)).rejects.toThrow(/payment budget/);
    }
    for (const [field, value] of [['max_payment_units', '2000'], ['payment_asset_id', '11111111111111111111111111111111']] as const) {
      const p = s.micro();
      p.runtime!.providerCallRequirements![0][field] = value;
      await expect(checkSourceBinding(s.binding, p, OWNER, draft)).rejects.toThrow(field === 'payment_asset_id' ? /walletKind/ : /payment budget/);
    }
    const stale = {...draft, config: {...draft.config, maxUsdcPerPeriod: '3000'}};
    await expect(checkSourceBinding(s.binding, s.micro(), OWNER, stale)).rejects.toThrow(/payment budget/);
  });

  it('rejects asset metadata that differs from the signed mint or SOL base units', async () => {
    const s = await boundSetup();
    const p = s.micro();
    const runtime = p.runtime!;
    for (const altered of [
      {...runtime, paymentAsset: {...runtime.paymentAsset, mint: '11111111111111111111111111111111'}},
      {...runtime, fundingAsset: {...runtime.fundingAsset, decimals: 6}},
    ]) {
      await expect(checkSourceBinding(s.binding, {...p, runtime: altered}, OWNER, parseDraft(s.draft))).rejects.toThrow(/Asset/);
    }
  });

  it('refuses each tampered source, intent, IR, revision, owner, wallet, nonce or commitment', async () => {
    const s = await boundSetup();
    const draft = parseDraft(s.draft);
    const cases: [string, Promise<void>][] = [
      ['source', checkSourceBinding(s.binding, s.micro({code: `${SOURCE} `}), OWNER, draft)],
      ['source hash', checkSourceBinding(s.binding, s.micro({sourceHash: 'a'.repeat(64)}), OWNER, draft)],
      ['intent newline', checkSourceBinding(s.binding, s.micro({originalIntent: INTENT.replace('\n', '\r\n')}), OWNER, draft)],
      ['intent Unicode', checkSourceBinding(s.binding, s.micro({originalIntent: INTENT.normalize('NFD')}), OWNER, draft)],
      ['intent missing', checkSourceBinding(s.binding, s.micro({originalIntent: undefined}), OWNER, draft)],
      ['IR', checkSourceBinding(s.binding, s.micro({irHash: 'a'.repeat(64)}), OWNER, draft)],
      ['revision', checkSourceBinding(s.binding, s.micro({revision: 3}), OWNER, draft)],
      ['owner', checkSourceBinding(s.binding, s.micro(), '11111111111111111111111111111111', draft)],
      ['wallet', checkSourceBinding(s.binding, s.micro({runtime: {...contractRuntime, wallet: {kind: 'contract-wallet', profile: 'solana-paysh-v2'}} as never}), OWNER, draft)],
      ['nonce', checkSourceBinding({...s.binding, nonce: '02'.repeat(32)}, s.micro(), OWNER, draft)],
      ['commitment', checkSourceBinding({...s.binding, configCommitment: 'a'.repeat(64)}, s.micro(), OWNER, draft)],
      ['policy ID', checkSourceBinding(s.binding, s.micro({id: 'ab'.repeat(32)}), OWNER, draft)],
    ];
    await Promise.all(cases.map(([name, check]) => expect(check, name).rejects.toThrow(/source binding/)));
  });

  it('refuses signed caps changed in the Config, since the commitment covers them', async () => {
    const s = await boundSetup();
    const changed = encodeConfig({...s.config, maxUsdcPerPeriod: String(BigInt(s.config.maxUsdcPerPeriod) + 1n)}).toString('base64');
    const draft = {...parseDraft(s.draft), configBytes: changed};
    await expect(checkBindingConfig(s.binding, draft, OWNER)).rejects.toThrow(/configCommitment/);
  });
});
