import type { Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import {
  collapsedAncestorsOf,
  computeTimeRange,
  flattenVisible,
  hiddenFindings,
  insightsBySpan,
  laneMarks,
  matchingSpanIds,
  subagentRails,
  subagentSpanIds,
  subtreeRollups,
} from './waterfall';

function stubSpan(overrides: {
  id: string;
  parentId?: string | null;
  kind?: Span['kind'];
  startedAt?: string;
  durationMs?: number;
  depth?: number;
}): Span {
  return {
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    kind: overrides.kind ?? 'tool_call',
    name: overrides.id,
    status: 'ok',
    startedAt: overrides.startedAt ?? '2026-07-07T10:00:00.000Z',
    ...(overrides.durationMs !== undefined && {
      durationMs: overrides.durationMs,
    }),
    depth: overrides.depth ?? 0,
    attributes: {},
    provenance: { file: 'stub.jsonl' },
  };
}

const at = (sec: number) =>
  `2026-07-07T10:00:${String(sec).padStart(2, '0')}.000Z`;

describe('computeTimeRange', () => {
  it('spans min start to max end', () => {
    const range = computeTimeRange([
      stubSpan({ id: 'a', startedAt: at(0), durationMs: 5000 }),
      stubSpan({ id: 'b', startedAt: at(2), durationMs: 10000 }),
    ]);
    expect(range.end - range.start).toBe(12000);
  });

  it('never returns a zero-width range', () => {
    const range = computeTimeRange([stubSpan({ id: 'a', startedAt: at(0) })]);
    expect(range.end).toBeGreaterThan(range.start);
    expect(computeTimeRange([]).end).toBeGreaterThan(0);
  });
});

describe('flattenVisible', () => {
  const spans = [
    stubSpan({ id: 'root', startedAt: at(0), durationMs: 30000 }),
    stubSpan({ id: 'c1', parentId: 'root', startedAt: at(1), depth: 1 }),
    stubSpan({ id: 'c2', parentId: 'root', startedAt: at(2), depth: 1 }),
    stubSpan({ id: 'g1', parentId: 'c2', startedAt: at(3), depth: 2 }),
  ];

  it('emits depth-first rows preserving span order', () => {
    const rows = flattenVisible({ spans }, new Set());
    expect(rows.map((r) => r.span.id)).toEqual(['root', 'c1', 'c2', 'g1']);
    expect(rows[0]?.hasChildren).toBe(true);
    expect(rows[1]?.hasChildren).toBe(false);
  });

  it('collapse hides the whole subtree and counts it', () => {
    const rows = flattenVisible({ spans }, new Set(['root']));
    expect(rows.map((r) => r.span.id)).toEqual(['root']);
    expect(rows[0]?.collapsed).toBe(true);
    expect(rows[0]?.hiddenDescendants).toBe(3);

    const partial = flattenVisible({ spans }, new Set(['c2']));
    expect(partial.map((r) => r.span.id)).toEqual(['root', 'c1', 'c2']);
    expect(partial[2]?.hiddenDescendants).toBe(1);
  });

  it('ignores collapse marks on leaves', () => {
    const rows = flattenVisible({ spans }, new Set(['c1']));
    expect(rows).toHaveLength(4);
    expect(rows[1]?.collapsed).toBe(false);
  });
});

describe('matchingSpanIds + filtered flatten', () => {
  const spans = [
    stubSpan({ id: 'root', startedAt: at(0), durationMs: 30000 }),
    stubSpan({ id: 'c1', parentId: 'root', startedAt: at(1), depth: 1 }),
    stubSpan({ id: 'c2', parentId: 'root', startedAt: at(2), depth: 1 }),
    stubSpan({ id: 'g1', parentId: 'c2', startedAt: at(3), depth: 2 }),
  ];

  it('keeps matches and their ancestors, case-insensitively', () => {
    const ids = matchingSpanIds(spans, 'G1');
    expect(ids).not.toBeNull();
    expect([...(ids ?? [])].sort()).toEqual(['c2', 'g1', 'root']);
  });

  it('returns null for an empty query (no filtering)', () => {
    expect(matchingSpanIds(spans, '')).toBeNull();
    expect(matchingSpanIds(spans, '  ')).toBeNull();
  });

  it('flattenVisible drops rows outside the filter set', () => {
    const ids = matchingSpanIds(spans, 'g1');
    const rows = flattenVisible({ spans }, new Set(), ids ?? undefined);
    expect(rows.map((r) => r.span.id)).toEqual(['root', 'c2', 'g1']);
  });

  it('no matches yields no rows', () => {
    const ids = matchingSpanIds(spans, 'zzz');
    expect(ids?.size).toBe(0);
    expect(flattenVisible({ spans }, new Set(), ids ?? undefined)).toEqual([]);
  });
});

describe('laneMarks', () => {
  it('marks overlapping sibling chains start/mid/end', () => {
    const marks = laneMarks([
      stubSpan({ id: 'a', startedAt: at(0), durationMs: 5000 }),
      stubSpan({ id: 'b', startedAt: at(2), durationMs: 5000 }),
      stubSpan({ id: 'c', startedAt: at(4), durationMs: 1000 }),
      stubSpan({ id: 'd', startedAt: at(20), durationMs: 1000 }),
    ]);
    expect(marks).toEqual(['start', 'mid', 'end', null]);
  });

  it('sequential siblings get no marks', () => {
    const marks = laneMarks([
      stubSpan({ id: 'a', startedAt: at(0), durationMs: 1000 }),
      stubSpan({ id: 'b', startedAt: at(1), durationMs: 1000 }),
    ]);
    expect(marks).toEqual([null, null]);
  });

  it('overlap is judged against the group max end, not the previous span', () => {
    // b is short; c still overlaps the group because a is long.
    const marks = laneMarks([
      stubSpan({ id: 'a', startedAt: at(0), durationMs: 10000 }),
      stubSpan({ id: 'b', startedAt: at(1), durationMs: 1000 }),
      stubSpan({ id: 'c', startedAt: at(5), durationMs: 1000 }),
    ]);
    expect(marks).toEqual(['start', 'mid', 'end']);
  });
});

describe('subagentSpanIds', () => {
  it('collects only subagent spans', () => {
    const ids = subagentSpanIds([
      stubSpan({ id: 'a' }),
      stubSpan({ id: 's1', kind: 'subagent' }),
      stubSpan({ id: 's2', kind: 'subagent' }),
    ]);
    expect(ids).toEqual(['s1', 's2']);
  });
});

describe('subagentRails', () => {
  const spans = [
    stubSpan({ id: 'session', kind: 'session' }),
    stubSpan({ id: 'own', parentId: 'session', depth: 1 }),
    stubSpan({ id: 'outer', parentId: 'session', kind: 'subagent', depth: 1 }),
    stubSpan({ id: 'turn', parentId: 'outer', kind: 'turn', depth: 2 }),
    stubSpan({ id: 'read', parentId: 'turn', depth: 3 }),
    stubSpan({ id: 'inner', parentId: 'turn', kind: 'subagent', depth: 3 }),
    stubSpan({ id: 'grep', parentId: 'inner', depth: 4 }),
    stubSpan({ id: 'orphan', parentId: 'gone', depth: 2 }),
  ];
  const rails = subagentRails(spans);

  it('lists the depth of every enclosing subagent, outermost first', () => {
    expect(rails.get('turn')).toEqual([1]);
    expect(rails.get('read')).toEqual([1]);
    expect(rails.get('inner')).toEqual([1]);
    expect(rails.get('grep')).toEqual([1, 3]);
  });

  it('gives a subagent only the rails of the subagents above it', () => {
    expect(rails.get('outer')).toEqual([]);
  });

  it('draws nothing for the orchestrator’s own spans or orphans', () => {
    expect(rails.get('session')).toEqual([]);
    expect(rails.get('own')).toEqual([]);
    expect(rails.get('orphan')).toEqual([]);
  });

  it('shares one array among siblings', () => {
    expect(rails.get('read')).toBe(rails.get('inner'));
  });
});

describe('subtreeRollups (D3)', () => {
  const llmStub = (
    id: string,
    parentId: string,
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      reasoning?: number;
    },
    costUSD?: number,
  ): Span => ({
    ...stubSpan({ id, parentId, kind: 'llm_call' }),
    llm: {
      provider: 'anthropic',
      model: 'm',
      tokens: { ...tokens, cacheWrite: 0 },
      ...(costUSD === undefined ? {} : { costUSD }),
      costSource: costUSD === undefined ? 'unknown' : 'computed',
    },
  });

  it('rolls nested subagents up with priced-only cost and honest unpriced counts', () => {
    const spans = [
      stubSpan({ id: 'root', parentId: null, kind: 'session' }),
      stubSpan({ id: 'sub', parentId: 'root', kind: 'subagent' }),
      llmStub('l1', 'sub', { input: 100, output: 10, cacheRead: 5 }, 0.5),
      stubSpan({ id: 'inner', parentId: 'sub', kind: 'subagent' }),
      llmStub('l2', 'inner', {
        input: 200,
        output: 20,
        cacheRead: 0,
        reasoning: 30,
      }),
      llmStub('l3', 'root', { input: 50, output: 5, cacheRead: 0 }, 0.25),
    ];
    const rollups = subtreeRollups(spans);
    expect(rollups.get('inner')).toEqual({
      costUSD: 0,
      unpricedCalls: 1,
      tokens: 250,
      llmCalls: 1,
    });
    expect(rollups.get('sub')).toEqual({
      costUSD: 0.5,
      unpricedCalls: 1,
      tokens: 365,
      llmCalls: 2,
    });
    expect(rollups.get('root')?.costUSD).toBeCloseTo(0.75, 6);
    expect(rollups.get('root')?.llmCalls).toBe(3);
  });
});

describe('collapsedAncestorsOf', () => {
  const spans = [
    stubSpan({ id: 'root' }),
    stubSpan({ id: 'agent', parentId: 'root', depth: 1 }),
    stubSpan({ id: 'call', parentId: 'agent', depth: 2 }),
    stubSpan({ id: 'other', parentId: 'root', depth: 1 }),
    stubSpan({ id: 'leaf', parentId: 'other', depth: 2 }),
  ];

  it('returns only the collapsed ancestors of the targets', () => {
    const hidden = collapsedAncestorsOf(
      spans,
      new Set(['call']),
      new Set(['agent', 'other', 'root']),
    );
    expect([...hidden].sort()).toEqual(['agent', 'root']);
  });

  it('is empty when nothing above a target is collapsed', () => {
    expect(
      collapsedAncestorsOf(spans, new Set(['call']), new Set(['other'])).size,
    ).toBe(0);
    expect(collapsedAncestorsOf(spans, new Set(), new Set(['root'])).size).toBe(
      0,
    );
  });

  it('ignores a collapsed target itself — only ancestors hide it', () => {
    expect(
      collapsedAncestorsOf(spans, new Set(['agent']), new Set(['agent'])).size,
    ).toBe(0);
  });
});

describe('insightsBySpan', () => {
  const finding = (
    id: string,
    severity: 'info' | 'warning' | 'critical',
    spanIds: string[],
    usd?: number,
  ) => ({
    id,
    ruleId: 'retry-loop',
    severity,
    title: id,
    detail: '',
    spanIds,
    ...(usd === undefined ? {} : { estimatedWasteUSD: usd }),
  });

  it('keys every evidence span and lists a shared span under each finding', () => {
    const map = insightsBySpan([
      finding('a', 'warning', ['s1', 's2']),
      finding('b', 'info', ['s2', 's3']),
    ]);
    expect([...map.keys()].sort()).toEqual(['s1', 's2', 's3']);
    expect(map.get('s2')?.map((i) => i.id)).toEqual(['a', 'b']);
    expect(map.get('s3')?.map((i) => i.id)).toEqual(['b']);
  });

  it('orders a span’s findings worst first: severity, then waste, then id', () => {
    const map = insightsBySpan([
      finding('cheap', 'warning', ['s'], 1),
      finding('info', 'info', ['s'], 50),
      finding('critical', 'critical', ['s']),
      finding('dear', 'warning', ['s'], 9),
    ]);
    expect(map.get('s')?.map((i) => i.id)).toEqual([
      'critical',
      'dear',
      'cheap',
      'info',
    ]);
  });

  it('is empty for a run without findings', () => {
    expect(insightsBySpan([]).size).toBe(0);
  });
});

describe('hiddenFindings', () => {
  const finding = (
    id: string,
    severity: 'info' | 'warning' | 'critical',
    spanIds: string[],
  ) => ({
    id,
    ruleId: 'retry-loop',
    severity,
    title: id,
    detail: '',
    spanIds,
  });
  const spans = [
    stubSpan({ id: 'session', kind: 'session' }),
    stubSpan({ id: 'agent', parentId: 'session', kind: 'subagent', depth: 1 }),
    stubSpan({ id: 'a1', parentId: 'agent', depth: 2 }),
    stubSpan({ id: 'inner', parentId: 'agent', kind: 'subagent', depth: 2 }),
    stubSpan({ id: 'i1', parentId: 'inner', depth: 3 }),
    stubSpan({ id: 'own', parentId: 'session', depth: 1 }),
  ];
  const retry = finding('retry', 'warning', ['a1', 'i1']);
  const loop = finding('loop', 'critical', ['i1']);
  const costly = finding('costly', 'warning', ['agent', 'a1']);
  const outside = finding('outside', 'info', ['own']);
  const all = [retry, loop, costly, outside];

  it('rolls findings up onto the collapsed row that hides all their evidence, worst first', () => {
    const hidden = hiddenFindings(spans, all, new Set(['agent']));
    expect(hidden.get('agent')?.map((f) => f.id)).toEqual(['loop', 'retry']);
    expect(hidden.has('session')).toBe(false);
  });

  it('counts a finding once, however many of its spans the row hides', () => {
    const hidden = hiddenFindings(spans, [retry], new Set(['agent']));
    expect(hidden.get('agent')).toEqual([retry]);
  });

  it('leaves out a finding that already names the row itself', () => {
    const hidden = hiddenFindings(spans, [costly], new Set(['agent']));
    expect(hidden.has('agent')).toBe(false);
  });

  it('leaves out a finding with evidence outside the subtree', () => {
    // a session-wide finding with one call inside the subagent is not the
    // subagent's; its outside evidence keeps its own marker
    const straddle = finding('straddle', 'critical', ['i1', 'own']);
    const hidden = hiddenFindings(spans, [straddle], new Set(['agent']));
    expect(hidden.size).toBe(0);
  });

  it('gives each collapsed ancestor only the findings it hides entirely', () => {
    const hidden = hiddenFindings(spans, all, new Set(['agent', 'inner']));
    // retry also has evidence in agent's own subtree, outside inner
    expect(hidden.get('inner')?.map((f) => f.id)).toEqual(['loop']);
    expect(hidden.get('agent')?.map((f) => f.id)).toEqual(['loop', 'retry']);
  });

  it('is empty when nothing is collapsed or nothing is hidden', () => {
    expect(hiddenFindings(spans, all, new Set()).size).toBe(0);
    expect(hiddenFindings(spans, [outside], new Set(['agent'])).size).toBe(0);
  });
});
