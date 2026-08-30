import type { Run, SourceTool } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  filterRuns,
  periodAnchorDay,
  periodStartDay,
  projectKey,
  reconcileFilter,
  spendTrend,
} from './filter-runs';

function stubRun(overrides: {
  id: string;
  startedAt: string;
  project?: string;
  source?: SourceTool;
  cost?: number;
  byModel?: Record<string, number>;
}): Run {
  return {
    id: overrides.id,
    source: {
      tool: overrides.source ?? 'claude-code',
      format: 'claude-jsonl',
      files: [],
    },
    ...(overrides.project !== undefined && {
      project: { name: overrides.project },
    }),
    startedAt: overrides.startedAt,
    spans: [],
    totals: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUSD: {
        total: overrides.cost ?? 0,
        wastedEstimate: 0,
        byModel: overrides.byModel ?? {},
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

const runs = [
  stubRun({
    id: 'old-opencode',
    startedAt: '2026-06-20T10:00:00',
    project: 'alpha',
    source: 'opencode',
  }),
  stubRun({
    id: 'edge-of-window',
    startedAt: '2026-07-01T00:30:00',
    project: 'beta',
  }),
  stubRun({ id: 'no-project', startedAt: '2026-07-03T09:00:00' }),
  stubRun({
    id: 'newest',
    startedAt: '2026-07-07T14:00:00',
    project: 'alpha',
  }),
];

const modelDayRuns = [
  stubRun({
    id: 'm-opus',
    startedAt: '2026-07-01T09:00:00',
    byModel: { opus: 3 },
  }),
  stubRun({
    id: 'm-haiku',
    startedAt: '2026-07-03T09:00:00',
    byModel: { haiku: 1 },
  }),
  stubRun({
    id: 'm-both',
    startedAt: '2026-07-05T09:00:00',
    byModel: { opus: 2, haiku: 0.5 },
  }),
];

describe('filterRuns', () => {
  it('EMPTY_FILTER keeps every run', () => {
    expect(filterRuns(runs, EMPTY_FILTER).map((r) => r.id)).toEqual(
      runs.map((r) => r.id),
    );
  });

  it('filters by project, including the — placeholder group', () => {
    const alpha = filterRuns(runs, { ...EMPTY_FILTER, project: 'alpha' });
    expect(alpha.map((r) => r.id)).toEqual(['old-opencode', 'newest']);
    // the rank list shows runs without a project as '—'; clicking that row
    // must filter to exactly those runs
    const none = filterRuns(runs, { ...EMPTY_FILTER, project: '—' });
    expect(none.map((r) => r.id)).toEqual(['no-project']);
  });

  it('filters by source tool', () => {
    const opencode = filterRuns(runs, { ...EMPTY_FILTER, source: 'opencode' });
    expect(opencode.map((r) => r.id)).toEqual(['old-opencode']);
  });

  it('period anchors to the newest run, not wall-clock now (export determinism)', () => {
    // 7-day window ending at the newest run's local day (2026-07-07):
    // covers 07-01..07-07 inclusive — wherever "today" is when this runs.
    const week = filterRuns(runs, { ...EMPTY_FILTER, periodDays: 7 });
    expect(week.map((r) => r.id)).toEqual([
      'edge-of-window',
      'no-project',
      'newest',
    ]);
  });

  it('other filters never shift the period anchor', () => {
    // Newest run is claude-code; filtering to opencode must keep the window
    // anchored at 2026-07-07, so the June opencode run stays outside it.
    const result = filterRuns(runs, {
      ...EMPTY_FILTER,
      source: 'opencode',
      periodDays: 7,
    });
    expect(result).toEqual([]);
  });

  it('combines filters conjunctively', () => {
    const result = filterRuns(runs, {
      ...EMPTY_FILTER,
      project: 'alpha',
      source: 'claude-code',
      periodDays: 30,
    });
    expect(result.map((r) => r.id)).toEqual(['newest']);
  });

  it('filters by model (a run that spent on it) and by a single day', () => {
    const byModel = filterRuns(modelDayRuns, {
      ...EMPTY_FILTER,
      model: 'opus',
    });
    expect(byModel.map((r) => r.id)).toEqual(['m-opus', 'm-both']);
    const byDay = filterRuns(modelDayRuns, {
      ...EMPTY_FILTER,
      day: '2026-07-03',
    });
    expect(byDay.map((r) => r.id)).toEqual(['m-haiku']);
  });

  it('handles empty input', () => {
    expect(filterRuns([], { ...EMPTY_FILTER, periodDays: 7 })).toEqual([]);
  });
});

describe('reconcileFilter', () => {
  it('keeps filter values that still exist among the runs', () => {
    const filter = {
      ...EMPTY_FILTER,
      project: 'alpha',
      source: 'opencode' as const,
      periodDays: 7,
    };
    // same reference back when nothing rolled off (no needless store churn)
    expect(reconcileFilter(filter, runs)).toBe(filter);
  });

  it('drops a project that rolled off a --watch refresh, keeping the rest', () => {
    const filter = {
      ...EMPTY_FILTER,
      project: 'beta',
      source: 'opencode' as const,
      periodDays: 7,
    };
    // a refresh where project 'beta' is gone but opencode remains
    const refreshed = runs.filter((r) => projectKey(r) !== 'beta');
    expect(reconcileFilter(filter, refreshed)).toEqual({
      ...EMPTY_FILTER,
      source: 'opencode',
      periodDays: 7,
    });
  });

  it('drops a vanished source', () => {
    const filter = {
      ...EMPTY_FILTER,
      source: 'opencode' as const,
    };
    const noOpencode = runs.filter((r) => r.source.tool !== 'opencode');
    expect(reconcileFilter(filter, noOpencode)).toEqual(EMPTY_FILTER);
  });

  it('drops a drilled-down model or day that rolled off', () => {
    const model = { ...EMPTY_FILTER, model: 'opus' };
    const noOpus = modelDayRuns.filter((r) => r.id === 'm-haiku');
    expect(reconcileFilter(model, noOpus)).toEqual(EMPTY_FILTER);
    const day = { ...EMPTY_FILTER, day: '2026-07-01' };
    const notThatDay = modelDayRuns.filter((r) => r.id !== 'm-opus');
    expect(reconcileFilter(day, notThatDay)).toEqual(EMPTY_FILTER);
    // a model still present is kept (same reference)
    expect(reconcileFilter(model, modelDayRuns)).toBe(model);
  });

  it('leaves EMPTY_FILTER untouched (same reference)', () => {
    expect(reconcileFilter(EMPTY_FILTER, runs)).toBe(EMPTY_FILTER);
    expect(reconcileFilter(EMPTY_FILTER, [])).toBe(EMPTY_FILTER);
  });
});

describe('spendTrend', () => {
  // anchor 2026-07-14 → current window 07-08..07-14, previous 07-01..07-07
  const trendRuns = [
    stubRun({ id: 'cur-newest', startedAt: '2026-07-14T09:00:00', cost: 30 }),
    stubRun({ id: 'cur-2', startedAt: '2026-07-10T09:00:00', cost: 20 }),
    stubRun({ id: 'prev-1', startedAt: '2026-07-05T09:00:00', cost: 10 }),
    stubRun({ id: 'prev-2', startedAt: '2026-07-03T09:00:00', cost: 30 }),
    stubRun({ id: 'ancient', startedAt: '2026-06-01T09:00:00', cost: 999 }),
  ];

  it('compares the visible period to the equal-length one before it', () => {
    // current 50 (30+20) vs previous 40 (10+30) → +25%; the June run is
    // outside both windows and must not leak in
    expect(spendTrend(trendRuns, { ...EMPTY_FILTER, periodDays: 7 })).toEqual({
      currentUSD: 50,
      previousUSD: 40,
      deltaFraction: 0.25,
    });
  });

  it('suppresses without a bounded period (no baseline to compare)', () => {
    expect(spendTrend(trendRuns, EMPTY_FILTER)).toBeNull();
  });

  it('suppresses when the previous window holds fewer than 2 runs', () => {
    const oneBaseline = [
      stubRun({ id: 'cur-newest', startedAt: '2026-07-14T09:00:00', cost: 30 }),
      stubRun({ id: 'cur-2', startedAt: '2026-07-10T09:00:00', cost: 20 }),
      stubRun({ id: 'prev-only', startedAt: '2026-07-05T09:00:00', cost: 10 }),
    ];
    expect(
      spendTrend(oneBaseline, { ...EMPTY_FILTER, periodDays: 7 }),
    ).toBeNull();
  });

  it('suppresses when the previous window spent nothing (no percentage)', () => {
    const zeroBaseline = [
      stubRun({ id: 'cur', startedAt: '2026-07-14T09:00:00', cost: 30 }),
      stubRun({ id: 'prev-1', startedAt: '2026-07-05T09:00:00', cost: 0 }),
      stubRun({ id: 'prev-2', startedAt: '2026-07-03T09:00:00', cost: 0 }),
    ];
    expect(
      spendTrend(zeroBaseline, { ...EMPTY_FILTER, periodDays: 7 }),
    ).toBeNull();
  });

  it('scopes both windows by project/source without shifting the anchor', () => {
    // a beta run sits in the current window but must not count under project=alpha
    const mixed = [
      stubRun({
        id: 'cur-alpha',
        startedAt: '2026-07-14T09:00:00',
        project: 'alpha',
        cost: 30,
      }),
      stubRun({
        id: 'cur-beta',
        startedAt: '2026-07-12T09:00:00',
        project: 'beta',
        cost: 500,
      }),
      stubRun({
        id: 'prev-alpha-1',
        startedAt: '2026-07-05T09:00:00',
        project: 'alpha',
        cost: 10,
      }),
      stubRun({
        id: 'prev-alpha-2',
        startedAt: '2026-07-03T09:00:00',
        project: 'alpha',
        cost: 10,
      }),
    ];
    expect(
      spendTrend(mixed, { ...EMPTY_FILTER, project: 'alpha', periodDays: 7 }),
    ).toEqual({ currentUSD: 30, previousUSD: 20, deltaFraction: 0.5 });
  });

  it('suppresses when a single day is pinned (a point cannot trend)', () => {
    expect(
      spendTrend(trendRuns, {
        ...EMPTY_FILTER,
        periodDays: 7,
        day: '2026-07-14',
      }),
    ).toBeNull();
  });

  it('handles empty input', () => {
    expect(spendTrend([], { ...EMPTY_FILTER, periodDays: 7 })).toBeNull();
  });
});

describe('period helpers', () => {
  it('periodAnchorDay picks the newest local start day', () => {
    expect(periodAnchorDay(runs)).toBe('2026-07-07');
    expect(periodAnchorDay([])).toBeUndefined();
  });

  it('periodStartDay counts the window inclusively, across month bounds', () => {
    expect(periodStartDay('2026-07-07', 7)).toBe('2026-07-01');
    expect(periodStartDay('2026-07-07', 30)).toBe('2026-06-08');
    expect(periodStartDay('2026-07-07', 1)).toBe('2026-07-07');
  });

  it('projectKey mirrors the overview ranking placeholder', () => {
    expect(projectKey(runs[2] as Run)).toBe('—');
    expect(projectKey(runs[0] as Run)).toBe('alpha');
  });
});

describe('tool filter dimension (E5)', () => {
  const withTool = (id: string, toolName: string): Run => ({
    ...stubRun({ id, startedAt: '2026-07-07T10:00:00Z' }),
    spans: [
      {
        id: `${id}-t`,
        parentId: null,
        kind: 'tool_call',
        name: toolName,
        status: 'ok',
        startedAt: '2026-07-07T10:00:00Z',
        depth: 0,
        attributes: {},
        provenance: { file: 'x' },
        tool: { name: toolName, isError: false },
      },
    ],
  });

  it('filterRuns keeps runs containing at least one span of that tool', () => {
    const runs = [withTool('a', 'webfetch'), withTool('b', 'Bash')];
    const out = filterRuns(runs, { ...EMPTY_FILTER, tool: 'webfetch' });
    expect(out.map((r) => r.id)).toEqual(['a']);
  });

  it('reconcileFilter clears a tool that rolled off the data', () => {
    const runs = [withTool('a', 'Bash')];
    const kept = reconcileFilter({ ...EMPTY_FILTER, tool: 'Bash' }, runs);
    expect(kept.tool).toBe('Bash');
    const cleared = reconcileFilter(
      { ...EMPTY_FILTER, tool: 'webfetch' },
      runs,
    );
    expect(cleared.tool).toBeNull();
  });
});
