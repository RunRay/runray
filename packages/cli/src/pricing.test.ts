import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledPricing } from '@runray/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  effectivePricing,
  loadUserPricing,
  refreshPricing,
} from './pricing.js';

const dir = mkdtempSync(join(tmpdir(), 'runray-pricing-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const litellmSample = {
  'claude-test-model': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 5e-6,
    output_cost_per_token: 25e-6,
  },
};

describe('refreshPricing', () => {
  it('fetches, converts and writes the user override (explicit opt-in)', async () => {
    const path = join(dir, 'nested', 'pricing.json');
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify(litellmSample), { status: 200 });
    }) as typeof fetch;

    const result = await refreshPricing({ path, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(result.entries).toBe(1);

    const loaded = loadUserPricing(path);
    expect(loaded?.entries[0]?.modelPattern).toBe('claude-test-model');
    expect(loaded?.entries[0]?.inputPerMTok).toBe(5);
  });

  it('throws on a failing fetch', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 503 })) as typeof fetch;
    await expect(
      refreshPricing({ path: join(dir, 'x.json'), fetchImpl }),
    ).rejects.toThrow(/503/);
  });
});

describe('effectivePricing', () => {
  it('prefers a valid user override', async () => {
    const path = join(dir, 'valid.json');
    const fetchImpl = (async () =>
      new Response(JSON.stringify(litellmSample), {
        status: 200,
      })) as typeof fetch;
    await refreshPricing({ path, fetchImpl });
    const effective = effectivePricing(path);
    expect(effective.origin).toBe('user');
    expect(effective.table.entries).toHaveLength(1);
  });

  it('falls back to the bundled snapshot when the override is missing or invalid', () => {
    expect(effectivePricing(join(dir, 'missing.json')).origin).toBe('bundled');

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{not json');
    const effective = effectivePricing(broken);
    expect(effective.origin).toBe('bundled');
    expect(effective.table.entries.length).toBe(
      bundledPricing().entries.length,
    );
  });
});
