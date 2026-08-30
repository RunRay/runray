import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawRun, RawSpan } from '../adapter.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { normalize } from '../normalize.js';
import {
  bundledPricing,
  CACHE_WRITE_1H_ATTR,
  computeCostUSD,
  matchModel,
  type PricingTable,
  priceRun,
} from './index.js';

const table: PricingTable = {
  snapshotDate: '2026-07-07',
  source: 'litellm-snapshot',
  aliases: { 'legacy-name': 'claude-sonnet-4-6' },
  entries: [
    {
      modelPattern: 'claude-sonnet-4-6',
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
    {
      modelPattern: 'claude-sonnet-4',
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
    },
    {
      modelPattern: 'gpt-5',
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.125,
      cacheWritePerMTok: 1.25,
    },
  ],
};

describe('matchModel: exact → prefix → alias', () => {
  it.each([
    ['claude-sonnet-4-6', 'claude-sonnet-4-6'], // exact
    ['claude-sonnet-4-6-20260101', 'claude-sonnet-4-6'], // dated → longest prefix
    ['claude-sonnet-4-20250514', 'claude-sonnet-4'], // shorter prefix when 4-6 does not fit
    ['anthropic/claude-sonnet-4-6', 'claude-sonnet-4-6'], // provider prefix stripped
    ['claude-sonnet-4-6-latest', 'claude-sonnet-4-6'], // -latest stripped
    ['CLAUDE-SONNET-4-6', 'claude-sonnet-4-6'], // case-insensitive
    ['legacy-name', 'claude-sonnet-4-6'], // alias table
  ])('%s → %s', (model, expected) => {
    expect(matchModel(table, model)?.modelPattern).toBe(expected);
  });

  it('does not match across word boundaries or unknown models', () => {
    expect(matchModel(table, 'gpt-50')).toBeUndefined(); // '0' is not a boundary
    expect(matchModel(table, 'totally-unknown')).toBeUndefined();
  });
});

describe('matchModel: separator-loose fallback', () => {
  // OpenCode's zen provider spells Claude versions with dots
  // (`claude-opus-4.5`); LiteLLM — and therefore the bundled snapshot —
  // spells them with dashes. Both are the same model and must price.
  it.each([
    ['claude-sonnet-4.6', 'claude-sonnet-4-6'],
    ['claude-sonnet-4.6-20260101', 'claude-sonnet-4-6'],
    ['zen/claude-sonnet-4.6', 'claude-sonnet-4-6'],
  ])('%s → %s', (model, expected) => {
    expect(matchModel(table, model)?.modelPattern).toBe(expected);
  });

  it('matches a dash-form model against a dot-form catalog', () => {
    const dotted: PricingTable = {
      ...table,
      entries: [{ ...table.entries[0], modelPattern: 'gemini-2.5-flash' }],
    } as PricingTable;
    expect(matchModel(dotted, 'gemini-2-5-flash')?.modelPattern).toBe(
      'gemini-2.5-flash',
    );
  });

  it('never overrides a verbatim hit', () => {
    // 'gpt-5.3-codex' prefix-matches 'gpt-5' on the verbatim pass; the
    // loose pass must not run at all, let alone win
    expect(matchModel(table, 'gpt-5.3-codex')?.modelPattern).toBe('gpt-5');
    expect(matchModel(table, 'gpt-50')).toBeUndefined();
  });

  it('prices the Claude ids the bundled snapshot spells with dashes', () => {
    const bundled = bundledPricing();
    for (const model of [
      'claude-haiku-4.5',
      'claude-opus-4.5',
      'claude-opus-4.6',
      'claude-opus-4.8',
      'claude-sonnet-4.5',
      'claude-sonnet-4.6',
    ]) {
      const entry = matchModel(bundled, model);
      expect(entry, model).toBeDefined();
      expect(entry?.inputPerMTok, model).toBeGreaterThan(0);
      expect(matchModel(bundled, model.replace('.', '-'))).toBe(entry);
    }
  });
});

describe('computeCostUSD — tabular (05-ARCHITECTURE §2.3)', () => {
  const sonnet = table.entries[0];
  if (!sonnet) throw new Error('table fixture broken');

  it.each([
    // [input, output, cacheRead, cacheWrite, reasoning, expectedUSD]
    [1_000_000, 0, 0, 0, 0, 3],
    [0, 1_000_000, 0, 0, 0, 15],
    [0, 0, 1_000_000, 0, 0, 0.3], // cache read at its distinct rate
    [0, 0, 0, 1_000_000, 0, 3.75], // cache write at its distinct rate
    [0, 0, 0, 0, 1_000_000, 15], // reasoning billed at output rate
    [12_480, 610, 0, 11_020, 0, 0.087915],
    [0, 0, 0, 0, 0, 0],
  ])('in=%d out=%d cr=%d cw=%d r=%d → $%d', (input, output, cacheRead, cacheWrite, reasoning, usd) => {
    expect(
      computeCostUSD(sonnet, {
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning,
      }),
    ).toBe(usd);
  });

  const quad = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 };

  it('prices the 1h cache-write share at the published 1h rate', () => {
    const with1h = { ...sonnet, cacheWrite1hPerMTok: 6 };
    expect(computeCostUSD(with1h, quad, 1_000_000)).toBe(6);
    // split write: 400k at 5m ($3.75/M) + 600k at 1h ($6/M)
    expect(computeCostUSD(with1h, quad, 600_000)).toBe(5.1);
  });

  it('derives the 1h rate as 2× input when the table has none', () => {
    // sonnet fixture has no cacheWrite1hPerMTok → 2 × $3/M = $6/M
    expect(computeCostUSD(sonnet, quad, 1_000_000)).toBe(6);
    expect(computeCostUSD(sonnet, quad, 0)).toBe(3.75);
  });

  it('never invents a 1h premium for non-claude entries', () => {
    const gpt = table.entries[2];
    if (!gpt) throw new Error('table fixture broken');
    // gpt-5: no published 1h rate, no TTL-tiered cache product → the 1h
    // share bills at the entry's plain write rate ($1.25/M), not 2× input
    expect(computeCostUSD(gpt, quad, 1_000_000)).toBe(
      computeCostUSD(gpt, quad, 0),
    );
  });

  it('clamps the 1h share internally — no negative 5m term, no overshoot', () => {
    // over-total: all of cacheWrite bills at 1h, nothing beyond it
    expect(computeCostUSD(sonnet, quad, 9_000_000)).toBe(
      computeCostUSD(sonnet, quad, 1_000_000),
    );
    // negative: ignored, plain 5m pricing
    expect(computeCostUSD(sonnet, quad, -5)).toBe(
      computeCostUSD(sonnet, quad, 0),
    );
    // zero cacheWrite with a stray 1h count: no phantom cost
    expect(
      computeCostUSD(
        sonnet,
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        10_000,
      ),
    ).toBe(0);
    // NaN never poisons the total (public API, defaulted param)
    expect(computeCostUSD(sonnet, quad, Number.NaN)).toBe(
      computeCostUSD(sonnet, quad, 0),
    );
  });

  it('derives the premium for bedrock-style claude patterns too', () => {
    const bedrock = {
      modelPattern: 'us.anthropic.claude-sonnet-4-6-v1:0',
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    };
    // substring match: dot-delimited bedrock/vertex ids and user pricing
    // tables qualify for the Anthropic 2×-input premium as well
    expect(computeCostUSD(bedrock, quad, 1_000_000)).toBe(6);
  });
});

describe('priceRun', () => {
  const llmSpan = (
    id: string,
    model: string,
    costSource?: 'reported',
    costUSD?: number,
  ): RawSpan => ({
    id,
    parentId: 'root',
    kind: 'llm_call',
    name: model,
    status: 'ok',
    startedAt: '2026-07-02T13:00:01Z',
    llm: {
      provider: 'anthropic',
      model,
      tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      costSource: costSource ?? 'unknown',
      ...(costUSD === undefined ? {} : { costUSD }),
    },
    attributes: {},
    provenance: { file: 'x.jsonl', line: 1 },
  });
  const root: RawSpan = {
    id: 'root',
    parentId: null,
    kind: 'session',
    name: 'session',
    status: 'ok',
    startedAt: '2026-07-02T13:00:00Z',
    agent: { sessionId: 's' },
    attributes: {},
    provenance: { file: 'x.jsonl', line: 1 },
  };
  const raw: RawRun = {
    source: { tool: 'claude-code', format: 'claude-jsonl', files: ['x.jsonl'] },
    spans: [
      root,
      llmSpan('known', 'claude-sonnet-4-6'),
      llmSpan('mystery', 'no-such-model'),
    ],
    warnings: [],
  };

  it('computes cost for matched models and marks unknown ones', () => {
    const priced = priceRun(raw, table);
    const known = priced.spans.find((s) => s.id === 'known');
    expect(known?.llm?.costSource).toBe('computed');
    expect(known?.llm?.costUSD).toBe(3);
    const mystery = priced.spans.find((s) => s.id === 'mystery');
    expect(mystery?.llm?.costSource).toBe('unknown');
    expect(mystery?.llm?.costUSD).toBeUndefined();
  });

  it('unknown-model spans are excluded from normalized cost rollups', () => {
    const run = normalize(priceRun(raw, table));
    expect(run.totals.costUSD.total).toBe(3);
    expect(Object.keys(run.totals.costUSD.byModel)).toEqual([
      'claude-sonnet-4-6',
    ]);
  });

  it('prices the attribute-declared 1h cache-write share at the 1h rate', () => {
    const ttlSpan: RawSpan = {
      ...llmSpan('ttl', 'claude-sonnet-4-6'),
      llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 },
        costSource: 'unknown',
      },
      attributes: { [CACHE_WRITE_1H_ATTR]: 1_000_000 },
    };
    const priced = priceRun({ ...raw, spans: [root, ttlSpan] }, table);
    // all-1h write: 2 × $3/M input = $6, not the 5m $3.75
    expect(priced.spans.find((s) => s.id === 'ttl')?.llm?.costUSD).toBe(6);
  });

  it('keeps an adapter-reported cost only when it cannot compute its own', () => {
    const reported: RawRun = {
      ...raw,
      spans: [root, llmSpan('rep', 'no-such-model', 'reported', 1.23)],
    };
    const priced = priceRun(reported, table);
    expect(priced.spans.find((s) => s.id === 'rep')?.llm?.costUSD).toBe(1.23);
    expect(priced.spans.find((s) => s.id === 'rep')?.llm?.costSource).toBe(
      'reported',
    );
  });

  it('is pure — input RawRun is not mutated', () => {
    const before = JSON.stringify(raw);
    priceRun(raw, table);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe('bundled snapshot', () => {
  it('is non-empty, sorted, and prices are sane', () => {
    const bundled = bundledPricing();
    expect(bundled.entries.length).toBeGreaterThan(50);
    expect(bundled.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const patterns = bundled.entries.map((e) => e.modelPattern);
    expect([...patterns].sort()).toEqual(patterns);
    for (const e of bundled.entries) {
      expect(e.inputPerMTok).toBeGreaterThanOrEqual(0);
      expect(e.outputPerMTok).toBeGreaterThanOrEqual(0);
      expect(e.cacheReadPerMTok).toBeGreaterThanOrEqual(0);
      expect(e.cacheWritePerMTok).toBeGreaterThanOrEqual(0);
    }
  });

  it('prices the real fixture end to end (parse → price → normalize)', async () => {
    const fixtureDir = fileURLToPath(
      new URL('../../../../fixtures/claude-code/subagents', import.meta.url),
    );
    const candidates = await claudeCodeAdapter.detect([fixtureDir]);
    const candidate = candidates.find(
      (c) =>
        c.runRef.endsWith('72de75e7-d5ab-4c07-a381-6539f4e34e42.jsonl') &&
        !/[\\/]raw[\\/]/.test(c.runRef),
    );
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const run = normalize(
      priceRun(await claudeCodeAdapter.parse(candidate, { redact: false })),
      {
        baseDir: fixtureDir,
      },
    );
    // every llm span is either computed (with a cost) or explicitly unknown
    for (const s of run.spans) {
      if (s.kind !== 'llm_call' || !s.llm) continue;
      if (s.llm.costSource === 'computed')
        expect(s.llm.costUSD).toBeGreaterThanOrEqual(0);
      else expect(s.llm.costUSD).toBeUndefined();
    }
    // fixture models (opus-4-8, haiku-4-5, …) are covered by the snapshot
    expect(run.totals.costUSD.total).toBeGreaterThan(0);
    expect(Object.keys(run.totals.costUSD.byModel).length).toBeGreaterThan(0);
  }, 30_000);
});
