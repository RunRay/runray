import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Candidate, NoSessionYet, type RawRun } from '../adapter.js';
import { applyInsights } from '../insights/index.js';
import { normalize } from '../normalize.js';
import { CACHE_WRITE_1H_ATTR } from '../pricing/engine.js';
import { priceRun } from '../pricing/index.js';
import { claudeCodeAdapter } from './claude-code.js';

const fixtureDir = fileURLToPath(
  new URL('../../../../fixtures/claude-code/subagents', import.meta.url),
);

function assistant(
  uuid: string,
  parentUuid: string,
  messageId: string,
  ts: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
) {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    sessionId: 'sess-1',
    timestamp: ts,
    cwd: '/home/user/project/x',
    gitBranch: 'main',
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 20,
      },
      content,
    },
    ...extra,
  };
}

function toolResult(
  uuid: string,
  ts: string,
  toolUseId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type: 'user',
    uuid,
    sessionId: 'sess-1',
    timestamp: ts,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
    },
    ...extra,
  };
}

describe('claude-code adapter — synthetic session', () => {
  let dir: string;
  let candidate: Candidate;
  let run: RawRun;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'runray-cc-'));
    const proj = join(dir, 'proj');
    const subagents = join(proj, 'sess-1', 'subagents');
    mkdirSync(subagents, { recursive: true });

    const lines = [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 'sess-1',
        timestamp: '2026-07-02T13:00:00Z',
        cwd: '/home/user/project/x',
        message: { role: 'user', content: 'please fix the tests' },
      },
      assistant('a1', 'u1', 'm1', '2026-07-02T13:00:05Z', [
        {
          type: 'tool_use',
          id: 't1',
          name: 'Edit',
          input: {
            file_path: '/x.ts',
            old_string: 'a\nb',
            new_string: 'a\nb\nc\nd',
          },
        },
      ]),
      toolResult('r1', '2026-07-02T13:00:07Z', 't1'),
      // same message.id → same API call: usage must be counted once
      assistant('a2', 'r1', 'm1', '2026-07-02T13:00:08Z', [
        { type: 'text', text: 'done' },
      ]),
      '{not json',
      {
        type: 'user',
        uuid: 'u2',
        sessionId: 'sess-1',
        timestamp: '2026-07-02T13:00:09Z',
        isSidechain: true,
        message: { role: 'user', content: 'legacy marker' },
      },
      assistant('a3', 'u2', 'm2', '2026-07-02T13:00:10Z', [
        {
          type: 'tool_use',
          id: 't2',
          name: 'Agent',
          input: {
            subagent_type: 'reviewer',
            description: 'check things',
            prompt: 'go',
          },
        },
      ]),
      toolResult('r2', '2026-07-02T13:00:20Z', 't2', {
        toolUseResult: { agentId: 'abc123', status: 'completed' },
      }),
      assistant('a4', 'r2', 'm3', '2026-07-02T13:00:21Z', [
        {
          type: 'tool_use',
          id: 't3',
          name: 'Agent',
          input: { subagent_type: 'ghost', description: 'gone' },
        },
      ]),
      toolResult('r3', '2026-07-02T13:00:25Z', 't3', {
        toolUseResult: { agentId: 'missing1', status: 'completed' },
      }),
      assistant('a5', 'r3', 'm4', '2026-07-02T13:00:30Z', [
        { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'ls' } },
      ]),
      { type: 'custom-title', customTitle: 'My session', sessionId: 'sess-1' },
    ];
    writeFileSync(
      join(proj, 'sess-1.jsonl'),
      `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`,
    );

    const childLines = [
      {
        type: 'user',
        uuid: 'cu1',
        timestamp: '2026-07-02T13:00:12Z',
        message: { role: 'user', content: 'child prompt' },
      },
      {
        type: 'assistant',
        uuid: 'ca1',
        parentUuid: 'cu1',
        timestamp: '2026-07-02T13:00:40Z',
        message: {
          id: 'cm1',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 2 },
          content: [{ type: 'text', text: 'child done' }],
        },
      },
    ];
    writeFileSync(
      join(subagents, 'agent-abc123.jsonl'),
      `${childLines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    );
    writeFileSync(join(subagents, 'journal.jsonl'), '{"type":"journal"}\n');

    const candidates = await claudeCodeAdapter.detect([dir]);
    expect(candidates).toHaveLength(1);
    candidate = candidates[0] as Candidate;
    run = await claudeCodeAdapter.parse(candidate, { redact: false });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detect finds the session with its subagent transcript, excluding journal.jsonl', () => {
    expect(candidate.format).toBe('claude-jsonl');
    expect(candidate.files).toHaveLength(2);
    expect(candidate.files.some((f) => f.endsWith('agent-abc123.jsonl'))).toBe(
      true,
    );
  });

  it('detect ignores .jsonl files that contain OTLP resourceSpans', async () => {
    const otlpFile = join(dir, 'proj', 'traces.jsonl');
    writeFileSync(otlpFile, '{"resourceSpans": []}\n');
    const candidates = await claudeCodeAdapter.detect([dir]);
    expect(candidates.some((c) => c.runRef === otlpFile)).toBe(false);
  });

  it('emits one session root and a resolvable tree', () => {
    const roots = run.spans.filter((s) => s.parentId === null);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.kind).toBe('session');
    expect(roots[0]?.id).toBe('sess-1');
    const ids = new Set(run.spans.map((s) => s.id));
    expect(ids.size).toBe(run.spans.length);
    for (const s of run.spans) {
      if (s.parentId !== null) expect(ids.has(s.parentId)).toBe(true);
    }
  });

  it('dedupes assistant records sharing a message.id into one llm_call', () => {
    const m1 = run.spans.filter((s) => s.id === 'm1');
    expect(m1).toHaveLength(1);
    expect(m1[0]?.llm?.tokens).toEqual({
      input: 100,
      output: 5,
      cacheRead: 10,
      cacheWrite: 20,
    });
    expect(m1[0]?.content?.outputPreview).toBe('done');
    expect(m1[0]?.content?.promptPreview).toBe('please fix the tests');
    expect(m1[0]?.llm?.costSource).toBe('unknown');
  });

  it('derives code-change counts from Edit input strings', () => {
    const edit = run.spans.find((s) => s.id === 't1');
    expect(edit?.kind).toBe('tool_call');
    expect(edit?.status).toBe('ok');
    expect(edit?.tool?.linesAdded).toBe(4);
    expect(edit?.tool?.linesRemoved).toBe(2);
  });

  it('links the Agent call to its child transcript', () => {
    const sub = run.spans.find((s) => s.id === 'abc123');
    expect(sub?.kind).toBe('subagent');
    expect(sub?.parentId).toBe('t2');
    expect(sub?.name).toBe('subagent:reviewer');
    expect(sub?.agent).toEqual({ name: 'reviewer', sessionId: 'abc123' });
    expect(sub?.content?.delegationReason).toBe('check things');
    const childLlm = run.spans.find((s) => s.id === 'cm1');
    expect(childLlm?.parentId).toBe('abc123');
    expect(childLlm?.name).toBe('claude-haiku-4-5');
    // async agent: child record at 13:00:40 outlives the tool result at 13:00:20
    expect(sub?.endedAt).toBe('2026-07-02T13:00:40Z');
  });

  it('warns when a referenced transcript is missing but still emits the subagent span', () => {
    expect(run.spans.find((s) => s.id === 'missing1')?.kind).toBe('subagent');
    expect(
      run.warnings.some((w) =>
        /not found for agentId missing1/.test(w.message),
      ),
    ).toBe(true);
  });

  it('marks a tool without a result as in_progress', () => {
    const bash = run.spans.find((s) => s.id === 't4');
    expect(bash?.status).toBe('in_progress');
    expect(bash?.endedAt).toBeUndefined();
  });

  it('tolerates malformed lines with a warning naming file and line', () => {
    const w = run.warnings.find((w) => w.message === 'unparseable JSONL line');
    expect(w?.line).toBe(5);
    expect(w?.file).toBe(candidate.runRef);
  });

  it('flags legacy markers with a run warning', () => {
    expect(
      run.warnings.some((w) => /legacy subagent format/.test(w.message)),
    ).toBe(true);
  });

  it('extracts title and project metadata', () => {
    expect(run.title).toBe('My session');
    expect(run.project).toEqual({
      name: 'x',
      path: '/home/user/project/x',
      gitBranch: 'main',
    });
  });

  it('redact nulls all prompt-derived content in core', async () => {
    const redacted = await claudeCodeAdapter.parse(candidate, { redact: true });
    expect(redacted.title).toBeUndefined();
    const withContent = redacted.spans.filter((s) => s.content !== undefined);
    expect(withContent.length).toBeGreaterThan(0);
    for (const s of withContent) {
      for (const value of Object.values(s.content ?? {}))
        expect(value).toBeNull();
    }
  });
});

describe('claude-code adapter — real scrubbed fixture', () => {
  it('parses the subagents fixture end to end', async () => {
    const candidates = await claudeCodeAdapter.detect([fixtureDir]);
    const candidate = candidates.find(
      (c) =>
        c.runRef.endsWith('72de75e7-d5ab-4c07-a381-6539f4e34e42.jsonl') &&
        !/[\\/]raw[\\/]/.test(c.runRef),
    );
    expect(candidate).toBeDefined();
    if (!candidate) return;
    // main transcript + 45 agent transcripts; 2 journal.jsonl excluded
    expect(candidate.files).toHaveLength(46);

    const run = await claudeCodeAdapter.parse(candidate, { redact: false });

    const subagents = run.spans.filter((s) => s.kind === 'subagent');
    // 11 Agent calls in the main transcript; children spawned more of their own
    const mainSubagents = subagents.filter(
      (s) => s.provenance.file === candidate.runRef,
    );
    expect(mainSubagents).toHaveLength(11);
    expect(subagents.length).toBeGreaterThanOrEqual(11);
    const byId = new Map(run.spans.map((s) => [s.id, s]));
    for (const sub of subagents) {
      const parent = sub.parentId === null ? undefined : byId.get(sub.parentId);
      expect(parent?.name).toBe('Agent');
    }

    // child transcripts contributed spans with their own provenance
    const childSpans = run.spans.filter((s) =>
      /agent-[a-z0-9]+\.jsonl$/.test(s.provenance.file),
    );
    expect(childSpans.length).toBeGreaterThan(50);

    // tree is internally consistent and token counts survived scrubbing
    for (const s of run.spans) {
      if (s.parentId !== null) expect(byId.has(s.parentId)).toBe(true);
    }
    const totalInput = run.spans.reduce(
      (acc, s) => acc + (s.llm?.tokens.input ?? 0),
      0,
    );
    expect(totalInput).toBeGreaterThan(0);

    // 45 transcripts on disk, 11 reachable from Agent calls → 34 unlinked (workflow agents)
    expect(
      run.warnings.some((w) => /^34 subagent transcript/.test(w.message)),
    ).toBe(true);
  }, 30_000);
});

describe('claude-code adapter — git branch', () => {
  const record = (n: number, branch: unknown) => ({
    type: 'assistant',
    uuid: `u-${n}`,
    parentUuid: n === 1 ? null : `u-${n - 1}`,
    sessionId: 'sess-branch',
    timestamp: `2026-07-02T14:00:0${n}Z`,
    cwd: '/home/user/project/x',
    ...(branch === undefined ? {} : { gitBranch: branch }),
    message: {
      id: `m${n}`,
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: 'ok' }],
    },
  });

  async function branchOf(branches: unknown[]): Promise<string | undefined> {
    const dir = mkdtempSync(join(tmpdir(), 'runray-cc-branch-'));
    try {
      const proj = join(dir, 'proj');
      mkdirSync(proj, { recursive: true });
      writeFileSync(
        join(proj, 'sess-branch.jsonl'),
        `${branches.map((b, i) => JSON.stringify(record(i + 1, b))).join('\n')}\n`,
      );
      const candidates = await claudeCodeAdapter.detect([dir]);
      const run = await claudeCodeAdapter.parse(candidates[0] as Candidate, {
        redact: false,
      });
      return run.project?.gitBranch;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('keeps the branch the session started on', async () => {
    expect(await branchOf(['feat/a', 'feat/b'])).toBe('feat/a');
  });

  it('skips empty and missing values to the first real branch', async () => {
    expect(await branchOf(['', undefined, 'main'])).toBe('main');
    expect(await branchOf(['', ''])).toBeUndefined();
  });
});

describe('claude-code adapter — cache-write TTL split', () => {
  const record = (
    messageId: string,
    ts: string,
    usage: Record<string, unknown>,
  ) => ({
    type: 'assistant',
    uuid: `u-${messageId}`,
    parentUuid: null,
    sessionId: 'sess-ttl',
    timestamp: ts,
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      usage,
      content: [{ type: 'text', text: 'ok' }],
    },
  });

  it('emits the 1h share as an attribute, clamped and only when nonzero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracepulse-cc-ttl-'));
    try {
      const proj = join(dir, 'proj');
      mkdirSync(proj, { recursive: true });
      const lines = [
        record('m1', '2026-07-02T14:00:01Z', {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 300,
          cache_creation: {
            ephemeral_5m_input_tokens: 100,
            ephemeral_1h_input_tokens: 200,
          },
        }),
        // all-5m write → no attribute (zero is not emitted)
        record('m2', '2026-07-02T14:00:02Z', {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 50,
          cache_creation: {
            ephemeral_5m_input_tokens: 50,
            ephemeral_1h_input_tokens: 0,
          },
        }),
        // breakdown larger than the flat total → the breakdown wins (the
        // write count is max(flat, 5m+1h), so nothing prices as zero)
        record('m3', '2026-07-02T14:00:03Z', {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_1h_input_tokens: 999 },
        }),
        // flat total missing entirely → the breakdown must still price
        record('m4', '2026-07-02T14:00:04Z', {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 12_000 },
        }),
      ];
      writeFileSync(
        join(proj, 'sess-ttl.jsonl'),
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      );
      const candidates = await claudeCodeAdapter.detect([dir]);
      expect(candidates).toHaveLength(1);
      const run = await claudeCodeAdapter.parse(candidates[0] as Candidate, {
        redact: false,
      });
      const attr = (id: string) =>
        run.spans.find((s) => s.id === id)?.attributes[CACHE_WRITE_1H_ATTR];
      expect(attr('m1')).toBe(200);
      expect(attr('m2')).toBeUndefined();
      // flat 100 vs breakdown 999: cacheWrite becomes 999 and the 1h share
      // clamps to that — the attribute can never exceed the priced write
      expect(attr('m3')).toBe(999);
      expect(run.spans.find((s) => s.id === 'm3')?.llm?.tokens.cacheWrite).toBe(
        999,
      );
      // no flat total → the breakdown itself is the write count
      expect(attr('m4')).toBe(12_000);
      expect(run.spans.find((s) => s.id === 'm4')?.llm?.tokens.cacheWrite).toBe(
        12_000,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('claude-code adapter — meta.json sidecar adoption', () => {
  it('links forked skills and background agents through sidecars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracepulse-cc-meta-'));
    try {
      const proj = join(dir, 'proj');
      const subagents = join(proj, 'sess-m', 'subagents');
      mkdirSync(subagents, { recursive: true });
      const jsonl = (lines: unknown[]) =>
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
      writeFileSync(
        join(proj, 'sess-m.jsonl'),
        jsonl([
          {
            type: 'user',
            uuid: 'u1',
            sessionId: 'sess-m',
            timestamp: '2026-08-18T10:00:00Z',
            message: { role: 'user', content: 'review this' },
          },
          {
            type: 'assistant',
            uuid: 'a1',
            parentUuid: 'u1',
            timestamp: '2026-08-18T10:00:05Z',
            message: {
              id: 'mm1',
              role: 'assistant',
              model: 'claude-fable-5',
              usage: { input_tokens: 5, output_tokens: 5 },
              content: [
                {
                  type: 'tool_use',
                  id: 'sk1',
                  name: 'Skill',
                  input: { skill: 'code-review', args: 'high' },
                },
              ],
            },
          },
          // forked skill: agentId arrives on the record-level toolUseResult
          // of a NON-Agent tool — the old `name === 'Agent'` gate dropped it
          {
            type: 'user',
            uuid: 'r1',
            timestamp: '2026-08-18T10:00:06Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'sk1',
                  content: [
                    { type: 'text', text: 'Running in the background' },
                  ],
                },
              ],
            },
            toolUseResult: {
              success: true,
              commandName: 'code-review',
              status: 'forked',
              background: true,
              agentId: 'fork1',
            },
          },
        ]),
      );
      // fork1 spawns a background child via an Agent tool_use with NO result
      writeFileSync(
        join(subagents, 'agent-fork1.jsonl'),
        jsonl([
          {
            type: 'user',
            uuid: 'cu1',
            timestamp: '2026-08-18T10:00:10Z',
            message: { role: 'user', content: 'run the review' },
          },
          {
            type: 'assistant',
            uuid: 'fa1',
            parentUuid: 'cu1',
            timestamp: '2026-08-18T10:00:12Z',
            message: {
              id: 'fm1',
              role: 'assistant',
              model: 'claude-fable-5',
              usage: { input_tokens: 3, output_tokens: 7 },
              content: [
                {
                  type: 'tool_use',
                  id: 'ct1',
                  name: 'Agent',
                  input: { description: 'Angle A: scan', prompt: 'go' },
                },
              ],
            },
          },
        ]),
      );
      writeFileSync(
        join(subagents, 'agent-fork1.meta.json'),
        JSON.stringify({
          agentType: 'general-purpose',
          description: '/code-review high',
          name: 'code-review',
          spawnDepth: 1,
        }),
      );
      // child linked ONLY through its sidecar (background: no tool result)
      writeFileSync(
        join(subagents, 'agent-child2.jsonl'),
        jsonl([
          {
            type: 'assistant',
            uuid: 'ca1',
            parentUuid: null,
            timestamp: '2026-08-18T10:00:40Z',
            message: {
              id: 'cm1',
              role: 'assistant',
              model: 'claude-fable-5',
              usage: { input_tokens: 2, output_tokens: 4 },
              content: [{ type: 'text', text: 'child done' }],
            },
          },
        ]),
      );
      writeFileSync(
        join(subagents, 'agent-child2.meta.json'),
        JSON.stringify({
          agentType: 'Explore',
          description: 'Angle A: scan',
          toolUseId: 'ct1',
          parentAgentId: 'fork1',
          spawnDepth: 2,
        }),
      );
      // orphan: no sidecar, no tool-result link → stays unlinked, warned
      writeFileSync(
        join(subagents, 'agent-orphan3.jsonl'),
        jsonl([
          {
            type: 'assistant',
            uuid: 'oa1',
            timestamp: '2026-08-18T10:00:50Z',
            message: {
              id: 'om1',
              role: 'assistant',
              model: 'claude-fable-5',
              usage: { input_tokens: 1, output_tokens: 1 },
              content: [{ type: 'text', text: 'orphan' }],
            },
          },
        ]),
      );

      const candidates = await claudeCodeAdapter.detect([dir]);
      expect(candidates).toHaveLength(1);
      const run = await claudeCodeAdapter.parse(candidates[0] as Candidate, {
        redact: false,
      });
      const span = (id: string) => run.spans.find((s) => s.id === id);

      // fork: linked via record-level agentId on the Skill result
      expect(span('fork1')?.kind).toBe('subagent');
      expect(span('fork1')?.parentId).toBe('sk1');
      expect(span('fork1')?.name).toBe('subagent:code-review');
      expect(span('fork1')?.status).toBe('ok');
      // child: adopted via sidecar, anchored on the spawning tool_use
      expect(span('child2')?.kind).toBe('subagent');
      expect(span('child2')?.parentId).toBe('ct1');
      expect(span('child2')?.agent?.name).toBe('Explore');
      expect(span('child2')?.content?.delegationReason).toBe('Angle A: scan');
      // …and it CLAIMS the placeholder the resultless Agent call left —
      // no phantom sibling delegation
      expect(span('ct1:agent')).toBeUndefined();
      // both transcripts contributed llm spans (their cost now counts)
      expect(span('fm1')?.kind).toBe('llm_call');
      expect(span('cm1')?.kind).toBe('llm_call');
      // the orphan stays out, with the warning naming one file
      expect(span('om1')).toBeUndefined();
      expect(
        run.warnings.some((w) => /^1 subagent transcript/.test(w.message)),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never adopts a transcript twice and dedupes repeated agentId results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracepulse-cc-meta2-'));
    try {
      const proj = join(dir, 'proj');
      const subagents = join(proj, 'sess-d', 'subagents');
      mkdirSync(subagents, { recursive: true });
      const jsonl = (lines: unknown[]) =>
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
      writeFileSync(
        join(proj, 'sess-d.jsonl'),
        jsonl([
          {
            type: 'user',
            uuid: 'u1',
            sessionId: 'sess-d',
            timestamp: '2026-08-18T11:00:00Z',
            message: { role: 'user', content: 'go' },
          },
          {
            type: 'assistant',
            uuid: 'a1',
            parentUuid: 'u1',
            timestamp: '2026-08-18T11:00:01Z',
            message: {
              id: 'dm1',
              role: 'assistant',
              model: 'claude-fable-5',
              usage: { input_tokens: 1, output_tokens: 1 },
              content: [
                { type: 'tool_use', id: 'dt1', name: 'Agent', input: {} },
                { type: 'tool_use', id: 'dt2', name: 'AgentOutput', input: {} },
              ],
            },
          },
          // two result records for DIFFERENT tool uses echo the same
          // agentId (spawn ack + later status poll) — one span, not two
          {
            type: 'user',
            uuid: 'r1',
            timestamp: '2026-08-18T11:00:02Z',
            message: {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'dt1', content: [] },
              ],
            },
            toolUseResult: { status: 'async', agentId: 'aa1' },
          },
          {
            type: 'user',
            uuid: 'r2',
            timestamp: '2026-08-18T11:00:03Z',
            message: {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'dt2', content: [] },
              ],
            },
            toolUseResult: { status: 'running', agentId: 'aa1' },
          },
        ]),
      );
      // agent aa1: transcript carries isSidechain (modern era) and forks
      // bb2 via a tool result — bb2 ALSO has a sidecar, the double-adoption
      // trap; bb2's transcript errored, which the fork span must surface
      writeFileSync(
        join(subagents, 'agent-aa1.jsonl'),
        jsonl([
          {
            type: 'assistant',
            uuid: 'aa-1',
            isSidechain: true,
            timestamp: '2026-08-18T11:00:05Z',
            message: {
              id: 'am1',
              role: 'assistant',
              model: 'claude-fable-5',
              usage: { input_tokens: 1, output_tokens: 1 },
              content: [
                { type: 'tool_use', id: 'at1', name: 'Skill', input: {} },
              ],
            },
          },
          {
            type: 'user',
            uuid: 'aa-2',
            isSidechain: true,
            timestamp: '2026-08-18T11:00:06Z',
            message: {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'at1', content: [] },
              ],
            },
            toolUseResult: { status: 'forked', agentId: 'bb2' },
          },
        ]),
      );
      writeFileSync(
        join(subagents, 'agent-bb2.jsonl'),
        jsonl([
          {
            type: 'assistant',
            uuid: 'bb-1',
            isSidechain: true,
            timestamp: '2026-08-18T11:00:10Z',
            isApiErrorMessage: true,
            message: {
              id: 'bm1',
              role: 'assistant',
              model: 'claude-fable-5',
              usage: { input_tokens: 1, output_tokens: 1 },
              content: [{ type: 'text', text: 'API error' }],
            },
          },
        ]),
      );
      writeFileSync(
        join(subagents, 'agent-aa1.meta.json'),
        JSON.stringify({ agentType: 'general-purpose', toolUseId: 'dt1' }),
      );
      writeFileSync(
        join(subagents, 'agent-bb2.meta.json'),
        JSON.stringify({
          agentType: 'Explore',
          toolUseId: 'at1',
          parentAgentId: 'aa1',
        }),
      );

      const candidates = await claudeCodeAdapter.detect([dir]);
      const run = await claudeCodeAdapter.parse(candidates[0] as Candidate, {
        redact: false,
      });
      // sidecars are provenance: they ride in the candidate's file set
      expect(
        (candidates[0]?.files ?? []).filter((f) => f.endsWith('.meta.json')),
      ).toHaveLength(2);
      // repeated agentId results collapse to ONE subagent span
      expect(run.spans.filter((s) => s.id === 'aa1')).toHaveLength(1);
      // bb2 was linked by aa1's tool result mid-adoption; the sidecar pass
      // must NOT adopt it again — one span, its llm span emitted once
      expect(run.spans.filter((s) => s.id === 'bb2')).toHaveLength(1);
      expect(run.spans.filter((s) => s.id === 'bm1')).toHaveLength(1);
      // the fork's transcript errored: the container says so
      expect(run.spans.find((s) => s.id === 'bb2')?.status).toBe('error');
      // isSidechain inside AGENT transcripts is the modern era, not legacy
      expect(
        run.warnings.some((w) => /legacy subagent format/.test(w.message)),
      ).toBe(false);
      // nothing left unlinked
      expect(
        run.warnings.some((w) => /subagent transcript/.test(w.message)),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('claude-code adapter — error text on failed tool spans', () => {
  const toolErrorsDir = join(fixtureDir, '..', 'tool-errors');
  async function toolErrorsRun(redact: boolean) {
    const candidates = await claudeCodeAdapter.detect([toolErrorsDir]);
    const candidate = candidates.find((c) =>
      c.runRef.endsWith('tool-errors.jsonl'),
    );
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error('tool-errors fixture not found');
    return claudeCodeAdapter.parse(candidate, { redact });
  }

  it('keeps the first 200 chars of a failed result as the tool span preview', async () => {
    const run = await toolErrorsRun(false);
    const failed = run.spans.filter(
      (s) =>
        s.kind !== 'llm_call' && s.status === 'error' && s.tool !== undefined,
    );
    expect(failed.length).toBeGreaterThan(0);
    const withText = failed.filter(
      (s) => typeof s.content?.outputPreview === 'string',
    );
    expect(withText.length).toBeGreaterThan(0);
    for (const s of withText) {
      expect((s.content?.outputPreview ?? '').length).toBeLessThanOrEqual(200);
    }
    // successful tool spans carry no preview: outputs are sized, not quoted
    for (const s of run.spans) {
      if (s.tool !== undefined && s.status === 'ok') {
        expect(s.content).toBeUndefined();
      }
    }
  });

  it('nulls the error text under redaction, like every other preview', async () => {
    const run = await toolErrorsRun(true);
    const failed = run.spans.filter(
      (s) => s.tool !== undefined && s.status === 'error',
    );
    expect(failed.length).toBeGreaterThan(0);
    for (const s of failed) {
      expect(s.content?.outputPreview).toBeNull();
    }
  });
});

describe('claude-code adapter — where a failure is named, exit codes, declined calls', () => {
  const BATCH_LOG = [
    '[navigate] navigated to http://localhost:4326',
    '',
    'Tab Context:',
    '- Executed on tabId: seed',
    '',
    '[computer:screenshot] Screenshot size: 800x450',
    '',
    'actions[2] (computer:screenshot) failed: screenshot failed: Screenshot timed out after 5s: the page did not finish rendering in time. (2 completed, 0 remaining)',
  ].join('\n');
  const REJECTION =
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

  function failedResult(
    uuid: string,
    ts: string,
    toolUseId: string,
    text: string,
  ) {
    return {
      type: 'user',
      uuid,
      sessionId: 'sess-e0',
      timestamp: ts,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            is_error: true,
            content: [{ type: 'text', text }],
          },
        ],
      },
    };
  }

  async function parseSession(redact: boolean): Promise<RawRun> {
    const dir = mkdtempSync(join(tmpdir(), 'runray-cc-e0-'));
    try {
      const proj = join(dir, 'proj');
      mkdirSync(proj, { recursive: true });
      const lines = [
        {
          type: 'user',
          uuid: 'u1',
          sessionId: 'sess-e0',
          timestamp: '2026-09-03T10:00:00Z',
          cwd: '/home/user/project/x',
          message: { role: 'user', content: 'fix it' },
        },
        {
          ...assistant('a1', 'u1', 'msg_e0', '2026-09-03T10:00:01Z', [
            {
              type: 'tool_use',
              id: 'tu_bash',
              name: 'Bash',
              input: { command: 'cd packages/ui/src && ls' },
            },
            {
              type: 'tool_use',
              id: 'tu_batch',
              name: 'mcp__Claude_Browser__browser_batch',
              input: { actions: [] },
            },
            {
              type: 'tool_use',
              id: 'tu_edit',
              name: 'Edit',
              input: {
                file_path: '/home/user/project/x/a.ts',
                old_string: 'a',
                new_string: 'b',
              },
            },
          ]),
          sessionId: 'sess-e0',
        },
        failedResult(
          'u2',
          '2026-09-03T10:00:02Z',
          'tu_bash',
          'Exit code 1\n/usr/bin/bash: line 1: cd: packages/ui/src: No such file or directory',
        ),
        failedResult('u3', '2026-09-03T10:00:03Z', 'tu_batch', BATCH_LOG),
        failedResult('u4', '2026-09-03T10:00:04Z', 'tu_edit', REJECTION),
      ];
      writeFileSync(
        join(proj, 'sess-e0.jsonl'),
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      );
      const candidates = await claudeCodeAdapter.detect([dir]);
      const candidate = candidates.find((c) =>
        c.runRef.endsWith('sess-e0.jsonl'),
      );
      if (!candidate) throw new Error('synthetic session not detected');
      // awaited inside the try: the finally below deletes the transcript
      return await claudeCodeAdapter.parse(candidate, { redact });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('parses the Exit code line into tool.exitCode and previews the message after it', async () => {
    const run = await parseSession(false);
    const bash = run.spans.find((s) => s.id === 'tu_bash');
    expect(bash?.status).toBe('error');
    expect(bash?.tool?.exitCode).toBe(1);
    expect(bash?.tool?.isError).toBe(true);
    expect(bash?.content?.outputPreview).toBe(
      '/usr/bin/bash: line 1: cd: packages/ui/src: No such file or directory',
    );
  });

  it('starts a batch log preview at the failing step', async () => {
    const run = await parseSession(false);
    const batch = run.spans.find((s) => s.id === 'tu_batch');
    expect(batch?.kind).toBe('mcp_call');
    expect(batch?.tool?.exitCode).toBeUndefined();
    expect(
      batch?.content?.outputPreview?.startsWith(
        'actions[2] (computer:screenshot) failed:',
      ),
    ).toBe(true);
  });

  it('marks a declined call cancelled, not failed, and keeps its message', async () => {
    const run = await parseSession(false);
    const edit = run.spans.find((s) => s.id === 'tu_edit');
    expect(edit?.status).toBe('cancelled');
    expect(edit?.statusReason).toBe('user-rejected');
    expect(edit?.tool?.isError).toBe(false);
    expect(edit?.tool?.linesAdded).toBeUndefined();
    expect(
      edit?.content?.outputPreview?.startsWith("The user doesn't want"),
    ).toBe(true);
    // the normalizer counts failures by status, so a decision is not one
    const normalized = normalize(priceRun(run), { baseDir: '/' });
    expect(normalized.totals.counts.toolErrors).toBe(2);
    expect(normalized.totals.counts.toolCalls).toBe(3);
  });

  it('nulls the declined call message under redaction too', async () => {
    const run = await parseSession(true);
    const edit = run.spans.find((s) => s.id === 'tu_edit');
    expect(edit?.status).toBe('cancelled');
    expect(edit?.content).toEqual({ outputPreview: null });
    const bash = run.spans.find((s) => s.id === 'tu_bash');
    expect(bash?.tool?.exitCode).toBe(1);
  });
});

describe('claude-code adapter — records repeated after a bridge-session', () => {
  const jsonl = (lines: unknown[]) =>
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  const bash = (id: string) => ({
    type: 'tool_use',
    id,
    name: 'Bash',
    input: { command: 'pnpm test' },
  });
  const failed = (uuid: string, ts: string, toolUseId: string) => ({
    ...toolResult(uuid, ts, toolUseId),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: true,
          content: [{ type: 'text', text: 'FAIL 1 test' }],
        },
      ],
    },
  });
  const noUuid = (ts: string) => ({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'text', text: 'no uuid' }],
    },
  });
  // three consecutive failures of one tool: exactly one retry-loop cluster
  const original = [
    {
      type: 'user',
      uuid: 'u1',
      sessionId: 'sess-dup',
      timestamp: '2026-09-03T18:38:10Z',
      cwd: '/home/user/project/x',
      message: { role: 'user', content: 'run the tests' },
    },
    assistant('a1', 'u1', 'm1', '2026-09-03T18:38:12Z', [bash('t1')]),
    failed('r1', '2026-09-03T18:38:15Z', 't1'),
    assistant('a2', 'r1', 'm2', '2026-09-03T18:38:20Z', [bash('t2')]),
    failed('r2', '2026-09-03T18:38:22Z', 't2'),
    assistant('a3', 'r2', 'm3', '2026-09-03T18:38:30Z', [bash('t3')]),
    failed('r3', '2026-09-03T18:38:32Z', 't3'),
    assistant('a4', 'r3', 'm4', '2026-09-03T18:38:40Z', [
      { type: 'text', text: 'gave up' },
    ]),
  ];
  // the desktop app re-appends the whole transcript after a bridge: the
  // same uuids and ids on later lines, with a newer version and a slug
  const copies = original.map((r) => ({
    ...r,
    version: '2.1.258',
    slug: 'copy',
  }));
  let run: RawRun;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runray-cc-dup-'));
    try {
      const proj = join(dir, 'proj');
      mkdirSync(proj, { recursive: true });
      writeFileSync(
        join(proj, 'sess-dup.jsonl'),
        jsonl([
          ...original, // lines 1–8
          {
            type: 'bridge-session',
            sessionId: 'sess-dup',
            bridgeSessionId: 'cse_1',
          },
          ...copies, // lines 10–17
          // fresh uuids re-registering a known tool_use and its result: the
          // block is not pushed again and the first result (the failure)
          // keeps deciding the span
          assistant('a1-again', 'u1', 'm1', '2026-09-03T18:38:12Z', [
            bash('t1'),
          ]),
          toolResult('r1-again', '2026-09-03T18:39:00Z', 't1'),
          // records without a uuid are never deduplicated
          noUuid('2026-09-03T18:39:10Z'),
          noUuid('2026-09-03T18:39:11Z'),
        ]),
      );
      const candidates = await claudeCodeAdapter.detect([dir]);
      expect(candidates).toHaveLength(1);
      run = await claudeCodeAdapter.parse(candidates[0] as Candidate, {
        redact: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the first copy of every record and counts the session once', () => {
    const spans = (id: string) => run.spans.filter((s) => s.id === id);
    const ids = run.spans.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['m1', 'm2', 'm3', 'm4', 't1', 't2', 't3']) {
      expect(spans(id)).toHaveLength(1);
    }
    // provenance stays on the lines written live, never past the bridge
    expect(spans('m1')[0]?.provenance.line).toBe(2);
    expect(spans('t1')[0]?.provenance.line).toBe(2);
    expect(spans('m4')[0]?.provenance.line).toBe(8);
    expect(spans('m1')[0]?.content?.promptPreview).toBe('run the tests');
    // the first tool_result wins over the re-registered success
    const t1 = spans('t1')[0];
    expect(t1?.status).toBe('error');
    expect(t1?.endedAt).toBe('2026-09-03T18:38:15Z');
    expect(t1?.content?.outputPreview).toBe('FAIL 1 test');
    // counts match a single copy: 4 calls plus the two uuid-less records,
    // 3 tool calls, all failed
    const llm = run.spans.filter((s) => s.kind === 'llm_call');
    expect(llm).toHaveLength(6);
    expect(llm.filter((s) => s.id.startsWith('rec-'))).toHaveLength(2);
    const tools = run.spans.filter((s) => s.tool !== undefined);
    expect(tools).toHaveLength(3);
    expect(tools.filter((s) => s.status === 'error')).toHaveLength(3);
  });

  it('manufactures no second retry-loop cluster from the copies', () => {
    const loops = applyInsights(normalize(run)).insights.filter(
      (i) => i.ruleId === 'retry-loop',
    );
    expect(loops).toHaveLength(1);
    expect(loops[0]?.spanIds).toEqual(['t1', 't2', 't3']);
    expect(loops[0]?.title).toBe('Bash failed 3× in a row');
  });
});

describe('claude-code files that are not sessions', () => {
  // detect() picks files by name, so parse() is where a non-session .jsonl
  // is refused: a foreign one with an Error (discovery warns), Claude Code's
  // own with no conversation yet with NoSessionYet (discovery stays quiet).
  // Either way, no 1970 run.
  async function parseLines(lines: readonly unknown[]): Promise<RawRun> {
    const dir = mkdtempSync(join(tmpdir(), 'runray-cc-foreign-'));
    try {
      writeFileSync(
        join(dir, 'foreign.jsonl'),
        lines
          .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
          .join('\n'),
      );
      const [candidate] = await claudeCodeAdapter.detect([dir]);
      if (candidate === undefined) throw new Error('not detected');
      return await claudeCodeAdapter.parse(candidate, { redact: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each<[string, unknown[]]>([
    [
      'a log from another tool, timestamps and all',
      [{ level: 'info', timestamp: '2026-07-02T13:00:00Z', msg: 'started' }],
    ],
    [
      'user records without any timestamp',
      [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }],
    ],
    ['lines that are not JSON', ['not json', '{also not']],
    [
      'a timestamped log line next to an untimestamped user record',
      [
        { level: 'info', timestamp: '2026-07-02T13:00:00Z', msg: 'started' },
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
      ],
    ],
  ])('refuses %s as foreign', async (_label, lines) => {
    const err = await parseLines(lines).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NoSessionYet);
    expect((err as Error).message).toBe(
      'not a Claude Code session: no timestamped user or assistant records',
    );
  });

  it.each<[string, unknown[]]>([
    [
      'a live session before its first prompt is written',
      [
        {
          type: 'queue-operation',
          operation: 'enqueue',
          sessionId: 'sess-new',
          timestamp: '2026-07-02T13:00:00Z',
        },
      ],
    ],
    [
      'a summary-only file',
      [{ type: 'summary', summary: 's', leafUuid: 'u1' }],
    ],
    [
      'a timestamped queue-operation ahead of an untimestamped prompt',
      [
        {
          type: 'queue-operation',
          operation: 'enqueue',
          sessionId: 'sess-new',
          timestamp: '2026-07-02T13:00:00Z',
        },
        {
          type: 'user',
          uuid: 'u1',
          sessionId: 'sess-new',
          message: { role: 'user', content: 'hi' },
        },
      ],
    ],
  ])('skips %s quietly (NoSessionYet)', async (_label, lines) => {
    await expect(parseLines(lines)).rejects.toBeInstanceOf(NoSessionYet);
  });

  it('keeps a session whose prompt never got a reply', async () => {
    const raw = await parseLines([
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 'sess-crashed',
        timestamp: '2026-07-02T13:00:00Z',
        message: { role: 'user', content: 'hi' },
      },
    ]);
    expect(raw.spans[0]?.kind).toBe('session');
    expect(raw.spans[0]?.startedAt).toBe('2026-07-02T13:00:00Z');
  });
});

describe('claude-code adapter — hook spans', () => {
  // The three shapes a transcript records a hook in (design D5), as Claude
  // Code writes them: the record's timestamp is when the hook ended.
  const prompt = (uuid = 'u1', ts = '2026-11-03T10:00:00.000Z') => ({
    type: 'user',
    uuid,
    sessionId: 'sess-hooks',
    timestamp: ts,
    cwd: '/home/user/project/x',
    message: { role: 'user', content: 'tidy the module' },
  });
  const edit = (id: string) => ({
    type: 'tool_use',
    id,
    name: 'Edit',
    input: { file_path: '/x.ts', old_string: 'a', new_string: 'b' },
  });
  const hookError = (
    uuid: string | undefined,
    ts: string | undefined,
    attachment: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'attachment',
    uuid,
    sessionId: 'sess-hooks',
    timestamp: ts,
    attachment: {
      type: 'hook_non_blocking_error',
      hookName: 'PostToolUse:Edit',
      hookEvent: 'PostToolUse',
      toolUseID: 't1',
      command: 'node /Users/alex/.claude/hooks/format.mjs',
      durationMs: 688,
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Cannot find module /Users/alex/.claude/hooks/format.mjs',
      ...attachment,
    },
    ...extra,
  });
  const hookCancelled = (uuid: string, ts: string, durationMs: number) => ({
    type: 'attachment',
    uuid,
    sessionId: 'sess-hooks',
    timestamp: ts,
    attachment: {
      type: 'hook_cancelled',
      hookName: 'UserPromptSubmit',
      hookEvent: 'UserPromptSubmit',
      toolUseID: 'not-a-tool-call',
      command: 'python3 "$CLAUDE_PLUGIN_ROOT/hooks/remind.py"',
      durationMs,
      timedOut: true,
      timeoutMs: 30000,
    },
  });
  const stopSummary = (
    uuid: string,
    ts: string,
    commands: string[],
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'system',
    subtype: 'stop_hook_summary',
    uuid,
    sessionId: 'sess-hooks',
    timestamp: ts,
    hookCount: commands.length,
    hookInfos: commands.map((command) => ({ command })),
    hookErrors: [],
    preventedContinuation: false,
    stopReason: '',
    hasOutput: false,
    level: 'suggestion',
    toolUseID: 'not-a-tool-call',
    ...extra,
  });
  // one turn: a prompt, an Edit whose PostToolUse hook failed, a reply
  const turn = [
    prompt(),
    assistant('a1', 'u1', 'm1', '2026-11-03T10:00:05.000Z', [edit('t1')]),
    hookError('h1', '2026-11-03T10:00:07.000Z'),
    toolResult('r1', '2026-11-03T10:00:07.002Z', 't1'),
    assistant('a2', 'r1', 'm2', '2026-11-03T10:00:09.000Z', [
      { type: 'text', text: 'done' },
    ]),
  ];
  const conversation = turn.filter((r) => r.type !== 'attachment');

  async function parseFiles(
    files: Record<string, readonly unknown[]>,
    redact = false,
  ): Promise<RawRun> {
    const dir = mkdtempSync(join(tmpdir(), 'runray-cc-hooks-'));
    try {
      for (const [name, lines] of Object.entries(files)) {
        const path = join(dir, 'proj', name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
        );
      }
      const [candidate] = await claudeCodeAdapter.detect([dir]);
      if (candidate === undefined) throw new Error('not detected');
      return await claudeCodeAdapter.parse(candidate, { redact });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const parseLines = (lines: readonly unknown[], redact = false) =>
    parseFiles({ 'sess-hooks.jsonl': lines }, redact);
  const hooksOf = (run: RawRun) => run.spans.filter((s) => s.kind === 'hook');

  it('emits a failed hook with its duration, ending where the record was written', async () => {
    const run = await parseLines(turn);
    const hooks = hooksOf(run);
    expect(hooks).toHaveLength(1);
    const [hook] = hooks;
    expect(hook).toMatchObject({
      id: 'h1',
      kind: 'hook',
      name: 'PostToolUse:Edit',
      status: 'error',
      startedAt: '2026-11-03T10:00:06.312Z',
      endedAt: '2026-11-03T10:00:07.000Z',
      durationMs: 688,
      // the data model keeps `tool` for tool and MCP calls
      statusReason: 'exit 1',
      provenance: { line: 3 },
    });
    expect(hook?.tool).toBeUndefined();
    expect(hook?.content).toBeUndefined();
  });

  it('nests a tool hook under the call that triggered it', async () => {
    const run = await parseLines(turn);
    expect(hooksOf(run)[0]?.parentId).toBe('t1');
    // the hook ran inside the call: the call's own bounds are untouched
    const call = run.spans.find((s) => s.id === 't1');
    expect(call?.startedAt).toBe('2026-11-03T10:00:05.000Z');
    expect(call?.endedAt).toBe('2026-11-03T10:00:07.002Z');
  });

  it('emits a cancelled hook, with the timeout as the reason', async () => {
    const run = await parseLines([
      prompt(),
      hookCancelled('h0', '2026-11-03T10:00:04.000Z', 3_000),
      ...turn.slice(1),
    ]);
    const hook = hooksOf(run).find((s) => s.name === 'UserPromptSubmit');
    expect(hook).toMatchObject({
      id: 'h0',
      status: 'cancelled',
      statusReason: 'timeout',
      startedAt: '2026-11-03T10:00:01.000Z',
      endedAt: '2026-11-03T10:00:04.000Z',
      durationMs: 3_000,
      // not a tool hook: it belongs to the transcript's container
      parentId: 'sess-hooks',
    });
    expect(hook?.tool).toBeUndefined();
    expect(hook?.attributes).toEqual({
      'runray.toolActivity': 'run',
      'runray.tool': 'python',
      'runray.toolSub': 'script',
      'runray.toolScript': 'remind.py',
    });
  });

  it('emits a stop-hook summary as a zero-duration span with its hook count', async () => {
    const run = await parseLines([
      ...turn,
      stopSummary('s1', '2026-11-03T10:00:09.500Z', [
        'node "$CLAUDE_PLUGIN_ROOT/hooks/a.mjs"',
        'node "$CLAUDE_PLUGIN_ROOT/hooks/b.mjs"',
        'node /Users/alex/.claude/hooks/c.mjs',
      ]),
    ]);
    const stop = hooksOf(run).find((s) => s.name === 'Stop');
    expect(stop).toMatchObject({
      id: 's1',
      status: 'ok',
      startedAt: '2026-11-03T10:00:09.500Z',
      endedAt: '2026-11-03T10:00:09.500Z',
      durationMs: 0,
      parentId: 'sess-hooks',
    });
    // three hooks, one tool: the span may name it, and nothing else
    expect(stop?.attributes).toEqual({
      'runray.toolActivity': 'run',
      'runray.tool': 'node',
      'runray.hookCount': 3,
    });
    expect(stop?.tool).toBeUndefined();
  });

  it('names no tool for a summary of hooks that ran different ones, and marks listed errors', async () => {
    const run = await parseLines([
      ...turn,
      stopSummary(
        's1',
        '2026-11-03T10:00:09.500Z',
        ['node /h/a.mjs', 'python3 /h/b.py'],
        { hookErrors: ['b.py exited with code 2'] },
      ),
      // one command: it is classified like any single hook
      stopSummary('s2', '2026-11-03T10:00:09.600Z', ['bash ~/.claude/done.sh']),
      // a count without commands still says how many ran
      stopSummary('s3', '2026-11-03T10:00:09.700Z', [], { hookCount: 2 }),
    ]);
    const byId = new Map(hooksOf(run).map((s) => [s.id, s]));
    expect(byId.get('s1')?.status).toBe('error');
    expect(byId.get('s1')?.attributes).toEqual({ 'runray.hookCount': 2 });
    expect(byId.get('s2')?.status).toBe('ok');
    expect(byId.get('s2')?.attributes).toEqual({
      'runray.toolActivity': 'run',
      'runray.tool': 'bash',
      'runray.toolSub': 'script',
      'runray.toolScript': 'done.sh',
      'runray.hookCount': 1,
    });
    expect(byId.get('s3')?.attributes).toEqual({ 'runray.hookCount': 2 });
  });

  it('emits nothing for hooks the transcript does not record', async () => {
    const run = await parseLines([
      ...conversation,
      // a successful hook that handed text to the model: no duration, and
      // only some successful runs leave one, so it is not a span
      {
        type: 'attachment',
        uuid: 'c1',
        sessionId: 'sess-hooks',
        timestamp: '2026-11-03T10:00:07.001Z',
        attachment: {
          type: 'hook_additional_context',
          hookName: 'PostToolUse:Edit',
          hookEvent: 'PostToolUse',
          toolUseID: 't1',
          content: ['formatted'],
        },
      },
      // an attachment that is not about hooks at all
      {
        type: 'attachment',
        uuid: 'c2',
        sessionId: 'sess-hooks',
        timestamp: '2026-11-03T10:00:07.001Z',
        attachment: { type: 'diagnostics', files: [] },
      },
      // a system note that is not a stop-hook summary
      {
        type: 'system',
        subtype: 'turn_duration',
        uuid: 'c3',
        sessionId: 'sess-hooks',
        timestamp: '2026-11-03T10:00:09.100Z',
        durationMs: 9100,
      },
      // a hook record that cannot be placed in time
      hookError('c4', undefined),
      hookError('c5', 'yesterday'),
    ]);
    expect(hooksOf(run)).toEqual([]);
  });

  it('leaves tool totals alone', async () => {
    // `maxDepth` is the one count a hook can move: it hangs off its call
    const counts = (run: RawRun) => {
      const { maxDepth: _depth, ...rest } = normalize(priceRun(run)).totals
        .counts;
      return rest;
    };
    const withHooks = await parseLines([
      ...turn,
      stopSummary('s1', '2026-11-03T10:00:09.500Z', ['node /h/a.mjs'], {
        hookErrors: ['boom'],
      }),
    ]);
    const without = await parseLines(conversation);
    expect(hooksOf(withHooks)).toHaveLength(2);
    expect(hooksOf(withHooks).every((s) => s.status === 'error')).toBe(true);
    expect(counts(withHooks)).toEqual(counts(without));
    expect(counts(withHooks)).toMatchObject({ toolCalls: 1, toolErrors: 0 });
  });

  it.each([false, true])(
    'classifies the hook command and stores none of it (redact: %s)',
    async (redact) => {
      const run = await parseLines(
        [
          ...turn,
          // a Windows path that a POSIX reading would glue into the script name
          hookError('h2', '2026-11-03T10:00:08.000Z', {
            command: 'node C:\\Users\\alex\\.claude\\hooks\\format.mjs',
            toolUseID: 'not-a-tool-call',
            hookName: 'SessionStart:startup',
          }),
          stopSummary('s1', '2026-11-03T10:00:09.500Z', [
            'node /Users/alex/.claude/hooks/format.mjs',
          ]),
        ],
        redact,
      );
      const hooks = hooksOf(run);
      expect(hooks).toHaveLength(3);
      for (const hook of hooks) {
        expect(hook.attributes).toMatchObject({
          'runray.toolActivity': 'run',
          'runray.tool': 'node',
          'runray.toolSub': 'script',
        });
        // the script's file name is free-form text: local reports only
        expect(hook.attributes['runray.toolScript']).toBe(
          redact ? undefined : 'format.mjs',
        );
      }
      // no path, no user name, no stderr anywhere in the run
      expect(JSON.stringify(run.spans)).not.toMatch(
        /alex|\.claude|hooks[\\/]|Cannot find/,
      );
    },
  );

  it('stamps nothing for an SDK callback hook or a hook without a command', async () => {
    const run = await parseLines([
      ...turn.slice(0, 2),
      hookError('h1', '2026-11-03T10:00:07.000Z', { command: 'callback' }),
      hookError('h2', '2026-11-03T10:00:07.001Z', { command: undefined }),
      ...turn.slice(3),
    ]);
    expect(hooksOf(run).map((s) => s.attributes)).toEqual([{}, {}]);
  });

  it('reads a hook command that starts with a quoted Windows path (spec scenario)', async () => {
    // cmd runs a quoted path as it stands; PowerShell would call it a string
    const run = await parseLines([
      ...turn.slice(0, 2),
      hookError('h1', '2026-11-03T10:00:07.000Z', {
        command:
          '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\alex\\.claude\\hooks\\format.mjs',
      }),
      ...turn.slice(3),
    ]);
    expect(hooksOf(run).map((s) => s.attributes)).toEqual([
      {
        'runray.toolActivity': 'run',
        'runray.tool': 'node',
        'runray.toolSub': 'script',
        'runray.toolScript': 'format.mjs',
      },
    ]);
  });

  it('never lets free text become a span name', async () => {
    const run = await parseLines([
      ...turn.slice(0, 2),
      hookError('h1', '2026-11-03T10:00:07.000Z', {
        hookName: 'tempor enim sed',
      }),
      hookError('h2', '2026-11-03T10:00:07.001Z', {
        hookName: 'tempor enim sed',
        hookEvent: 'magna minim amet',
      }),
      hookError('h3', '2026-11-03T10:00:07.002Z', {
        hookName: 'PreToolUse:mcp__plugin_docs_docs__resolve-library-id',
      }),
      hookError('h4', '2026-11-03T10:00:07.003Z', {
        hookName: 'SubagentStop:feature-dev:code-reviewer',
      }),
      ...turn.slice(3),
    ]);
    const names = new Map(hooksOf(run).map((s) => [s.id, s.name]));
    expect(Object.fromEntries(names)).toEqual({
      h1: 'PostToolUse',
      h2: 'hook',
      h3: 'PreToolUse:mcp__plugin_docs_docs__resolve-library-id',
      h4: 'SubagentStop:feature-dev:code-reviewer',
    });
  });

  it('never lets a file name or a path into a span name (spec scenario)', async () => {
    const named = (hookName: string, hookEvent: string, n: number) =>
      hookError(`h${n}`, `2026-11-03T10:00:07.00${n}Z`, {
        hookName,
        hookEvent,
      });
    const run = await parseLines([
      ...turn.slice(0, 2),
      // an event that matches on file names: the matcher is project text
      named('FileChanged:Makefile', 'FileChanged', 1),
      named('FileChanged:.env.local', 'FileChanged', 2),
      // a tool event whose matcher is not shaped like a tool name
      named('PostToolUse:src/billing/invoice.ts', 'PostToolUse', 3),
      named('PostToolUse:notes.md', 'PostToolUse', 4),
      named('PreToolUse:C:\\Users\\alex\\plan', 'PreToolUse', 5),
      // names stay names
      named('PostToolUse:Edit', 'PostToolUse', 6),
      named('SessionStart:startup', 'SessionStart', 7),
      ...turn.slice(3),
    ]);
    const names = new Map(hooksOf(run).map((s) => [s.id, s.name]));
    expect(Object.fromEntries(names)).toEqual({
      h1: 'FileChanged',
      h2: 'FileChanged',
      h3: 'PostToolUse',
      h4: 'PostToolUse',
      h5: 'PreToolUse',
      h6: 'PostToolUse:Edit',
      h7: 'SessionStart:startup',
    });
    expect(JSON.stringify(run.spans)).not.toMatch(
      /Makefile|env\.local|billing|invoice|notes\.md|alex/,
    );
  });

  it('emits each hook once from a re-appended transcript', async () => {
    const lines = [
      ...turn,
      hookCancelled('h2', '2026-11-03T10:00:50.000Z', 30_000),
      stopSummary('s1', '2026-11-03T10:00:51.000Z', ['node /h/a.mjs']),
    ];
    const once = await parseLines(lines);
    const twice = await parseLines([
      ...lines,
      { type: 'bridge-session', sessionId: 'sess-hooks', bridgeSessionId: 'c' },
      ...lines.map((r) => ({ ...r, version: '2.1.258', slug: 'copy' })),
    ]);
    expect(hooksOf(twice).map((s) => s.id)).toEqual(['h1', 'h2', 's1']);
    // the first copy keeps its provenance line
    expect(hooksOf(twice).map((s) => s.provenance.line)).toEqual([3, 6, 7]);
    const plain = (run: RawRun) =>
      hooksOf(run).map((s) => ({
        ...s,
        provenance: { line: s.provenance.line },
      }));
    expect(plain(twice)).toEqual(plain(once));
    const ids = twice.spans.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keys a hook record without a uuid by its place in its own transcript', async () => {
    const run = await parseLines([
      ...turn.slice(0, 2),
      hookError(undefined, '2026-11-03T10:00:07.000Z'),
      hookError(undefined, '2026-11-03T10:00:07.001Z'),
      ...turn.slice(3),
    ]);
    expect(hooksOf(run).map((s) => s.id)).toEqual([
      'sess-hooks:hook:3',
      'sess-hooks:hook:4',
    ]);
  });

  it('opens the session where a start-up hook began, before the first record', async () => {
    const run = await parseLines([
      hookError(
        'h0',
        '2026-11-03T09:59:59.000Z',
        {
          hookName: 'SessionStart:startup',
          hookEvent: 'SessionStart',
          toolUseID: 'not-a-tool-call',
          durationMs: 1500,
        },
        { parentUuid: null },
      ),
      ...turn,
    ]);
    const session = run.spans.find((s) => s.kind === 'session');
    const hook = hooksOf(run).find((s) => s.id === 'h0');
    expect(hook?.startedAt).toBe('2026-11-03T09:59:57.500Z');
    expect(hook?.parentId).toBe(session?.id);
    // the container covers its child at both ends
    expect(session?.startedAt).toBe('2026-11-03T09:59:57.500Z');
    expect(session?.endedAt).toBe('2026-11-03T10:00:09.000Z');
    expect(session?.durationMs).toBe(11_500);
    const normalized = normalize(priceRun(run));
    expect(normalized.startedAt).toBe('2026-11-03T09:59:57.500Z');
    expect(normalized.durationMs).toBe(11_500);
  });

  it('gives a subagent its own hooks', async () => {
    const run = await parseFiles({
      'sess-hooks.jsonl': [
        prompt(),
        assistant('a1', 'u1', 'm1', '2026-11-03T10:00:05.000Z', [
          {
            type: 'tool_use',
            id: 'tA',
            name: 'Agent',
            input: { subagent_type: 'reviewer', description: 'd', prompt: 'p' },
          },
        ]),
        toolResult('r1', '2026-11-03T10:01:00.000Z', 'tA', {
          toolUseResult: { agentId: 'abc123', status: 'completed' },
        }),
      ],
      'sess-hooks/subagents/agent-abc123.jsonl': [
        { ...prompt('cu1', '2026-11-03T10:00:06.000Z'), isSidechain: true },
        assistant('ca1', 'cu1', 'cm1', '2026-11-03T10:00:10.000Z', [
          edit('ct1'),
        ]),
        // a tool hook inside the agent, and one that names no call of its
        hookError('ch1', '2026-11-03T10:00:12.000Z', { toolUseID: 'ct1' }),
        hookError('ch2', '2026-11-03T10:00:13.000Z', { toolUseID: 't1' }),
        toolResult('cr1', '2026-11-03T10:00:14.000Z', 'ct1'),
      ],
    });
    const byId = new Map(hooksOf(run).map((s) => [s.id, s]));
    expect(byId.get('ch1')?.parentId).toBe('ct1');
    // `t1` is not a call of this transcript: the agent's own span holds it
    expect(byId.get('ch2')?.parentId).toBe('abc123');
    expect(byId.get('ch1')?.provenance.file).toMatch(/agent-abc123\.jsonl$/);
  });

  it('changes no finding and no total on the committed fixtures', async () => {
    // spec: "Findings are unchanged". Every fixture, parsed as committed and
    // from a copy with its hook records taken out.
    const source = fileURLToPath(
      new URL('../../../../fixtures/claude-code', import.meta.url),
    );
    const isHookRecord = (line: string): boolean => {
      if (!line.includes('hook')) return false;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        const attachment = rec.attachment as { type?: unknown } | undefined;
        return (
          (rec.type === 'attachment' &&
            (attachment?.type === 'hook_non_blocking_error' ||
              attachment?.type === 'hook_cancelled')) ||
          (rec.type === 'system' && rec.subtype === 'stop_hook_summary')
        );
      } catch {
        return false;
      }
    };
    const live = (candidates: Candidate[]) =>
      candidates.filter((c) => !/[\\/]raw[\\/]/.test(c.runRef));
    const dir = mkdtempSync(join(tmpdir(), 'runray-cc-nohooks-'));
    try {
      cpSync(source, dir, { recursive: true });
      const original = live(await claudeCodeAdapter.detect([source]));
      const stripped = live(await claudeCodeAdapter.detect([dir]));
      expect(stripped).toHaveLength(original.length);
      let removed = 0;
      for (const candidate of stripped) {
        for (const file of candidate.files) {
          if (!file.endsWith('.jsonl')) continue;
          const lines = readFileSync(file, 'utf8').split('\n');
          const kept = lines.filter((line) => !isHookRecord(line));
          removed += lines.length - kept.length;
          if (kept.length !== lines.length) {
            writeFileSync(file, kept.join('\n'));
          }
        }
      }
      expect(removed).toBeGreaterThan(1000);

      const pipeline = async (c: Candidate) =>
        applyInsights(
          normalize(
            priceRun(await claudeCodeAdapter.parse(c, { redact: false })),
          ),
        );
      let hookSpans = 0;
      for (const [i, candidate] of original.entries()) {
        const withHooks = await pipeline(candidate);
        const without = await pipeline(stripped[i] as Candidate);
        hookSpans += withHooks.spans.filter((s) => s.kind === 'hook').length;
        expect(without.spans.filter((s) => s.kind === 'hook')).toEqual([]);
        // tokens, cost, calls and errors are the same; `maxDepth` may be
        // one deeper, where a hook hangs off the deepest call
        const depth = withHooks.totals.counts.maxDepth;
        expect([0, 1], candidate.runRef).toContain(
          depth - without.totals.counts.maxDepth,
        );
        expect(withHooks.totals, candidate.runRef).toEqual({
          ...without.totals,
          counts: { ...without.totals.counts, maxDepth: depth },
        });
        expect(withHooks.insights, candidate.runRef).toEqual(without.insights);
        // every other span is still there, one for one
        expect(
          withHooks.spans.filter((s) => s.kind !== 'hook').map((s) => s.id),
          candidate.runRef,
        ).toEqual(without.spans.map((s) => s.id));
      }
      expect(hookSpans).toBeGreaterThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
