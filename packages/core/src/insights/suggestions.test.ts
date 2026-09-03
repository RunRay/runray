import { describe, expect, it } from 'vitest';
import type { RawRun, RawSpan } from '../adapter.js';
import { normalize } from '../normalize.js';
import {
  bundledPricing,
  CACHE_WRITE_1H_ATTR,
  matchModel,
} from '../pricing/index.js';
import { applyInsights } from './index.js';

/**
 * Suggestions address the person running the agent, name a lever that
 * person has, and pick it by `run.source.tool`. These tests pin the copy
 * contract, not the detection (that lives in rules/new-rules tests).
 */

/** The sources suggestions distinguish (the schema also knows 'unknown'). */
type Source = 'claude-code' | 'opencode' | 'otlp';
const FORMAT: Record<Source, RawRun['source']['format']> = {
  'claude-code': 'claude-jsonl',
  opencode: 'opencode-storage',
  otlp: 'otlp-json',
};

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
    cacheWrite?: number;
    write1h?: number;
    cost?: number;
    parentId?: string;
    model?: string;
  } = {},
): RawSpan {
  return base(id, {
    kind: 'llm_call',
    startedAt: ts(second),
    endedAt: ts(second + 1),
    ...(opts.write1h === undefined
      ? {}
      : { attributes: { [CACHE_WRITE_1H_ATTR]: opts.write1h } }),
    parentId: opts.parentId ?? 'root',
    llm: {
      provider: 'anthropic',
      model: opts.model ?? 'claude-sonnet-4-6',
      tokens: {
        input: opts.input ?? 1000,
        output: 100,
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
    kind?: 'tool_call' | 'mcp_call';
    mcpServer?: string;
    status?: RawSpan['status'];
    parentId?: string;
    outputBytes?: number;
    targetKey?: string;
    targetKind?: 'file-read' | 'file-write' | 'command';
    linesAdded?: number;
    /** The failure's text, as the adapters keep it on error tool spans. */
    errorText?: string;
  } = {},
): RawSpan {
  const name = opts.name ?? 'Bash';
  return base(id, {
    kind: opts.kind ?? 'tool_call',
    name,
    startedAt: ts(second),
    endedAt: ts(second + 1),
    parentId: opts.parentId ?? 'root',
    status: opts.status ?? 'ok',
    ...(opts.errorText === undefined
      ? {}
      : { content: { outputPreview: opts.errorText } }),
    attributes:
      opts.targetKey === undefined
        ? {}
        : {
            'runray.targetKey': opts.targetKey,
            'runray.targetKind': opts.targetKind ?? 'file-read',
          },
    tool: {
      name,
      isError: opts.status === 'error',
      ...(opts.mcpServer === undefined ? {} : { mcpServer: opts.mcpServer }),
      ...(opts.outputBytes === undefined
        ? {}
        : { outputBytes: opts.outputBytes }),
      ...(opts.linesAdded === undefined ? {} : { linesAdded: opts.linesAdded }),
    },
  });
}

const sub = (id: string, second: number): RawSpan =>
  base(id, {
    kind: 'subagent',
    name: `subagent:${id}`,
    startedAt: ts(second),
    parentId: 'root',
    agent: { name: id },
  });

function findings(spans: RawSpan[], source: Source = 'claude-code') {
  const raw: RawRun = {
    source: { tool: source, format: FORMAT[source], files: ['x'] },
    spans,
    warnings: [],
  };
  return applyInsights(normalize(raw)).insights;
}
function suggestionOf(
  spans: RawSpan[],
  ruleId: string,
  source: Source = 'claude-code',
): string {
  const f = findings(spans, source).find((i) => i.ruleId === ruleId);
  if (f?.suggestion === undefined)
    throw new Error(`${ruleId} did not fire for ${source}`);
  return f.suggestion;
}

describe('retry-loop suggestion picks the lever by tool class', () => {
  // the failures hang off the model call that issued them, as in the
  // adapters — that call is what the loop bills
  const fail = (id: string, sec: number, name: string, extra: object) =>
    tool(id, sec, {
      name,
      status: 'error',
      targetKey: 'k',
      parentId: 'l1',
      ...extra,
    });
  const loop = (name: string, extra: Parameters<typeof tool>[2] = {}) => [
    root(),
    llm('l1', 0, { cost: 0.5 }),
    fail('t1', 1, name, extra),
    fail('t2', 2, name, extra),
    fail('t3', 3, name, extra),
  ];

  it('shell: points at the instructions file of the source', () => {
    expect(suggestionOf(loop('Bash'), 'retry-loop')).toContain('CLAUDE.md');
    expect(suggestionOf(loop('bash'), 'retry-loop', 'opencode')).toContain(
      'AGENTS.md',
    );
    expect(suggestionOf(loop('Bash'), 'retry-loop', 'otlp')).toContain(
      'system prompt',
    );
  });

  it('edit: points at the file changing under the agent', () => {
    expect(suggestionOf(loop('Edit'), 'retry-loop')).toMatch(
      /changed the file under the agent/,
    );
  });

  it('mcp: names the server', () => {
    const s = suggestionOf(
      loop('mcp__notion__search', { kind: 'mcp_call', mcpServer: 'notion' }),
      'retry-loop',
    );
    expect(s).toContain('notion MCP server');
    expect(s).toContain('3 failures in a row');
  });

  it('anything else: tells the person to interrupt, with the loop cost', () => {
    const s = suggestionOf(loop('Grep'), 'retry-loop');
    expect(s).toMatch(/^Interrupt the agent/);
    expect(s).toContain('$0.50');
  });

  it('detail no longer claims the calls were identical', () => {
    const f = findings(loop('Bash')).find((i) => i.ruleId === 'retry-loop');
    expect(f?.detail).toMatch(/^3 consecutive Bash calls failed/);
  });
});

describe('fixed-context-overhead suggestion', () => {
  const heavy = (extra: RawSpan[] = []) => [
    root(),
    llm('l1', 0, { input: 30_000 }),
    llm('l2', 10),
    llm('l3', 20),
    llm('l4', 30),
    llm('l5', 40),
    ...extra,
  ];

  it('lists the candidates the person controls in Claude Code', () => {
    const s = suggestionOf(heavy(), 'fixed-context-overhead');
    expect(s).toContain('CLAUDE.md');
    expect(s).toContain('no MCP server was called in this session');
    expect(s).toContain('re-read 4 times');
  });

  it('names the MCP servers that were actually called, sorted', () => {
    const s = suggestionOf(
      heavy([
        tool('m1', 5, { kind: 'mcp_call', name: 'mcp__z__a', mcpServer: 'z' }),
        tool('m2', 6, { kind: 'mcp_call', name: 'mcp__a__b', mcpServer: 'a' }),
        tool('m3', 7, { kind: 'mcp_call', name: 'mcp__a__c', mcpServer: 'a' }),
      ]),
      'fixed-context-overhead',
    );
    expect(s).toContain('only a and z were called in this session');
  });

  it('speaks OpenCode and OTLP', () => {
    expect(
      suggestionOf(heavy(), 'fixed-context-overhead', 'opencode'),
    ).toContain('mcp.<name>.enabled: false');
    expect(suggestionOf(heavy(), 'fixed-context-overhead', 'otlp')).toMatch(
      /^Trim the fixed part of every request/,
    );
  });
});

describe('idle-cache-expiry suggestion', () => {
  const pair = (gapMinutes: number, write1h?: number) => [
    root(),
    llm('l1', 0, {
      cacheRead: 50_000,
      cacheWrite: 1_000,
      ...(write1h === undefined ? {} : { write1h }),
    }),
    llm('l2', gapMinutes * 60, { cacheWrite: 50_000 }),
  ];

  it('a long break: compact first or start a new session, with the running cost', () => {
    const s = suggestionOf(pair(120), 'idle-cache-expiry');
    expect(s).toMatch(/^Compact before a long break, or start the next task/);
    expect(s).toContain('resuming after 120 minutes re-wrote 50.0k tokens');
    expect(s).toMatch(/every further call in this context costs \$\d/);
  });

  it('a short break on a 5-minute cache in Claude Code: the TTL is a setting', () => {
    const s = suggestionOf(pair(10), 'idle-cache-expiry');
    expect(s).toMatch(/^Compact before stepping away/);
    expect(s).toContain('promptCacheTtl');
    expect(s).toContain('a 10-minute pause');
  });

  it('the TTL hint is Claude Code only', () => {
    expect(
      suggestionOf(pair(10), 'idle-cache-expiry', 'opencode'),
    ).not.toContain('promptCacheTtl');
  });
});

describe('low-cache-hit suggestion names the cause per source', () => {
  const cold = () => [
    root(),
    ...[0, 10, 20, 30, 40].map((sec, i) =>
      llm(`l${i}`, sec, { input: 20_000, cost: 0.1 }),
    ),
  ];
  it('claude-code: the prefix must be changing', () => {
    expect(suggestionOf(cold(), 'low-cache-hit')).toContain(
      'cache-prefix-break',
    );
  });
  it('opencode: the provider may not cache', () => {
    expect(suggestionOf(cold(), 'low-cache-hit', 'opencode')).toContain(
      'provider and model support prompt caching',
    );
  });
  it('otlp: the agent has to mark the prefix', () => {
    expect(suggestionOf(cold(), 'low-cache-hit', 'otlp')).toMatch(
      /^Mark a stable prefix/,
    );
  });
});

describe('model and subagent suggestions say where the switch lives', () => {
  const opus = (id: string, sec: number, parentId = 'root') =>
    llm(id, sec, {
      model: 'claude-opus-4-8',
      cost: 5,
      input: 10_000,
      parentId,
    });

  it('model-mismatch: /model alias in Claude Code, /models in OpenCode', () => {
    expect(suggestionOf([root(), opus('l1', 1)], 'model-mismatch')).toContain(
      '/model sonnet switches mid-session',
    );
    expect(
      suggestionOf([root(), opus('l1', 1)], 'model-mismatch', 'opencode'),
    ).toContain('/models');
    expect(
      suggestionOf([root(), opus('l1', 1)], 'model-mismatch', 'otlp'),
    ).not.toContain('/model');
  });

  it('expensive-subagent: frontmatter in Claude Code, agent config in OpenCode', () => {
    const spans = [
      root(),
      llm('l0', 1, { cost: 0.05 }),
      sub('worker', 2),
      opus('l1', 3, 'worker'),
    ];
    expect(suggestionOf(spans, 'expensive-subagent')).toContain(
      "model: claude-sonnet-5 in the worker agent's frontmatter",
    );
    expect(suggestionOf(spans, 'expensive-subagent', 'opencode')).toContain(
      'agent.worker.model = claude-sonnet-5 in opencode.json',
    );
  });
});

describe('the remaining rules address the person, with the finding in numbers', () => {
  it('scattered-tool-failures: the dominant tool with its share, and the instructions file', () => {
    const s = suggestionOf(
      [
        root(),
        llm('l1', 0, { cost: 0.2 }),
        tool('t1', 1, { name: 'Grep', status: 'error' }),
        tool('t2', 2, { name: 'Grep', status: 'error' }),
        tool('t3', 3, { name: 'Glob', status: 'error' }),
        tool('t4', 4, { name: 'Read', status: 'error' }),
        tool('t5', 5, { name: 'WebFetch', status: 'error' }),
        llm('l2', 6, { cost: 0.2 }),
      ],
      'scattered-tool-failures',
    );
    expect(s).toContain('why Grep kept failing (2 of the 5)');
    expect(s).toContain('CLAUDE.md');
  });

  it('dead-end-run: resume when a completed change exists, otherwise fix before rerunning', () => {
    const tail = [
      llm('l1', 0, { cost: 1 }),
      tool('t9', 9, { status: 'error' }),
    ];
    expect(suggestionOf([root(), ...tail], 'dead-end-run')).toMatch(
      /^Deal with the failing Bash before running this again/,
    );
    expect(
      suggestionOf(
        [
          root(),
          tool('e1', 1, { name: 'Edit', linesAdded: 3 }),
          llm('l2', 2, { cost: 0.5 }),
          ...tail,
        ],
        'dead-end-run',
      ),
    ).toContain('last completed change (Edit) is intact');
  });

  it('duplicate-read: says plainly there is nothing to configure', () => {
    const read = (id: string, sec: number) =>
      tool(id, sec, { name: 'Read', targetKey: 'f', targetKind: 'file-read' });
    expect(
      suggestionOf(
        [root(), read('r1', 1), read('r2', 2), read('r3', 3)],
        'duplicate-read',
      ),
    ).toMatch(/^Nothing to configure here/);
  });

  it('oversized-output: names the tool and its size', () => {
    expect(
      suggestionOf(
        [root(), tool('t1', 1, { name: 'Read', outputBytes: 150_000 })],
        'oversized-output',
      ),
    ).toContain('Read returned 150.0k bytes');
  });

  it('context-bloat: /compact for agents that have it, history trimming for OTLP', () => {
    const grow = [
      root(),
      ...[10_000, 10_000, 10_000, 60_000, 120_000, 120_000, 120_000].map(
        (input, i) => llm(`l${i}`, i * 10, { input }),
      ),
    ];
    expect(suggestionOf(grow, 'context-bloat')).toContain('/compact');
    expect(suggestionOf(grow, 'context-bloat', 'otlp')).toMatch(
      /^Summarize or drop history/,
    );
  });
});

describe('findings quote the error text the adapters keep on failed tool spans', () => {
  const failing = (
    id: string,
    sec: number,
    errorText?: string,
    name = 'Bash',
  ) =>
    tool(id, sec, {
      name,
      status: 'error',
      targetKey: 'k',
      parentId: 'l1',
      ...(errorText === undefined ? {} : { errorText }),
    });

  it('retry-loop: the last failure, first line only, whitespace collapsed', () => {
    const f = findings([
      root(),
      llm('l1', 0, { cost: 0.5 }),
      failing('t1', 1, 'first'),
      failing('t2', 2, 'second'),
      failing(
        't3',
        3,
        "  The token '&&' is not a valid   statement separator.\r\nAt line:1 char:5",
      ),
    ]).find((i) => i.ruleId === 'retry-loop');
    expect(f?.detail).toContain(
      "(last error: “The token '&&' is not a valid statement separator.”)",
    );
  });

  it('retry-loop: caps a long error at 120 chars', () => {
    const long = 'x'.repeat(300);
    const f = findings([
      root(),
      llm('l1', 0, { cost: 0.5 }),
      failing('t1', 1, long),
      failing('t2', 2, long),
      failing('t3', 3, long),
    ]).find((i) => i.ruleId === 'retry-loop');
    expect(f?.detail).toContain(`“${'x'.repeat(119)}…”`);
  });

  it('retry-loop: no quote when the trace holds no error text', () => {
    const f = findings([
      root(),
      llm('l1', 0, { cost: 0.5 }),
      failing('t1', 1),
      failing('t2', 2),
      failing('t3', 3),
    ]).find((i) => i.ruleId === 'retry-loop');
    expect(f?.detail).not.toContain('last error');
  });

  it('dead-end-run: the failing step says why, and stays silent otherwise', () => {
    const withText = findings([
      root(),
      llm('l1', 0, { cost: 1 }),
      tool('t9', 9, { status: 'error', errorText: 'ENOENT: no such file' }),
    ]).find((i) => i.ruleId === 'dead-end-run');
    expect(withText?.detail).toContain('failing Bash (“ENOENT: no such file”)');
    const without = findings([
      root(),
      llm('l1', 0, { cost: 1 }),
      tool('t9', 9, { status: 'error' }),
    ]).find((i) => i.ruleId === 'dead-end-run');
    expect(without?.detail).toMatch(
      /^The session terminated on a failing Bash after/,
    );
  });

  it("scattered-tool-failures: the dominant tool's most recent error", () => {
    const f = findings([
      root(),
      llm('l1', 0, { cost: 0.2 }),
      tool('t1', 1, { name: 'Grep', status: 'error', errorText: 'pattern A' }),
      tool('t2', 2, { name: 'Grep', status: 'error', errorText: 'pattern B' }),
      tool('t3', 3, { name: 'Glob', status: 'error' }),
      tool('t4', 4, { name: 'Read', status: 'error' }),
      tool('t5', 5, { name: 'WebFetch', status: 'error' }),
      llm('l2', 6, { cost: 0.2 }),
    ]).find((i) => i.ruleId === 'scattered-tool-failures');
    expect(f?.detail).toContain('Most recent Grep error: “pattern B”.');
  });
});

describe('context-bloat measures the full context of the main session', () => {
  it('fires on cached growth and prices the excess at the cache-read rate', () => {
    // fresh input stays small; the cached prefix grows 10k → 150k
    const reads = [10_000, 10_000, 10_000, 60_000, 150_000, 150_000, 150_000];
    const spans = [
      root(),
      ...reads.map((cacheRead, i) =>
        llm(`l${i}`, i * 10, { input: 2_000, cacheRead }),
      ),
    ];
    const f = findings(spans).find((i) => i.ruleId === 'context-bloat');
    expect(f).toBeDefined();
    expect(f?.title).toBe('Context grew from 12.0k to 152.0k tokens');
    // excess over the 12k baseline: 50k + 3 × 140k = 470k tokens
    expect(f?.detail).toContain('~470.0k cumulative excess');
    const entry = matchModel(bundledPricing(), 'claude-sonnet-4-6');
    if (entry === undefined) throw new Error('sonnet must be priced');
    // every excess token was a cache read plus a 2k/152k sliver of input
    const rateLast =
      (2_000 * entry.inputPerMTok + 150_000 * entry.cacheReadPerMTok) / 152_000;
    const rateMid =
      (2_000 * entry.inputPerMTok + 60_000 * entry.cacheReadPerMTok) / 62_000;
    const expected = (50_000 * rateMid + 3 * 140_000 * rateLast) / 1e6;
    expect(f?.estimatedWasteUSD).toBeCloseTo(expected, 6);
    expect(f?.estimatedWasteUSD ?? 0).toBeLessThan(
      (470_000 * entry.inputPerMTok) / 1e6,
    );
  });

  it('ignores subagent calls when taking the medians', () => {
    const spans = [
      root(),
      ...[0, 1, 2, 3, 4, 5].map((i) => llm(`m${i}`, i * 10, { input: 80_000 })),
      sub('worker', 55),
      ...[0, 1, 2].map((i) =>
        llm(`s${i}`, 56 + i, { input: 5_000, parentId: 'worker' }),
      ),
    ];
    expect(
      findings(spans).filter((i) => i.ruleId === 'context-bloat'),
    ).toHaveLength(0);
  });
});

describe('cache-prefix-break says what survived', () => {
  const pair = (b: {
    cacheRead: number;
    cacheWrite: number;
    input?: number;
  }) => [
    root(),
    llm('a', 0, { cacheRead: 200_000, input: 1_000 }),
    llm('b', 5, { input: 1_000, ...b }),
  ];
  const finding = (b: Parameters<typeof pair>[0]) =>
    findings(pair(b)).find((i) => i.ruleId === 'cache-prefix-break');

  it('history: the front stayed cached, the conversation was written again', () => {
    const f = finding({ cacheRead: 38_000, cacheWrite: 190_000 });
    expect(f?.detail).toContain(
      'The first 38.0k tokens (system prompt and tools) stayed cached',
    );
    expect(f?.suggestion).toMatch(/^The system prompt and tools stayed cached/);
  });

  it('front: almost nothing stayed cached, so the tool list or a setting changed', () => {
    const f = finding({ cacheRead: 1_000, cacheWrite: 200_000 });
    expect(f?.detail).toContain('Only 1.0k tokens stayed cached');
    expect(f?.suggestion).toMatch(
      /^Everything from the front was written again/,
    );
  });

  it('compaction: the context shrank, the summary is the new prefix', () => {
    const f = finding({ cacheRead: 1_000, cacheWrite: 58_000 });
    expect(f?.detail).toContain(
      'The context shrank from 201.0k to 60.0k tokens',
    );
    expect(f?.suggestion).toMatch(/^This is the price of compaction/);
  });

  it('the estimate does not depend on the shape', () => {
    const history = finding({ cacheRead: 38_000, cacheWrite: 190_000 });
    const front = finding({ cacheRead: 1_000, cacheWrite: 190_000 });
    expect(history?.estimatedWasteUSD).toBe(front?.estimatedWasteUSD);
  });
});

describe('token figures in finding copy', () => {
  it('switch to millions past 1M, so a cumulative excess never reads as 469443.8k', () => {
    const reads = [10_000, 10_000, 10_000, ...Array(10).fill(900_000)];
    const spans = [
      root(),
      ...reads.map((cacheRead, i) =>
        llm(`l${i}`, i * 10, { input: 2_000, cacheRead }),
      ),
    ];
    const f = findings(spans).find((i) => i.ruleId === 'context-bloat');
    expect(f?.detail).toContain('~8.9M cumulative excess');
    expect(f?.detail).not.toMatch(/\d{5,}\.\dk/);
  });
});

describe('expensive-subagent says why there is no saving figure', () => {
  it('names the tier that resolved when the subtree could not be repriced cheaper', () => {
    // a reported cost below what the cheaper tier would charge for the same
    // tokens: the tier resolves, repricing is not cheaper, no saving claimed
    const spans = [
      root(),
      llm('l0', 1, { cost: 0.05 }),
      sub('worker', 2),
      base('l1', {
        kind: 'llm_call',
        startedAt: ts(3),
        parentId: 'worker',
        llm: {
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          tokens: { input: 3_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
          costUSD: 5,
          costSource: 'reported',
        },
      }),
    ];
    const f = findings(spans).find((i) => i.ruleId === 'expensive-subagent');
    expect(f).toBeDefined();
    expect(f?.estimatedWasteUSD).toBeUndefined();
    expect(f?.detail).toContain('A cheaper tier (claude-sonnet-5) resolves');
    expect(f?.suggestion).toContain('a cheaper tier (claude-sonnet-5) exists');
    expect(f?.suggestion).toContain(
      "model: claude-sonnet-5 in the worker agent's frontmatter",
    );
    expect(f?.suggestion).not.toContain('no priced cheaper tier');
  });
});
