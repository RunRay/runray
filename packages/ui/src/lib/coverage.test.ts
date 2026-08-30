import type { Run, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { coverageOf } from './coverage';

function llmSpan(id: string, model: string, unpriced: boolean): Span {
  return {
    id,
    parentId: null,
    kind: 'llm_call',
    name: model,
    status: 'ok',
    startedAt: '2026-07-02T13:00:00Z',
    depth: 0,
    attributes: {},
    provenance: { file: 'x' },
    llm: {
      provider: 'anthropic',
      model,
      tokens: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0 },
      ...(unpriced ? {} : { costUSD: 0.1 }),
      costSource: unpriced ? 'unknown' : 'computed',
    },
  };
}

function run(id: string, spans: Span[]): Run {
  return {
    id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: '2026-07-02T13:00:00Z',
    spans,
    totals: {
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 0,
      },
      costUSD: { total: 0, wastedEstimate: 0, byModel: {} },
      counts: {
        llmCalls: spans.length,
        toolCalls: 0,
        toolErrors: 0,
        subagents: 0,
        maxDepth: 1,
      },
      cache: { hitRate: 0 },
    },
    insights: [],
  };
}

describe('coverageOf', () => {
  it('aggregates across runs with sorted model names', () => {
    const c = coverageOf([
      run('a', [llmSpan('1', 'zz-x', true), llmSpan('2', 'priced', false)]),
      run('b', [llmSpan('3', 'aa-y', true)]),
      run('c', [llmSpan('4', 'priced', false)]),
    ]);
    expect(c.llmCalls).toBe(4);
    expect(c.unpricedLlmCalls).toBe(2);
    expect(c.unpricedTokens).toBe(2 * 115);
    expect(c.models).toEqual(['aa-y', 'zz-x']);
    expect(c.runsAffected).toBe(2);
    expect(c.complete).toBe(false);
  });

  it('fully priced runs report complete', () => {
    const c = coverageOf([run('a', [llmSpan('1', 'm', false)])]);
    expect(c.complete).toBe(true);
    expect(c.models).toEqual([]);
  });
});
