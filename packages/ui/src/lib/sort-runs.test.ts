import type { Run } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { sortRuns } from './sort-runs';

function stubRun(overrides: {
  id: string;
  startedAt?: string;
  title?: string;
  project?: string;
  durationMs?: number;
  tokens?: number;
  cost?: number;
  models?: string[];
}): Run {
  return {
    id: overrides.id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    ...(overrides.title !== undefined && { title: overrides.title }),
    ...(overrides.project !== undefined && {
      project: { name: overrides.project },
    }),
    startedAt: overrides.startedAt ?? '2026-07-07T10:00:00.000Z',
    ...(overrides.durationMs !== undefined && {
      durationMs: overrides.durationMs,
    }),
    spans: [],
    totals: {
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: overrides.tokens ?? 0,
      },
      costUSD: {
        total: overrides.cost ?? 0,
        wastedEstimate: 0,
        byModel: Object.fromEntries(
          (overrides.models ?? []).map((m) => [m, 0.01]),
        ),
      },
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

describe('sortRuns', () => {
  it('sorts by cost in both directions without mutating the input', () => {
    const runs = [
      stubRun({ id: 'a', cost: 2 }),
      stubRun({ id: 'b', cost: 0.5 }),
      stubRun({ id: 'c', cost: 10 }),
    ];
    expect(sortRuns(runs, 'cost', 'desc').map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(sortRuns(runs, 'cost', 'asc').map((r) => r.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(runs.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('defaults to recency: date desc puts the newest run first', () => {
    const runs = [
      stubRun({ id: 'old', startedAt: '2026-07-01T00:00:00.000Z' }),
      stubRun({ id: 'new', startedAt: '2026-07-07T00:00:00.000Z' }),
    ];
    expect(sortRuns(runs, 'date', 'desc')[0]?.id).toBe('new');
  });

  it('sinks missing values to the bottom in either direction', () => {
    const runs = [
      stubRun({ id: 'no-duration' }),
      stubRun({ id: 'short', durationMs: 100 }),
      stubRun({ id: 'long', durationMs: 900 }),
    ];
    expect(sortRuns(runs, 'duration', 'asc').map((r) => r.id)).toEqual([
      'short',
      'long',
      'no-duration',
    ]);
    expect(sortRuns(runs, 'duration', 'desc').map((r) => r.id)).toEqual([
      'long',
      'short',
      'no-duration',
    ]);
  });

  it('breaks ties deterministically (newest first, then id)', () => {
    const runs = [
      stubRun({ id: 'b', cost: 1, startedAt: '2026-07-07T00:00:00.000Z' }),
      stubRun({ id: 'a', cost: 1, startedAt: '2026-07-07T00:00:00.000Z' }),
      stubRun({ id: 'z', cost: 1, startedAt: '2026-07-08T00:00:00.000Z' }),
    ];
    expect(sortRuns(runs, 'cost', 'asc').map((r) => r.id)).toEqual([
      'z',
      'a',
      'b',
    ]);
  });

  it('sorts titles case-insensitively', () => {
    const runs = [
      stubRun({ id: 'b', title: 'Zebra' }),
      stubRun({ id: 'a', title: 'alpha' }),
    ];
    expect(sortRuns(runs, 'title', 'asc').map((r) => r.id)).toEqual(['a', 'b']);
  });
});
