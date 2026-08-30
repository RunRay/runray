import { describe, expect, it } from 'vitest';
import type { RawRun, RawSpan } from '../adapter.js';
import { normalize } from '../normalize.js';
import {
  bundledPricing,
  CACHE_WRITE_1H_ATTR,
  matchModel,
} from '../pricing/index.js';
import { applyInsights } from './index.js';

/** Scenario tests for the seven post-MVP rules (profiler-depth phase 4). */

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
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    /** 1h-TTL share of cacheWrite (tracepulse.cacheWrite1hTokens). */
    write1h?: number;
    cost?: number;
    parentId?: string;
    model?: string;
    endedAt?: number;
  } = {},
): RawSpan {
  return base(id, {
    kind: 'llm_call',
    startedAt: ts(second),
    ...(opts.endedAt === undefined ? {} : { endedAt: ts(opts.endedAt) }),
    ...(opts.write1h === undefined
      ? {}
      : { attributes: { [CACHE_WRITE_1H_ATTR]: opts.write1h } }),
    parentId: opts.parentId ?? 'root',
    llm: {
      provider: 'anthropic',
      model: opts.model ?? 'claude-sonnet-4-6',
      tokens: {
        input: opts.input ?? 1000,
        output: opts.output ?? 100,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
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
    targetKey?: string;
    targetKind?: 'file-read' | 'file-write' | 'command';
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
    attributes: {
      ...(opts.targetKey === undefined
        ? {}
        : {
            'runray.targetKey': opts.targetKey,
            'runray.targetKind': opts.targetKind ?? 'file-read',
          }),
    },
    tool: {
      name,
      isError: opts.status === 'error',
      ...(opts.outputBytes === undefined
        ? {}
        : { outputBytes: opts.outputBytes }),
    },
  });
}

const sub = (id: string, second: number, parentId = 'root'): RawSpan =>
  base(id, {
    kind: 'subagent',
    name: `subagent:${id}`,
    startedAt: ts(second),
    parentId,
    agent: { name: id },
  });

function mkRun(spans: RawSpan[]) {
  const raw: RawRun = {
    source: { tool: 'claude-code', format: 'claude-jsonl', files: ['x.jsonl'] },
    spans,
    warnings: [],
  };
  return normalize(raw);
}

const bundled = bundledPricing();
const opusEntry = matchModel(bundled, 'claude-opus-4-8');
const sonnet5 = matchModel(bundled, 'claude-sonnet-5');
if (!opusEntry || !sonnet5) throw new Error('snapshot must cover opus/sonnet');

describe('model-mismatch', () => {
  const opusCall = (id: string, sec: number, parentId = 'root') =>
    llm(id, sec, {
      model: 'claude-opus-4-8',
      cost: 5,
      input: 10_000,
      parentId,
    });

  it('fires on safe savings with the repriced delta, never touching wastedEstimate', () => {
    const run = applyInsights(mkRun([root(), opusCall('l1', 1)]));
    const finding = run.insights.find((i) => i.ruleId === 'model-mismatch');
    expect(finding).toBeDefined();
    expect(finding?.title).toContain('claude-sonnet-5');
    expect(finding?.estimatedWasteUSD).toBeGreaterThan(0.5);
    expect(finding?.severity).toBe('info');
    expect(run.totals.costUSD.wastedEstimate).toBe(0);
  });

  it('stays silent when only risky subtrees would save', () => {
    const run = applyInsights(
      mkRun([
        root(),
        opusCall('l1', 1),
        tool('t1', 2, { status: 'error' }), // errors flag on the main cell
      ]),
    );
    expect(
      run.insights.filter((i) => i.ruleId === 'model-mismatch'),
    ).toHaveLength(0);
  });

  it('excludes subtrees already claimed by expensive-subagent (no double counting)', () => {
    const run = applyInsights(
      mkRun([
        root(),
        llm('l0', 1, { cost: 0.05 }), // cheap main-session sonnet call
        sub('worker', 2),
        opusCall('l1', 3, 'worker'), // dominates the run → delegation finding
      ]),
    );
    const delegation = run.insights.find(
      (i) => i.ruleId === 'expensive-subagent',
    );
    expect(delegation?.estimatedWasteUSD).toBeGreaterThan(0);
    // the same opus dollars must not resurface as a model-mismatch claim
    expect(
      run.insights.filter((i) => i.ruleId === 'model-mismatch'),
    ).toHaveLength(0);
  });

  it('stays silent when no downgrade resolves', () => {
    const run = applyInsights(
      mkRun([
        root(),
        llm('l1', 1, { model: 'claude-haiku-4-5', cost: 5, input: 10_000 }),
      ]),
    );
    expect(
      run.insights.filter((i) => i.ruleId === 'model-mismatch'),
    ).toHaveLength(0);
  });
});

describe('cache-prefix-break vs idle-cache-expiry (spec scenarios)', () => {
  const breakPair = (gapSeconds: number) => [
    root(),
    llm('a', 1, {
      cost: 0.5,
      cacheRead: 80_000,
      endedAt: 2,
    }),
    llm('b', 2 + gapSeconds, {
      cost: 0.9,
      cacheRead: 2_000,
      cacheWrite: 75_000,
    }),
  ];

  it('mid-session prefix break prices min(write, priorRead) at the rate delta', () => {
    const run = applyInsights(mkRun(breakPair(1)));
    const finding = run.insights.find((i) => i.ruleId === 'cache-prefix-break');
    expect(finding).toBeDefined();
    expect(finding?.spanIds).toEqual(['a', 'b']);
    const sonnet = matchModel(bundled, 'claude-sonnet-4-6');
    const expected =
      Math.round(
        75_000 *
          ((sonnet?.cacheWritePerMTok ?? 0) - (sonnet?.cacheReadPerMTok ?? 0)),
      ) / 1e6;
    expect(finding?.estimatedWasteUSD).toBeCloseTo(expected, 6);
    // waste-class: enters the rollup
    expect(run.totals.costUSD.wastedEstimate).toBe(
      finding?.estimatedWasteUSD ?? -1,
    );
  });

  it('a 12-minute gap is claimed by idle-cache-expiry, never duplicated', () => {
    const run = applyInsights(mkRun(breakPair(12 * 60)));
    expect(
      run.insights.filter((i) => i.ruleId === 'cache-prefix-break'),
    ).toHaveLength(0);
    const idle = run.insights.find((i) => i.ruleId === 'idle-cache-expiry');
    expect(idle).toBeDefined();
    expect(idle?.spanIds).toEqual(['a', 'b']);
    expect(idle?.estimatedWasteUSD).toBeGreaterThan(0);
  });

  it('prices the rewrite at the 1h rate when the write carried a 1h TTL', () => {
    const run = applyInsights(
      mkRun([
        root(),
        llm('a', 1, { cost: 0.5, cacheRead: 80_000, endedAt: 2 }),
        llm('b', 3, {
          cost: 0.9,
          cacheRead: 2_000,
          cacheWrite: 75_000,
          write1h: 75_000,
        }),
      ]),
    );
    const finding = run.insights.find((i) => i.ruleId === 'cache-prefix-break');
    const sonnet = matchModel(bundled, 'claude-sonnet-4-6');
    // all-1h write bills at 2× input ($6/M for sonnet), not the 5m $3.75/M —
    // the waste figure must reconcile with the span cost billed next to it
    const expected =
      Math.round(
        75_000 *
          (2 * (sonnet?.inputPerMTok ?? 0) - (sonnet?.cacheReadPerMTok ?? 0)),
      ) / 1e6;
    expect(finding?.estimatedWasteUSD).toBeCloseTo(expected, 6);
  });

  it('a 12-minute gap cannot expire a 1h-TTL cache — prefix-break claims the pair', () => {
    const pair1h = (gapSeconds: number) => [
      root(),
      llm('a', 1, {
        cost: 0.5,
        cacheRead: 80_000,
        cacheWrite: 80_000,
        write1h: 80_000,
        endedAt: 2,
      }),
      llm('b', 2 + gapSeconds, {
        cost: 0.9,
        cacheRead: 2_000,
        cacheWrite: 75_000,
      }),
    ];
    const short = applyInsights(mkRun(pair1h(12 * 60)));
    expect(
      short.insights.filter((i) => i.ruleId === 'idle-cache-expiry'),
    ).toHaveLength(0);
    const brk = short.insights.find((i) => i.ruleId === 'cache-prefix-break');
    expect(brk?.spanIds).toEqual(['a', 'b']);
    // past the actual 60-minute TTL the idle rule claims the pair again
    const long = applyInsights(mkRun(pair1h(65 * 60)));
    expect(
      long.insights.find((i) => i.ruleId === 'idle-cache-expiry')?.spanIds,
    ).toEqual(['a', 'b']);
    expect(
      long.insights.filter((i) => i.ruleId === 'cache-prefix-break'),
    ).toHaveLength(0);
  });

  it('a read-only turn before the gap does not forget the live 1h TTL', () => {
    // 1h prefix written at call 1; call 2 only READS it (no write, so no
    // attribute); the TTL still belongs to the live cache, not to call 2
    const run = applyInsights(
      mkRun([
        root(),
        llm('w', 1, {
          cost: 0.4,
          cacheWrite: 80_000,
          write1h: 80_000,
          endedAt: 2,
        }),
        llm('a', 3, { cost: 0.1, cacheRead: 80_000, endedAt: 4 }),
        llm('b', 4 + 12 * 60, {
          cost: 0.9,
          cacheRead: 2_000,
          cacheWrite: 75_000,
        }),
      ]),
    );
    expect(
      run.insights.filter((i) => i.ruleId === 'idle-cache-expiry'),
    ).toHaveLength(0);
    expect(
      run.insights.find((i) => i.ruleId === 'cache-prefix-break')?.spanIds,
    ).toEqual(['a', 'b']);
  });

  it('no expiry finding when nothing was cached before the gap', () => {
    const run = applyInsights(
      mkRun([
        root(),
        llm('a', 1, { cost: 0.1, endedAt: 2 }),
        llm('b', 2 + 12 * 60, { cost: 0.2, cacheWrite: 75_000 }),
      ]),
    );
    expect(
      run.insights.filter((i) => i.ruleId === 'idle-cache-expiry'),
    ).toHaveLength(0);
  });
});

describe('fixed-context-overhead (born bloated)', () => {
  it('fires on a heavy first call while growth-based context-bloat stays silent', () => {
    const calls = [root()];
    for (let i = 0; i < 20; i++) {
      calls.push(
        llm(`l${i}`, i + 1, {
          cost: 0.2,
          input: 95_000, // flat — growth rule cannot fire
        }),
      );
    }
    const run = applyInsights(mkRun(calls));
    const fixed = run.insights.find(
      (i) => i.ruleId === 'fixed-context-overhead',
    );
    expect(fixed).toBeDefined();
    expect(fixed?.spanIds).toEqual(['l0']);
    expect(fixed?.estimatedWasteUSD).toBeGreaterThan(0);
    expect(
      run.insights.filter((i) => i.ruleId === 'context-bloat'),
    ).toHaveLength(0);
    // opportunity-class: not in the waste rollup
    expect(run.totals.costUSD.wastedEstimate).toBe(0);
  });

  it('stays silent below the floor', () => {
    const calls = [root()];
    for (let i = 0; i < 6; i++)
      calls.push(llm(`l${i}`, i + 1, { cost: 0.1, input: 5_000 }));
    const run = applyInsights(mkRun(calls));
    expect(
      run.insights.filter((i) => i.ruleId === 'fixed-context-overhead'),
    ).toHaveLength(0);
  });
});

describe('duplicate-read', () => {
  it('flags three reads of an unchanged target and prices the redundant bytes', () => {
    const run = applyInsights(
      mkRun([
        root(),
        llm('l1', 0, { cost: 0.3 }),
        tool('r1', 1, { name: 'Read', targetKey: 'k1', outputBytes: 4000 }),
        tool('r2', 2, { name: 'Read', targetKey: 'k1', outputBytes: 4000 }),
        tool('r3', 3, { name: 'Read', targetKey: 'k1', outputBytes: 4000 }),
      ]),
    );
    const finding = run.insights.find((i) => i.ruleId === 'duplicate-read');
    expect(finding).toBeDefined();
    expect(finding?.spanIds).toEqual(['r1', 'r2', 'r3']);
    // title counts the REDUNDANT re-reads (2 of the 3 reads), detail names both
    expect(finding?.title).toContain('re-read 2×');
    expect(finding?.detail).toContain('read 3 times');
    expect(finding?.estimatedWasteUSD).toBeGreaterThan(0);
  });

  it('a write between reads legitimizes the re-read', () => {
    const run = applyInsights(
      mkRun([
        root(),
        tool('r1', 1, { name: 'Read', targetKey: 'k1', outputBytes: 4000 }),
        tool('w1', 2, {
          name: 'Edit',
          targetKey: 'k1',
          targetKind: 'file-write',
        }),
        tool('r2', 3, { name: 'Read', targetKey: 'k1', outputBytes: 4000 }),
        tool('r3', 4, { name: 'Read', targetKey: 'k1', outputBytes: 4000 }),
      ]),
    );
    // only r3 is redundant (r2 followed the edit) — below minRepeats-1
    expect(
      run.insights.filter((i) => i.ruleId === 'duplicate-read'),
    ).toHaveLength(0);
  });
});

describe('scattered-tool-failures', () => {
  it('counts only failures outside retry clusters and prices reaction calls', () => {
    const spans = [root()];
    // one retry cluster (claimed): 3 consecutive same-name failures
    for (let i = 0; i < 3; i++)
      spans.push(tool(`c${i}`, i + 1, { name: 'Agent', status: 'error' }));
    // five scattered failures across distinct tools, each with a reaction llm
    const names = ['Bash', 'Read', 'Edit', 'Glob', 'Grep'];
    names.forEach((name, i) => {
      spans.push(tool(`f${i}`, 10 + i * 2, { name, status: 'error' }));
      spans.push(llm(`re${i}`, 11 + i * 2, { cost: 0.1 }));
    });
    const run = applyInsights(mkRun(spans));
    const finding = run.insights.find(
      (i) => i.ruleId === 'scattered-tool-failures',
    );
    expect(finding).toBeDefined();
    expect(finding?.spanIds).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    expect(finding?.estimatedWasteUSD).toBeCloseTo(0.5, 6);
    expect(finding?.title).toContain('5 scattered');
  });

  it('stays silent below the share threshold', () => {
    const spans = [root()];
    for (let i = 0; i < 30; i++) spans.push(tool(`ok${i}`, i + 1));
    for (let i = 0; i < 5; i++)
      spans.push(tool(`f${i}`, 40 + i, { name: `T${i}`, status: 'error' }));
    const run = applyInsights(mkRun(spans));
    // 5/35 ≈ 14% < 20%
    expect(
      run.insights.filter((i) => i.ruleId === 'scattered-tool-failures'),
    ).toHaveLength(0);
  });
});

describe('oversized-output', () => {
  it('aggregates offenders as an opportunity that never enters the rollup', () => {
    const run = applyInsights(
      mkRun([
        root(),
        llm('l1', 0, { cost: 0.3 }),
        tool('big1', 1, { name: 'Bash', outputBytes: 500_000 }),
        tool('big2', 2, { name: 'Read', outputBytes: 150_000 }),
        tool('small', 3, { outputBytes: 5_000 }),
      ]),
    );
    const finding = run.insights.find((i) => i.ruleId === 'oversized-output');
    expect(finding).toBeDefined();
    expect(finding?.spanIds).toEqual(['big1', 'big2']);
    expect(finding?.severity).toBe('info');
    expect(finding?.estimatedWasteUSD).toBeGreaterThan(0);
    expect(finding?.detail).toContain('≈');
    expect(run.totals.costUSD.wastedEstimate).toBe(0);
  });
});
