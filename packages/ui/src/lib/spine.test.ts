import type { Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { buildCostSeries, buildSpineSegments, cumulativeCostAt } from './spine';

const at = (sec: number) =>
  `2026-07-07T10:00:${String(sec).padStart(2, '0')}.000Z`;
const atMs = (sec: number) => Date.parse(at(sec));

function llmSpan(overrides: {
  id: string;
  startedAt: string;
  durationMs: number;
  costUSD?: number;
  costSource?: 'reported' | 'computed' | 'unknown';
}): Span {
  return {
    id: overrides.id,
    parentId: null,
    kind: 'llm_call',
    name: 'model',
    status: 'ok',
    startedAt: overrides.startedAt,
    durationMs: overrides.durationMs,
    depth: 0,
    llm: {
      provider: 'anthropic',
      model: 'model',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      ...(overrides.costUSD !== undefined && { costUSD: overrides.costUSD }),
      costSource: overrides.costSource ?? 'computed',
    },
    attributes: {},
    provenance: { file: 'stub.jsonl' },
  };
}

describe('buildCostSeries', () => {
  it('accumulates priced spans at their end time, sorted', () => {
    const series = buildCostSeries([
      llmSpan({ id: 'b', startedAt: at(10), durationMs: 2000, costUSD: 0.2 }),
      llmSpan({ id: 'a', startedAt: at(0), durationMs: 1000, costUSD: 0.1 }),
    ]);
    expect(series).toEqual([
      { t: atMs(1), cumulative: 0.1 },
      { t: atMs(12), cumulative: 0.30000000000000004 },
    ]);
  });

  it('skips unpriced and unknown-source spans', () => {
    const series = buildCostSeries([
      llmSpan({ id: 'a', startedAt: at(0), durationMs: 1000 }),
      llmSpan({
        id: 'b',
        startedAt: at(1),
        durationMs: 1000,
        costUSD: 1,
        costSource: 'unknown',
      }),
      llmSpan({ id: 'c', startedAt: at(2), durationMs: 1000, costUSD: 0.5 }),
    ]);
    expect(series).toHaveLength(1);
    expect(series[0]?.cumulative).toBe(0.5);
  });
});

describe('cumulativeCostAt', () => {
  const series = [
    { t: 1000, cumulative: 0.1 },
    { t: 5000, cumulative: 0.4 },
  ];
  it('steps through the series', () => {
    expect(cumulativeCostAt(series, 0)).toBe(0);
    expect(cumulativeCostAt(series, 1000)).toBe(0.1);
    expect(cumulativeCostAt(series, 4999)).toBe(0.1);
    expect(cumulativeCostAt(series, 99999)).toBe(0.4);
  });
});

describe('buildSpineSegments', () => {
  it('maps spend bursts to hot segments and idle stretches to heat 0', () => {
    // All the cost lands in the first second of a 10s run.
    const spans = [
      llmSpan({ id: 'a', startedAt: at(0), durationMs: 500, costUSD: 0.5 }),
    ];
    const segments = buildSpineSegments(
      buildCostSeries(spans),
      { start: atMs(0), end: atMs(10) },
      10,
    );
    expect(segments).toHaveLength(10);
    expect(segments[0]?.heat).toBe(3);
    expect(segments.slice(1).every((s) => s.heat === 0)).toBe(true);
    // Cumulative fraction hits 1 after the burst and stays there.
    expect(segments[0]?.c1).toBe(1);
    expect(segments[9]?.c1).toBe(1);
  });

  it('handles zero-cost runs without NaN', () => {
    const segments = buildSpineSegments([], { start: 0, end: 1000 }, 4);
    expect(
      segments.every((s) => s.c0 === 0 && s.c1 === 0 && s.heat === 0),
    ).toBe(true);
  });

  it('grades heat relative to the steepest segment', () => {
    const spans = [
      llmSpan({ id: 'a', startedAt: at(0), durationMs: 100, costUSD: 0.9 }),
      llmSpan({ id: 'b', startedAt: at(5), durationMs: 100, costUSD: 0.3 }),
    ];
    const segments = buildSpineSegments(
      buildCostSeries(spans),
      { start: atMs(0), end: atMs(10) },
      10,
    );
    expect(segments[0]?.heat).toBe(3); // 0.9 = the max burst
    expect(segments[5]?.heat).toBe(1); // 0.3/0.9 = a third
  });
});
