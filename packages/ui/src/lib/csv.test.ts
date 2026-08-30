import type { Run } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { dayAggregatesCsv, sessionsCsv } from './csv';

function stubRun(overrides: {
  id: string;
  startedAt?: string;
  cost?: number;
  wasted?: number;
  title?: string;
  byModel?: Record<string, number>;
}): Run {
  return {
    id: overrides.id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
    startedAt: overrides.startedAt ?? '2026-07-07T10:00:00Z',
    spans: [],
    totals: {
      tokens: {
        input: 100,
        output: 10,
        cacheRead: 5,
        cacheWrite: 2,
        total: 117,
      },
      costUSD: {
        total: overrides.cost ?? 1,
        wastedEstimate: overrides.wasted ?? 0,
        byModel: overrides.byModel ?? { m1: overrides.cost ?? 1 },
      },
      counts: {
        llmCalls: 2,
        toolCalls: 3,
        toolErrors: 1,
        subagents: 0,
        maxDepth: 1,
      },
      cache: { hitRate: 0 },
    },
    insights: [],
  };
}

describe('sessionsCsv (D5)', () => {
  it('is byte-deterministic regardless of input order', () => {
    const a = stubRun({ id: 'run_a', startedAt: '2026-07-07T10:00:00Z' });
    const b = stubRun({ id: 'run_b', startedAt: '2026-07-06T10:00:00Z' });
    expect(sessionsCsv([a, b])).toBe(sessionsCsv([b, a]));
    // canonical sort: startedAt then id — b (earlier) first
    const lines = sessionsCsv([a, b]).split('\r\n');
    expect(lines[1]?.startsWith('run_b')).toBe(true);
  });

  it('RFC 4180: quotes fields with commas and doubles embedded quotes', () => {
    const run = stubRun({ id: 'run_q', title: 'fix "auth", part 2' });
    const csv = sessionsCsv([run]);
    expect(csv).toContain('"fix ""auth"", part 2"');
  });

  it('numbers are locale-free String(n); CRLF + BOM framing', () => {
    const csv = sessionsCsv([stubRun({ id: 'r', cost: 0.3959 })]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('0.3959');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('dayAggregatesCsv (D5)', () => {
  it('aggregates per local day with stable per-model columns', () => {
    const csv = dayAggregatesCsv([
      stubRun({
        id: 'a',
        startedAt: '2026-07-07T10:00:00Z',
        cost: 2,
        byModel: { zeta: 2 },
      }),
      stubRun({
        id: 'b',
        startedAt: '2026-07-07T12:00:00Z',
        cost: 3,
        byModel: { alpha: 3 },
      }),
      stubRun({
        id: 'c',
        startedAt: '2026-07-06T10:00:00Z',
        cost: 1,
        byModel: { alpha: 1 },
      }),
    ]);
    const lines = csv.replace('﻿', '').trimEnd().split('\r\n');
    expect(lines[0]).toBe('day,costUSD,wastedUSD,runs,alpha,zeta');
    expect(lines[1]?.startsWith('2026-07-06,1,0,1,1,0')).toBe(true);
    expect(lines[2]?.startsWith('2026-07-07,5,0,2,3,2')).toBe(true);
  });
});
