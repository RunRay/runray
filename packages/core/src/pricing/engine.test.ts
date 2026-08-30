import { describe, expect, it } from 'vitest';
import type { RawSpan } from '../adapter.js';
import { normalize } from '../normalize.js';
import type { PricingTable } from './engine.js';
import {
  CACHE_WRITE_1H_ATTR,
  cacheWrite1hTokens,
  computeCostUSD,
  downgradeMap,
  matchModel,
  repriceRun,
  suggestedDowngrade,
  unpricedCoverage,
} from './engine.js';
import { bundledPricing } from './index.js';

function tableOf(
  entries: Array<[string, number, number]>,
  aliases: Record<string, string> = {},
): PricingTable {
  return {
    snapshotDate: '2026-07-18',
    source: 'litellm-snapshot',
    aliases,
    entries: entries.map(([modelPattern, input, output]) => ({
      modelPattern,
      inputPerMTok: input,
      outputPerMTok: output,
      cacheReadPerMTok: input / 10,
      cacheWritePerMTok: input * 1.25,
    })),
  };
}

describe('suggestedDowngrade (C4)', () => {
  const bundled = bundledPricing();

  it('walks one stage down within a family, against the bundled snapshot', () => {
    expect(suggestedDowngrade('claude-opus-4-8', bundled)?.target).toBe(
      'claude-sonnet-5',
    );
    expect(suggestedDowngrade('claude-fable-5', bundled)?.target).toBe(
      'claude-opus-4-8',
    );
    expect(suggestedDowngrade('claude-sonnet-4-6', bundled)?.target).toBe(
      'claude-haiku-4-5',
    );
    expect(suggestedDowngrade('gemini-3.1-pro-preview', bundled)?.target).toBe(
      'gemini-3.5-flash',
    );
  });

  it('dated variants and provider prefixes resolve to their stage', () => {
    expect(
      suggestedDowngrade('anthropic/claude-opus-4-8-20260501', bundled)?.target,
    ).toBe('claude-sonnet-5');
    expect(suggestedDowngrade('gpt-5.3-codex', bundled)?.target).toBe(
      'gpt-5.4-mini',
    );
  });

  it('bottom of the ladder yields no suggestion', () => {
    expect(suggestedDowngrade('claude-haiku-4-5', bundled)).toBeUndefined();
    expect(suggestedDowngrade('gpt-5.4-nano', bundled)).toBeUndefined();
  });

  it('models outside every ladder yield no suggestion', () => {
    expect(suggestedDowngrade('deepseek-v4-pro', bundled)).toBeUndefined();
    expect(suggestedDowngrade('totally-unknown', bundled)).toBeUndefined();
  });

  it('walks past a stage missing from the effective table', () => {
    // opus present, sonnet stage absent, haiku present → haiku suggested
    const table = tableOf([
      ['claude-opus-4-8', 15, 75],
      ['claude-haiku-4-5', 1, 5],
    ]);
    expect(suggestedDowngrade('claude-opus-4-8', table)?.target).toBe(
      'claude-haiku-4-5',
    );
  });

  it('zero-rate targets are guarded; a table lacking every lower tier yields nothing', () => {
    const zeroRates = tableOf([
      ['claude-opus-4-8', 15, 75],
      ['claude-sonnet-5', 0, 0],
      ['claude-haiku-4-5', 0, 0],
    ]);
    expect(suggestedDowngrade('claude-opus-4-8', zeroRates)).toBeUndefined();
    const opusOnly = tableOf([['claude-opus-4-8', 15, 75]]);
    expect(suggestedDowngrade('claude-opus-4-8', opusOnly)).toBeUndefined();
  });

  it('the returned entry is the effective table match for the target', () => {
    const s = suggestedDowngrade('claude-opus-4-8', bundled);
    expect(s?.entry).toBe(matchModel(bundled, s?.target ?? ''));
  });
});

describe('repriceRun / repriceSpans (C5, C8)', () => {
  const T0 = Date.parse('2026-07-02T13:00:00Z');
  const ts = (s: number) =>
    new Date(T0 + s * 1000).toISOString().replace(/\.000Z$/, 'Z');

  const span = (id: string, over: Partial<RawSpan>): RawSpan => ({
    id,
    parentId: 'root',
    kind: 'other',
    name: id,
    status: 'ok',
    startedAt: ts(0),
    attributes: {},
    provenance: { file: 'x.jsonl', line: 1 },
    ...over,
  });
  const root = (): RawSpan =>
    span('root', {
      parentId: null,
      kind: 'session',
      name: 'session',
      agent: { sessionId: 's' },
    });
  const llm = (
    id: string,
    sec: number,
    o: {
      model?: string;
      parentId?: string;
      cost?: number;
      source?: 'computed' | 'reported' | 'unknown';
      input?: number;
      cacheRead?: number;
    } = {},
  ): RawSpan =>
    span(id, {
      kind: 'llm_call',
      startedAt: ts(sec),
      parentId: o.parentId ?? 'root',
      llm: {
        provider: 'anthropic',
        model: o.model ?? 'claude-opus-4-8',
        tokens: {
          input: o.input ?? 10_000,
          output: 1000,
          cacheRead: o.cacheRead ?? 0,
          cacheWrite: 0,
        },
        ...(o.cost === undefined ? {} : { costUSD: o.cost }),
        costSource: o.source ?? (o.cost === undefined ? 'unknown' : 'computed'),
      },
    });
  const sub = (id: string, sec: number, parentId = 'root'): RawSpan =>
    span(id, {
      kind: 'subagent',
      name: `subagent:${id}`,
      startedAt: ts(sec),
      parentId,
      agent: { name: id },
    });
  const tool = (
    id: string,
    sec: number,
    o: { parentId?: string; status?: RawSpan['status'] } = {},
  ): RawSpan =>
    span(id, {
      kind: 'tool_call',
      name: 'Bash',
      startedAt: ts(sec),
      parentId: o.parentId ?? 'root',
      status: o.status ?? 'ok',
      tool: { name: 'Bash', isError: o.status === 'error' },
    });

  const mk = (spans: RawSpan[]) =>
    normalize({
      source: {
        tool: 'claude-code',
        format: 'claude-jsonl',
        files: ['x.jsonl'],
      },
      spans,
      warnings: [],
    });

  const bundled = bundledPricing();
  const opus = matchModel(bundled, 'claude-opus-4-8');
  const sonnet5 = matchModel(bundled, 'claude-sonnet-5');
  if (!opus || !sonnet5) throw new Error('snapshot must cover opus/sonnet');

  it('computes per-span deltas at target rates and exact rollups', () => {
    const run = mk([root(), llm('l1', 1, { cost: 1.5 })]);
    const r = repriceRun(run, bundled);
    expect(r.spans).toHaveLength(1);
    const s = r.spans[0];
    expect(s?.target).toBe('claude-sonnet-5');
    const expected = computeCostUSD(sonnet5, {
      input: 10_000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(s?.repricedUSD).toBe(expected);
    expect(s?.deltaUSD).toBeCloseTo(expected - 1.5, 6);
    expect(r.repricedUSD).toBeCloseTo(r.currentUSD + r.deltaUSD, 6);
  });

  it('reprices the attribute-declared 1h cache-write share at the 1h rate', () => {
    const base = llm('l1', 1, { cost: 1.5 });
    const withWrite: RawSpan = {
      ...base,
      attributes: { [CACHE_WRITE_1H_ATTR]: 500_000 },
      llm: {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 500_000 },
        costUSD: 1.5,
        costSource: 'computed',
      },
    };
    const run = mk([root(), withWrite]);
    const r = repriceRun(run, bundled);
    const expected = computeCostUSD(
      sonnet5,
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 500_000 },
      500_000,
    );
    expect(r.spans[0]?.repricedUSD).toBe(expected);
    // the 1h share must not be repriced at the target's 5m rate
    expect(expected).toBeGreaterThan(
      computeCostUSD(sonnet5, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 500_000,
      }),
    );
  });

  it('reported costs are honored as the current side', () => {
    const run = mk([root(), llm('l1', 1, { cost: 2.0, source: 'reported' })]);
    const r = repriceRun(run, bundled);
    expect(r.spans[0]?.currentUSD).toBe(2.0);
    expect(r.spans[0]?.deltaUSD).toBeDefined();
  });

  it('unknown-cost spans taint their subtree and stay out of the safe delta', () => {
    const run = mk([
      root(),
      sub('worker', 1),
      llm('l1', 2, { parentId: 'worker', source: 'unknown' }),
      llm('l2', 3, { cost: 1.0 }),
    ]);
    const r = repriceRun(run, bundled);
    const workerCell = r.subtrees.find((c) => c.rootId !== null);
    expect(workerCell?.flags).toContain('unpriced');
    const main = r.subtrees.find((c) => c.rootId === null);
    expect(main?.flags).toEqual([]);
    expect(r.safeDeltaUSD).toBe(main?.deltaUSD);
  });

  it('self-mapped models contribute zero delta', () => {
    const run = mk([
      root(),
      llm('l1', 1, { model: 'claude-haiku-4-5', cost: 0.1 }),
    ]);
    const r = repriceRun(run, bundled);
    expect(r.spans[0]?.target).toBe('claude-haiku-4-5');
    expect(r.spans[0]?.deltaUSD).toBe(0);
    expect(r.deltaUSD).toBe(0);
  });

  it('risk flags: errors and tool fan-out exclude a cell from the safe figure', () => {
    const run = mk([
      root(),
      sub('risky', 1),
      llm('l1', 2, { parentId: 'risky', cost: 1.0 }),
      tool('t1', 3, { parentId: 'risky', status: 'error' }),
      llm('l2', 4, { cost: 1.0 }),
    ]);
    const r = repriceRun(run, bundled, undefined, {
      riskToolCalls: 1,
      riskContextTokens: 150_000,
    });
    const risky = r.subtrees.find((c) => c.rootId !== null);
    expect(risky?.flags).toEqual(['errors', 'tool-fanout']);
    const main = r.subtrees.find((c) => c.rootId === null);
    expect(r.safeDeltaUSD).toBe(main?.deltaUSD);
  });

  it('long-context flag fires on input+cacheRead threshold', () => {
    const run = mk([
      root(),
      llm('l1', 1, { cost: 3.0, input: 50_000, cacheRead: 120_000 }),
    ]);
    const r = repriceRun(run, bundled);
    expect(r.subtrees[0]?.flags).toContain('long-context');
    expect(r.safeDeltaUSD).toBe(0);
  });

  it('nested delegation attributes innermost; ordering is |delta| desc then rootId', () => {
    const run = mk([
      root(),
      sub('outer', 1),
      sub('inner', 2, 'outer'),
      llm('l1', 3, { parentId: 'inner', cost: 5.0 }),
      llm('l2', 4, { parentId: 'outer', cost: 0.5 }),
      llm('l3', 5, { cost: 0.1 }),
    ]);
    const r = repriceRun(run, bundled);
    const inner = r.subtrees.find((c) => c.name === 'inner');
    const outer = r.subtrees.find((c) => c.name === 'outer');
    expect(inner?.currentUSD).toBe(5.0);
    expect(outer?.currentUSD).toBe(0.5); // l1 belongs to inner, not outer
    expect(r.subtrees[0]?.name).toBe('inner'); // largest |delta| first
    const again = repriceRun(run, bundled);
    expect(again.subtrees.map((c) => c.rootId)).toEqual(
      r.subtrees.map((c) => c.rootId),
    );
  });

  it('downgradeMap enumerates distinct models deterministically', () => {
    const run = mk([
      root(),
      llm('l1', 1, { model: 'claude-opus-4-8', cost: 1 }),
      llm('l2', 2, { model: 'claude-haiku-4-5', cost: 0.1 }),
      llm('l3', 3, { model: 'zz-unknown-model', cost: 0.2 }),
    ]);
    const map = downgradeMap(run, bundled);
    expect([...map.entries()]).toEqual([
      ['claude-haiku-4-5', 'claude-haiku-4-5'],
      ['claude-opus-4-8', 'claude-sonnet-5'],
      ['zz-unknown-model', 'zz-unknown-model'],
    ]);
  });
});

describe('unpricedCoverage (C7)', () => {
  const T0 = Date.parse('2026-07-02T13:00:00Z');
  const ts = (s: number) =>
    new Date(T0 + s * 1000).toISOString().replace(/\.000Z$/, 'Z');
  const mkLlm = (
    id: string,
    sec: number,
    model: string,
    source: 'computed' | 'unknown',
  ): RawSpan => ({
    id,
    parentId: 'root',
    kind: 'llm_call',
    name: model,
    status: 'ok',
    startedAt: ts(sec),
    attributes: {},
    provenance: { file: 'x.jsonl', line: 1 },
    llm: {
      provider: 'anthropic',
      model,
      tokens: {
        input: 100,
        output: 10,
        cacheRead: 5,
        cacheWrite: 2,
        reasoning: 3,
      },
      ...(source === 'computed' ? { costUSD: 0.1 } : {}),
      costSource: source,
    },
  });
  const rootSpan = (): RawSpan => ({
    id: 'root',
    parentId: null,
    kind: 'session',
    name: 'session',
    status: 'ok',
    startedAt: ts(0),
    attributes: {},
    provenance: { file: 'x.jsonl', line: 1 },
    agent: { sessionId: 's' },
  });
  const mkCovRun = (spans: RawSpan[]) =>
    normalize({
      source: {
        tool: 'claude-code',
        format: 'claude-jsonl',
        files: ['x.jsonl'],
      },
      spans,
      warnings: [],
    });

  it('counts unpriced calls, tokens, and names models in stable order', () => {
    const run = mkCovRun([
      rootSpan(),
      mkLlm('l1', 1, 'zeta-model', 'unknown'),
      mkLlm('l2', 2, 'alpha-model', 'unknown'),
      mkLlm('l3', 3, 'claude-opus-4-8', 'computed'),
      mkLlm('l4', 4, 'zeta-model', 'unknown'),
    ]);
    const c = unpricedCoverage(run);
    expect(c.llmCalls).toBe(4);
    expect(c.unpricedLlmCalls).toBe(3);
    expect(c.unpricedTokens).toBe(3 * 120);
    expect(c.models).toEqual(['alpha-model', 'zeta-model']);
    expect(c.complete).toBe(false);
  });

  it('fully priced runs report complete', () => {
    const run = mkCovRun([
      rootSpan(),
      mkLlm('l1', 1, 'claude-opus-4-8', 'computed'),
    ]);
    const c = unpricedCoverage(run);
    expect(c.complete).toBe(true);
    expect(c.unpricedLlmCalls).toBe(0);
    expect(c.models).toEqual([]);
  });
});

describe('cacheWrite1hTokens — attribute input hardening', () => {
  const quad = { input: 0, output: 0, cacheRead: 0, cacheWrite: 500_000 };
  it('coerces numeric strings (OTLP int64-as-string encoding)', () => {
    expect(cacheWrite1hTokens({ [CACHE_WRITE_1H_ATTR]: '200000' }, quad)).toBe(
      200_000,
    );
  });
  it('drops non-numeric or non-finite values without poisoning the count', () => {
    expect(cacheWrite1hTokens({ [CACHE_WRITE_1H_ATTR]: 'abc' }, quad)).toBe(0);
    expect(
      cacheWrite1hTokens({ [CACHE_WRITE_1H_ATTR]: Number.NaN }, quad),
    ).toBe(0);
    expect(cacheWrite1hTokens(undefined, quad)).toBe(0);
  });
});
