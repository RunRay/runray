import { diffRuns } from '@runray/core/diff';
import type { Run, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { buildDiffRows } from './diff-view';

const at = (sec: number) =>
  `2026-07-07T10:00:${String(sec).padStart(2, '0')}.000Z`;

function stubSpan(overrides: {
  id: string;
  parentId?: string | null;
  kind?: Span['kind'];
  name?: string;
  startedAt?: string;
  durationMs?: number;
  depth?: number;
  costUSD?: number;
  status?: Span['status'];
}): Span {
  return {
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    kind: overrides.kind ?? 'tool_call',
    name: overrides.name ?? overrides.id,
    status: overrides.status ?? 'ok',
    startedAt: overrides.startedAt ?? at(0),
    ...(overrides.durationMs !== undefined && {
      durationMs: overrides.durationMs,
    }),
    depth: overrides.depth ?? 1,
    attributes: {},
    provenance: { file: 'stub.jsonl' },
    ...(overrides.costUSD !== undefined && {
      kind: 'llm_call' as const,
      llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
        costUSD: overrides.costUSD,
        costSource: 'computed' as const,
      },
    }),
  };
}

const root = (): Span =>
  stubSpan({
    id: 'root',
    kind: 'session',
    name: 'session',
    durationMs: 60_000,
    depth: 0,
  });

function stubRun(id: string, spans: Span[]): Run {
  return {
    id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: ['x'] },
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
        maxDepth: 1,
      },
      cache: { hitRate: 0 },
    },
    insights: [],
  };
}

describe('buildDiffRows (run-diff 3.2)', () => {
  it('reordered independent tools interleave as matched rows, zero delta, none flagged', () => {
    const a = stubRun('a', [
      root(),
      stubSpan({ id: 'a1', parentId: 'root', name: 'Read', startedAt: at(1) }),
      stubSpan({ id: 'a2', parentId: 'root', name: 'Glob', startedAt: at(2) }),
    ]);
    const b = stubRun('b', [
      root(),
      stubSpan({ id: 'b1', parentId: 'root', name: 'Glob', startedAt: at(1) }),
      stubSpan({ id: 'b2', parentId: 'root', name: 'Read', startedAt: at(2) }),
    ]);
    const rows = buildDiffRows(a, b, diffRuns(a, b));
    expect(rows.map((r) => r.type)).toEqual(['matched', 'matched', 'matched']);
    expect(rows.map((r) => r.name)).toEqual(['session', 'Read', 'Glob']);
    for (const row of rows) {
      expect(row.costRegressed).toBe(false);
      expect(row.durationMs?.delta ?? 0).toBe(0);
    }
  });

  it('duplicate-name multiset: the unpaired occurrence renders as an added row', () => {
    const a = stubRun('a', [
      root(),
      stubSpan({ id: 'a1', parentId: 'root', name: 'Bash', startedAt: at(1) }),
    ]);
    const b = stubRun('b', [
      root(),
      stubSpan({ id: 'b1', parentId: 'root', name: 'Bash', startedAt: at(1) }),
      stubSpan({
        id: 'b2',
        parentId: 'root',
        name: 'Bash',
        startedAt: at(5),
        durationMs: 2000,
      }),
    ]);
    const rows = buildDiffRows(a, b, diffRuns(a, b));
    const added = rows.filter((r) => r.type === 'added');
    expect(added).toHaveLength(1);
    expect(added[0]?.bId).toBe('b2');
    expect(added[0]?.aId).toBeNull();
    expect(added[0]?.ownDurationMs).toBe(2000);
    // interleaved by offset: the added row lands after the matched pair at t=1
    expect(rows.map((r) => `${r.type}:${r.name}`)).toEqual([
      'matched:session',
      'matched:Bash',
      'added:Bash',
    ]);
  });

  it('a removed subtree keeps depth and chronology; own cost is priced-only', () => {
    const worker = stubSpan({
      id: 'worker',
      parentId: 'root',
      kind: 'subagent',
      name: 'subagent:worker',
      startedAt: at(3),
      depth: 1,
    });
    const a = stubRun('a', [
      root(),
      worker,
      stubSpan({
        id: 'wl',
        parentId: 'worker',
        startedAt: at(4),
        depth: 2,
        costUSD: 1.25,
      }),
      stubSpan({
        id: 'wt',
        parentId: 'worker',
        name: 'Bash',
        startedAt: at(5),
        depth: 2,
      }),
    ]);
    const b = stubRun('b', [root()]);
    const rows = buildDiffRows(a, b, diffRuns(a, b));
    const removed = rows.filter((r) => r.type === 'removed');
    expect(removed.map((r) => r.aId)).toEqual(['worker', 'wl', 'wt']);
    expect(removed.map((r) => r.depth)).toEqual([1, 2, 2]);
    expect(removed[1]?.ownCostUSD).toBe(1.25);
    expect(removed[2]?.ownCostUSD).toBe(0);
  });

  it('flags cost-regressed matched pairs and surfaces status flips', () => {
    const a = stubRun('a', [
      root(),
      stubSpan({ id: 'l1', parentId: 'root', startedAt: at(1), costUSD: 1.0 }),
      stubSpan({ id: 't1', parentId: 'root', name: 'Bash', startedAt: at(2) }),
    ]);
    const b = stubRun('b', [
      root(),
      stubSpan({ id: 'l1', parentId: 'root', startedAt: at(1), costUSD: 2.5 }),
      stubSpan({
        id: 't1',
        parentId: 'root',
        name: 'Bash',
        startedAt: at(2),
        status: 'error',
      }),
    ]);
    const rows = buildDiffRows(a, b, diffRuns(a, b));
    const llmRow = rows.find((r) => r.kind === 'llm_call');
    expect(llmRow?.costRegressed).toBe(true);
    expect(llmRow?.costUSD?.delta).toBeCloseTo(1.5, 6);
    const toolRow = rows.find((r) => r.name === 'Bash');
    expect(toolRow?.statusChanged).toEqual({ a: 'ok', b: 'error' });
    expect(toolRow?.costRegressed).toBe(false);
  });
});
