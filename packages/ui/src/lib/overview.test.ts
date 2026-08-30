import type { Insight, Run, SourceTool, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import {
  aggregateTotals,
  cacheAggregate,
  errorRate,
  mcpShare,
  mostExpensiveCall,
  savingsSummary,
  sessionCostStats,
  spendByDay,
  topModels,
  topProjects,
  topSources,
  topTools,
  wasteByRule,
  worstToolError,
} from './overview';

function toolSpan(name: string, isError: boolean): Span {
  return {
    id: name,
    parentId: null,
    kind: 'tool_call',
    name,
    status: isError ? 'error' : 'ok',
    startedAt: '2026-07-07T10:00:00',
    depth: 1,
    tool: { name, isError },
    attributes: {},
    provenance: { file: 'x' },
  };
}

function llmSpan(id: string, costUSD: number): Span {
  return {
    id,
    parentId: null,
    kind: 'llm_call',
    name: id,
    status: 'ok',
    startedAt: '2026-07-07T10:00:00',
    depth: 1,
    llm: {
      provider: 'anthropic',
      model: 'opus',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUSD,
      costSource: 'computed',
    },
    attributes: {},
    provenance: { file: 'x' },
  };
}

function stubRun(overrides: {
  id: string;
  startedAt?: string;
  cost?: number;
  wasted?: number;
  tokens?: number;
  input?: number;
  cacheRead?: number;
  toolCalls?: number;
  toolErrors?: number;
  source?: SourceTool;
  project?: string;
  byModel?: Record<string, number>;
  codeChanges?: { linesAdded: number; linesRemoved: number };
  insights?: Insight[];
  spans?: Span[];
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
    startedAt: overrides.startedAt ?? '2026-07-07T10:00:00',
    spans: overrides.spans ?? [],
    totals: {
      tokens: {
        input: overrides.input ?? 0,
        output: 0,
        cacheRead: overrides.cacheRead ?? 0,
        cacheWrite: 0,
        total: overrides.tokens ?? 0,
      },
      costUSD: {
        total: overrides.cost ?? 0,
        wastedEstimate: overrides.wasted ?? 0,
        byModel: overrides.byModel ?? {},
      },
      counts: {
        llmCalls: 0,
        toolCalls: overrides.toolCalls ?? 0,
        toolErrors: overrides.toolErrors ?? 0,
        subagents: 0,
        maxDepth: 0,
      },
      cache: { hitRate: 0 },
      ...(overrides.codeChanges !== undefined && {
        codeChanges: overrides.codeChanges,
      }),
    },
    insights: overrides.insights ?? [],
  };
}

function stubInsight(
  id: string,
  wasteUSD?: number,
  ruleId = 'retry-loop',
  severity: Insight['severity'] = 'warning',
): Insight {
  return {
    id,
    ruleId,
    severity,
    title: `finding ${id}`,
    detail: 'detail',
    spanIds: ['s1'],
    ...(wasteUSD !== undefined && { estimatedWasteUSD: wasteUSD }),
  };
}

describe('aggregateTotals', () => {
  it('sums cost, waste, tokens, and code changes across runs', () => {
    const totals = aggregateTotals([
      stubRun({
        id: 'a',
        cost: 1.5,
        wasted: 0.2,
        tokens: 100,
        codeChanges: { linesAdded: 10, linesRemoved: 3 },
      }),
      stubRun({ id: 'b', cost: 2.5, tokens: 50 }),
    ]);
    expect(totals).toEqual({
      costUSD: 4,
      wastedUSD: 0.2,
      tokens: 150,
      sessions: 2,
      linesAdded: 10,
      linesRemoved: 3,
    });
  });
});

describe('spendByDay', () => {
  it('buckets by local day and fills the gaps with zero days', () => {
    const days = spendByDay([
      stubRun({ id: 'a', startedAt: '2026-07-01T09:00:00', cost: 1 }),
      stubRun({
        id: 'b',
        startedAt: '2026-07-01T21:00:00',
        cost: 2,
        wasted: 0.5,
      }),
      stubRun({ id: 'c', startedAt: '2026-07-04T12:00:00', cost: 4 }),
    ]);
    expect(days.map((d) => [d.day, d.costUSD, d.wastedUSD, d.runs])).toEqual([
      ['2026-07-01', 3, 0.5, 2],
      ['2026-07-02', 0, 0, 0],
      ['2026-07-03', 0, 0, 0],
      ['2026-07-04', 4, 0, 1],
    ]);
  });

  it('breaks each day down by model and by source', () => {
    const days = spendByDay([
      stubRun({
        id: 'a',
        startedAt: '2026-07-01T09:00:00',
        cost: 3,
        source: 'claude-code',
        byModel: { opus: 2, haiku: 1 },
      }),
      stubRun({
        id: 'b',
        startedAt: '2026-07-01T20:00:00',
        cost: 5,
        source: 'opencode',
        byModel: { opus: 5 },
      }),
    ]);
    expect(days).toHaveLength(1);
    expect(days[0]?.byModel).toEqual({ opus: 7, haiku: 1 });
    expect(days[0]?.bySource).toEqual({ 'claude-code': 3, opencode: 5 });
  });

  it('caps to the most recent maxDays and handles empty input', () => {
    const days = spendByDay(
      [
        stubRun({ id: 'a', startedAt: '2026-06-01T09:00:00', cost: 1 }),
        stubRun({ id: 'b', startedAt: '2026-07-04T12:00:00', cost: 4 }),
      ],
      7,
    );
    expect(days).toHaveLength(7);
    expect(days[6]?.day).toBe('2026-07-04');
    expect(spendByDay([])).toEqual([]);
  });
});

describe('rankings', () => {
  it('ranks projects by cost with a placeholder for missing names', () => {
    const ranks = topProjects([
      stubRun({ id: 'a', project: 'alpha', cost: 1 }),
      stubRun({ id: 'b', project: 'alpha', cost: 2 }),
      stubRun({ id: 'c', cost: 5 }),
    ]);
    expect(ranks).toEqual([
      { name: '—', costUSD: 5, tokens: 0 },
      { name: 'alpha', costUSD: 3, tokens: 0 },
    ]);
  });

  it('ranks models from byModel rollups across runs', () => {
    const ranks = topModels([
      stubRun({ id: 'a', byModel: { opus: 3, haiku: 0.5 } }),
      stubRun({ id: 'b', byModel: { opus: 1 } }),
    ]);
    expect(ranks).toEqual([
      { name: 'opus', costUSD: 4, tokens: 0 },
      { name: 'haiku', costUSD: 0.5, tokens: 0 },
    ]);
  });

  it('ranks sources by summed cost', () => {
    const ranks = topSources([
      stubRun({ id: 'a', source: 'claude-code', cost: 5 }),
      stubRun({ id: 'b', source: 'opencode', cost: 2 }),
      stubRun({ id: 'c', source: 'claude-code', cost: 1 }),
    ]);
    expect(ranks).toEqual([
      { name: 'claude-code', costUSD: 6, tokens: 0 },
      { name: 'opencode', costUSD: 2, tokens: 0 },
    ]);
  });
});

describe('cacheAggregate', () => {
  it('token-weights the hit-rate — never a naive mean of per-run rates', () => {
    // Run A: 900 cacheRead / 100 input (rate 0.9, big). Run B: 0/100 (rate 0).
    // Weighted: 900 / (900 + 200) = 0.818…, NOT the (0.9+0)/2 = 0.45 mean.
    const agg = cacheAggregate([
      stubRun({ id: 'a', cacheRead: 900, input: 100 }),
      stubRun({ id: 'b', cacheRead: 0, input: 100 }),
    ]);
    expect(agg.hitRate).toBeCloseTo(900 / 1100, 10);
    expect(agg.cacheReadTokens).toBe(900);
  });

  it('is zero (not NaN) with no input-class tokens', () => {
    expect(cacheAggregate([stubRun({ id: 'a' })])).toEqual({
      hitRate: 0,
      cacheReadTokens: 0,
    });
    expect(cacheAggregate([])).toEqual({ hitRate: 0, cacheReadTokens: 0 });
  });
});

describe('errorRate', () => {
  it('aggregates errors over calls across runs', () => {
    const r = errorRate([
      stubRun({ id: 'a', toolCalls: 10, toolErrors: 2 }),
      stubRun({ id: 'b', toolCalls: 30, toolErrors: 1 }),
    ]);
    expect(r).toEqual({ rate: 3 / 40, errors: 3, calls: 40 });
  });

  it('is zero (not NaN) when nothing ran', () => {
    expect(errorRate([stubRun({ id: 'a' })])).toEqual({
      rate: 0,
      errors: 0,
      calls: 0,
    });
  });
});

describe('sessionCostStats', () => {
  it('reports mean and median; median resists a runaway session', () => {
    // costs 1,1,1,1,96 → mean 20, median 1
    const stats = sessionCostStats(
      [1, 1, 1, 1, 96].map((c, i) => stubRun({ id: `r${i}`, cost: c })),
    );
    expect(stats.averageUSD).toBe(20);
    expect(stats.medianUSD).toBe(1);
  });

  it('averages the two middles for an even count', () => {
    const stats = sessionCostStats(
      [2, 4, 6, 8].map((c, i) => stubRun({ id: `r${i}`, cost: c })),
    );
    expect(stats.averageUSD).toBe(5);
    expect(stats.medianUSD).toBe(5); // (4 + 6) / 2
  });

  it('is zeros for no runs', () => {
    expect(sessionCostStats([])).toEqual({ averageUSD: 0, medianUSD: 0 });
  });
});

describe('worstToolError', () => {
  it('picks the most-failed tool across runs; null when clean', () => {
    const runs = [
      stubRun({
        id: 'a',
        spans: [
          toolSpan('Bash', true),
          toolSpan('Bash', true),
          toolSpan('Read', false),
        ],
      }),
      stubRun({ id: 'b', spans: [toolSpan('Edit', true)] }),
    ];
    expect(worstToolError(runs)).toEqual({ name: 'Bash', count: 2 });
    expect(worstToolError([stubRun({ id: 'c' })])).toBeNull();
  });
});

describe('mostExpensiveCall', () => {
  it('returns the priciest priced llm span, 0 when none', () => {
    const runs = [
      stubRun({ id: 'a', spans: [llmSpan('x', 1.2), llmSpan('y', 3.4)] }),
      stubRun({ id: 'b', spans: [llmSpan('z', 0.9)] }),
    ];
    expect(mostExpensiveCall(runs)).toBeCloseTo(3.4, 10);
    expect(mostExpensiveCall([stubRun({ id: 'c' })])).toBe(0);
  });
});

describe('wasteByRule', () => {
  it('groups waste-bearing insights by ruleId, worst group first (the spec scenario)', () => {
    // three retry-loop findings + one low-cache-hit, across runs
    const groups = wasteByRule([
      stubRun({
        id: 'r1',
        insights: [
          stubInsight('a', 12, 'retry-loop', 'critical'),
          stubInsight('b', 3, 'low-cache-hit', 'warning'),
        ],
      }),
      stubRun({
        id: 'r2',
        insights: [stubInsight('c', 6, 'retry-loop', 'warning')],
      }),
      stubRun({
        id: 'r3',
        insights: [stubInsight('d', 2, 'retry-loop', 'warning')],
      }),
    ]);
    expect(
      groups.map((g) => [
        g.ruleId,
        g.count,
        g.sessionCount,
        g.totalUSD,
        g.worstSeverity,
      ]),
    ).toEqual([
      // retry-loop: 3 findings across 3 sessions, $20, worst=critical, first
      ['retry-loop', 3, 3, 20, 'critical'],
      ['low-cache-hit', 1, 1, 3, 'warning'],
    ]);
    // findings inside the group are worst-first
    expect(groups[0]?.entries.map((e) => e.insight.id)).toEqual([
      'a',
      'c',
      'd',
    ]);
  });

  it('skips zero-waste insights and returns [] when nothing wastes', () => {
    expect(
      wasteByRule([
        stubRun({ id: 'r1', insights: [stubInsight('i1')] }), // no waste
      ]),
    ).toEqual([]);
  });

  it('counts distinct sessions, not findings, per group', () => {
    // two findings from the SAME run → count 2, sessionCount 1
    const groups = wasteByRule([
      stubRun({
        id: 'r1',
        insights: [stubInsight('a', 5), stubInsight('b', 4)],
      }),
    ]);
    expect([groups[0]?.count, groups[0]?.sessionCount]).toEqual([2, 1]);
  });
});

describe('savingsSummary (D1)', () => {
  it('class-sums the split: burned = capped rollup, opportunity = class members', () => {
    const runs = [
      stubRun({
        id: 'r1',
        wasted: 3,
        insights: [
          stubInsight('i1', 5, 'dead-end-run'), // waste-class, capped to 3 in rollup
          stubInsight('i2', 5, 'low-cache-hit'), // opportunity
          stubInsight('i3', 2, 'model-mismatch'), // opportunity (registry)
          stubInsight('i4', 1, 'future-unknown-rule'), // open set → opportunity
        ],
      }),
    ];
    const s = savingsSummary(runs);
    expect(s.burnedUSD).toBe(3); // rollup, NOT the $5 finding
    expect(s.opportunityUSD).toBe(8);
    expect(s.findings).toBe(4);
  });

  it('ranks top changes by summed estimate and honors topN', () => {
    const runs = [
      stubRun({
        id: 'r1',
        wasted: 0,
        insights: [
          stubInsight('i1', 1, 'a-rule'),
          stubInsight('i2', 5, 'b-rule'),
          stubInsight('i3', 3, 'c-rule'),
          stubInsight('i4', 2, 'd-rule'),
        ],
      }),
    ];
    const s = savingsSummary(runs, 2);
    expect(s.topChanges.map((g) => g.ruleId)).toEqual(['b-rule', 'c-rule']);
  });

  it('empty findings yield an all-zero summary (honest empty state)', () => {
    const s = savingsSummary([stubRun({ id: 'r1', wasted: 0, insights: [] })]);
    expect(s.burnedUSD).toBe(0);
    expect(s.opportunityUSD).toBe(0);
    expect(s.findings).toBe(0);
    expect(s.topChanges).toEqual([]);
  });
});

describe('topTools + mcpShare (E5)', () => {
  const toolSpan = (
    id: string,
    name: string,
    kind: 'tool_call' | 'mcp_call',
    mcpServer?: string,
  ): Span => ({
    id,
    parentId: 'l1',
    kind,
    name,
    status: 'ok',
    startedAt: '2026-07-07T10:00:01Z',
    endedAt: '2026-07-07T10:00:03Z',
    durationMs: 2000,
    depth: 1,
    attributes: {},
    provenance: { file: 'x' },
    tool: {
      name,
      isError: false,
      ...(mcpServer === undefined ? {} : { mcpServer }),
    },
  });
  const llmSpan = (cost: number): Span => ({
    id: 'l1',
    parentId: null,
    kind: 'llm_call',
    name: 'm',
    status: 'ok',
    startedAt: '2026-07-07T10:00:00Z',
    depth: 0,
    attributes: {},
    provenance: { file: 'x' },
    llm: {
      provider: 'anthropic',
      model: 'm',
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      costUSD: cost,
      costSource: 'computed',
    },
  });

  it('merges per-run attribution, excludes orchestration, attaches p95', () => {
    const run = stubRun({
      id: 'r1',
      spans: [
        llmSpan(4),
        toolSpan('t1', 'webfetch', 'tool_call'),
        toolSpan('t2', 'ctx7_query', 'mcp_call', 'ctx7'),
      ],
    });
    const tools = topTools([run]);
    expect(tools.map((t) => t.name).sort()).toEqual(['ctx7_query', 'webfetch']);
    const mcp = tools.find((t) => t.name === 'ctx7_query');
    expect(mcp?.mcpServer).toBe('ctx7');
    expect(mcp?.costUSD).toBeCloseTo(2, 6); // equal split of the $4 turn
    expect(mcp?.p95Ms).toBe(2000);
    expect(tools.some((t) => t.name.includes('Orchestration'))).toBe(false);

    const share = mcpShare([run]);
    expect(share.share).toBeCloseTo(0.5, 6);
    expect(share.topServer).toBe('ctx7');
  });

  it('mcpShare covers the FULL leaderboard, not just the displayed top-8', () => {
    // 10 tools share one $10 turn ($1 each): an MCP tool ranks 10th (ties
    // break by name, and 'zzz_mcp' sorts last) so it falls outside the top-8
    const spans: Span[] = [llmSpan(10)];
    const names = [
      'aaa',
      'bbb',
      'ccc',
      'ddd',
      'eee',
      'fff',
      'ggg',
      'hhh',
      'iii',
    ];
    names.forEach((n, i) => {
      spans.push(toolSpan(`t${i}`, n, 'tool_call'));
    });
    spans.push(toolSpan('tm', 'zzz_mcp', 'mcp_call', 'srv'));
    const run = stubRun({ id: 'r1', spans });

    const tools = topTools([run]); // top 8 — the MCP tool is not shown
    expect(tools.some((t) => t.name === 'zzz_mcp')).toBe(false);

    const share = mcpShare([run]);
    // full denominator = $10 across 10 tools; the $1 MCP tool = 10%
    expect(share.costUSD).toBeCloseTo(1, 6);
    expect(share.share).toBeCloseTo(0.1, 6);
    expect(share.topServer).toBe('srv');
  });
});
