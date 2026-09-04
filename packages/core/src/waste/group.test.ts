import type { Insight, Run, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { wasteRun } from './group.js';

/**
 * Waste grouping (waste-grouping capability): groups by rule and class,
 * graded by the group's sum, cent-level groups folded, cache breaks read
 * by shape from the evidence spans, burned findings on the clock, model
 * calls as context points. The findings are inputs here — the engine's
 * detection is tested with the rules.
 */

const T0 = Date.parse('2026-09-04T08:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function base(over: Partial<Span>): Span {
  return {
    id: 'x',
    parentId: 'sess',
    kind: 'tool_call',
    name: 'Bash',
    status: 'ok',
    startedAt: at(0),
    depth: 2,
    attributes: {},
    provenance: { file: 'f' },
    ...over,
  } as Span;
}
function llm(
  id: string,
  s: number,
  tokens: { input?: number; cacheRead?: number; cacheWrite?: number },
  model = 'claude-fable-5-1',
): Span {
  return base({
    id,
    kind: 'llm_call',
    name: 'llm',
    startedAt: at(s),
    endedAt: at(s + 1),
    durationMs: 1000,
    llm: {
      provider: 'anthropic',
      model,
      tokens: {
        input: tokens.input ?? 0,
        output: 10,
        cacheRead: tokens.cacheRead ?? 0,
        cacheWrite: tokens.cacheWrite ?? 0,
      },
      costUSD: 0.1,
      costSource: 'computed',
    },
  });
}
function tool(
  id: string,
  s: number,
  name: string,
  status: Span['status'] = 'ok',
): Span {
  return base({
    id,
    name,
    status,
    startedAt: at(s),
    endedAt: at(s + 0.5),
    durationMs: 500,
    tool: { name, isError: status === 'error' },
  });
}
function finding(
  id: string,
  ruleId: string,
  spanIds: string[],
  estimatedWasteUSD?: number,
  severity: Insight['severity'] = 'info',
): Insight {
  return {
    id,
    ruleId,
    severity,
    title: `${ruleId} ${id}`,
    detail: 'd',
    spanIds,
    ...(estimatedWasteUSD === undefined ? {} : { estimatedWasteUSD }),
  };
}
function run(spans: Span[], insights: Insight[], costUSD = 100): Run {
  return {
    id: 'run1',
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: at(0),
    durationMs: 1_200_000,
    spans: [
      base({
        id: 'sess',
        parentId: null,
        kind: 'session',
        name: 's',
        depth: 0,
      }),
      ...spans,
    ],
    totals: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUSD: { total: costUSD, wastedEstimate: 20.95, byModel: {} },
      counts: {
        llmCalls: 0,
        toolCalls: 0,
        toolErrors: 0,
        subagents: 0,
        maxDepth: 0,
      },
      cache: { hitRate: 0 },
    },
    insights,
  };
}

const SPANS = [
  llm('L1', 0, { input: 50_000 }),
  llm('L2', 100, { cacheRead: 277_000 }),
  // a compaction: context shrinks to 60.6k (< 0.6 × 277k)
  llm('L3', 200, { input: 13_000, cacheRead: 34_000, cacheWrite: 13_600 }),
  llm('L4', 300, { cacheRead: 790_000 }),
  // a history re-write: the 34k front stayed cached, the rest was written
  llm('L5', 400, { input: 1_000, cacheRead: 34_000, cacheWrite: 759_000 }),
  // after an idle gap: everything written again
  llm('L6', 1000, { cacheWrite: 150_000 }, 'claude-opus-4-8'),
  tool('B1', 500, 'Bash', 'error'),
  tool('B2', 510, 'Bash', 'error'),
  tool('B3', 520, 'Bash', 'error'),
  tool('R1', 600, 'Read'),
  tool('R2', 610, 'Read'),
];
const FINDINGS = [
  finding('i1', 'cache-prefix-break', ['L2', 'L3'], 0.26),
  finding('i2', 'cache-prefix-break', ['L4', 'L5'], 14.43),
  finding('i3', 'idle-cache-expiry', ['L5', 'L6'], 2.87),
  finding('i4', 'retry-loop', ['B1', 'B2', 'B3'], 3.36),
  finding('i5', 'duplicate-read', ['R1', 'R2'], 0.01),
  finding('i6', 'duplicate-read', ['R1', 'R2'], 0.01),
  finding('i7', 'duplicate-read', ['R1', 'R2'], 0.01),
  finding('i8', 'context-bloat', ['L6', 'R1'], 659.26, 'critical'),
  finding('i9', 'fixed-context-overhead', ['L1'], 38.31, 'warning'),
  finding('i10', 'low-cache-hit', ['L1']),
];

describe('wasteRun', () => {
  const w = wasteRun(run(SPANS, FINDINGS));

  it('splits groups by class, largest first', () => {
    expect(w.burned.map((g) => [g.ruleId, g.usd, g.count])).toEqual([
      ['cache-prefix-break', 14.69, 2],
      ['retry-loop', 3.36, 1],
      ['idle-cache-expiry', 2.87, 1],
      ['duplicate-read', 0.03, 3],
    ]);
    expect(w.opportunities.map((g) => [g.ruleId, g.usd])).toEqual([
      ['context-bloat', 659.26],
      ['fixed-context-overhead', 38.31],
      ['low-cache-hit', 0],
    ]);
    expect(w.findings).toBe(10);
    expect(w.burnedUSD).toBe(20.95);
    expect(w.burnedShare).toBeCloseTo(0.2095, 6);
    expect(w.opportunityUSD).toBeCloseTo(697.57, 6);
  });

  it('grades a group by its sum with the engine tiers', () => {
    const by = new Map(
      [...w.burned, ...w.opportunities].map((g) => [g.ruleId, g]),
    );
    // 14.69% of a $100 run and over $1: critical although each finding
    // alone was graded info
    expect(by.get('cache-prefix-break')?.severity).toBe('critical');
    expect(by.get('cache-prefix-break')?.share).toBeCloseTo(0.1469, 6);
    expect(by.get('retry-loop')?.severity).toBe('warning');
    expect(by.get('idle-cache-expiry')?.severity).toBe('warning');
    expect(by.get('duplicate-read')?.severity).toBe('info');
    expect(by.get('context-bloat')?.severity).toBe('critical');
  });

  it('folds a group whose findings are all under the warning floor', () => {
    const dup = w.burned.find((g) => g.ruleId === 'duplicate-read');
    expect(dup?.folded).toBe(true);
    expect(w.folded).toBe(3);
    expect(w.burned.find((g) => g.ruleId === 'retry-loop')?.folded).toBe(false);
  });

  it('never folds or grades an unpriced group as if it were sized', () => {
    const low = w.opportunities.find((g) => g.ruleId === 'low-cache-hit');
    expect(low?.unpriced).toBe(true);
    expect(low?.folded).toBe(false);
    expect(low?.severity).toBe('info');
    expect(w.unpriced).toBe(true);
  });

  it('reads the shape and the tokens of a cache break from its evidence', () => {
    const cpb = w.burned.find((g) => g.ruleId === 'cache-prefix-break');
    expect(cpb?.shapes).toEqual({
      compaction: { count: 1, usd: 0.26 },
      history: { count: 1, usd: 14.43 },
    });
    const [big, small] = cpb?.occurrences ?? [];
    expect(big?.insightId).toBe('i2');
    expect(big?.shape).toBe('history');
    expect(big?.cache).toEqual({
      readBefore: 790_000,
      readAfter: 34_000,
      rewritten: 759_000,
    });
    expect(big?.model).toBe('claude-fable-5-1');
    // the leak is at the breaking call, not the call before it
    expect(big?.atMs).toBe(400_000);
    expect(big?.spanId).toBe('L5');
    expect(small?.shape).toBe('compaction');
  });

  it('records the idle gap and the resumed call', () => {
    const idle = w.burned.find((g) => g.ruleId === 'idle-cache-expiry');
    const o = idle?.occurrences[0];
    expect(o?.gapMs).toBe(599_000); // L5 ends at 401s, L6 starts at 1000s
    expect(o?.model).toBe('claude-opus-4-8');
    expect(o?.atMs).toBe(1_000_000);
    expect(o?.cache?.rewritten).toBe(150_000);
  });

  it('caps the idle re-write at what was live before the gap, like the rule', () => {
    const w2 = wasteRun(
      run(
        [
          llm('A', 0, { cacheRead: 10_000 }),
          llm('B', 1000, { cacheWrite: 50_000 }),
        ],
        [finding('i1', 'idle-cache-expiry', ['A', 'B'], 1)],
      ),
    );
    expect(w2.burned[0]?.occurrences[0]?.cache?.rewritten).toBe(10_000);
  });

  it('names the tool and the span of a tool-evidence finding', () => {
    const retry = w.burned.find((g) => g.ruleId === 'retry-loop');
    expect(retry?.occurrences[0]?.tool).toBe('Bash');
    expect(retry?.occurrences[0]?.spanId).toBe('B1');
    expect(retry?.occurrences[0]?.atMs).toBe(500_000);
    expect(retry?.occurrences[0]?.untilMs).toBe(520_500);
  });

  it('places burned findings on the clock, opportunities never', () => {
    expect(
      w.events.map((e) => [e.kind, e.ruleId, e.startMs, e.endMs, e.spanId]),
    ).toEqual([
      ['compaction', 'cache-prefix-break', 200_000, 200_000, 'L3'],
      ['burn', 'cache-prefix-break', 400_000, 400_000, 'L5'],
      ['idle', 'idle-cache-expiry', 401_000, 1_000_000, 'L6'],
      ['burn', 'retry-loop', 500_000, 520_500, 'B1'],
      ['burn', 'duplicate-read', 600_000, 610_500, 'R1'],
      ['burn', 'duplicate-read', 600_000, 610_500, 'R1'],
      ['burn', 'duplicate-read', 600_000, 610_500, 'R1'],
      ['burn', 'idle-cache-expiry', 1_000_000, 1_000_000, 'L6'],
    ]);
    const idle = w.events.find((e) => e.kind === 'idle');
    expect(idle?.usd).toBe(0);
    expect(w.events.find((e) => e.spanId === 'L5')?.usd).toBe(14.43);
  });

  it('lists every model call as a context point', () => {
    expect(w.context.map((c) => [c.offsetMs, c.tokens])).toEqual([
      [0, 50_000],
      [100_000, 277_000],
      [200_000, 60_600],
      [300_000, 790_000],
      [400_000, 794_000],
      [1_000_000, 150_000],
    ]);
    expect(w.context[5]?.model).toBe('claude-opus-4-8');
  });

  it('is deterministic in the findings order', () => {
    const shuffled = [...FINDINGS].reverse();
    expect(wasteRun(run(SPANS, shuffled))).toEqual(w);
  });

  it('is empty for a run without findings', () => {
    const e = wasteRun(run(SPANS, []));
    expect(e.burned).toEqual([]);
    expect(e.opportunities).toEqual([]);
    expect(e.events).toEqual([]);
    expect(e.findings).toBe(0);
    expect(e.unpriced).toBe(false);
    expect(e.context).toHaveLength(6);
  });

  it('survives evidence that does not resolve', () => {
    const w2 = wasteRun(run(SPANS, [finding('i1', 'retry-loop', ['nope'], 1)]));
    expect(w2.burned[0]?.occurrences[0]?.atMs).toBeUndefined();
    expect(w2.burned[0]?.occurrences[0]?.spanId).toBeUndefined();
    expect(w2.events).toEqual([]);
  });

  it('uses the run cost for the share and grades nothing on an unpriced run', () => {
    const w0 = wasteRun(run(SPANS, FINDINGS, 0));
    expect(w0.burned[0]?.share).toBe(0);
    expect(w0.burned[0]?.severity).toBe('info');
    expect(w0.burnedShare).toBe(0);
  });
});
