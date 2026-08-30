import type { Run, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { buildRunTeaser, mostExpensiveRun } from './run-teaser';

function llmSpan(id: string, model: string, tokensIn: number): Span {
  return {
    id,
    parentId: null,
    kind: 'llm_call',
    name: id,
    status: 'ok',
    startedAt: '2026-07-07T10:00:00',
    durationMs: 10,
    depth: 1,
    llm: {
      provider: 'anthropic',
      model,
      tokens: {
        input: tokensIn,
        output: 20,
        cacheRead: tokensIn * 3,
        cacheWrite: 0,
      },
      costUSD: 1,
      costSource: 'computed',
    },
    attributes: {},
    provenance: { file: 'x', line: 1 },
  };
}

function run(opts: {
  byModel: Record<string, number>;
  total: number;
  spans?: Span[];
}): Run {
  return {
    id: 'r1',
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    title: 'audit run',
    startedAt: '2026-07-07T10:00:00',
    spans: opts.spans ?? [],
    totals: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUSD: { total: opts.total, wastedEstimate: 0, byModel: opts.byModel },
      counts: {
        llmCalls: 0,
        toolCalls: 0,
        toolErrors: 0,
        subagents: 0,
        maxDepth: 0,
      },
      cache: { hitRate: 0 },
    },
    insights: [],
  };
}

describe('buildRunTeaser', () => {
  it('splits cost by model (biggest first, shares of the total) with token detail', () => {
    const teaser = buildRunTeaser(
      run({
        byModel: { opus: 8, haiku: 2 },
        total: 10,
        spans: [llmSpan('a', 'opus', 100), llmSpan('b', 'haiku', 50)],
      }),
    );
    expect(teaser).not.toBeNull();
    if (teaser === null) return;
    expect(teaser.rows.map((r) => [r.model, r.costUSD])).toEqual([
      ['opus', 8],
      ['haiku', 2],
    ]);
    expect(teaser.rows[0]?.shareOfRun).toBeCloseTo(0.8, 10);
    expect(teaser.otherUSD).toBe(0);
    // inspector spotlights the biggest model + its aggregate span detail
    expect(teaser.topModel).toBe('opus');
    expect(teaser.topCostUSD).toBe(8);
    expect(teaser.topDetail.calls).toBe(1);
    expect(teaser.topDetail.tokensIn).toBe(100);
  });

  it('surfaces cost not attributed to any model as "other"', () => {
    const teaser = buildRunTeaser(run({ byModel: { opus: 6 }, total: 10 }));
    expect(teaser?.otherUSD).toBe(4); // 10 total − 6 attributed
  });

  it('returns null when the run has no priced models', () => {
    expect(buildRunTeaser(run({ byModel: {}, total: 0 }))).toBeNull();
  });
});

describe('mostExpensiveRun', () => {
  it('picks the priciest priced run, undefined when all free', () => {
    const cheap = run({ byModel: { opus: 0.5 }, total: 0.5 });
    const dear = { ...run({ byModel: { opus: 9 }, total: 9 }), id: 'r2' };
    expect(mostExpensiveRun([cheap, dear])?.id).toBe('r2');
    expect(mostExpensiveRun([run({ byModel: {}, total: 0 })])).toBeUndefined();
  });
});
