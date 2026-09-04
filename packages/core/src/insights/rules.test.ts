import { describe, expect, it } from 'vitest';
import type { RawRun, RawSpan } from '../adapter.js';
import { normalize } from '../normalize.js';
import type { PricingTable } from '../pricing/engine.js';
import { bundledPricing, matchModel } from '../pricing/index.js';
import { applyInsights, V0_RULES } from './index.js';

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
  opts: {
    input?: number;
    cacheRead?: number;
    cost?: number;
    parentId?: string;
    model?: string;
  } = {},
): RawSpan {
  return base(id, {
    kind: 'llm_call',
    startedAt: ts(second),
    parentId: opts.parentId ?? 'root',
    llm: {
      provider: 'anthropic',
      model: opts.model ?? 'claude-sonnet-4-6',
      tokens: {
        input: opts.input ?? 1000,
        output: 100,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: 0,
      },
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
    outputBytes?: number;
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
    tool: {
      name,
      isError: opts.status === 'error',
      ...(opts.outputBytes === undefined
        ? {}
        : { outputBytes: opts.outputBytes }),
    },
  });
}

function mkRun(spans: RawSpan[]) {
  const raw: RawRun = {
    source: { tool: 'claude-code', format: 'claude-jsonl', files: ['x.jsonl'] },
    spans,
    warnings: [],
  };
  return normalize(raw);
}

const sonnet = matchModel(bundledPricing(), 'claude-sonnet-4-6');
if (!sonnet) throw new Error('bundled snapshot must cover claude-sonnet-4-6');

describe('retry-loop', () => {
  it('flags ≥3 consecutive same-tool failures across different llm parents', () => {
    const run = applyInsights(
      mkRun([
        root(),
        llm('l1', 1, { cost: 0.1 }),
        tool('b1', 2, { status: 'error', parentId: 'l1' }),
        llm('l2', 3, { cost: 0.2 }),
        tool('b2', 4, { status: 'error', parentId: 'l2' }),
        llm('l3', 5, { cost: 0.3 }),
        tool('b3', 6, { status: 'error', parentId: 'l3' }),
        llm('l4', 7, { cost: 0.05 }),
        tool('b4', 8, { parentId: 'l4' }),
      ]),
    );
    const finding = run.insights.find((i) => i.ruleId === 'retry-loop');
    expect(finding).toBeDefined();
    expect(finding?.spanIds).toEqual(['b1', 'b2', 'b3']);
    expect(finding?.estimatedWasteUSD).toBe(0.6); // l1 + l2 + l3
    expect(finding?.severity).toBe('warning');
    expect(finding?.detail).toContain('3 consecutive');
    // waste-class: flows into the run's wasted total
    expect(run.totals.costUSD.wastedEstimate).toBe(0.6);
  });

  it('does not flag two failures or a broken streak', () => {
    const two = applyInsights(
      mkRun([
        root(),
        tool('b1', 1, { status: 'error' }),
        tool('b2', 2, { status: 'error' }),
      ]),
    );
    expect(two.insights.filter((i) => i.ruleId === 'retry-loop')).toHaveLength(
      0,
    );

    const broken = applyInsights(
      mkRun([
        root(),
        tool('b1', 1, { status: 'error' }),
        tool('ok', 2),
        tool('b2', 3, { status: 'error' }),
        tool('b3', 4, { status: 'error' }),
      ]),
    );
    expect(
      broken.insights.filter((i) => i.ruleId === 'retry-loop'),
    ).toHaveLength(0);
  });

  it('does not merge failures of different tools', () => {
    const run = applyInsights(
      mkRun([
        root(),
        tool('b1', 1, { status: 'error', name: 'Bash' }),
        tool('e1', 2, { status: 'error', name: 'Edit' }),
        tool('b2', 3, { status: 'error', name: 'Bash' }),
      ]),
    );
    expect(run.insights.filter((i) => i.ruleId === 'retry-loop')).toHaveLength(
      0,
    );
  });
});

describe('low-cache-hit', () => {
  const coldRun = () =>
    mkRun([
      root(),
      ...[1, 2, 3, 4, 5].map((n) =>
        llm(`l${n}`, n, { input: 100_000, cost: 0.05 }),
      ),
    ]);

  it('flags a cold-cache run and prices the opportunity via the dominant model', () => {
    const run = applyInsights(coldRun());
    const finding = run.insights.find((i) => i.ruleId === 'low-cache-hit');
    expect(finding).toBeDefined();
    const expected =
      Math.round(
        0.6 * 500_000 * (sonnet.inputPerMTok - sonnet.cacheReadPerMTok),
      ) / 1e6;
    expect(finding?.estimatedWasteUSD).toBeCloseTo(expected, 6);
    // efficiency-opportunity: must NOT inflate the run's wasted total
    expect(run.totals.costUSD.wastedEstimate).toBe(0);
  });

  it('applies configured threshold overrides instead of defaults (spec scenario)', () => {
    const warmish = mkRun([
      root(),
      ...[1, 2, 3, 4, 5].map((n) =>
        llm(`l${n}`, n, { input: 100_000, cacheRead: 100_000, cost: 0.05 }),
      ),
    ]);
    // hitRate 0.5 — silent with the default 0.4 ceiling…
    expect(
      applyInsights(warmish).insights.filter(
        (i) => i.ruleId === 'low-cache-hit',
      ),
    ).toHaveLength(0);
    // …but flagged when the user raises the threshold to 0.6
    const raised = applyInsights(warmish, { lowCacheHit: { maxHitRate: 0.6 } });
    expect(
      raised.insights.filter((i) => i.ruleId === 'low-cache-hit'),
    ).toHaveLength(1);
  });

  it('prices insight dollars from the effective table, never the snapshot (C3)', () => {
    const doubled: PricingTable = {
      snapshotDate: '2026-07-18',
      source: 'litellm-snapshot',
      aliases: {},
      entries: [
        {
          modelPattern: 'claude-sonnet-4-6',
          inputPerMTok: sonnet.inputPerMTok * 2,
          outputPerMTok: sonnet.outputPerMTok * 2,
          cacheReadPerMTok: sonnet.cacheReadPerMTok * 2,
          cacheWritePerMTok: sonnet.cacheWritePerMTok * 2,
        },
      ],
    };
    const bundled = applyInsights(coldRun()).insights.find(
      (i) => i.ruleId === 'low-cache-hit',
    );
    const refreshed = applyInsights(
      coldRun(),
      {},
      V0_RULES,
      doubled,
    ).insights.find((i) => i.ruleId === 'low-cache-hit');
    expect(bundled?.estimatedWasteUSD).toBeGreaterThan(0);
    expect(refreshed?.estimatedWasteUSD).toBeCloseTo(
      (bundled?.estimatedWasteUSD ?? 0) * 2,
      6,
    );
  });
});

describe('context-bloat', () => {
  it('flags a >2× median growth above 50k input tokens and names culprits', () => {
    const run = applyInsights(
      mkRun([
        root(),
        llm('l1', 1, { input: 10_000, cost: 0.01 }),
        llm('l2', 2, { input: 10_000, cost: 0.01 }),
        llm('l3', 3, { input: 10_000, cost: 0.01 }),
        tool('big', 4, { outputBytes: 500_000 }),
        tool('small', 5, { outputBytes: 100 }),
        llm('l4', 6, { input: 60_000, cost: 0.05 }),
        llm('l5', 7, { input: 70_000, cost: 0.05 }),
        llm('l6', 8, { input: 80_000, cost: 0.05 }),
      ]),
    );
    const finding = run.insights.find((i) => i.ruleId === 'context-bloat');
    expect(finding).toBeDefined();
    expect(finding?.spanIds).toEqual(['l4', 'l5', 'l6', 'big', 'small']);
    const expected =
      Math.round((70_000 - 10_000) * 3 * sonnet.inputPerMTok) / 1e6;
    expect(finding?.estimatedWasteUSD).toBeCloseTo(expected, 6);
    expect(finding?.detail).toContain('70.0k');
  });

  it('stays silent below the 50k median floor', () => {
    const run = applyInsights(
      mkRun([
        root(),
        ...[1, 2, 3].map((n) => llm(`a${n}`, n, { input: 1_000 })),
        ...[4, 5, 6].map((n) => llm(`b${n}`, n, { input: 10_000 })),
      ]),
    );
    expect(
      run.insights.filter((i) => i.ruleId === 'context-bloat'),
    ).toHaveLength(0);
  });
});

describe('expensive-subagent', () => {
  it('flags a subtree above 50% of run cost and $0.25', () => {
    const run = applyInsights(
      mkRun([
        root(),
        llm('l1', 1, { cost: 0.4 }),
        tool('t1', 2, { name: 'Agent', parentId: 'l1' }),
        base('sub1', {
          kind: 'subagent',
          parentId: 't1',
          startedAt: ts(3),
          agent: { name: 'reviewer' },
        }),
        llm('l2', 4, { cost: 0.6, parentId: 'sub1' }),
      ]),
    );
    const finding = run.insights.find((i) => i.ruleId === 'expensive-subagent');
    expect(finding).toBeDefined();
    expect(finding?.spanIds).toEqual(['sub1']);
    // quantified via the repricing primitive (4.5): sonnet subtree at the
    // haiku tier — a positive saving that never enters the waste rollup
    expect(finding?.estimatedWasteUSD).toBeGreaterThan(0);
    expect(finding?.suggestion).toContain('claude-haiku-4-5');
    expect(finding?.detail).toContain('60%');
    expect(run.totals.costUSD.wastedEstimate).toBe(0);
  });

  it('reports only the innermost qualifying subagent when nested', () => {
    const run = applyInsights(
      mkRun([
        root(),
        llm('l1', 1, { cost: 0.4 }),
        tool('t1', 2, { name: 'Agent', parentId: 'l1' }),
        base('sub1', {
          kind: 'subagent',
          parentId: 't1',
          startedAt: ts(3),
          agent: { name: 'outer' },
        }),
        llm('l2', 4, { cost: 0.05, parentId: 'sub1' }),
        tool('t2', 5, { name: 'Agent', parentId: 'sub1' }),
        base('sub2', {
          kind: 'subagent',
          parentId: 't2',
          startedAt: ts(6),
          agent: { name: 'inner' },
        }),
        llm('l3', 7, { cost: 0.55, parentId: 'sub2' }),
      ]),
    );
    const findings = run.insights.filter(
      (i) => i.ruleId === 'expensive-subagent',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.spanIds).toEqual(['sub2']);
  });
});

describe('dead-end-run', () => {
  it('flags a run whose last span errored, waste = full run cost', () => {
    const run = applyInsights(
      mkRun([
        root(),
        llm('l1', 1, { cost: 0.5 }),
        tool('b1', 2, { status: 'error', parentId: 'l1' }),
      ]),
    );
    const finding = run.insights.find((i) => i.ruleId === 'dead-end-run');
    expect(finding).toBeDefined();
    // graded by the engine: 100% of a $0.50 run, but under the $1 critical floor
    expect(finding?.severity).toBe('warning');
    expect(finding?.estimatedWasteUSD).toBe(0.5);
    expect(run.totals.costUSD.wastedEstimate).toBe(0.5);
  });

  it('grades critical when the tail is ≥10% of the run and ≥ $1, and stays silent on a clean run', () => {
    const costly = applyInsights(
      mkRun([
        root(),
        llm('l1', 1, { cost: 2 }),
        tool('b1', 2, { status: 'error', parentId: 'l1' }),
      ]),
    );
    expect(
      costly.insights.find((i) => i.ruleId === 'dead-end-run')?.severity,
    ).toBe('critical');

    const clean = applyInsights(
      mkRun([root(), llm('l1', 1, { cost: 2 }), tool('b1', 2)]),
    );
    expect(
      clean.insights.filter((i) => i.ruleId === 'dead-end-run'),
    ).toHaveLength(0);
  });
});

describe('applyInsights', () => {
  it('assigns sequential ids in rule order and is pure', () => {
    const spans = [
      root(),
      llm('l1', 1, { cost: 0.1 }),
      tool('b1', 2, { status: 'error', parentId: 'l1' }),
      llm('l2', 3, { cost: 0.2 }),
      tool('b2', 4, { status: 'error', parentId: 'l2' }),
      llm('l3', 5, { cost: 0.3 }),
      tool('b3', 6, { status: 'error', parentId: 'l3' }),
    ];
    const before = mkRun(spans);
    const frozen = JSON.stringify(before);
    const run = applyInsights(before);
    expect(JSON.stringify(before)).toBe(frozen); // pure
    expect(run.insights.map((i) => i.id)).toEqual(
      run.insights.map((_, n) => `i${n + 1}`),
    );
    // retry-loop (waste-class) + dead-end-run both fire; both count into wasted
    const ruleIds = run.insights.map((i) => i.ruleId);
    expect(ruleIds).toContain('retry-loop');
    expect(ruleIds).toContain('dead-end-run');
  });
});
