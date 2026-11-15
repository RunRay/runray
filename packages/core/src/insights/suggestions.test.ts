import { readFileSync } from 'node:fs';
import type { Run } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import type { RawRun, RawSpan } from '../adapter.js';
import { CODEX_REVIEWER_AGENT } from '../adapters/codex-names.js';
import { normalize } from '../normalize.js';
import {
  bundledPricing,
  CACHE_WRITE_1H_ATTR,
  matchModel,
} from '../pricing/index.js';
import { HARNESS_TOOLS } from '../tools/registry.js';
import { applyInsights } from './index.js';

/**
 * Suggestions address the person running the agent, name a lever that
 * person has, and pick it by `run.source.tool`. These tests pin the copy
 * contract, not the detection (that lives in rules/new-rules tests).
 */

/** The sources suggestions distinguish (the schema also knows 'unknown'). */
type Source = 'claude-code' | 'opencode' | 'codex' | 'otlp';
const FORMAT: Record<Source, RawRun['source']['format']> = {
  'claude-code': 'claude-jsonl',
  opencode: 'opencode-storage',
  codex: 'codex-jsonl',
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
    // Codex names its command tool differently in every generation
    for (const name of [
      'exec_command',
      'shell',
      'shell_command',
      'local_shell',
    ]) {
      expect(suggestionOf(loop(name), 'retry-loop', 'codex')).toContain(
        'in AGENTS.md',
      );
    }
  });

  it('shell and edit tools are the ones the tools registry lists', () => {
    for (const [name, harness] of HARNESS_TOOLS) {
      const s = suggestionOf(loop(name), 'retry-loop');
      if (harness.role === 'shell') expect(s, name).toContain('in CLAUDE.md');
      else if (harness.activity === 'edit')
        expect(s, name).toMatch(/changed the file under the agent/);
      else expect(s, name).toMatch(/^Interrupt the agent/);
    }
  });

  it('edit: a failing apply_patch on Codex is an edit, not "anything else"', () => {
    expect(suggestionOf(loop('apply_patch'), 'retry-loop', 'codex')).toMatch(
      /changed the file under the agent/,
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

  it('speaks OpenCode, Codex and OTLP', () => {
    expect(
      suggestionOf(heavy(), 'fixed-context-overhead', 'opencode'),
    ).toContain('mcp.<name>.enabled: false');
    // a reviewer thread read without its parent: what it opens with is the
    // transcript handed to it, nothing the person can trim
    const asReviewer = heavy().map((span) =>
      span.kind === 'session'
        ? { ...span, agent: { ...span.agent, name: 'guardian' } }
        : span,
    );
    expect(findings(asReviewer, 'codex').map((f) => f.ruleId)).not.toContain(
      'fixed-context-overhead',
    );
    expect(findings(asReviewer).map((f) => f.ruleId)).toContain(
      'fixed-context-overhead',
    );
    const codex = suggestionOf(heavy(), 'fixed-context-overhead', 'codex');
    expect(codex).toContain('AGENTS.md files');
    expect(codex).toContain(
      'enabled = false under [mcp_servers.<name>] in config.toml',
    );
    expect(codex).toContain('no MCP server was called in this session');
    expect(codex).toContain('re-read 4 times');
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
    // Codex records no cache writes, so the rule never fires on a real
    // rollout; were a write ever recorded, the copy still holds no
    // Claude Code setting
    expect(suggestionOf(pair(10), 'idle-cache-expiry', 'codex')).not.toContain(
      'promptCacheTtl',
    );
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
  it('codex: the causes are named, since cache-prefix-break cannot fire there', () => {
    const s = suggestionOf(cold(), 'low-cache-hit', 'codex');
    expect(s).toMatch(/^Codex leaves caching to the provider/);
    expect(s).toContain('at a task boundary, not mid-session');
    expect(s).not.toContain('cache-prefix-break');
    expect(s).toMatch(/this run would have cost ~\$\d/);
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

  // a model of the gpt ladder: Codex sessions do not run on Claude models
  const flagship = (id: string, sec: number, parentId = 'root') =>
    llm(id, sec, { model: 'gpt-5.5', cost: 5, input: 10_000, parentId });

  it('model-mismatch on Codex: /model, and the config key for the default', () => {
    const s = suggestionOf(
      [root(), flagship('l1', 1)],
      'model-mismatch',
      'codex',
    );
    expect(s).toContain('on gpt-5.4-mini (/model switches mid-session;');
    expect(s).toContain('the model key in config.toml');
    // the Claude Code alias form (`/model sonnet`) is not a Codex command
    expect(s).not.toMatch(/\/model [a-z]+ switches/);
  });

  it('expensive-subagent on Codex: the agent file, or the default for spawned agents', () => {
    const s = suggestionOf(
      [
        root(),
        llm('l0', 1, { cost: 0.05, model: 'gpt-5.5' }),
        sub('worker', 2),
        flagship('l1', 3, 'worker'),
      ],
      'expensive-subagent',
      'codex',
    );
    expect(s).toContain(
      'model = "gpt-5.4-mini" in its agent file (~/.codex/agents, or .codex/agents in the project)',
    );
    expect(s).toContain(
      'agents.default_subagent_model in config.toml when it has no file',
    );
    expect(s).not.toContain('frontmatter');
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

  it('scattered-tool-failures on Codex: the instructions file is AGENTS.md', () => {
    const s = suggestionOf(
      [
        root(),
        llm('l1', 0, { cost: 0.2 }),
        tool('t1', 1, { name: 'exec_command', status: 'error' }),
        tool('t2', 2, { name: 'exec_command', status: 'error' }),
        tool('t3', 3, { name: 'apply_patch', status: 'error' }),
        tool('t4', 4, { name: 'view_image', status: 'error' }),
        tool('t5', 5, { name: 'web.search', status: 'error' }),
        llm('l2', 6, { cost: 0.2 }),
      ],
      'scattered-tool-failures',
      'codex',
    );
    expect(s).toContain('AGENTS.md');
    expect(s).not.toContain('CLAUDE.md');
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

  it("oversized-output: the read tool's own parameters where the agent has them, a range of the file on Codex", () => {
    const big = [root(), tool('t1', 1, { name: 'Read', outputBytes: 150_000 })];
    expect(suggestionOf(big, 'oversized-output')).toContain(
      'slice files with offset and limit',
    );
    expect(suggestionOf(big, 'oversized-output', 'codex')).toContain(
      'read a range of a file instead of the whole of it',
    );
  });

  it('context-bloat: /compact for agents that have it, history trimming for OTLP', () => {
    const grow = [
      root(),
      ...[10_000, 10_000, 10_000, 60_000, 120_000, 120_000, 120_000].map(
        (input, i) => llm(`l${i}`, i * 10, { input }),
      ),
    ];
    expect(suggestionOf(grow, 'context-bloat')).toContain('/compact');
    expect(suggestionOf(grow, 'context-bloat', 'codex')).toContain('/compact');
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

/**
 * Codex runs (add-codex-adapter T12). The tree is the one the Codex adapter
 * builds: session → turn → llm_call → tool, a child thread as a `subagent`
 * under the turn that started it, with turns of its own.
 */
describe('Codex runs', () => {
  const turn = (id: string, second: number, parentId = 'root'): RawSpan =>
    base(id, { kind: 'turn', name: 'turn', startedAt: ts(second), parentId });
  const thread = (id: string, second: number, name: string): RawSpan =>
    base(id, {
      kind: 'subagent',
      name: `subagent:${name}`,
      startedAt: ts(second),
      parentId: 't1',
      agent: { name },
    });
  /** A Codex call: cached input, never a cache write. */
  const call = (
    id: string,
    second: number,
    opts: Parameters<typeof llm>[2] = {},
  ) => llm(id, second, { model: 'gpt-5.5', parentId: 't1', ...opts });
  const codex = (spans: RawSpan[]) => findings(spans, 'codex');
  const ruleIds = (spans: RawSpan[]) => codex(spans).map((f) => f.ruleId);

  describe('cache-write rules are silent', () => {
    it('an idle gap after which the cached input drops to zero fires neither rule', () => {
      const ids = ruleIds([
        root(),
        turn('t1', 0),
        call('l1', 0, { cacheRead: 50_000, input: 2_000 }),
        // 30 minutes later the whole context is fresh input again
        call('l2', 30 * 60, { cacheRead: 0, input: 52_000 }),
      ]);
      expect(ids).not.toContain('idle-cache-expiry');
      expect(ids).not.toContain('cache-prefix-break');
    });

    it('a collapse with no gap fires neither rule', () => {
      const ids = ruleIds([
        root(),
        turn('t1', 0),
        call('l1', 0, { cacheRead: 200_000, input: 1_000 }),
        call('l2', 5, { cacheRead: 1_000, input: 200_000 }),
      ]);
      expect(ids).not.toContain('idle-cache-expiry');
      expect(ids).not.toContain('cache-prefix-break');
    });

    it('a low hit-rate is still reported, with the Codex suggestion', () => {
      const f = codex([
        root(),
        turn('t1', 0),
        ...[0, 10, 20, 30, 40].map((sec, i) =>
          call(`l${i}`, sec, { input: 20_000, cost: 0.1 }),
        ),
      ]).find((i) => i.ruleId === 'low-cache-hit');
      expect(f?.suggestion).toMatch(/^Codex leaves caching to the provider/);
    });

    it('fixed-context-overhead gives a finite estimate when nothing was written to the cache', () => {
      const spans = [
        root(),
        turn('t1', 0),
        call('l1', 0, { input: 30_000 }),
        ...[10, 20, 30, 40].map((sec, i) => call(`m${i}`, sec)),
      ];
      const f = codex(spans).find((i) => i.ruleId === 'fixed-context-overhead');
      expect(f).toBeDefined();
      const entry = matchModel(bundledPricing(), 'gpt-5.5');
      if (entry === undefined) throw new Error('gpt-5.5 must be priced');
      // 10k tokens above the floor: "written" once at the entry's write
      // rate, which for an OpenAI entry is its input rate, and read 4 times
      const expected =
        (10_000 * (entry.cacheWritePerMTok + 4 * entry.cacheReadPerMTok)) / 1e6;
      expect(Number.isFinite(f?.estimatedWasteUSD)).toBe(true);
      expect(f?.estimatedWasteUSD).toBeGreaterThanOrEqual(0);
      expect(f?.estimatedWasteUSD).toBeCloseTo(expected, 6);
      expect(entry.cacheWritePerMTok).toBe(entry.inputPerMTok);
    });
  });

  describe('rules read the tree through turn spans', () => {
    it('retry-loop bills the call that issued the failures, a turn above them', () => {
      const fail = (id: string, sec: number) =>
        tool(id, sec, {
          name: 'exec_command',
          status: 'error',
          targetKey: 'k',
          parentId: 'l1',
        });
      const f = codex([
        root(),
        turn('t1', 0),
        call('l1', 0, { cost: 0.5 }),
        fail('x1', 1),
        fail('x2', 2),
        fail('x3', 3),
      ]).find((i) => i.ruleId === 'retry-loop');
      expect(f?.estimatedWasteUSD).toBe(0.5);
    });

    it('a child thread is its own context: its calls are not the main thread’s', () => {
      const f = codex([
        root(),
        turn('t1', 0),
        call('l1', 0, { input: 30_000 }),
        ...[10, 20, 30, 40].map((sec, i) => call(`m${i}`, sec)),
        thread('child', 50, 'thread_spawn'),
        turn('ct', 50, 'child'),
        ...[51, 52, 53].map((sec, i) =>
          call(`c${i}`, sec, { parentId: 'ct', input: 90_000 }),
        ),
      ]).find((i) => i.ruleId === 'fixed-context-overhead');
      // five calls of the main thread, so four re-reads; the child's three
      // calls under its own turn are left out
      expect(f?.suggestion).toContain('re-read 4 times');
    });

    it('expensive-subagent sums the calls under the child’s turns, and model-mismatch leaves them to it', () => {
      const all = codex([
        root(),
        turn('t1', 0),
        call('l1', 1, { cost: 4, input: 10_000 }),
        thread('child', 2, 'thread_spawn'),
        turn('ct1', 2, 'child'),
        call('c1', 3, { parentId: 'ct1', cost: 3, input: 10_000 }),
        turn('ct2', 4, 'child'),
        call('c2', 5, { parentId: 'ct2', cost: 3, input: 10_000 }),
      ]);
      const subagent = all.find((i) => i.ruleId === 'expensive-subagent');
      expect(subagent?.title).toBe(
        'Subagent thread_spawn consumed 60% of the run',
      );
      expect(subagent?.detail).toContain('subtree cost $6.00');
      const mismatch = all.find((i) => i.ruleId === 'model-mismatch');
      expect(mismatch?.detail).toContain(
        '1 subtree(s) covered by the delegation finding',
      );
      // only the main thread's $4 call is repriced
      expect(mismatch?.estimatedWasteUSD ?? 0).toBeLessThan(4);
    });
  });

  describe('a session that ends on a failed turn', () => {
    const ending = (reason?: string, status: RawSpan['status'] = 'error') => [
      root(),
      turn('t1', 0),
      call('l1', 1, { cost: 12 }),
      call('l2', 2, { cost: 8 }),
      base('t2', {
        kind: 'turn',
        name: 'turn',
        startedAt: ts(600),
        status,
        ...(reason === undefined ? {} : { statusReason: reason }),
      }),
    ];

    it('stopped at the usage limit: not a dead end, and nothing counted as burned', () => {
      expect(ruleIds(ending('usage_limit_exceeded'))).not.toContain(
        'dead-end-run',
      );
    });

    it('interrupted by the person: not a dead end', () => {
      expect(ruleIds(ending('interrupted', 'cancelled'))).not.toContain(
        'dead-end-run',
      );
    });

    it('any other failure of the turn is still one, with its code', () => {
      const f = codex(ending('internal_server_error')).find(
        (i) => i.ruleId === 'dead-end-run',
      );
      expect(f?.detail).toContain('failing turn (internal_server_error)');
    });

    // What a rollout holds: the turn that failed did work first, so the
    // last span of the run is a call inside it, not the turn.
    const endingAfterWork = (
      reason: string,
      status: RawSpan['status'] = 'error',
      lastStep: { status?: RawSpan['status'] } = {},
    ) => [
      root(),
      turn('t1', 0),
      call('l1', 1, { cost: 12 }),
      base('t2', {
        kind: 'turn',
        name: 'turn',
        startedAt: ts(600),
        status,
        statusReason: reason,
      }),
      call('l2', 601, { cost: 8, parentId: 't2' }),
      tool('c1', 602, { name: 'exec_command', parentId: 'l2', ...lastStep }),
    ];

    it('a failed turn is the dead end even when its last step went fine', () => {
      const f = codex(endingAfterWork('internal_server_error')).find(
        (i) => i.ruleId === 'dead-end-run',
      );
      expect(f?.spanIds).toEqual(['t2']);
      expect(f?.detail).toContain('failing turn (internal_server_error)');
    });

    it('a usage limit is no dead end even when the last step of its turn failed', () => {
      expect(
        ruleIds(
          endingAfterWork('usage_limit_exceeded', 'error', { status: 'error' }),
        ),
      ).not.toContain('dead-end-run');
    });

    it('an interrupted turn is no dead end even when its last step failed', () => {
      expect(
        ruleIds(
          endingAfterWork('interrupted', 'cancelled', { status: 'error' }),
        ),
      ).not.toContain('dead-end-run');
    });

    it('a turn that went fine and ended on a failed step is one, on that step', () => {
      const f = codex(endingAfterWork('', 'ok', { status: 'error' })).find(
        (i) => i.ruleId === 'dead-end-run',
      );
      expect(f?.spanIds).toEqual(['c1']);
    });
  });

  describe('the approval reviewer as the expensive subagent', () => {
    const run = (name: string, model: string, cost?: number) => [
      root(),
      turn('t1', 0),
      call('l1', 1, { cost: 0.05 }),
      thread('child', 2, name),
      turn('ct', 2, 'child'),
      call('c1', 3, {
        parentId: 'ct',
        model,
        input: 10_000,
        ...(cost === undefined ? {} : { cost }),
      }),
    ];

    it('unpriced, as the bundled table leaves it: no finding', () => {
      expect(ruleIds(run('guardian', 'codex-auto-review'))).not.toContain(
        'expensive-subagent',
      );
    });

    it('priced by an override: names it, claims no saving and no cheaper model', () => {
      const f = codex(run('guardian', 'codex-auto-review', 5)).find(
        (i) => i.ruleId === 'expensive-subagent',
      );
      expect(f?.title).toBe('Subagent guardian consumed 99% of the run');
      expect(f?.detail).toContain("Codex's automatic approval reviewer");
      expect(f?.estimatedWasteUSD).toBeUndefined();
      expect(f?.suggestion).toMatch(
        /^guardian is Codex's automatic approval reviewer/,
      );
      expect(f?.suggestion).toContain(
        'approvals_reviewer = "user" in config.toml',
      );
      expect(f?.suggestion).not.toContain('cheaper model');
    });

    it('claims no saving even on a model a cheaper tier exists for', () => {
      const reviewer = codex(run('guardian', 'gpt-5.5', 5)).find(
        (i) => i.ruleId === 'expensive-subagent',
      );
      expect(reviewer?.estimatedWasteUSD).toBeUndefined();
      expect(reviewer?.suggestion).not.toContain('gpt-5.4-mini');
      // the same subtree under any other child keeps its estimate
      const other = codex(run('thread_spawn', 'gpt-5.5', 5)).find(
        (i) => i.ruleId === 'expensive-subagent',
      );
      expect(other?.estimatedWasteUSD).toBeGreaterThan(0);
      expect(other?.suggestion).toMatch(/^Give thread_spawn a cheaper model/);
    });

    it('model-mismatch leaves a cheap reviewer out too, and says so', () => {
      const spans = [
        root(),
        turn('t1', 0),
        call('l1', 1, { cost: 8, input: 10_000 }),
        thread('child', 2, 'guardian'),
        turn('ct', 2, 'child'),
        call('c1', 3, { parentId: 'ct', cost: 2, input: 10_000 }),
      ];
      const reviewer = codex(spans).find((i) => i.ruleId === 'model-mismatch');
      expect(reviewer?.detail).toContain(
        'the approval reviewer left out (not an agent you configure)',
      );
      expect(reviewer?.detail).not.toContain('delegation finding');
      // the same child under another name is part of the estimate
      const other = codex(
        spans.map((s) =>
          s.id === 'child' ? thread('child', 2, 'thread_spawn') : s,
        ),
      ).find((i) => i.ruleId === 'model-mismatch');
      expect(other?.detail).not.toContain('approval reviewer');
      expect(other?.estimatedWasteUSD ?? 0).toBeGreaterThan(
        reviewer?.estimatedWasteUSD ?? 0,
      );
    });

    it('the reviewer of a real rollout is recognised by the name the adapter gives it', () => {
      const golden = JSON.parse(
        readFileSync(
          new URL(
            '../../../../fixtures/normalized/codex/guardian.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as Run;
      const reviewer = golden.spans.find((s) => s.kind === 'subagent');
      expect(reviewer?.agent?.name).toBe(CODEX_REVIEWER_AGENT);
      // its model has no price, so the thread costs nothing in the golden;
      // give its calls one and the rule must still read it as the reviewer
      const under = new Set<string>([reviewer?.id ?? '']);
      let added = 0;
      const spans = golden.spans.map((s) => {
        if (s.parentId !== null && under.has(s.parentId)) under.add(s.id);
        if (!under.has(s.id) || s.llm === undefined) return s;
        added += 2;
        return { ...s, llm: { ...s.llm, costUSD: 2 } };
      });
      const priced: Run = {
        ...golden,
        spans,
        insights: [],
        totals: {
          ...golden.totals,
          costUSD: {
            ...golden.totals.costUSD,
            total: golden.totals.costUSD.total + added,
          },
        },
      };
      const f = applyInsights(priced).insights.find(
        (i) => i.ruleId === 'expensive-subagent',
      );
      expect(f?.suggestion).toMatch(
        /^guardian is Codex's automatic approval reviewer/,
      );
    });

    it('a subagent called guardian in another source is an ordinary agent', () => {
      const f = findings(
        [
          root(),
          llm('l0', 1, { cost: 0.05 }),
          sub('guardian', 2),
          llm('l1', 3, {
            model: 'claude-opus-4-8',
            cost: 5,
            input: 10_000,
            parentId: 'guardian',
          }),
        ],
        'claude-code',
      ).find((i) => i.ruleId === 'expensive-subagent');
      expect(f?.suggestion).toMatch(/^Give guardian a cheaper model/);
    });
  });

  describe('no lever of another source', () => {
    const failing = (name: string, extra: Parameters<typeof tool>[2] = {}) => [
      root(),
      turn('t1', 0),
      call('l1', 0, { cost: 0.5 }),
      ...[1, 2, 3].map((sec) =>
        tool(`x${sec}`, sec, {
          name,
          status: 'error',
          targetKey: 'k',
          parentId: 'l1',
          ...extra,
        }),
      ),
    ];
    const read = (id: string, sec: number) =>
      tool(id, sec, {
        name: 'exec_command',
        targetKey: 'f',
        targetKind: 'file-read',
        parentId: 'l1',
      });
    const scenarios: RawSpan[][] = [
      failing('exec_command'),
      failing('apply_patch'),
      failing('search', { kind: 'mcp_call', mcpServer: 'notion' }),
      failing('view_image'),
      // fixed-context-overhead
      [
        root(),
        turn('t1', 0),
        call('l1', 0, { input: 30_000 }),
        ...[10, 20, 30, 40].map((sec, i) => call(`m${i}`, sec)),
      ],
      // low-cache-hit
      [
        root(),
        turn('t1', 0),
        ...[0, 10, 20, 30, 40].map((sec, i) =>
          call(`l${i}`, sec, { input: 20_000, cost: 0.1 }),
        ),
      ],
      // context-bloat
      [
        root(),
        turn('t1', 0),
        ...[10_000, 10_000, 10_000, 60_000, 120_000, 120_000, 120_000].map(
          (input, i) => call(`l${i}`, i * 10, { input }),
        ),
      ],
      // model-mismatch
      [root(), turn('t1', 0), call('l1', 1, { cost: 5, input: 10_000 })],
      // expensive-subagent: a spawned thread, and the reviewer
      ...['thread_spawn', 'guardian'].map((name) => [
        root(),
        turn('t1', 0),
        call('l1', 1, { cost: 0.05 }),
        thread('child', 2, name),
        turn('ct', 2, 'child'),
        call('c1', 3, { parentId: 'ct', cost: 5, input: 10_000 }),
      ]),
      // scattered-tool-failures
      [
        root(),
        turn('t1', 0),
        call('l1', 0, { cost: 0.2 }),
        ...[
          'exec_command',
          'exec_command',
          'apply_patch',
          'view_image',
          'wait',
        ].map((name, i) =>
          tool(`x${i}`, i + 1, { name, status: 'error', parentId: 'l1' }),
        ),
        call('l2', 6, { cost: 0.2 }),
      ],
      // dead-end-run
      [
        root(),
        turn('t1', 0),
        call('l1', 0, { cost: 1 }),
        tool('x9', 9, {
          name: 'exec_command',
          status: 'error',
          parentId: 'l1',
        }),
      ],
      // duplicate-read
      [
        root(),
        turn('t1', 0),
        call('l1', 0),
        read('r1', 1),
        read('r2', 2),
        read('r3', 3),
      ],
      // oversized-output
      [
        root(),
        turn('t1', 0),
        call('l1', 0),
        tool('x1', 1, {
          name: 'exec_command',
          outputBytes: 150_000,
          parentId: 'l1',
        }),
      ],
    ];
    const all = scenarios.flatMap((spans) => codex(spans));

    it('covers every rule that can fire on a run with no cache writes', () => {
      expect([...new Set(all.map((f) => f.ruleId))].sort()).toEqual([
        'context-bloat',
        'dead-end-run',
        'duplicate-read',
        'expensive-subagent',
        'fixed-context-overhead',
        'low-cache-hit',
        'model-mismatch',
        'oversized-output',
        'retry-loop',
        'scattered-tool-failures',
      ]);
    });

    it('no suggestion names a Claude Code or OpenCode lever, nor the custom-agent wording', () => {
      for (const f of all) {
        for (const foreign of [
          'CLAUDE.md',
          'promptCacheTtl',
          'opencode',
          'OpenCode',
          'Claude Code',
          "your agent's",
          'frontmatter',
          'your agent re-sends',
          // parameters of the other agents' read tools: Codex reads a file
          // through a command
          'offset and limit',
        ]) {
          expect(f.suggestion, f.ruleId).not.toContain(foreign);
        }
      }
    });

    it('a suggestion that names the instructions file names AGENTS.md', () => {
      const naming = all.filter((f) => f.suggestion?.includes('AGENTS.md'));
      expect([...new Set(naming.map((f) => f.ruleId))].sort()).toEqual([
        'fixed-context-overhead',
        'retry-loop',
        'scattered-tool-failures',
      ]);
    });
  });
});
