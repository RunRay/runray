import { describe, expect, it } from 'vitest';
import type { RawRun, RawSpan } from '../adapter.js';
import { normalize } from '../normalize.js';
import {
  buildScopeIndex,
  chronologicalLlmCalls,
  consecutiveSameModelPairs,
  detectRetryClusters,
} from './helpers.js';
import { applyInsights } from './index.js';

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
    agent: { sessionId: 's' },
  });

function llm(
  id: string,
  second: number,
  opts: { cost?: number; parentId?: string; model?: string } = {},
): RawSpan {
  return base(id, {
    kind: 'llm_call',
    startedAt: ts(second),
    parentId: opts.parentId ?? 'root',
    llm: {
      provider: 'anthropic',
      model: opts.model ?? 'claude-sonnet-4-6',
      tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
      ...(opts.cost === undefined ? {} : { costUSD: opts.cost }),
      costSource: opts.cost === undefined ? 'unknown' : 'computed',
    },
  });
}

function tool(
  id: string,
  second: number,
  opts: {
    name?: string;
    status?: RawSpan['status'];
    parentId?: string;
    targetKey?: string;
  } = {},
): RawSpan {
  const name = opts.name ?? 'Bash';
  return base(id, {
    kind: 'tool_call',
    name,
    startedAt: ts(second),
    endedAt: ts(second + 1),
    parentId: opts.parentId ?? 'root',
    status: opts.status ?? 'ok',
    attributes:
      opts.targetKey === undefined
        ? {}
        : { 'runray.targetKey': opts.targetKey },
    tool: { name, isError: opts.status === 'error' },
  });
}

const subagent = (id: string, second: number, parentId = 'root'): RawSpan =>
  base(id, {
    kind: 'subagent',
    name: `subagent:${id}`,
    startedAt: ts(second),
    parentId,
  });

function mkRun(spans: RawSpan[]) {
  const raw: RawRun = {
    source: { tool: 'claude-code', format: 'claude-jsonl', files: ['x.jsonl'] },
    spans,
    warnings: [],
  };
  return normalize(raw);
}

describe('buildScopeIndex', () => {
  it('maps spans to the nearest subagent/session; scopes map to themselves', () => {
    const run = mkRun([
      root(),
      llm('l1', 1),
      subagent('sub', 2),
      llm('l2', 3, { parentId: 'sub' }),
      tool('t1', 4, { parentId: 'l2' }),
    ]);
    const scope = buildScopeIndex(run);
    expect(scope.get('root')).toBe('root');
    expect(scope.get('l1')).toBe('root');
    expect(scope.get('sub')).toBe('sub');
    expect(scope.get('l2')).toBe('sub');
    expect(scope.get('t1')).toBe('sub');
  });
});

describe('chronological llm pairs', () => {
  it('orders llm calls by startedAt and pairs same-model neighbors only', () => {
    const run = mkRun([
      root(),
      llm('b', 2, { model: 'claude-sonnet-4-6' }),
      llm('a', 1, { model: 'claude-sonnet-4-6' }),
      llm('c', 3, { model: 'claude-haiku-4-5' }),
      llm('d', 4, { model: 'claude-haiku-4-5' }),
    ]);
    const llms = chronologicalLlmCalls(run);
    expect(llms.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
    const pairs = consecutiveSameModelPairs(llms);
    expect(pairs.map(([x, y]) => `${x.id}${y.id}`)).toEqual(['ab', 'cd']);
  });
});

describe('detectRetryClusters', () => {
  const OPTS = { minFailures: 3, maxGapToolCalls: 3 };

  it('clusters interleaved same-identity failures within the gap window', () => {
    const run = mkRun([
      root(),
      tool('f1', 1, { status: 'error', name: 'Bash', targetKey: 'k1' }),
      tool('ok1', 2, { name: 'Read' }),
      tool('f2', 3, { status: 'error', name: 'Bash', targetKey: 'k1' }),
      tool('ok2', 4, { name: 'Glob' }),
      tool('f3', 5, { status: 'error', name: 'Bash', targetKey: 'k1' }),
    ]);
    const clusters = detectRetryClusters(run, OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.failures.map((s) => s.id)).toEqual(['f1', 'f2', 'f3']);
    expect(clusters[0]?.scopeId).toBe('root');
  });

  it('a gap beyond maxGapToolCalls splits the cluster', () => {
    const run = mkRun([
      root(),
      tool('f1', 1, { status: 'error' }),
      tool('f2', 2, { status: 'error' }),
      ...[3, 4, 5, 6].map((n) => tool(`ok${n}`, n, { name: 'Read' })),
      tool('f3', 7, { status: 'error' }),
      tool('f4', 8, { status: 'error' }),
    ]);
    // neither fragment reaches minFailures=3 → no qualifying cluster
    expect(detectRetryClusters(run, OPTS)).toHaveLength(0);
  });

  it('different target keys are different identities', () => {
    const run = mkRun([
      root(),
      tool('f1', 1, { status: 'error', targetKey: 'a' }),
      tool('f2', 2, { status: 'error', targetKey: 'b' }),
      tool('f3', 3, { status: 'error', targetKey: 'a' }),
      tool('f4', 4, { status: 'error', targetKey: 'b' }),
      tool('f5', 5, { status: 'error', targetKey: 'a' }),
      tool('f6', 6, { status: 'error', targetKey: 'b' }),
    ]);
    const clusters = detectRetryClusters(run, OPTS);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.failures.map((s) => s.id)).toEqual(['f1', 'f3', 'f5']);
    expect(clusters[1]?.failures.map((s) => s.id)).toEqual(['f2', 'f4', 'f6']);
  });

  it('clusters never span scopes (parallel subagents stay independent)', () => {
    const run = mkRun([
      root(),
      subagent('s1', 1),
      subagent('s2', 1),
      tool('a1', 2, { status: 'error', parentId: 's1' }),
      tool('b1', 3, { status: 'error', parentId: 's2' }),
      tool('a2', 4, { status: 'error', parentId: 's1' }),
      tool('b2', 5, { status: 'error', parentId: 's2' }),
      tool('a3', 6, { status: 'error', parentId: 's1' }),
    ]);
    const clusters = detectRetryClusters(run, OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.scopeId).toBe('s1');
    expect(clusters[0]?.failures.map((s) => s.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('a success of the same identity resolves the saga', () => {
    const run = mkRun([
      root(),
      tool('f1', 1, { status: 'error' }),
      tool('f2', 2, { status: 'error' }),
      tool('win', 3),
      tool('f3', 4, { status: 'error' }),
    ]);
    // success closed {f1,f2} below minFailures; f3 starts a fresh cluster
    expect(detectRetryClusters(run, OPTS)).toHaveLength(0);
  });
});

describe('wasted-estimate cap (B2)', () => {
  it('overlapping waste-class findings never push wastedEstimate past total', () => {
    // dead-end-run claims 100% of the run; retry-loop claims the same llm
    // calls again — uncapped, the sum would be ~2× total
    const run = applyInsights(
      mkRun([
        root(),
        llm('l1', 1, { cost: 0.5 }),
        tool('b1', 2, { status: 'error', parentId: 'l1' }),
        llm('l2', 3, { cost: 0.5 }),
        tool('b2', 4, { status: 'error', parentId: 'l2' }),
        llm('l3', 5, { cost: 0.5 }),
        tool('b3', 6, { status: 'error', parentId: 'l3' }),
      ]),
    );
    const rules = new Set(run.insights.map((i) => i.ruleId));
    expect(rules.has('retry-loop')).toBe(true);
    expect(rules.has('dead-end-run')).toBe(true);
    expect(run.totals.costUSD.wastedEstimate).toBe(run.totals.costUSD.total);
  });
});
