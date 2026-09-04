import type { Run, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { bundledPricing } from '../pricing/index.js';
import { contextCapEstimates, mainScopeLlmCalls } from './context-excess.js';
import { applyInsights } from './index.js';

/**
 * The context-excess formula is one function shared by the rule and the
 * Waste tab (cost-engine "Context ceiling estimates"): the figure against
 * the baseline equals the finding's estimate, ceilings shrink it, an
 * unpriced run keeps its tokens and loses its amounts, subagents are out.
 */

const T0 = Date.parse('2026-09-04T08:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function base(over: Partial<Span>): Span {
  return {
    id: 'x',
    parentId: 'sess',
    kind: 'llm_call',
    name: 'llm',
    status: 'ok',
    startedAt: at(0),
    depth: 1,
    attributes: {},
    provenance: { file: 'f' },
    ...over,
  } as Span;
}
function llm(id: string, s: number, cacheRead: number, parent = 'sess'): Span {
  return base({
    id,
    parentId: parent,
    startedAt: at(s),
    endedAt: at(s + 1),
    llm: {
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      tokens: { input: 2_000, output: 500, cacheRead, cacheWrite: 0 },
      costUSD: 0.5,
      costSource: 'computed',
    },
  });
}
function run(spans: Span[]): Run {
  return {
    id: 'run1',
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: at(0),
    spans: [
      base({
        id: 'sess',
        parentId: null,
        kind: 'session',
        name: 's',
        depth: 0,
      }),
      ...spans,
    ],
    totals: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUSD: { total: 100, wastedEstimate: 0, byModel: {} },
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

// contexts (input 2k + cache read): 20k · 22k · 24k, then 60k … 200k
const GROWING = [
  llm('l1', 0, 18_000),
  llm('l2', 10, 20_000),
  llm('l3', 20, 22_000),
  llm('l4', 30, 58_000),
  llm('l5', 40, 98_000),
  llm('l6', 50, 138_000),
  llm('l7', 60, 178_000),
  llm('l8', 70, 198_000),
];

describe('contextCapEstimates', () => {
  const table = bundledPricing();

  it("reproduces the rule's estimate against the baseline and shrinks it under a ceiling", () => {
    const graded = applyInsights(run(GROWING), {}, undefined, table);
    const finding = graded.insights.find((i) => i.ruleId === 'context-bloat');
    expect(finding?.estimatedWasteUSD).toBeGreaterThan(0);
    const est = contextCapEstimates(run(GROWING), table);
    expect(est?.baseline).toBe(22_000);
    expect(est?.last).toBe(180_000);
    expect(est?.counted).toBe(5);
    expect(est?.excess.tokens).toBe(570_000); // 38k + 78k + 118k + 158k + 178k
    expect(est?.excess.above).toBe(5);
    expect(est?.excess.usd).toBe(finding?.estimatedWasteUSD);
    expect(est?.ratePerMTok).toBeGreaterThan(0);
    expect(est?.caps.map((c) => [c.cap, c.tokens, c.above])).toEqual([
      [100_000, 220_000, 3], // 40k + 80k + 100k
      [200_000, 0, 0],
      [400_000, 0, 0],
    ]);
    const [cap100, cap200] = est?.caps ?? [];
    expect(cap100?.usd).toBeGreaterThan(0);
    expect(cap100?.usd ?? 0).toBeLessThan(est?.excess.usd ?? 0);
    expect(cap200?.usd).toBe(0);
  });

  it('keeps the tokens and drops the amounts without a pricing table', () => {
    const est = contextCapEstimates(run(GROWING));
    expect(est?.excess.tokens).toBe(570_000);
    expect(est?.excess.usd).toBeUndefined();
    expect(est?.ratePerMTok).toBeUndefined();
    expect(est?.caps.every((c) => c.usd === undefined)).toBe(true);
  });

  it('yields nothing below six main-scope calls, where the rule never fires', () => {
    expect(
      contextCapEstimates(run(GROWING.slice(0, 5)), table),
    ).toBeUndefined();
  });

  it('leaves subagent calls out of the baseline and the excess', () => {
    const withSub = run([
      ...GROWING,
      base({
        id: 'sub',
        kind: 'subagent',
        name: 'sub',
        startedAt: at(5),
        endedAt: at(6),
      }),
      llm('s1', 5, 900_000, 'sub'),
    ]);
    expect(mainScopeLlmCalls(withSub).map((s) => s.id)).toEqual(
      GROWING.map((s) => s.id),
    );
    expect(contextCapEstimates(withSub, table)?.excess.tokens).toBe(570_000);
  });
});
