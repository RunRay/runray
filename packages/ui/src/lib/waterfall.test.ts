import type { Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import {
  collapsedAncestorsOf,
  computeTimeRange,
  flattenVisible,
  laneMarks,
  matchingSpanIds,
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
