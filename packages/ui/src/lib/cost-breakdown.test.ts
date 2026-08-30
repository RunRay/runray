import { repriceRun } from '@runray/core/pricing';
import type { Run, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import {
  type AgentTreeNode,
  agentSubtreeCosts,
  agentSubtreeTree,
  bucketCostByModel,
  heatForShare,
  toolSpendLeaderboard,
  treemapLayout,
} from './cost-breakdown';

const at = (sec: number) =>
  `2026-07-07T10:00:${String(sec).padStart(2, '0')}.000Z`;
const atMs = (sec: number) => Date.parse(at(sec));

function stubSpan(overrides: {
  id: string;
  parentId?: string | null;
  kind?: Span['kind'];
  startedAt?: string;
  durationMs?: number;
  model?: string;
  costUSD?: number;
  costSource?: 'reported' | 'computed' | 'unknown';
}): Span {
  return {
    id: overrides.id,
    parentId: overrides.parentId ?? null,
    kind:
      overrides.kind ??
      (overrides.model !== undefined ? 'llm_call' : 'tool_call'),
    name: overrides.id,
    status: 'ok',
    startedAt: overrides.startedAt ?? at(0),
    durationMs: overrides.durationMs ?? 1000,
    depth: 0,
    ...(overrides.model !== undefined && {
      llm: {
        provider: 'anthropic',
        model: overrides.model,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        ...(overrides.costUSD !== undefined && { costUSD: overrides.costUSD }),
        costSource: overrides.costSource ?? 'computed',
      },
    }),
    attributes: {},
    provenance: { file: 'stub.jsonl' },
  };
}

describe('bucketCostByModel', () => {
  const range = { start: atMs(0), end: atMs(40) };

  it('drops cost into the bucket where the call completes, keyed by model', () => {
    const buckets = bucketCostByModel(
      [
        stubSpan({
          id: 'a',
          startedAt: at(0),
          durationMs: 1000,
          model: 'opus',
          costUSD: 0.2,
        }),
        stubSpan({
          id: 'b',
          startedAt: at(0),
          durationMs: 1000,
          model: 'haiku',
          costUSD: 0.1,
        }),
        stubSpan({
          id: 'c',
          startedAt: at(38),
          durationMs: 1000,
          model: 'opus',
          costUSD: 0.4,
        }),
      ],
      range,
      4,
    );
    expect(buckets).toHaveLength(4);
    expect(buckets[0]?.byModel.get('opus')).toBeCloseTo(0.2);
    expect(buckets[0]?.byModel.get('haiku')).toBeCloseTo(0.1);
    expect(buckets[0]?.total).toBeCloseTo(0.3);
    expect(buckets[1]?.total).toBe(0);
    expect(buckets[3]?.byModel.get('opus')).toBeCloseTo(0.4);
  });

  it('clamps end-of-run costs into the last bucket and skips unknown source', () => {
    const buckets = bucketCostByModel(
      [
        stubSpan({
          id: 'a',
          startedAt: at(40),
          durationMs: 5000,
          model: 'opus',
          costUSD: 1,
        }),
        stubSpan({
          id: 'b',
          startedAt: at(1),
          durationMs: 0,
          model: 'x',
          costUSD: 9,
          costSource: 'unknown',
        }),
      ],
      range,
      4,
    );
    expect(buckets[3]?.total).toBe(1);
    expect(buckets.reduce((s, b) => s + b.total, 0)).toBe(1);
  });
});

describe('agentSubtreeCosts', () => {
  it('attributes cost to the innermost subagent, remainder to main', () => {
    const spans = [
      stubSpan({ id: 'root', kind: 'session' }),
      stubSpan({
        id: 'llm-main',
        parentId: 'root',
        model: 'opus',
        costUSD: 0.5,
      }),
      stubSpan({ id: 'sub1', parentId: 'root', kind: 'subagent' }),
      stubSpan({
        id: 'llm-s1',
        parentId: 'sub1',
        model: 'haiku',
        costUSD: 0.2,
      }),
      stubSpan({ id: 'sub2', parentId: 'sub1', kind: 'subagent' }),
      stubSpan({ id: 'tool-s2', parentId: 'sub2', kind: 'tool_call' }),
      stubSpan({
        id: 'llm-s2',
        parentId: 'tool-s2',
        model: 'haiku',
        costUSD: 0.7,
      }),
    ];
    const cells = agentSubtreeCosts(spans);
    expect(cells.map((c) => [c.name, c.cost])).toEqual([
      ['sub2', 0.7],
      ['main session', 0.5],
      ['sub1', 0.2],
    ]);
    expect(cells[0]?.rootId).toBe('sub2');
  });
});

describe('treemapLayout', () => {
  it('produces proportional, in-bounds cells', () => {
    const cells = treemapLayout(
      [{ v: 6 }, { v: 3 }, { v: 1 }],
      (i) => i.v,
      100,
      100,
    );
    expect(cells).toHaveLength(3);
    const zero = { w: 0, h: 0 };
    const area = (c: { w: number; h: number }) => c.w * c.h;
    expect(area(cells[0] ?? zero)).toBeCloseTo(6000, 5);
    expect(area(cells[1] ?? zero)).toBeCloseTo(3000, 5);
    expect(area(cells[2] ?? zero)).toBeCloseTo(1000, 5);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(100.000001);
      expect(c.y + c.h).toBeLessThanOrEqual(100.000001);
    }
  });

  it('drops zero-value items and handles empty input', () => {
    expect(treemapLayout([], (i: { v: number }) => i.v, 100, 60)).toEqual([]);
    expect(treemapLayout([{ v: 0 }], (i) => i.v, 100, 60)).toEqual([]);
  });
});

describe('heatForShare', () => {
  it('grades thirds of the max', () => {
    expect(heatForShare(0, 1)).toBe(0);
    expect(heatForShare(0.2, 1)).toBe(1);
    expect(heatForShare(0.5, 1)).toBe(2);
    expect(heatForShare(1, 1)).toBe(3);
  });
});

describe('toolSpendLeaderboard', () => {
  it('correctly attributes direct child tool calls and counts calls', () => {
    const spans = [
      stubSpan({ id: 'session', kind: 'session' }),
      {
        ...stubSpan({
          id: 'llm1',
          parentId: 'session',
          model: 'opus',
          costUSD: 0.1,
        }),
        llm: {
          provider: 'anthropic',
          model: 'opus',
          tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
          costUSD: 0.1,
          costSource: 'computed' as const,
        },
      },
      {
        ...stubSpan({ id: 'tool1', parentId: 'llm1', kind: 'tool_call' }),
        tool: { name: 'grep', isError: false },
      },
      {
        ...stubSpan({ id: 'tool2', parentId: 'llm1', kind: 'tool_call' }),
        tool: { name: 'grep', isError: false },
      },
    ];

    const leaderboard = toolSpendLeaderboard(spans);
    expect(leaderboard).toHaveLength(1);
    expect(leaderboard[0]?.name).toBe('grep');
    expect(leaderboard[0]?.costUSD).toBeCloseTo(0.1);
    expect(leaderboard[0]?.tokens.total).toBe(1200);
    expect(leaderboard[0]?.calls).toBe(2);
  });

  it('splits cost and tokens equally among unique tool names in one LLM turn', () => {
    const spans = [
      stubSpan({ id: 'session', kind: 'session' }),
      {
        ...stubSpan({
          id: 'llm1',
          parentId: 'session',
          model: 'opus',
          costUSD: 0.3,
        }),
        llm: {
          provider: 'anthropic',
          model: 'opus',
          tokens: { input: 300, output: 60, cacheRead: 0, cacheWrite: 0 },
          costUSD: 0.3,
          costSource: 'computed' as const,
        },
      },
      {
        ...stubSpan({ id: 'tool1', parentId: 'llm1', kind: 'tool_call' }),
        tool: { name: 'grep', isError: false },
      },
      {
        ...stubSpan({ id: 'tool2', parentId: 'llm1', kind: 'tool_call' }),
        tool: { name: 'read_file', isError: false },
      },
    ];

    const leaderboard = toolSpendLeaderboard(spans);
    expect(leaderboard).toHaveLength(2);
    const grep = leaderboard.find((t) => t.name === 'grep');
    const read = leaderboard.find((t) => t.name === 'read_file');
    expect(grep?.costUSD).toBeCloseTo(0.15);
    expect(grep?.tokens.total).toBe(180);
    expect(grep?.calls).toBe(1);
    expect(read?.costUSD).toBeCloseTo(0.15);
    expect(read?.tokens.total).toBe(180);
    expect(read?.calls).toBe(1);
  });

  it('attributes OTLP style sibling turns via turn parent', () => {
    const spans = [
      stubSpan({ id: 'session', kind: 'session' }),
      stubSpan({ id: 'turn1', parentId: 'session', kind: 'turn' }),
      {
        ...stubSpan({
          id: 'llm1',
          parentId: 'turn1',
          model: 'haiku',
          costUSD: 0.05,
        }),
        llm: {
          provider: 'anthropic',
          model: 'haiku',
          tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
          costUSD: 0.05,
          costSource: 'computed' as const,
        },
      },
      {
        ...stubSpan({ id: 'tool1', parentId: 'turn1', kind: 'tool_call' }),
        tool: { name: 'grep', isError: false },
      },
    ];

    const leaderboard = toolSpendLeaderboard(spans);
    expect(leaderboard).toHaveLength(1);
    expect(leaderboard[0]?.name).toBe('grep');
    expect(leaderboard[0]?.costUSD).toBeCloseTo(0.05);
    expect(leaderboard[0]?.tokens.total).toBe(120);
    expect(leaderboard[0]?.calls).toBe(1);
  });

  it('groups unaffiliated calls under Orchestration / Interface', () => {
    const spans = [
      stubSpan({ id: 'session', kind: 'session' }),
      {
        ...stubSpan({
          id: 'llm1',
          parentId: 'session',
          model: 'opus',
          costUSD: 0.1,
        }),
        llm: {
          provider: 'anthropic',
          model: 'opus',
          tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
          costUSD: 0.1,
          costSource: 'computed' as const,
        },
      },
    ];

    const leaderboard = toolSpendLeaderboard(spans);
    expect(leaderboard).toHaveLength(1);
    expect(leaderboard[0]?.name).toBe('Orchestration / Interface');
    expect(leaderboard[0]?.costUSD).toBeCloseTo(0.1);
    expect(leaderboard[0]?.tokens.total).toBe(1200);
  });
});

describe('agentSubtreeTree (D3)', () => {
  const nested = () => [
    stubSpan({ id: 'root', parentId: null, kind: 'session' }),
    stubSpan({ id: 'l0', parentId: 'root', model: 'm', costUSD: 0.1 }),
    stubSpan({ id: 'outer', parentId: 'root', kind: 'subagent' }),
    stubSpan({ id: 'l1', parentId: 'outer', model: 'm', costUSD: 0.5 }),
    stubSpan({ id: 'inner', parentId: 'outer', kind: 'subagent' }),
    stubSpan({ id: 'l2', parentId: 'inner', model: 'm', costUSD: 5 }),
  ];

  it('nests delegation and includes children in parent totals', () => {
    const tree = agentSubtreeTree(nested(), 'cost');
    expect(tree.name).toBe('main session');
    expect(tree.own).toBeCloseTo(0.1, 6);
    expect(tree.total).toBeCloseTo(5.6, 6);
    const outer = tree.children[0];
    expect(outer?.rootId).toBe('outer');
    expect(outer?.own).toBeCloseTo(0.5, 6); // l2 belongs to inner, not outer
    expect(outer?.total).toBeCloseTo(5.5, 6);
    expect(outer?.children[0]?.rootId).toBe('inner');
    expect(outer?.children[0]?.own).toBeCloseTo(5, 6);
  });

  it('token mode re-derives values with the same nesting', () => {
    const tree = agentSubtreeTree(nested(), 'tokens');
    // every llm stub carries 2 tokens (1 in / 1 out)
    expect(tree.own).toBe(2);
    expect(tree.total).toBe(6);
    expect(tree.children[0]?.children[0]?.own).toBe(2);
  });

  it('Σ own equals Σ core attribution cells (pinned — the treemap and the what-if panel must agree)', () => {
    const spans = nested();
    const run: Run = {
      id: 'run_pin',
      source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
      startedAt: at(0),
      spans,
      totals: {
        tokens: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
        costUSD: { total: 5.6, wastedEstimate: 0, byModel: {} },
        counts: {
          llmCalls: 3,
          toolCalls: 0,
          toolErrors: 0,
          subagents: 2,
          maxDepth: 3,
        },
        cache: { hitRate: 0 },
      },
      insights: [],
    };
    const emptyTable = {
      snapshotDate: '2026-01-01',
      source: 'litellm-snapshot' as const,
      aliases: {},
      entries: [],
    };
    // self-mapped targets: repriceRun's cells carry pure current attribution
    const cells = repriceRun(run, emptyTable, new Map()).subtrees;
    const collect = (node: AgentTreeNode): Array<[string | null, number]> => [
      [node.rootId, node.own] as [string | null, number],
      ...node.children.flatMap(collect),
    ];
    const uiOwn = new Map(collect(agentSubtreeTree(spans, 'cost')));
    for (const cell of cells) {
      expect(uiOwn.get(cell.rootId) ?? 0).toBeCloseTo(cell.currentUSD, 6);
    }
    const uiSum = [...uiOwn.values()].reduce((a, b) => a + b, 0);
    const coreSum = cells.reduce((a, c) => a + c.currentUSD, 0);
    expect(uiSum).toBeCloseTo(coreSum, 6);
  });
});
