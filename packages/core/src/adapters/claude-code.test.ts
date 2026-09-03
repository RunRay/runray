import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Candidate, RawRun } from '../adapter.js';
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
