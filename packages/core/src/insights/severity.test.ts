import type { Run } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import {
  applyInsights,
  DEFAULT_THRESHOLDS,
  type Finding,
  gradeSeverity,
  type InsightRule,
} from './index.js';

/**
 * Severity is graded by the engine from magnitude alone (spec: cost-engine
 * "Severity grading") — rules never set it. These tests pin the tiers, the
 * floors, the unsized cases, and the config override path.
 */

function stubRun(costUSD: number): Run {
  return {
    id: 'run_test',
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: '2026-07-07T11:00:00.000Z',
    spans: [],
    totals: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUSD: { total: costUSD, wastedEstimate: 0, byModel: {} },
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

/** A rule that emits exactly the findings handed to it — grading isolated. */
function emitting(findings: Finding[]): InsightRule {
  return { id: 'retry-loop', evaluate: () => findings };
}

function finding(estimatedWasteUSD?: number): Finding {
  return {
    ruleId: 'retry-loop',
    title: 't',
    detail: 'd',
    spanIds: [],
    ...(estimatedWasteUSD === undefined ? {} : { estimatedWasteUSD }),
  };
}

describe('gradeSeverity', () => {
  it('tiers by share of the run cost', () => {
    expect(gradeSeverity(20, 100)).toBe('critical'); // 20% ≥ 10%, ≥ $1
    expect(gradeSeverity(5, 100)).toBe('warning'); // 5% ≥ 2%, ≥ $0.05
    expect(gradeSeverity(1, 100)).toBe('info'); // 1% < 2%
  });

  it('applies an absolute floor per tier so cents never read as critical', () => {
    expect(gradeSeverity(0.6, 0.65)).toBe('warning'); // 92% but < $1
    expect(gradeSeverity(0.5, 0.5)).toBe('warning'); // 100% but < $1
    expect(gradeSeverity(0.04, 0.1)).toBe('info'); // 40% but < $0.05
    expect(gradeSeverity(1, 10)).toBe('critical'); // 10% and exactly $1
  });

  it('cannot size an unpriced finding or an unpriced run: info', () => {
    expect(gradeSeverity(undefined, 100)).toBe('info');
    expect(gradeSeverity(50, 0)).toBe('info');
    expect(gradeSeverity(50, Number.NaN)).toBe('info');
  });

  it('honours custom thresholds', () => {
    const t = { ...DEFAULT_THRESHOLDS.severity, criticalShare: 0.5 };
    expect(gradeSeverity(20, 100, t)).toBe('warning');
    expect(gradeSeverity(60, 100, t)).toBe('critical');
  });
});

describe('applyInsights grades every finding', () => {
  it('assigns severity from the estimate and the run cost, not from the rule', () => {
    const run = applyInsights(stubRun(100), {}, [
      emitting([finding(0.6), finding(), finding(20)]),
    ]);
    expect(run.insights.map((i) => i.severity)).toEqual([
      'info',
      'info',
      'critical',
    ]);
  });

  it('the same finding grades differently on a small run', () => {
    const small = applyInsights(stubRun(0.65), {}, [emitting([finding(0.6)])]);
    const large = applyInsights(stubRun(600), {}, [emitting([finding(0.6)])]);
    expect(small.insights[0]?.severity).toBe('warning');
    expect(large.insights[0]?.severity).toBe('info');
  });

  it('reads the tiers from insights.thresholds.severity overrides', () => {
    const run = applyInsights(
      stubRun(100),
      { severity: { warningShare: 0.001 } },
      [emitting([finding(0.6)])],
    );
    expect(run.insights[0]?.severity).toBe('warning');
  });
});
