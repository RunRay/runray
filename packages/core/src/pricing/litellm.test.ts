import { describe, expect, it } from 'vitest';
import { computeCostUSD, matchModel } from './engine.js';
import {
  convertLitellmPricing,
  PriceListTooShortError,
  priceListFromText,
} from './litellm.js';

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

describe('convertLitellmPricing with responses-mode models', () => {
  const openai = (mode: string, input: number, output: number) => ({
    litellm_provider: 'openai',
    mode,
    input_cost_per_token: input,
    output_cost_per_token: output,
    cache_read_input_token_cost: input / 10,
  });
  const raw: Record<string, unknown> = {
    'gpt-5.1': openai('chat', 1.25e-6, 10e-6),
    // filed under `responses` upstream, at a fifth of the base model's rates
    'gpt-5.1-codex-mini': openai('responses', 0.25e-6, 2e-6),
    // no `gpt-5.3` is published, so only its own entry can price it right
    'gpt-5': openai('chat', 1.25e-6, 10e-6),
    'gpt-5.3-codex': openai('responses', 1.75e-6, 14e-6),
    // the mode is the filter: other responses models come in with it
    'o3-pro': openai('responses', 20e-6, 80e-6),
    // a responses model of a provider we do not list stays out
    'elsewhere/big-model': {
      ...openai('responses', 1e-6, 2e-6),
      litellm_provider: 'somewhere-else',
    },
    // modes that bill by something other than chat tokens stay out
    'gpt-image': openai('image_generation', 5e-6, 40e-6),
    'gpt-realtime': openai('realtime', 4e-6, 16e-6),
    'text-embedding': openai('embedding', 1e-7, 0),
    'davinci-old': openai('completion', 2e-6, 2e-6),
    'no-mode': { ...openai('chat', 1e-6, 2e-6), mode: undefined },
    'mode-not-a-string': { ...openai('chat', 1e-6, 2e-6), mode: ['chat'] },
  };
  const invalid: string[] = [];
  const table = convertLitellmPricing(
    { ...raw, 'gpt-5.2-codex': openai('responses', -1, 14e-6) },
    { snapshotDate: '2026-11-14', onInvalid: (key) => invalid.push(key) },
  );

  it('keeps responses models of the listed providers next to chat ones', () => {
    expect(table.entries.map((e) => e.modelPattern)).toEqual([
      'gpt-5',
      'gpt-5.1',
      'gpt-5.1-codex-mini',
      'gpt-5.3-codex',
      'o3-pro',
    ]);
  });

  it('prices a Codex variant at its own rates, not at its base model’s', () => {
    const tokens = {
      input: 2000,
      output: 200,
      cacheRead: 8000,
      cacheWrite: 0,
      reasoning: 300,
    };
    const mini = matchModel(table, 'gpt-5.1-codex-mini');
    expect(mini?.modelPattern).toBe('gpt-5.1-codex-mini');
    expect(mini).toMatchObject({
      inputPerMTok: 0.25,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.025,
    });
    const base = matchModel(table, 'gpt-5.1');
    if (mini === undefined || base === undefined)
      throw new Error('both models must resolve');
    // 2,000 in + 8,000 cached + 500 out (reasoning at the output rate)
    expect(computeCostUSD(mini, tokens)).toBe(0.0017);
    expect(computeCostUSD(base, tokens)).toBe(0.0085);
  });

  it('resolves a Codex id that has no base model in the list to itself', () => {
    expect(matchModel(table, 'gpt-5.3-codex')?.modelPattern).toBe(
      'gpt-5.3-codex',
    );
    // a dated or provider-prefixed spelling still lands on the Codex entry
    expect(matchModel(table, 'openai/gpt-5.3-codex')?.outputPerMTok).toBe(14);
    expect(matchModel(table, 'gpt-5.3-codex-2026-02-05')?.outputPerMTok).toBe(
      14,
    );
  });

  it('reports a responses model with an unusable rate, like a chat one', () => {
    expect(invalid).toEqual(['gpt-5.2-codex']);
    expect(table.entries.some((e) => e.modelPattern === 'gpt-5.2-codex')).toBe(
      false,
    );
  });
});

describe('convertLitellmPricing with corrupted rates', () => {
  const chat = (rates: Record<string, unknown>) => ({
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    ...rates,
  });
  const raw: Record<string, unknown> = {
    'negative-output': chat({ output_cost_per_token: -15e-6 }),
    'string-input': chat({ input_cost_per_token: '0.000003' }),
    'absurd-cache-read': chat({ cache_read_input_token_cost: 0.5 }),
    // JSON.parse turns an overflowing literal into Infinity
    'infinite-input': chat({ input_cost_per_token: JSON.parse('1e400') }),
    'null-cache-read': chat({ cache_read_input_token_cost: null }),
    'free-model': chat({ input_cost_per_token: 0, output_cost_per_token: 0 }),
    // no input price: never priced, so an odd field is not worth a warning
    'no-input-odd-output': chat({
      input_cost_per_token: undefined,
      output_cost_per_token: 'TBD',
    }),
    // outside our providers: skipped before any rate check, never reported
    'foreign-negative': {
      litellm_provider: 'somewhere-else',
      mode: 'chat',
      input_cost_per_token: -1,
    },
    sample_spec: {
      litellm_provider: 'one of https://docs.litellm.ai/docs/providers',
      mode: 'one of: chat, embedding, completion',
      input_cost_per_token: 0,
    },
  };

  const invalid: Array<[string, string]> = [];
  const table = convertLitellmPricing(raw, {
    snapshotDate: '2026-10-06',
    onInvalid: (key, problem) => invalid.push([key, problem]),
  });

  it('leaves out chat models whose published rates are unusable', () => {
    expect(table.entries.map((e) => e.modelPattern)).toEqual([
      'free-model',
      'null-cache-read',
    ]);
  });

  it('reports each one with the field and the reason', () => {
    expect(invalid).toEqual([
      ['negative-output', 'output_cost_per_token is negative'],
      ['string-input', 'input_cost_per_token is not a number'],
      [
        'absurd-cache-read',
        'cache_read_input_token_cost is above $10,000 per million tokens',
      ],
      ['infinite-input', 'input_cost_per_token is not a number'],
    ]);
  });

  it('treats null like an absent rate and keeps zero prices', () => {
    const nulled = table.entries.find(
      (e) => e.modelPattern === 'null-cache-read',
    );
    expect(nulled?.cacheReadPerMTok).toBe(3); // falls back to the input rate
    const free = table.entries.find((e) => e.modelPattern === 'free-model');
    expect(free?.inputPerMTok).toBe(0);
  });
});

describe('priceListFromText', () => {
  const model = {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
  };
  const options = { snapshotDate: '2026-10-06', minEntries: 2 };

  it('parses, converts and keeps a list that is long enough', () => {
    const text = `﻿${JSON.stringify({ 'claude-a': model, 'claude-b': model })}`;
    expect(
      priceListFromText(text, options).entries.map((e) => e.modelPattern),
    ).toEqual(['claude-a', 'claude-b']);
  });

  it.each([
    ['text that is not JSON', '{"claude-a": ', /not valid JSON/],
    ['a top-level array', '[]', /not a JSON object keyed by model/],
    ['a bare value', '42', /not a JSON object keyed by model/],
  ])('refuses %s', (_case, text, message) => {
    expect(() => priceListFromText(text, options)).toThrow(message);
  });

  it('refuses a list shorter than minEntries, saying how short', () => {
    const text = JSON.stringify({ 'claude-a': model });
    expect(() => priceListFromText(text, options)).toThrow(
      PriceListTooShortError,
    );
    try {
      priceListFromText(text, options);
    } catch (err) {
      expect(err).toMatchObject({ models: 1, expected: 2 });
    }
  });

  it('never accepts an empty list, whatever minEntries says', () => {
    expect(() =>
      priceListFromText('{}', { ...options, minEntries: 0 }),
    ).toThrow(/only 0 usable models, fewer than the 1 expected/);
  });
});
