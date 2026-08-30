import type { Run, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { timeBreakdown, toolDurationStats } from './time-breakdown';

const T0 = Date.parse('2026-07-02T13:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function span(
  id: string,
  kind: Span['kind'],
  startSec: number,
  endSec?: number,
  name = id,
): Span {
  return {
    id,
    parentId: null,
    kind,
    name,
    status: 'ok',
    startedAt: at(startSec),
    ...(endSec === undefined
      ? {}
      : { endedAt: at(endSec), durationMs: (endSec - startSec) * 1000 }),
    depth: 0,
    attributes: {},
    provenance: { file: 'x' },
  };
}

function mkRun(spans: Span[]): Run {
  return {
    id: 'run_t',
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: at(0),
    spans,
    totals: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUSD: { total: 0, wastedEstimate: 0, byModel: {} },
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

describe('timeBreakdown (E2)', () => {
  it('segments sum exactly to wall-clock; parallel spans never double-count', () => {
    // two OVERLAPPING llm calls (parallel subagents) + one tool + a gap
    const run = mkRun([
      span('session', 'session', 0, 200),
      span('l1', 'llm_call', 0, 60),
      span('l2', 'llm_call', 30, 90), // overlaps l1 by 30s
      span('t1', 'tool_call', 90, 110),
      // 110..200 = 90s gap ≥ 60s idle threshold
    ]);
    const b = timeBreakdown(run);
    expect(b.wallClockMs).toBe(200_000);
    const sum =
      b.totals.model + b.totals.tool + b.totals.coordination + b.totals.idle;
    expect(sum).toBe(b.wallClockMs);
    expect(b.totals.model).toBe(90_000); // union of l1∪l2, not 150s
    expect(b.totals.tool).toBe(20_000);
    expect(b.totals.idle).toBe(90_000);
    // Σ active (60+60+20) / covered (90+20) ≈ ×1.27 parallel compression
    expect(b.parallelism).toBeCloseTo(140 / 110, 3);
  });

  it('model wait wins over tool execution on overlap', () => {
    const run = mkRun([
      span('session', 'session', 0, 100),
      span('l1', 'llm_call', 0, 100),
      span('t1', 'tool_call', 20, 40),
    ]);
    const b = timeBreakdown(run);
    expect(b.totals.model).toBe(100_000);
    expect(b.totals.tool).toBe(0);
  });

  it('short gaps are coordination, long ones idle (own display threshold)', () => {
    const run = mkRun([
      span('session', 'session', 0, 130),
      span('l1', 'llm_call', 0, 10),
      span('l2', 'llm_call', 40, 50), // 30s gap < 60s → coordination
      span('l3', 'llm_call', 120, 130), // 70s gap ≥ 60s → idle
    ]);
    const b = timeBreakdown(run);
    expect(b.totals.coordination).toBe(30_000);
    expect(b.totals.idle).toBe(70_000);
  });

  it('in-progress spans contribute zero length', () => {
    const run = mkRun([
      span('session', 'session', 0, 50),
      span('open', 'llm_call', 10), // no end
      span('l1', 'llm_call', 0, 20),
    ]);
    const b = timeBreakdown(run);
    expect(b.totals.model).toBe(20_000);
  });
});

describe('toolDurationStats', () => {
  it('nearest-rank p50/p95, ordered p95-desc with stable name ties', () => {
    const spans = [span('session', 'session', 0, 500)];
    for (let i = 1; i <= 10; i++) {
      spans.push(span(`b${i}`, 'tool_call', i * 10, i * 10 + i, 'Bash'));
    }
    spans.push(span('g1', 'tool_call', 200, 203, 'Glob'));
    const stats = toolDurationStats(mkRun(spans));
    expect(stats[0]?.name).toBe('Bash');
    expect(stats[0]?.calls).toBe(10);
    expect(stats[0]?.p50Ms).toBe(5000); // nearest-rank: 5th of 10 sorted
    expect(stats[0]?.p95Ms).toBe(10_000); // ceil(0.95*10)=10th
    expect(stats[1]?.name).toBe('Glob');
  });
});
