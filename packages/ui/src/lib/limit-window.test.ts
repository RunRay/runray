import type { Run } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import {
  hasBudget,
  limitShare,
  windowBounds,
  windowSpend,
} from './limit-window';

// TZ-proof assertions: relative properties (containment, local day-of-week,
// local hour, exact length) instead of absolute epoch values.

const DAY_MS = 86_400_000;

function costRun(id: string, startedAt: string, cost: number): Run {
  return {
    id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt,
    spans: [],
    totals: {
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1000,
      },
      costUSD: { total: cost, wastedEstimate: 0, byModel: {} },
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

describe('windowBounds (E1)', () => {
  const anchor = '2026-07-18T09:30:00'; // a Saturday, local time

  it('is deterministic and anchored — never Date.now()', () => {
    const a = windowBounds(anchor, { days: 7, resetDay: 'thu' });
    const b = windowBounds(anchor, { days: 7, resetDay: 'thu' });
    expect(a).toEqual(b);
    expect(a.end - a.start).toBe(7 * DAY_MS);
    const t = Date.parse(anchor);
    expect(t).toBeGreaterThanOrEqual(a.start);
    expect(t).toBeLessThan(a.end);
  });

  it('starts on the configured local reset day and hour', () => {
    const bounds = windowBounds(anchor, {
      days: 7,
      resetDay: 'thu',
      resetHour: 14,
    });
    const start = new Date(bounds.start);
    expect(start.getDay()).toBe(4); // thursday
    expect(start.getHours()).toBe(14);
  });

  it('an anchor before the reset hour lands in the PREVIOUS window', () => {
    const before = windowBounds('2026-07-16T10:00:00', {
      days: 7,
      resetDay: 'thu',
      resetHour: 14,
    });
    const after = windowBounds('2026-07-16T15:00:00', {
      days: 7,
      resetDay: 'thu',
      resetHour: 14,
    });
    expect(after.start - before.start).toBe(7 * DAY_MS);
  });

  it('days < 7 steps sub-week windows from the reset reference', () => {
    const bounds = windowBounds(anchor, { days: 1, resetDay: 'mon' });
    expect(bounds.end - bounds.start).toBe(DAY_MS);
    const t = Date.parse(anchor);
    expect(t).toBeGreaterThanOrEqual(bounds.start);
    expect(t).toBeLessThan(bounds.end);
  });
});

describe('windowSpend + limitShare', () => {
  it('buckets by startedAt and computes budget-based shares', () => {
    const bounds = windowBounds('2026-07-18T09:30:00', {
      days: 7,
      resetDay: 'mon',
    });
    const inside = costRun(
      'in',
      new Date(bounds.start + DAY_MS).toISOString(),
      30,
    );
    const outside = costRun(
      'out',
      new Date(bounds.start - DAY_MS).toISOString(),
      99,
    );
    const spend = windowSpend([inside, outside], bounds);
    expect(spend).toEqual({ costUSD: 30, tokens: 1000, runs: 1 });

    const cfg = { budgetUSD: 120 };
    expect(hasBudget(cfg)).toBe(true);
    expect(limitShare(30, spend, cfg)).toBeCloseTo(0.25, 6);
    // no budget → denominator is spend-to-date
    expect(limitShare(15, spend, {})).toBeCloseTo(0.5, 6);
    // empty window → no meaningful share
    expect(
      limitShare(1, { costUSD: 0, tokens: 0, runs: 0 }, {}),
    ).toBeUndefined();
  });
});
