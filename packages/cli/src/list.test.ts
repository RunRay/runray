import type { Run, TraceFile } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import {
  formatRunTable,
  humanDuration,
  humanTokens,
  summarizeRuns,
} from './list.js';

const run: Run = {
  id: 'run_abc',
  source: { tool: 'claude-code', format: 'claude-jsonl', files: ['x.jsonl'] },
  title: 'Fix checkout tests',
  project: { name: 'shop' },
  startedAt: '2026-07-02T13:02:10Z',
  endedAt: '2026-07-02T13:11:42Z',
  durationMs: 572_000,
  spans: [],
  totals: {
    tokens: {
      input: 101_040,
      output: 4950,
      cacheRead: 21_600,
      cacheWrite: 11_020,
      reasoning: 0,
      total: 138_610,
    },
    costUSD: {
      total: 0.3959,
      wastedEstimate: 0.094,
      byModel: { 'claude-sonnet-4-6': 0.3959 },
    },
    counts: {
      llmCalls: 4,
      toolCalls: 3,
      toolErrors: 3,
      subagents: 1,
      maxDepth: 3,
    },
    cache: { hitRate: 0.176 },
  },
  insights: [
    {
      id: 'i1',
      ruleId: 'retry-loop',
      severity: 'warning',
      title: 'x',
      detail: 'y',
      spanIds: [],
    },
  ],
};

const traceFile: TraceFile = {
  schemaVersion: '0.1.0',
  generator: { name: 'runray', version: '0.1.0' },
  generatedAt: '2026-07-02T14:00:00Z',
  runs: [run],
};

describe('summarizeRuns', () => {
  it('emits the machine-readable fields from the cli spec (id, source, timing, tokens, cost)', () => {
    const [summary] = summarizeRuns(traceFile);
    expect(summary).toEqual({
      id: 'run_abc',
      source: 'claude-code',
      title: 'Fix checkout tests',
      project: 'shop',
      startedAt: '2026-07-02T13:02:10Z',
      endedAt: '2026-07-02T13:11:42Z',
      durationMs: 572_000,
      tokens: run.totals.tokens,
      costUSD: 0.3959,
      wastedUSD: 0.094,
      insights: 1,
      toolErrors: 3,
      unpricedLlmCalls: 0,
      unpricedTokens: 0,
    });
    // round-trips through JSON for scripting
    expect(JSON.parse(JSON.stringify(summarizeRuns(traceFile)))).toEqual(
      summarizeRuns(traceFile),
    );
  });
});

describe('human formatting', () => {
  it.each([
    [572_000, '9m32s'],
    [30_000, '30s'],
    [7_260_000, '2h1m'],
    [undefined, '-'],
  ])('%s ms → %s', (ms, expected) => {
    expect(humanDuration(ms)).toBe(expected);
  });

  it.each([
    [138_610, '138.6k'],
    [950, '950'],
    [2_500_000, '2.5M'],
  ])('%d tokens → %s', (n, expected) => {
    expect(humanTokens(n)).toBe(expected);
  });

  it('renders an aligned table with cost and flags', () => {
    const text = formatRunTable(summarizeRuns(traceFile));
    const [header, row] = text.split('\n');
    expect(header).toMatch(
      /DATE\s+SOURCE\s+PROJECT\s+TITLE\s+DUR\s+TOKENS\s+COST\s+FLAGS/,
    );
    expect(row).toContain('claude-code');
    expect(row).toContain('$0.40');
    expect(row).toContain('9m32s');
    expect(row).toContain('1 insight, 3 err');
  });
});
