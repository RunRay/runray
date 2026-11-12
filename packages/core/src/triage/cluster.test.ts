import type { Insight, Run, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { toolUsageAttributes } from '../tools/classify.js';
import { triageRun, triageTone } from './cluster.js';

const T0 = Date.parse('2026-09-03T10:00:00Z');
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
  cost: number,
  parent = 'sess',
  status: Span['status'] = 'ok',
  text?: string,
): Span {
  return base({
    id,
    parentId: parent,
    kind: 'llm_call',
    name: 'llm',
    status,
    startedAt: at(s),
    endedAt: at(s + 1),
    durationMs: 1000,
    llm: {
      provider: 'anthropic',
      model: 'claude-fable-5-1',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      costUSD: cost,
      costSource: 'computed',
    },
    ...(text === undefined ? {} : { content: { outputPreview: text } }),
  });
}
function tool(
  id: string,
  s: number,
  name: string,
  status: Span['status'],
  parent: string,
  text?: string | null,
  extra: Partial<Span> = {},
): Span {
  return base({
    id,
    parentId: parent,
    kind: name.startsWith('mcp__') ? 'mcp_call' : 'tool_call',
    name,
    status,
    startedAt: at(s),
    endedAt: at(s + 0.5),
    durationMs: 500,
    tool: {
      name,
      isError: status === 'error',
      ...(name.startsWith('mcp__') ? { mcpServer: name.split('__')[1] } : {}),
    },
    ...(text === undefined ? {} : { content: { outputPreview: text } }),
    ...extra,
  });
}
function run(spans: Span[], insights: Insight[] = []): Run {
  const session = base({
    id: 'sess',
    parentId: null,
    kind: 'session',
    name: 'session',
    depth: 0,
    startedAt: at(0),
  });
  return {
    id: 'run1',
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: at(0),
    spans: [session, ...spans],
    totals: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUSD: { total: 0, wastedEstimate: 0, byModel: {} },
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
    warnings: [],
  } as unknown as Run;
}

describe('triageRun — clusters, reaction cost, recovery', () => {
  const spans = [
    llm('l1', 0, 0.1),
    tool(
      'e1',
      1,
      'Bash',
      'error',
      'l1',
      '/usr/bin/bash: line 1: cd: x: No such file or directory',
    ),
    llm('l2', 2, 0.3), // reacts to e1
    tool('t1', 3, 'Bash', 'ok', 'l2'), // Bash comes back → e1 recovered
    tool(
      'e2',
      4,
      'Bash',
      'error',
      'l2',
      "/usr/bin/bash: -c: line 1: unexpected EOF while looking for matching `''",
    ),
    tool(
      'e3',
      4.2,
      'Edit',
      'error',
      'l2',
      '<tool_use_error>String to replace not found in file.</tool_use_error>',
    ),
    llm('l3', 5, 0.5), // ONE reaction to both e2 and e3: billed once
    tool('t2', 6, 'Bash', 'ok', 'l3'),
    tool(
      'c1',
      6.5,
      'Write',
      'cancelled',
      'l3',
      "The user doesn't want to proceed with this tool use.",
      { statusReason: 'user-rejected' },
    ),
    tool(
      'e4',
      7,
      'Edit',
      'error',
      'l3',
      '<tool_use_error>String to replace not found in file.</tool_use_error>',
    ),
    // no later Edit call → e4 unrecovered
  ];

  it('groups by class × tool in owner order and bills each reaction once', () => {
    const t = triageRun(run(spans));
    expect(t.toolErrors).toBe(4);
    expect(t.modelErrors).toBe(0);
    expect(t.cancelled).toBe(1);
    expect(t.clusters.map((c) => c.key)).toEqual([
      'shell-syntax|Bash', // owner you comes first
      'path-not-found|Bash',
      'edit-anchor-miss|Edit',
    ]);
    const [shell, path, edit] = t.clusters;
    expect(path?.reactionUSD).toBe(0.3);
    expect(shell?.reactionUSD).toBe(0.5); // l3 claimed by e2 (chronologically first)
    expect(edit?.reactionUSD).toBe(0); // e3's reaction already claimed; e4 has none
    expect(t.reactionUSD).toBe(0.8);
  });

  it('keeps hook spans out of every count', () => {
    const hooks = [
      base({
        id: 'h1',
        parentId: 'e1',
        kind: 'hook',
        name: 'PostToolUse:Bash',
        status: 'error',
        statusReason: 'exit 1',
        startedAt: at(1.2),
      }),
      // cancelled by the harness on a timeout: not a call the person declined
      base({
        id: 'h2',
        kind: 'hook',
        name: 'UserPromptSubmit',
        status: 'cancelled',
        statusReason: 'timeout',
        startedAt: at(0.5),
      }),
    ];
    expect(triageRun(run([...spans, ...hooks]))).toEqual(triageRun(run(spans)));
  });

  it('records recovery per occurrence and an outcome per cluster', () => {
    const t = triageRun(run(spans));
    const path = t.clusters.find((c) => c.classId === 'path-not-found');
    expect(path?.occurrences[0]?.recovery).toEqual({
      kind: 'ok',
      afterMs: 2000,
      nextSpanId: 't1',
    });
    expect(path?.outcome).toBe('recovered');
    const edit = t.clusters.find((c) => c.classId === 'edit-anchor-miss');
    expect(edit?.count).toBe(2);
    expect(edit?.occurrences[0]?.recovery.kind).toBe('error'); // e3 → e4
    expect(edit?.occurrences[1]?.recovery.kind).toBe('none');
    expect(edit?.outcome).toBe('unrecovered');
    expect(t.recovered).toBe(2); // e1, e2
  });

  it('flags attention for an owner-you cluster or an unrecovered one', () => {
    const t = triageRun(run(spans));
    expect(t.needsAttention).toBe(true);
    expect(triageTone(t)).toBe('alarm');
    const quiet = triageRun(
      run([
        llm('l1', 0, 0.1),
        tool(
          'e1',
          1,
          'Bash',
          'error',
          'l1',
          '/usr/bin/bash: line 1: cd: x: No such file or directory',
        ),
        llm('l2', 2, 0.3),
        tool('t1', 3, 'Bash', 'ok', 'l2'),
      ]),
    );
    expect(quiet.needsAttention).toBe(false);
    expect(triageTone(quiet)).toBe('quiet');
    expect(triageTone(triageRun(run([llm('l1', 0, 0.1)])))).toBe('none');
  });

  it('stays quiet when an abandoned tool was worked around and the session moved on', () => {
    const t = triageRun(
      run([
        llm('l1', 0, 0.1),
        tool(
          'e1',
          1,
          'mcp__Claude_Browser__navigate',
          'error',
          'l1',
          'navigation to http://localhost:3001 was denied or failed',
        ),
        llm('l2', 2, 0.3),
        tool('t1', 3, 'Bash', 'ok', 'l2'), // a different tool succeeds afterwards
      ]),
    );
    expect(t.clusters[0]?.outcome).toBe('unrecovered');
    expect(t.needsAttention).toBe(false);
  });

  it('never alarms on expected feedback, even when it is the last call', () => {
    const t = triageRun(
      run([
        llm('l1', 0, 0.1),
        tool(
          'e1',
          1,
          'PowerShell',
          'error',
          'l1',
          'Failing tests: test/a_test.dart',
        ),
      ]),
    );
    expect(t.clusters[0]?.owner).toBe('work');
    expect(t.clusters[0]?.outcome).toBe('unrecovered');
    expect(t.needsAttention).toBe(false);
  });

  it('does not call a class looping when other failures of the tool sit between its occurrences', () => {
    const shell = "unexpected EOF while looking for matching `''";
    const path = 'cd: x: No such file or directory';
    const t = triageRun(
      run([
        llm('l1', 0, 0.1),
        tool('e1', 1, 'Bash', 'error', 'l1', shell),
        tool('f1', 2, 'Bash', 'error', 'l1', path),
        tool('e2', 3, 'Bash', 'error', 'l1', shell),
        tool('f2', 4, 'Bash', 'error', 'l1', path),
        tool('e3', 5, 'Bash', 'error', 'l1', shell),
        tool('t1', 6, 'Bash', 'ok', 'l1'),
      ]),
    );
    const shellCluster = t.clusters.find((c) => c.classId === 'shell-syntax');
    expect(shellCluster?.count).toBe(3);
    expect(shellCluster?.occurrences[0]?.recovery).toEqual({
      kind: 'error',
      afterMs: 1000,
      nextSpanId: 'f1',
    });
    expect(shellCluster?.outcome).toBe('recovered');
  });

  it('marks three consecutive failures of one tool as looping', () => {
    const text = 'screenshot failed: Screenshot timed out after 5s';
    const t = triageRun(
      run([
        llm('l1', 0, 0.1),
        tool('e1', 1, 'mcp__Claude_Browser__computer', 'error', 'l1', text),
        tool('e2', 2, 'mcp__Claude_Browser__computer', 'error', 'l1', text),
        tool('e3', 3, 'mcp__Claude_Browser__computer', 'error', 'l1', text),
        tool('t1', 4, 'mcp__Claude_Browser__computer', 'ok', 'l1'),
      ]),
    );
    const c = t.clusters[0];
    expect(c?.classId).toBe('pane-timeout');
    expect(c?.mcpServer).toBe('Claude_Browser');
    expect(c?.outcome).toBe('looping');
    expect(t.needsAttention).toBe(false); // it recovered; tooling, not you
  });

  it('links clusters to the findings that cite their spans', () => {
    const insight: Insight = {
      id: 'ins-1',
      ruleId: 'retry-loop',
      severity: 'info',
      title: 'Bash failed 3× in a row',
      detail: '',
      spanIds: ['e1'],
    };
    const t = triageRun(
      run(
        [
          llm('l1', 0, 0.1),
          tool('e1', 1, 'Bash', 'error', 'l1', 'x failed'),
          tool('t1', 2, 'Bash', 'ok', 'l1'),
        ],
        [insight],
      ),
    );
    expect(t.clusters[0]?.insightIds).toEqual(['ins-1']);
    expect(t.clusters[0]?.outcome).toBe('looping');
  });

  it('keeps model-call failures apart from the tool-error count and bills the retry', () => {
    const t = triageRun(
      run([
        llm(
          'l1',
          0,
          0.1,
          'sess',
          'error',
          'API Error: 500 Internal server error',
        ),
        llm('l2', 1, 0.4), // the retry
      ]),
    );
    expect(t.toolErrors).toBe(0);
    expect(t.modelErrors).toBe(1);
    const c = t.clusters[0];
    expect(c?.classId).toBe('model-server');
    expect(c?.tool).toBe('claude-fable-5-1');
    expect(c?.reactionUSD).toBe(0.4);
    expect(c?.outcome).toBe('recovered');
  });

  it('keeps scopes apart: a subagent failure looks for its reaction inside the subagent', () => {
    const sub = base({
      id: 'sub',
      parentId: 'l1',
      kind: 'subagent',
      name: 'subagent:x',
      depth: 2,
      startedAt: at(1),
    });
    const t = triageRun(
      run([
        llm('l1', 0, 0.1),
        sub,
        llm('sl1', 1.5, 0.05, 'sub'),
        tool('e1', 2, 'Read', 'error', 'sl1', 'File does not exist.'),
        llm('l2', 2.5, 9.9), // main-session call: NOT the reaction
        llm('sl2', 3, 0.07, 'sub'),
      ]),
    );
    expect(t.clusters[0]?.reactionUSD).toBe(0.07);
  });

  it('reports redaction when a failure has no text and still classifies by shape', () => {
    const t = triageRun(
      run([
        llm('l1', 0, 0.1),
        tool('e1', 1, 'Bash', 'error', 'l1', null),
        tool('e2', 2, 'mcp__srv__op', 'error', 'l1', null),
      ]),
    );
    expect(t.redacted).toBe(true);
    expect(t.clusters.map((c) => c.classId)).toEqual([
      'mcp-error',
      'unclassified',
    ]);
  });

  it('is deterministic regardless of span input order', () => {
    const shuffled = [...spans].reverse();
    expect(triageRun(run(shuffled))).toEqual(triageRun(run(spans)));
  });
});

describe('triageRun — a shell failure is keyed on the program it ran', () => {
  // stamped the way the adapters stamp a shell call
  function sh(
    id: string,
    s: number,
    command: string,
    status: Span['status'],
    redact = false,
    name = 'Bash',
  ): Span {
    return tool(
      id,
      s,
      name,
      status,
      'sess',
      status === 'error' ? 'Exit code 1' : undefined,
      {
        attributes: toolUsageAttributes(command, 'posix', redact),
        tool: { name, isError: status === 'error', exitCode: 1 },
      },
    );
  }

  it('does not count a failed test run as recovered by an unrelated ls', () => {
    const t = triageRun(
      run([sh('e1', 1, 'pnpm test', 'error'), sh('ok1', 2, 'ls', 'ok')]),
    );
    const [c] = t.clusters;
    expect(c?.occurrences[0]?.recovery).toEqual({ kind: 'none' });
    expect(c?.outcome).toBe('unrecovered');
    expect(t.recovered).toBe(0);
  });

  it('counts it recovered when the tests ran again and passed', () => {
    const t = triageRun(
      run([
        sh('e1', 1, 'pnpm test', 'error'),
        sh('ok1', 2, 'ls', 'ok'),
        sh('ok2', 4, 'pnpm run test', 'ok'),
      ]),
    );
    const [c] = t.clusters;
    expect(c?.occurrences[0]?.recovery).toEqual({
      kind: 'ok',
      afterMs: 3000,
      nextSpanId: 'ok2',
    });
    expect(c?.outcome).toBe('recovered');
  });

  it('keeps a build apart from a test run of the same runner', () => {
    const t = triageRun(
      run([
        sh('e1', 1, 'pnpm test', 'error'),
        sh('ok1', 2, 'pnpm build', 'ok'),
      ]),
    );
    expect(t.clusters[0]?.outcome).toBe('unrecovered');
  });

  it('makes a failed test run and a failed push of one class two clusters', () => {
    const t = triageRun(
      run([
        sh('e1', 1, 'pnpm test', 'error'),
        sh('e2', 2, 'git push', 'error'),
      ]),
    );
    expect(t.clusters).toHaveLength(2);
    expect(t.clusters.map((c) => c.classId)).toEqual([
      'exit-nonzero',
      'exit-nonzero',
    ]);
    expect(t.clusters.map((c) => [c.tool, c.program])).toEqual([
      [
        'Bash',
        { key: 'pnpm', label: 'pnpm run', sub: 'run', activity: 'test' },
      ],
      ['Bash', { key: 'git', label: 'git push', sub: 'push', activity: 'vcs' }],
    ]);
    expect(t.clusters.map((c) => c.key)).toEqual([
      'exit-nonzero|Bash|pnpm|run|test',
      'exit-nonzero|Bash|git|push|vcs',
    ]);
  });

  it('puts programs outside the registry in one cluster, named or not', () => {
    const t = triageRun(
      run([
        sh('e1', 1, 'mytool --x', 'error'),
        sh('e2', 2, 'othertool', 'error'),
      ]),
    );
    expect(t.clusters).toHaveLength(1);
    expect(t.clusters[0]?.program).toEqual({
      key: 'other-command',
      label: 'other command',
      activity: 'other',
    });
  });

  it('triages a redacted parse the same as an unredacted one', () => {
    const commands: [string, string, Span['status']][] = [
      ['e1', 'pnpm run test', 'error'],
      ['s1', 'pnpm run lint', 'ok'],
      ['e2', 'pnpm run build', 'error'],
      ['e3', 'python foo.py', 'error'],
      ['s2', 'python bar.py', 'ok'],
      ['e4', 'mytool --x', 'error'],
      ['s3', 'othertool', 'ok'],
      ['s4', 'pnpm run build', 'ok'],
    ];
    const parse = (redact: boolean) =>
      triageRun(
        run(commands.map(([id, c, st], i) => sh(id, i + 1, c, st, redact))),
      );
    const plain = parse(false);
    const redacted = parse(true);
    expect(redacted).toEqual(plain);
    // the free-form script name is not what tells the scripts apart
    expect(plain.clusters.map((c) => c.program?.label)).toEqual([
      'pnpm run',
      'pnpm run',
      'python script',
      'other command',
    ]);
  });

  it('applies to a shell tool under another harness name', () => {
    const t = triageRun(
      run([
        sh('e1', 1, 'pnpm test', 'error', false, 'PowerShell'),
        sh('ok1', 2, 'pnpm test', 'ok', false, 'Bash'),
      ]),
    );
    // another harness tool is another tool, as before
    expect(t.clusters[0]?.tool).toBe('PowerShell');
    expect(t.clusters[0]?.outcome).toBe('unrecovered');
  });

  it('keys a shell call without tool-usage attributes on the harness name', () => {
    const t = triageRun(
      run([
        tool('e1', 1, 'Bash', 'error', 'sess', 'Exit code 1'),
        tool('ok1', 2, 'Bash', 'ok', 'sess'),
      ]),
    );
    const [c] = t.clusters;
    expect(c?.key).toBe(`${c?.classId}|Bash`);
    expect(c?.program).toBeUndefined();
    expect(c?.outcome).toBe('recovered');
  });
});
