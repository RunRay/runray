import type { Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { TOOL_ATTR } from './attributes.js';
import { toolUsageAttributes } from './classify.js';
import { OTHER_COMMAND_KEY } from './identity.js';
import { type ToolRow, type ToolUsage, toolUsage } from './usage.js';

/**
 * Tool usage aggregation (tool-usage spec: "Tool usage aggregation", "Time
 * attribution", "Containers, hooks and waiting stay out of tool time").
 * Runs are built inline with literal commands; committed fixtures hold
 * filler words where commands were.
 */

const T0 = Date.parse('2026-11-11T10:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
let seq = 0;

interface Over extends Partial<Span> {
  name: string;
  /** Duration in ms; `null` leaves the call in progress. */
  ms?: number | null;
}

function span({ ms = SEC, ...over }: Over): Span {
  seq++;
  const kind = over.kind ?? 'tool_call';
  const startedAt = new Date(T0 + seq * MIN).toISOString();
  const closed =
    ms === null
      ? { status: 'in_progress' as const }
      : {
          status: 'ok' as const,
          endedAt: new Date(T0 + seq * MIN + ms).toISOString(),
          durationMs: ms,
        };
  return {
    id: `s${seq}`,
    parentId: 'sess',
    kind,
    startedAt,
    depth: 1,
    attributes: {},
    provenance: { file: 'inline.jsonl' },
    ...closed,
    ...(kind === 'tool_call' || kind === 'mcp_call'
      ? { tool: { name: over.name, isError: false } }
      : {}),
    ...over,
  };
}

function shell(command: string, ms: number | null = SEC, redact = false): Span {
  return span({
    name: 'Bash',
    ms,
    attributes: toolUsageAttributes(command, 'posix', redact),
  });
}

function mcp(server: string, tool: string, ms = SEC): Span {
  const name = `mcp__${server}__${tool}`;
  return span({
    kind: 'mcp_call',
    name,
    ms,
    tool: { name, mcpServer: server, isError: false },
  });
}

function row(usage: ToolUsage, key: string): ToolRow {
  const found = usage.rows.find((r) => r.key === key);
  if (found === undefined) throw new Error(`no row ${key}`);
  return found;
}

const sum = (rows: readonly { totalMs: number }[]): number =>
  rows.reduce((acc, r) => acc + r.totalMs, 0);

/** A mixed run that touches every family and every side group. */
function mixedRun(): Span[] {
  const agent = span({ name: 'Agent', ms: 3 * MIN });
  const subagent = span({
    kind: 'subagent',
    name: 'subagent:Explore',
    parentId: agent.id,
    agent: { name: 'Explore' },
    ms: 3 * MIN,
  });
  return [
    shell('docker exec db psql', 4 * SEC),
    shell('docker ps', 1 * SEC),
    shell('git add -A && pnpm build', 60 * SEC),
    shell('git status', 2 * SEC),
    shell('cd web && pnpm test 2>&1 | tail -20', 40 * SEC),
    shell('ls -la | grep config', 300),
    shell('acme-deploy --prod', 9 * SEC),
    shell('sleep 600', null),
    span({ name: 'Read', ms: 120 }),
    span({ name: 'Edit', ms: 4200 }),
    span({ name: 'TodoWrite', ms: 15 }),
    span({ name: 'Skill', attributes: { [TOOL_ATTR.skill]: 'runbook' } }),
    span({ name: 'AskUserQuestion', ms: 10 * MIN }),
    mcp('playwright', 'browser_click', 800),
    mcp('playwright', 'browser_snapshot', 1500),
    agent,
    subagent,
    span({ name: 'Grep', parentId: subagent.id, ms: 2 * MIN }),
    span({ kind: 'hook', name: 'PostToolUse:Edit', ms: 350, status: 'error' }),
    span({ kind: 'llm_call', name: 'claude', ms: 5 * SEC }),
  ];
}

describe('toolUsage — spec scenarios of "Tool usage aggregation"', () => {
  it('gives one row per tool and one sub-row per subcommand', () => {
    const usage = toolUsage([
      shell('docker exec db psql', 4 * SEC),
      shell('docker exec db psql -c "select 1"', 3 * SEC),
      shell('docker exec -it web sh', 2 * SEC),
      shell('docker exec api env', 1 * SEC),
      shell('docker ps', 500),
    ]);
    expect(usage.rows).toHaveLength(1);
    const docker = row(usage, 'docker');
    expect(docker).toMatchObject({
      family: 'shell',
      calls: 5,
      totalMs: 10_500,
    });
    expect(docker.subs.map((s) => [s.label, s.calls])).toEqual([
      ['exec', 4],
      ['ps', 1],
    ]);
  });

  it('orders rows by total time, then by key', () => {
    const spans = [
      shell('vitest run', 5 * SEC),
      shell('cargo build', 5 * SEC),
      shell('docker ps', 9 * SEC),
      shell('biome check', 5 * SEC),
    ];
    const first = toolUsage(spans).rows.map((r) => r.key);
    expect(first).toEqual(['docker', 'biome', 'cargo', 'vitest']);
    expect(toolUsage([...spans].reverse()).rows.map((r) => r.key)).toEqual(
      first,
    );
  });

  it('counts a call in progress and adds no time to any figure', () => {
    const usage = toolUsage([
      shell('pnpm dev', null),
      shell('pnpm dev', 2 * SEC),
    ]);
    const pnpm = row(usage, 'pnpm');
    expect(pnpm).toMatchObject({
      calls: 2,
      open: 1,
      totalMs: 2 * SEC,
      p50Ms: 2 * SEC,
      maxMs: 2 * SEC,
    });
    expect(usage.summedMs).toBe(2 * SEC);
    expect(usage.calls).toBe(2);
    expect(usage.activities).toEqual([
      { activity: 'run', calls: 2, totalMs: 2 * SEC },
    ]);
  });
});

describe('toolUsage — spec scenarios of "Time attribution"', () => {
  it('gives a tool on its own the whole call and no shared time', () => {
    const vitest = row(toolUsage([shell('vitest run', 40 * SEC)]), 'vitest');
    expect(vitest).toMatchObject({ totalMs: 40 * SEC, sharedMs: 0 });
  });

  it('gives a shared call to the primary tool and marks the other', () => {
    const usage = toolUsage([shell('git add -A && pnpm build', 60 * SEC)]);
    expect(row(usage, 'pnpm')).toMatchObject({
      calls: 1,
      totalMs: 60 * SEC,
      sharedMs: 60 * SEC,
      alsoRanMs: 0,
    });
    expect(row(usage, 'git')).toMatchObject({
      calls: 0,
      totalMs: 0,
      alsoRanMs: 60 * SEC,
      alsoRanCalls: 1,
      registry: true,
      activity: 'vcs',
    });
    expect(usage.summedMs).toBe(60 * SEC);
  });

  it('keeps own time and also-ran time apart on one row', () => {
    const usage = toolUsage([
      shell('git commit -m wip', 85 * SEC),
      shell('git add -A && pnpm build', 50 * SEC),
    ]);
    expect(row(usage, 'git')).toMatchObject({
      calls: 1,
      totalMs: 85 * SEC,
      sharedMs: 0,
      alsoRanMs: 50 * SEC,
    });
  });

  it('never inflates the totals', () => {
    const usage = toolUsage(mixedRun());
    expect(sum(usage.rows)).toBe(usage.summedMs);
    // computed independently: every ranked call above, by hand
    expect(usage.summedMs).toBe(
      4000 +
        1000 +
        60_000 +
        2000 +
        40_000 +
        300 +
        9000 +
        120 +
        4200 +
        15 +
        1000 +
        800 +
        1500 +
        2 * MIN,
    );
  });
});

describe('toolUsage — spec scenarios of "Containers, hooks and waiting stay out of tool time"', () => {
  it('counts a delegation once, in the agent group', () => {
    const agent = span({ name: 'Agent', ms: 3 * MIN });
    const subagent = span({
      kind: 'subagent',
      name: 'subagent:Explore',
      parentId: agent.id,
      agent: { name: 'Explore' },
      ms: 3 * MIN,
    });
    const usage = toolUsage([
      agent,
      subagent,
      span({ name: 'Grep', parentId: subagent.id, ms: MIN }),
      span({ name: 'Read', parentId: subagent.id, ms: MIN }),
    ]);
    expect(usage.summedMs).toBe(2 * MIN);
    expect(usage.rows.map((r) => r.key).sort()).toEqual(['Grep', 'Read']);
    expect(usage.agents).toMatchObject({ calls: 1, totalMs: 3 * MIN });
    expect(usage.agents.rows[0]).toMatchObject({
      family: 'agent',
      key: 'Explore',
      calls: 1,
      totalMs: 3 * MIN,
    });
  });

  it('keeps waiting on the person out of tool time', () => {
    const usage = toolUsage([
      span({ name: 'AskUserQuestion', ms: 10 * MIN }),
      span({ name: 'Read', ms: 200 }),
    ]);
    expect(usage.summedMs).toBe(200);
    expect(usage.rows.map((r) => r.key)).toEqual(['Read']);
    expect(usage.waiting).toMatchObject({ calls: 1, totalMs: 10 * MIN });
    expect(usage.waiting.rows[0]?.key).toBe('AskUserQuestion');
    expect(usage.activities.map((a) => a.activity)).not.toContain('human');
  });

  it('partitions summed tool time by activity', () => {
    const usage = toolUsage(mixedRun());
    expect(sum(usage.activities)).toBe(usage.summedMs);
    expect(usage.activities.reduce((n, a) => n + a.calls, 0)).toBe(usage.calls);
    const byActivity = Object.fromEntries(
      usage.activities.map((a) => [a.activity, a.totalMs]),
    );
    expect(byActivity).toMatchObject({
      infra: 5000,
      build: 60_000,
      vcs: 2000,
      test: 40_000,
      other: 9000,
      edit: 4200,
      integration: 2300,
    });
  });

  it('keeps hook spans in their own group', () => {
    const usage = toolUsage(mixedRun());
    expect(usage.hooks).toMatchObject({ calls: 1, totalMs: 350 });
    expect(usage.hooks.rows[0]).toMatchObject({
      family: 'hook',
      key: 'PostToolUse:Edit',
      errors: 1,
    });
    expect(usage.rows.some((r) => r.family === 'hook')).toBe(false);
  });
});

describe('toolUsage — delegations', () => {
  it('takes the subagent span when the call returned at launch', () => {
    // a background agent: the call ends in 133 ms, the agent runs on
    const agent = span({ name: 'Agent', ms: 133 });
    const subagent = span({
      kind: 'subagent',
      name: 'subagent:general-purpose',
      parentId: agent.id,
      agent: { name: 'general-purpose' },
      ms: 221_280,
    });
    const usage = toolUsage([agent, subagent]);
    expect(usage.agents.rows[0]).toMatchObject({
      key: 'general-purpose',
      totalMs: 221_280,
      maxMs: 221_280,
    });
    expect(usage.summedMs).toBe(0);
  });

  it('counts a delegation still running without a time', () => {
    const agent = span({ name: 'Agent', ms: null });
    const subagent = span({
      kind: 'subagent',
      name: 'subagent:Explore',
      parentId: agent.id,
      ms: null,
    });
    expect(toolUsage([agent, subagent]).agents).toMatchObject({
      calls: 1,
      totalMs: 0,
    });
  });

  it('ranks a delegation without a recorded subagent as a plain call', () => {
    const usage = toolUsage([span({ name: 'Agent', ms: 2 * MIN })]);
    expect(usage.agents.calls).toBe(0);
    expect(usage.summedMs).toBe(2 * MIN);
    expect(row(usage, 'Agent')).toMatchObject({ family: 'agent' });
  });
});

describe('toolUsage — rows', () => {
  it('computes nearest-rank percentiles over closed calls', () => {
    const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 10_000];
    const usage = toolUsage(durations.map((d) => shell('docker ps', d)));
    expect(row(usage, 'docker')).toMatchObject({
      p50Ms: 500,
      p95Ms: 10_000,
      maxMs: 10_000,
      totalMs: 14_500,
    });
  });

  it('counts errors and result flags', () => {
    const background = shell('docker compose up -d');
    background.attributes[TOOL_ATTR.flags] = ['background'];
    const timedOut = shell('docker build .');
    timedOut.attributes[TOOL_ATTR.flags] = ['timeout', 'interrupted'];
    timedOut.status = 'error';
    const docker = row(
      toolUsage([background, timedOut, shell('docker ps')]),
      'docker',
    );
    expect(docker.errors).toBe(1);
    expect(docker.flags).toEqual({ background: 1, timeout: 1, interrupted: 1 });
    const up = docker.subs.find((s) => s.label === 'compose up');
    expect(up?.flags.background).toBe(1);
  });

  it('rolls MCP tools up to their server', () => {
    const spans = [
      ...Array.from({ length: 6 }, () => mcp('playwright', 'browser_click')),
      ...Array.from({ length: 4 }, () => mcp('playwright', 'browser_type')),
      ...Array.from({ length: 2 }, () => mcp('playwright', 'browser_close')),
    ];
    const usage = toolUsage(spans);
    expect(usage.rows).toHaveLength(1);
    const server = row(usage, 'playwright');
    expect(server).toMatchObject({
      family: 'mcp',
      calls: 12,
      activity: 'integration',
    });
    expect(server.subs.map((s) => [s.label, s.calls])).toEqual([
      ['browser_click', 6],
      ['browser_type', 4],
      ['browser_close', 2],
    ]);
  });

  it('splits a subcommand by script name where the trace carries one', () => {
    const spans = [
      shell('pnpm build', 30 * SEC),
      shell('pnpm test:e2e', 20 * SEC),
      shell('pnpm run build', 10 * SEC),
      shell('pnpm install', 5 * SEC),
    ];
    const open = row(toolUsage(spans), 'pnpm');
    expect(open.subs.map((s) => [s.label, s.calls, s.activity])).toEqual([
      ['run build', 2, 'build'],
      ['run test:e2e', 1, 'test'],
      ['install', 1, 'deps'],
    ]);
    expect(open.activity).toBe('build');

    // the same commands parsed with redaction: one sub-row per subcommand
    const redacted = row(
      toolUsage(
        ['pnpm build', 'pnpm test:e2e', 'pnpm run build', 'pnpm install'].map(
          (command) => shell(command, SEC, true),
        ),
      ),
      'pnpm',
    );
    expect(redacted.subs.map((s) => [s.label, s.calls])).toEqual([
      ['run', 3],
      ['install', 1],
    ]);
  });

  it('partitions a row by its sub-rows, bare calls included', () => {
    const git = row(
      toolUsage([
        shell('git status', 2 * SEC),
        shell('git frobnicate ./x', 3 * SEC),
        shell('git', 1 * SEC),
      ]),
      'git',
    );
    expect(git.subs.map((s) => [s.label, s.calls])).toEqual([
      ['', 2],
      ['status', 1],
    ]);
    expect(sum(git.subs)).toBe(git.totalMs);
  });

  it('leaves a row without subcommands unexpandable', () => {
    expect(row(toolUsage([span({ name: 'Read' })]), 'Read').subs).toEqual([]);
    expect(row(toolUsage([shell('vitest')]), 'vitest').subs).toEqual([]);
  });

  it('marks utilities for the folded group', () => {
    const usage = toolUsage([
      shell('ls -la | grep config'),
      shell('cd packages/ui'),
      shell('docker ps'),
    ]);
    expect(row(usage, 'ls').utility).toBe(true);
    expect(row(usage, 'cd').utility).toBe(true);
    expect(row(usage, 'docker').utility).toBe(false);
  });

  it('lists programs outside the registry under one row, by name', () => {
    const spans = [
      shell('acme-deploy --prod', 9 * SEC),
      shell('acme-deploy --staging', 6 * SEC),
      shell('frobctl sync', 2 * SEC),
      shell('"$BIN" --version', 1 * SEC),
    ];
    const other = row(toolUsage(spans), OTHER_COMMAND_KEY);
    expect(other).toMatchObject({
      family: 'shell',
      registry: false,
      calls: 4,
      totalMs: 18 * SEC,
      activity: 'other',
    });
    expect(other.subs.map((s) => [s.label, s.calls])).toEqual([
      ['acme-deploy', 2],
      ['frobctl', 1],
      ['', 1],
    ]);
  });

  it('shows one nameless row for those programs in a redacted trace', () => {
    const usage = toolUsage([
      shell('acme-deploy --prod', 9 * SEC, true),
      shell('frobctl sync', 2 * SEC, true),
      shell('docker ps', 1 * SEC, true),
    ]);
    expect(usage.rows.map((r) => r.key)).toEqual([OTHER_COMMAND_KEY, 'docker']);
    expect(row(usage, OTHER_COMMAND_KEY).subs).toEqual([]);
    expect(JSON.stringify(usage)).not.toMatch(/acme|frobctl/);
  });

  it('lists a pre-classification trace under the harness tool and says so', () => {
    const usage = toolUsage([
      span({ name: 'Bash', ms: 3 * SEC }),
      span({ name: 'Bash', ms: 2 * SEC }),
      span({ name: 'Read' }),
    ]);
    expect(row(usage, 'Bash')).toMatchObject({
      family: 'shell',
      classified: false,
      calls: 2,
      totalMs: 5 * SEC,
    });
    expect(usage.unclassifiedShellCalls).toBe(2);
    expect(toolUsage([shell('docker ps')]).unclassifiedShellCalls).toBe(0);
  });

  it('keeps a registry tool apart from a harness tool of the same name', () => {
    // OpenCode names its shell tool `bash`, which is also a registry id
    const usage = toolUsage([
      span({ name: 'bash', ms: 2 * SEC }),
      shell('bash scripts/build.sh', 3 * SEC),
    ]);
    const rows = usage.rows.filter((r) => r.key === 'bash');
    expect(rows.map((r) => [r.registry, r.totalMs])).toEqual([
      [true, 3 * SEC],
      [false, 2 * SEC],
    ]);
    expect(new Set(usage.rows.map((r) => r.id)).size).toBe(usage.rows.length);
  });
});

describe('toolUsage — options and totality', () => {
  it('narrows the rows to one activity and keeps the run-wide figures', () => {
    const spans = mixedRun();
    const all = toolUsage(spans);
    const tests = toolUsage(spans, { activity: 'test' });
    expect(tests.rows.map((r) => r.key)).toEqual(['pnpm']);
    expect(row(tests, 'pnpm')).toMatchObject({ calls: 1, totalMs: 40_000 });
    expect(tests.summedMs).toBe(all.summedMs);
    expect(tests.activities).toEqual(all.activities);
    expect(tests.agents).toEqual(all.agents);

    // per activity, the narrowed rows add up to that activity's total
    for (const { activity, totalMs } of all.activities) {
      expect(sum(toolUsage(spans, { activity }).rows), activity).toBe(totalMs);
    }
  });

  it('returns an empty result for a run without tool spans', () => {
    const empty = { rows: [], calls: 0, totalMs: 0 };
    expect(toolUsage([])).toEqual({
      summedMs: 0,
      calls: 0,
      rows: [],
      activities: [],
      agents: empty,
      hooks: empty,
      waiting: empty,
      unclassifiedShellCalls: 0,
    });
    expect(
      toolUsage([span({ kind: 'session', name: 'session' })]).rows,
    ).toEqual([]);
  });

  it('does not depend on the order of the spans', () => {
    const spans = mixedRun();
    const expected = toolUsage(spans);
    const rotated = [...spans.slice(7), ...spans.slice(0, 7)];
    expect(toolUsage(rotated)).toEqual(expected);
    expect(toolUsage([...spans].reverse())).toEqual(expected);
  });

  it('derives a duration from the timestamps when none is recorded', () => {
    const s = shell('docker ps', 4 * SEC);
    delete s.durationMs;
    expect(row(toolUsage([s]), 'docker').totalMs).toBe(4 * SEC);
  });
});
