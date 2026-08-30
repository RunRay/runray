import { describe, expect, it } from 'vitest';
import type { RawRun, RawSpan } from '../adapter.js';
import { normalize } from '../normalize.js';
import { diffRuns } from './index.js';

const T0 = Date.parse('2026-07-02T13:00:00Z');
function ts(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

function base(id: string, overrides: Partial<RawSpan>): RawSpan {
  return {
    id,
    parentId: 'root',
    kind: 'other',
    name: id,
    status: 'ok',
    startedAt: ts(0),
    attributes: {},
    provenance: { file: 'x.jsonl', line: 1 },
    ...overrides,
  };
}
const root = (): RawSpan =>
  base('root', {
    parentId: null,
    kind: 'session',
    name: 'session',
    startedAt: ts(0),
    endedAt: ts(100),
    durationMs: 100_000,
    agent: { sessionId: 's' },
  });

function llm(
  id: string,
  sec: number,
  o: { cost?: number; parentId?: string; input?: number } = {},
): RawSpan {
  return base(id, {
    kind: 'llm_call',
    startedAt: ts(sec),
    endedAt: ts(sec + 2),
    durationMs: 2000,
    parentId: o.parentId ?? 'root',
    llm: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tokens: {
        input: o.input ?? 1000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
      },
      ...(o.cost === undefined ? {} : { costUSD: o.cost }),
      costSource: o.cost === undefined ? 'unknown' : 'computed',
    },
  });
}

function tool(
  id: string,
  sec: number,
  o: {
    name?: string;
    parentId?: string;
    status?: RawSpan['status'];
    durationMs?: number;
  } = {},
): RawSpan {
  const name = o.name ?? 'Bash';
  return base(id, {
    kind: 'tool_call',
    name,
    startedAt: ts(sec),
    endedAt: ts(sec + (o.durationMs ?? 1000) / 1000),
    durationMs: o.durationMs ?? 1000,
    parentId: o.parentId ?? 'root',
    status: o.status ?? 'ok',
    tool: { name, isError: o.status === 'error' },
  });
}

const sub = (id: string, sec: number, parentId = 'root'): RawSpan =>
  base(id, {
    kind: 'subagent',
    name: `subagent:${id}`,
    startedAt: ts(sec),
    parentId,
    agent: { name: id },
  });

function mkRun(id: string, spans: RawSpan[]) {
  const raw: RawRun = {
    source: { tool: 'claude-code', format: 'claude-jsonl', files: ['x.jsonl'] },
    spans,
    warnings: [],
  };
  const run = normalize(raw);
  return { ...run, id };
}

describe('diffRuns header (1.1)', () => {
  it('identical runs → all-zero deltas, byte-stable structure', () => {
    const spans = [root(), llm('l1', 1, { cost: 0.5 }), tool('t1', 4)];
    const d = diffRuns(mkRun('run_a', spans), mkRun('run_b', spans));
    expect(d.header.costUSD.delta).toBe(0);
    expect(d.header.costUSD.pct).toBe(0);
    expect(d.header.tokens.total.delta).toBe(0);
    expect(d.header.llmCalls.delta).toBe(0);
    expect(d.header.toolErrors.delta).toBe(0);
    expect(d.header.maxDepth.delta).toBe(0);
    expect(d.header.wallClockMs.delta).toBe(0);
    expect(d.alignment.added).toEqual([]);
    expect(d.alignment.removed).toEqual([]);
    // determinism: the same inputs serialize identically
    expect(
      JSON.stringify(diffRuns(mkRun('run_a', spans), mkRun('run_b', spans))),
    ).toBe(JSON.stringify(d));
  });

  it('token class deltas (incl. reasoning) sum to the total delta', () => {
    const withReasoning = (reasoning: number): RawSpan => {
      const s = llm('l1', 1, { cost: 1 });
      (s.llm as { tokens: Record<string, number> }).tokens.reasoning =
        reasoning;
      return s;
    };
    const a = mkRun('a', [root(), withReasoning(0)]);
    const b = mkRun('b', [root(), withReasoning(5000)]);
    const d = diffRuns(a, b);
    const { input, output, cacheRead, cacheWrite, reasoning, total } =
      d.header.tokens;
    expect(reasoning.delta).toBe(5000);
    expect(
      input.delta +
        output.delta +
        cacheRead.delta +
        cacheWrite.delta +
        reasoning.delta,
    ).toBe(total.delta);
  });

  it('reports absolute and percentage increases; pct null on zero base', () => {
    const a = mkRun('a', [root(), llm('l1', 1, { cost: 1.0 })]);
    const b = mkRun('b', [
      root(),
      llm('l1', 1, { cost: 1.5 }),
      tool('t1', 3, { status: 'error' }),
    ]);
    const d = diffRuns(a, b);
    expect(d.header.costUSD.delta).toBeCloseTo(0.5, 6);
    expect(d.header.costUSD.pct).toBeCloseTo(0.5, 6);
    // toolErrors goes 0 → 1: base is zero, pct must be null, never Infinity
    expect(d.header.toolErrors.delta).toBe(1);
    expect(d.header.toolErrors.pct).toBeNull();
  });
});

describe('span alignment (1.2)', () => {
  it('reordered independent siblings match with zero delta (spec scenario)', () => {
    const a = mkRun('a', [
      root(),
      tool('a1', 1, { name: 'Read' }),
      tool('a2', 2, { name: 'Glob' }),
    ]);
    const b = mkRun('b', [
      root(),
      tool('b1', 1, { name: 'Glob' }),
      tool('b2', 2, { name: 'Read' }),
    ]);
    const d = diffRuns(a, b);
    expect(d.alignment.added).toEqual([]);
    expect(d.alignment.removed).toEqual([]);
    const names = d.alignment.matched.map((p) => p.name).sort();
    expect(names).toEqual(['Glob', 'Read', 'session']);
    for (const pair of d.alignment.matched) {
      expect(pair.durationMs.delta).toBe(0);
    }
  });

  it('duplicate-name multiset pairs off by occurrence order', () => {
    const a = mkRun('a', [
      root(),
      tool('a1', 1, { durationMs: 1000 }),
      tool('a2', 2, { durationMs: 2000 }),
    ]);
    const b = mkRun('b', [
      root(),
      tool('b1', 1, { durationMs: 1000 }),
      tool('b2', 2, { durationMs: 5000 }),
      tool('b3', 3, { durationMs: 9000 }),
    ]);
    const d = diffRuns(a, b);
    const bash = d.alignment.matched.filter((p) => p.name === 'Bash');
    expect(bash).toHaveLength(2);
    expect(bash[0]?.durationMs.delta).toBe(0); // 1st↔1st
    expect(bash[1]?.durationMs.delta).toBe(3000); // 2nd↔2nd
    expect(d.alignment.added).toEqual(['b3']); // 3rd has no partner
  });

  it('an unpaired subagent classifies as a whole added/removed subtree', () => {
    const common = [root(), llm('l1', 1, { cost: 0.2 })];
    const a = mkRun('a', common);
    const b = mkRun('b', [
      ...common,
      sub('worker', 3),
      llm('wl', 4, { parentId: 'worker', cost: 1.0 }),
      tool('wt', 5, { parentId: 'worker' }),
    ]);
    const d = diffRuns(a, b);
    expect(d.alignment.added).toEqual(['worker', 'wl', 'wt']);
    expect(d.alignment.removed).toEqual([]);
    const reversed = diffRuns(b, a);
    expect(reversed.alignment.removed).toEqual(['worker', 'wl', 'wt']);
  });
});

describe('pair deltas + subtree rollups (1.3)', () => {
  it('carries cost/tokens/duration deltas and status flips per pair', () => {
    const a = mkRun('a', [
      root(),
      llm('l1', 1, { cost: 1.0, input: 1000 }),
      tool('t1', 4, { durationMs: 1000 }),
    ]);
    const b = mkRun('b', [
      root(),
      llm('l1', 1, { cost: 3.0, input: 5000 }),
      tool('t1', 4, { durationMs: 4000, status: 'error' }),
    ]);
    const d = diffRuns(a, b);
    const llmPair = d.alignment.matched.find((p) => p.kind === 'llm_call');
    expect(llmPair?.costUSD.delta).toBeCloseTo(2.0, 6);
    expect(llmPair?.tokens.delta).toBe(4000);
    const toolPair = d.alignment.matched.find((p) => p.kind === 'tool_call');
    expect(toolPair?.durationMs.delta).toBe(3000);
    expect(toolPair?.statusChanged).toEqual({ a: 'ok', b: 'error' });
  });

  it('matched subagent pairs report whole-subtree cost deltas', () => {
    const mk = (id: string, workerCost: number) =>
      mkRun(id, [
        root(),
        sub('worker', 1),
        llm('wl', 2, { parentId: 'worker', cost: workerCost }),
      ]);
    const d = diffRuns(mk('a', 1.0), mk('b', 4.0));
    expect(d.alignment.subtrees).toHaveLength(1);
    expect(d.alignment.subtrees[0]?.name).toBe('worker');
    expect(d.alignment.subtrees[0]?.costUSD.delta).toBeCloseTo(3.0, 6);
  });

  it('property: Σ pair deltas + added − removed ≈ header cost delta', () => {
    const a = mkRun('a', [
      root(),
      llm('l1', 1, { cost: 1.0 }),
      llm('only-a', 3, { cost: 0.7 }),
      sub('worker', 5),
      llm('wl', 6, { parentId: 'worker', cost: 0.3 }),
    ]);
    const b = mkRun('b', [
      root(),
      llm('l1', 1, { cost: 2.5 }),
      sub('worker', 5),
      llm('wl', 6, { parentId: 'worker', cost: 0.9 }),
      llm('only-b', 8, { cost: 0.4 }),
    ]);
    const d = diffRuns(a, b);
    const spanById = (run: typeof a, id: string) =>
      run.spans.find((s) => s.id === id);
    const pairSum = d.alignment.matched.reduce(
      (acc, p) => acc + p.costUSD.delta,
      0,
    );
    const addedSum = d.alignment.added.reduce(
      (acc, id) => acc + (spanById(b, id)?.llm?.costUSD ?? 0),
      0,
    );
    const removedSum = d.alignment.removed.reduce(
      (acc, id) => acc + (spanById(a, id)?.llm?.costUSD ?? 0),
      0,
    );
    expect(pairSum + addedSum - removedSum).toBeCloseTo(
      d.header.costUSD.delta,
      6,
    );
  });
});
