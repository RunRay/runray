import { describe, expect, it } from 'vitest';
import { convertLitellmPricing } from './litellm.js';

const sample: Record<string, unknown> = {
  'claude-x': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 0.3e-6,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
  },
  // provider-prefixed duplicate must lose to the canonical key above
  'anthropic/claude-x': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 99e-6,
    output_cost_per_token: 99e-6,
  },
  // no cache pricing published → falls back to the input rate
  'no-cache-model': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 2e-6,
    output_cost_per_token: 8e-6,
  },
  // zero-filled 1h rate must be treated as "not published", never stored
  'claude-zero-1h': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: 0,
  },
  // upstream copy-paste garbage (real 2026-08 data): 1h below the 5m rate…
  'claude-1h-below-5m': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 15e-6,
    output_cost_per_token: 75e-6,
    cache_creation_input_token_cost: 18.75e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
  },
  // …and 1h at 20× the 5m rate — both outside the [1×, 4×] sanity band
  'claude-1h-absurd': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 0.25e-6,
    output_cost_per_token: 1.25e-6,
    cache_creation_input_token_cost: 0.3e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
  },
  'embedding-model': {
    litellm_provider: 'openai',
    mode: 'embedding',
    input_cost_per_token: 1e-7,
  },
  'foreign/model': {
    litellm_provider: 'somewhere-else',
    mode: 'chat',
    input_cost_per_token: 1e-6,
  },
  'no-price': { litellm_provider: 'openai', mode: 'chat' },
};

describe('convertLitellmPricing', () => {
  const table = convertLitellmPricing(sample, { snapshotDate: '2026-07-07' });

  it('filters to chat models of known providers with prices', () => {
    expect(table.entries.map((e) => e.modelPattern)).toEqual([
      'claude-1h-absurd',
      'claude-1h-below-5m',
      'claude-x',
      'claude-zero-1h',
      'no-cache-model',
    ]);
    expect(table.snapshotDate).toBe('2026-07-07');
    expect(table.source).toBe('litellm-snapshot');
  });

  it('converts per-token rates to per-MTok and prefers the un-prefixed key', () => {
    const claude = table.entries.find((e) => e.modelPattern === 'claude-x');
    expect(claude).toEqual({
      modelPattern: 'claude-x',
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
      cacheWrite1hPerMTok: 6,
    });
  });

  it('falls back to the input rate when cache pricing is missing', () => {
    const plain = table.entries.find(
      (e) => e.modelPattern === 'no-cache-model',
    );
    expect(plain?.cacheReadPerMTok).toBe(2);
    expect(plain?.cacheWritePerMTok).toBe(2);
    // no published 1h rate → field absent (engine derives the premium)
    expect('cacheWrite1hPerMTok' in (plain ?? {})).toBe(false);
  });

  it('treats a zero-filled 1h rate as not published', () => {
    const zeroed = table.entries.find(
      (e) => e.modelPattern === 'claude-zero-1h',
    );
    expect(zeroed?.cacheWritePerMTok).toBe(3.75);
    // a stored 0 would beat the ?? fallback and price 1h writes free
    expect('cacheWrite1hPerMTok' in (zeroed ?? {})).toBe(false);
  });

  it('drops published 1h rates outside the [1×, 4×] band of the 5m rate', () => {
    const below = table.entries.find(
      (e) => e.modelPattern === 'claude-1h-below-5m',
    );
    const absurd = table.entries.find(
      (e) => e.modelPattern === 'claude-1h-absurd',
    );
    // a 1h write is never cheaper than a 5m write, nor 20× dearer — both
    // are upstream copy-paste garbage; the engine derives 2× input instead
    expect('cacheWrite1hPerMTok' in (below ?? {})).toBe(false);
    expect('cacheWrite1hPerMTok' in (absurd ?? {})).toBe(false);
  });
});
