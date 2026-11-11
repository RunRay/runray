import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { RawRun, RawSpan } from '../adapter.js';
import {
  CLOSED_TOOL_ATTRS,
  FREE_TOOL_ATTRS,
  TOOL_ATTR,
} from '../tools/attributes.js';
import { claudeCodeAdapter } from './claude-code.js';
import { opencodeAdapter } from './opencode.js';
import { otlpAdapter } from './otlp.js';
import { toolTargetAttributes } from './target.js';
import { claudeCommandOutcome, toolUsageSpanAttributes } from './usage.js';

/**
 * Tool usage capture (trace-ingestion delta of add-tool-usage-breakdown:
 * "Shell tool usage capture", "Command result flags", "Skill identity
 * capture"). Transcripts are built inline: committed fixtures replace command
 * text with filler words and cannot exercise resolution.
 */

const COMPOUND = 'cd apps/web && pnpm exec vitest run 2>&1 | tail -20';
const ALSO = 'git add -A && pnpm build';
const UNKNOWN = 'acme-deploy --prod';

/** The tool-usage part of a span's attributes, in a comparable shape. */
function usageOf(span: RawSpan | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [...CLOSED_TOOL_ATTRS, ...FREE_TOOL_ATTRS]) {
    const value = span?.attributes[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

describe('toolUsageSpanAttributes', () => {
  it('classifies the shell tools of each source', () => {
    expect(
      toolUsageSpanAttributes(
        'claude-code',
        'Bash',
        { command: COMPOUND },
        true,
      ),
    ).toEqual({
      [TOOL_ATTR.activity]: 'test',
      [TOOL_ATTR.tool]: 'vitest',
      [TOOL_ATTR.sub]: 'run',
      [TOOL_ATTR.via]: 'pnpm exec',
    });
    expect(
      toolUsageSpanAttributes(
        'claude-code',
        'PowerShell',
        {
          command: '& "C:\\tools\\flutter\\bin\\flutter.bat" test; Get-Process',
        },
        true,
      ),
    ).toMatchObject({ [TOOL_ATTR.tool]: 'flutter', [TOOL_ATTR.sub]: 'test' });
    expect(
      toolUsageSpanAttributes('opencode', 'bash', { command: ALSO }, true),
    ).toMatchObject({ [TOOL_ATTR.tool]: 'pnpm', [TOOL_ATTR.also]: ['git'] });
  });

  it('stamps the activity alone when a shell call carries no command', () => {
    for (const input of [{}, { command: '' }, { command: 42 }, null, 'x']) {
      expect(
        toolUsageSpanAttributes('claude-code', 'Bash', input, false),
      ).toEqual({
        [TOOL_ATTR.activity]: 'other',
      });
    }
  });

  it('leaves every other tool alone, including inherited member names', () => {
    for (const name of [
      'Read',
      'Edit',
      'bash',
      'constructor',
      'toString',
      '__proto__',
    ]) {
      expect(
        toolUsageSpanAttributes(
          'claude-code',
          name,
          { command: 'docker ps' },
          false,
        ),
      ).toEqual({});
    }
    expect(
      toolUsageSpanAttributes(
        'opencode',
        'Bash',
        { command: 'docker ps' },
        false,
      ),
    ).toEqual({});
  });

  it('names the skill only when redaction is off (spec scenarios)', () => {
    const input = { skill: 'frontend-design' };
    expect(
      toolUsageSpanAttributes('claude-code', 'Skill', input, false),
    ).toEqual({
      [TOOL_ATTR.skill]: 'frontend-design',
    });
    expect(
      toolUsageSpanAttributes('claude-code', 'Skill', input, true),
    ).toEqual({});
    expect(
      toolUsageSpanAttributes(
        'opencode',
        'skill',
        { name: 'anthropic-skills:docx' },
        false,
      ),
    ).toEqual({ [TOOL_ATTR.skill]: 'anthropic-skills:docx' });
  });

  it('drops a skill name that is not one clean token', () => {
    for (const skill of [
      'two words',
      'a\nb',
      '',
      'x'.repeat(200),
      '../etc/passwd; rm',
    ]) {
      expect(
        toolUsageSpanAttributes('claude-code', 'Skill', { skill }, false),
      ).toEqual({});
    }
  });

  it('lists result flags in the fixed order and omits the key when none apply', () => {
    const run = (outcome: Parameters<typeof toolUsageSpanAttributes>[4]) =>
      toolUsageSpanAttributes(
        'claude-code',
        'Bash',
        { command: 'ls' },
        true,
        outcome,
      )[TOOL_ATTR.flags];
    expect(
      run({ interrupted: true, timedOut: true, background: true }),
    ).toEqual(['background', 'timeout', 'interrupted']);
    expect(run({ timedOut: true })).toEqual(['timeout']);
    expect(run({})).toBeUndefined();
    expect(run(undefined)).toBeUndefined();
  });
});

describe('claudeCommandOutcome', () => {
  it('reads the outcome from the call input and the recorded result', () => {
    expect(
      claudeCommandOutcome({ run_in_background: true }, undefined),
    ).toMatchObject({
      background: true,
      timedOut: false,
      interrupted: false,
    });
    expect(
      claudeCommandOutcome({}, { backgroundTaskId: 'b1' }).background,
    ).toBe(true);
    expect(claudeCommandOutcome({}, { timedOutAfterMs: 120000 }).timedOut).toBe(
      true,
    );
    expect(claudeCommandOutcome({}, { interrupted: true }).interrupted).toBe(
      true,
    );
  });

  it('reads nothing from shapes it does not recognise', () => {
    for (const result of [
      undefined,
      null,
      'text',
      3,
      [],
      { backgroundTaskId: '' },
    ]) {
      expect(claudeCommandOutcome(null, result)).toEqual({
        background: false,
        timedOut: false,
        interrupted: false,
      });
    }
  });
});

describe('claude-code adapter — tool usage capture', () => {
  const SESSION = 'sess-usage';
  const toolUse = (
    id: string,
    name: string,
    input: Record<string, unknown>,
  ) => ({
    type: 'tool_use',
    id,
    name,
    input,
  });
  const CALLS = [
    toolUse('tu_compound', 'Bash', { command: COMPOUND }),
    toolUse('tu_also', 'Bash', { command: ALSO }),
    toolUse('tu_unknown', 'Bash', { command: UNKNOWN }),
    toolUse('tu_ps', 'PowerShell', {
      command: '& "C:\\tools\\flutter\\bin\\flutter.bat" test; Get-Process',
    }),
    toolUse('tu_bg', 'Bash', {
      command: 'docker compose up',
      run_in_background: true,
    }),
    toolUse('tu_timeout', 'Bash', { command: 'pnpm test' }),
    toolUse('tu_plain', 'Bash', { command: 'ls -la' }),
    toolUse('tu_skill', 'Skill', { skill: 'frontend-design' }),
    toolUse('tu_read', 'Read', { file_path: '/home/user/project/x/a.ts' }),
    toolUse('tu_pending', 'Bash', { command: 'cargo build --release' }),
  ];
  const RESULTS: Record<string, Record<string, unknown>> = {
    tu_bg: { backgroundTaskId: 'bash_1', stdout: '', stderr: '' },
    tu_timeout: { timedOutAfterMs: 120000, interrupted: true },
  };

  async function parseSession(redact: boolean): Promise<RawRun> {
    const dir = mkdtempSync(join(tmpdir(), 'runray-cc-usage-'));
    try {
      const proj = join(dir, 'proj');
      mkdirSync(proj, { recursive: true });
      const lines: unknown[] = [
        {
          type: 'user',
          uuid: 'u0',
          sessionId: SESSION,
          timestamp: '2026-11-11T10:00:00Z',
          cwd: '/home/user/project/x',
          message: { role: 'user', content: 'ship it' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u0',
          sessionId: SESSION,
          timestamp: '2026-11-11T10:00:01Z',
          cwd: '/home/user/project/x',
          message: {
            id: 'msg_usage',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            stop_reason: 'tool_use',
            usage: { input_tokens: 100, output_tokens: 5 },
            content: CALLS,
          },
        },
      ];
      CALLS.forEach((call, index) => {
        if (call.id === 'tu_pending') return; // still running: no result
        lines.push({
          type: 'user',
          uuid: `r${index}`,
          sessionId: SESSION,
          timestamp: `2026-11-11T10:00:${String(10 + index).padStart(2, '0')}Z`,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: call.id,
                content: [{ type: 'text', text: 'ok' }],
              },
            ],
          },
          ...(RESULTS[call.id] === undefined
            ? {}
            : { toolUseResult: RESULTS[call.id] }),
        });
      });
      writeFileSync(
        join(proj, `${SESSION}.jsonl`),
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      );
      const candidates = await claudeCodeAdapter.detect([dir]);
      const candidate = candidates.find((c) =>
        c.runRef.endsWith(`${SESSION}.jsonl`),
      );
      if (!candidate) throw new Error('synthetic session not detected');
      // awaited inside the try: the finally below deletes the transcript
      return await claudeCodeAdapter.parse(candidate, { redact });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const span = (run: RawRun, id: string) => run.spans.find((s) => s.id === id);

  it('resolves a compound command and stores none of its text (spec scenario)', async () => {
    const run = await parseSession(false);
    const compound = span(run, 'tu_compound');
    expect(usageOf(compound)).toEqual({
      [TOOL_ATTR.activity]: 'test',
      [TOOL_ATTR.tool]: 'vitest',
      [TOOL_ATTR.sub]: 'run',
      [TOOL_ATTR.via]: 'pnpm exec',
    });
    const serialized = JSON.stringify(compound);
    expect(serialized).not.toContain('apps/web');
    expect(serialized).not.toContain('tail');
  });

  it('lists the also-ran tools (spec scenario)', async () => {
    const run = await parseSession(true);
    expect(usageOf(span(run, 'tu_also'))).toEqual({
      [TOOL_ATTR.activity]: 'build',
      [TOOL_ATTR.tool]: 'pnpm',
      [TOOL_ATTR.sub]: 'run',
      [TOOL_ATTR.also]: ['git'],
    });
  });

  it('keeps closed-vocabulary identity byte-identical under redaction (spec scenario)', async () => {
    const open = await parseSession(false);
    const redacted = await parseSession(true);
    for (const o of open.spans) {
      const r = span(redacted, o.id);
      for (const key of CLOSED_TOOL_ATTRS) {
        expect(JSON.stringify(r?.attributes[key]), `${o.id} ${key}`).toBe(
          JSON.stringify(o.attributes[key]),
        );
      }
      for (const key of FREE_TOOL_ATTRS) {
        expect(key in (r?.attributes ?? {}), `${o.id} ${key}`).toBe(false);
      }
    }
    expect(span(open, 'tu_also')?.attributes[TOOL_ATTR.script]).toBe('build');
    expect(span(open, 'tu_unknown')?.attributes[TOOL_ATTR.name]).toBe(
      'acme-deploy',
    );
  });

  it('stamps the activity alone on an unresolved command under redaction (spec scenario)', async () => {
    const run = await parseSession(true);
    expect(usageOf(span(run, 'tu_unknown'))).toEqual({
      [TOOL_ATTR.activity]: 'other',
    });
  });

  it('classifies PowerShell with its own dialect', async () => {
    const run = await parseSession(true);
    expect(usageOf(span(run, 'tu_ps'))).toEqual({
      [TOOL_ATTR.activity]: 'test',
      [TOOL_ATTR.tool]: 'flutter',
      [TOOL_ATTR.sub]: 'test',
    });
  });

  it('leaves target identity exactly as it was (spec scenario)', async () => {
    for (const redact of [false, true]) {
      const run = await parseSession(redact);
      for (const call of CALLS) {
        const expected = toolTargetAttributes(
          'claude-code',
          call.name,
          call.input,
          redact,
        );
        const got = span(run, call.id)?.attributes ?? {};
        for (const key of [
          'runray.targetKey',
          'runray.targetKind',
          'runray.target',
        ]) {
          expect(got[key], `${call.id} ${key}`).toBe(expected[key]);
        }
      }
    }
  });

  it('flags a background command (spec scenario)', async () => {
    const run = await parseSession(true);
    expect(span(run, 'tu_bg')?.attributes[TOOL_ATTR.flags]).toEqual([
      'background',
    ]);
    expect(span(run, 'tu_bg')?.attributes[TOOL_ATTR.sub]).toBe('compose up');
  });

  it('flags a timed-out, interrupted command in the fixed order (spec scenario)', async () => {
    const run = await parseSession(true);
    expect(span(run, 'tu_timeout')?.attributes[TOOL_ATTR.flags]).toEqual([
      'timeout',
      'interrupted',
    ]);
  });

  it('adds no flags key to an ordinary command (spec scenario)', async () => {
    const run = await parseSession(false);
    expect(TOOL_ATTR.flags in (span(run, 'tu_plain')?.attributes ?? {})).toBe(
      false,
    );
    expect(span(run, 'tu_plain')?.attributes[TOOL_ATTR.tool]).toBe('ls');
  });

  it('classifies a call that has no result yet', async () => {
    const run = await parseSession(true);
    const pending = span(run, 'tu_pending');
    expect(pending?.status).toBe('in_progress');
    expect(pending?.attributes[TOOL_ATTR.tool]).toBe('cargo');
    expect(pending?.attributes[TOOL_ATTR.activity]).toBe('build');
  });

  it('names the invoked skill only without redaction (spec scenarios)', async () => {
    const open = await parseSession(false);
    const redacted = await parseSession(true);
    expect(span(open, 'tu_skill')?.attributes[TOOL_ATTR.skill]).toBe(
      'frontend-design',
    );
    expect(
      TOOL_ATTR.skill in (span(redacted, 'tu_skill')?.attributes ?? {}),
    ).toBe(false);
    expect(span(redacted, 'tu_skill')?.name).toBe('Skill');
  });

  it('adds nothing to tools that are neither shells nor skills', async () => {
    const run = await parseSession(false);
    expect(usageOf(span(run, 'tu_read'))).toEqual({});
  });
});

describe('opencode adapter — tool usage capture', () => {
  const SES = 'ses_usage000000000000000000000';
  const MSG = 'msg_usage000000000000000000001';
  const toolPart = (
    id: string,
    tool: string,
    input: Record<string, unknown>,
  ) => ({
    id: `prt_${id}`,
    sessionID: SES,
    messageID: MSG,
    type: 'tool',
    tool,
    state: {
      status: 'completed',
      input,
      output: 'ok',
      time: { start: 1770823773832, end: 1770823773852 },
    },
  });
  const doc = {
    info: {
      id: SES,
      title: 'tool usage probe',
      directory: '/home/user/project',
      time: { created: 1770823768327, updated: 1770824247477 },
    },
    messages: [
      {
        info: {
          id: MSG,
          sessionID: SES,
          role: 'assistant',
          time: { created: 1770823768381, completed: 1770823773890 },
          modelID: 'gpt-5.3-codex',
          providerID: 'openai',
          cost: 0,
          tokens: {
            total: 100,
            input: 90,
            output: 10,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          toolPart('a', 'bash', {
            command: COMPOUND,
            description: 'run tests',
          }),
          toolPart('b', 'bash', { command: ALSO }),
          toolPart('c', 'bash', { command: UNKNOWN }),
          toolPart('d', 'skill', { name: 'docx' }),
          toolPart('e', 'read', { filePath: '/src/a.ts' }),
        ],
      },
    ],
  };
  const tmp = mkdtempSync(join(tmpdir(), 'runray-oc-usage-'));
  writeFileSync(join(tmp, 'probe-export.json'), JSON.stringify(doc));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  async function parse(dir: string, redact: boolean): Promise<RawRun> {
    const candidates = (await opencodeAdapter.detect([dir])).filter(
      (c) => !/[\\/]raw[\\/]/.test(c.runRef),
    );
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error('no opencode candidate');
    return opencodeAdapter.parse(candidate, { redact });
  }
  const part = (run: RawRun, id: string) =>
    run.spans.find((s) => s.id === `prt_${id}`);

  it('stamps the same attributes as Claude Code for the same command (spec scenario)', async () => {
    for (const redact of [false, true]) {
      const run = await parse(tmp, redact);
      for (const [id, command] of [
        ['a', COMPOUND],
        ['b', ALSO],
        ['c', UNKNOWN],
      ] as const) {
        expect(usageOf(part(run, id)), `${id} redact=${redact}`).toEqual(
          toolUsageSpanAttributes('claude-code', 'Bash', { command }, redact),
        );
      }
    }
  });

  it('names the skill from the tool input, only without redaction', async () => {
    expect(
      part(await parse(tmp, false), 'd')?.attributes[TOOL_ATTR.skill],
    ).toBe('docx');
    expect(
      TOOL_ATTR.skill in (part(await parse(tmp, true), 'd')?.attributes ?? {}),
    ).toBe(false);
  });

  it('keeps target identity and adds nothing to other tools', async () => {
    const run = await parse(tmp, false);
    expect(usageOf(part(run, 'e'))).toEqual({});
    expect(part(run, 'e')?.attributes['runray.targetKind']).toBe('file-read');
    expect(part(run, 'a')?.attributes['runray.targetKind']).toBe('command');
  });

  it('classifies bash spans identically across the three storage eras', async () => {
    const fixtures = fileURLToPath(
      new URL('../../../../fixtures/opencode', import.meta.url),
    );
    const byEra: Array<Array<Record<string, unknown>>> = [];
    for (const dir of [
      join(fixtures, 'storage'),
      join(fixtures, 'sqlite', 'simple'),
      join(fixtures, 'export-json'),
    ]) {
      const run = await parse(dir, true);
      const bash = run.spans
        .filter((s) => s.name === 'bash')
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      expect(bash.length, dir).toBeGreaterThan(0);
      for (const s of bash) {
        expect(
          s.attributes[TOOL_ATTR.activity],
          `${dir} ${s.id}`,
        ).toBeDefined();
      }
      byEra.push(bash.map((s) => usageOf(s)));
    }
    expect(byEra[1]).toEqual(byEra[0]);
    expect(byEra[2]).toEqual(byEra[0]);
  });
});

describe('otlp adapter — reserved tool-usage keys', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'runray-otlp-usage-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const text = (key: string, value: string) => ({
    key,
    value: { stringValue: value },
  });
  const list = (key: string, values: string[]) => ({
    key,
    value: { arrayValue: { values: values.map((v) => ({ stringValue: v })) } },
  });
  const toolSpan = (spanId: string, attributes: unknown[]) => ({
    traceId: 'd'.repeat(32),
    spanId,
    name: 'claude_code.tool',
    startTimeUnixNano: '1783425685375000000',
    attributes: [
      text('session.id', 'ses-usage'),
      text('tool_name', 'Bash'),
      ...attributes,
    ],
  });
  const VALID = 'a'.repeat(16);
  const FORGED = 'b'.repeat(16);
  writeFileSync(
    join(tmp, 'tool-usage.json'),
    JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                toolSpan(VALID, [
                  text(TOOL_ATTR.tool, 'docker'),
                  text(TOOL_ATTR.sub, 'compose up'),
                  text(TOOL_ATTR.activity, 'infra'),
                  text(TOOL_ATTR.via, 'bash -c'),
                  list(TOOL_ATTR.also, ['git']),
                  list(TOOL_ATTR.flags, ['background']),
                  text(TOOL_ATTR.name, 'acme-deploy'),
                  text(TOOL_ATTR.script, 'build:acme'),
                  text(TOOL_ATTR.skill, 'acme-runbook'),
                ]),
                toolSpan(FORGED, [
                  text(TOOL_ATTR.tool, '/Users/alex/bin/deploy'),
                  text(TOOL_ATTR.sub, 'push origin feature/top-secret'),
                  text(TOOL_ATTR.activity, 'exfiltrate'),
                  text(TOOL_ATTR.via, '/Users/alex/wrapper.sh'),
                  list(TOOL_ATTR.also, ['git', '/Users/alex/.ssh/id_rsa']),
                  list(TOOL_ATTR.flags, ['background', 'C:\\Users\\alex']),
                ]),
              ],
            },
          ],
        },
      ],
    }),
  );

  async function parse(redact: boolean) {
    const candidate = (await otlpAdapter.detect([tmp])).find((c) =>
      c.runRef.includes('tool-usage'),
    );
    if (candidate === undefined) throw new Error('no otlp candidate');
    const run = await otlpAdapter.parse(candidate, { redact });
    const byId = (id: string) => run.spans.find((s) => s.id === id);
    return { valid: byId(VALID), forged: byId(FORGED) };
  }

  it('passes valid closed-vocabulary values through in both modes (spec scenario)', async () => {
    for (const redact of [false, true]) {
      const { valid } = await parse(redact);
      expect(valid?.attributes).toMatchObject({
        [TOOL_ATTR.tool]: 'docker',
        [TOOL_ATTR.sub]: 'compose up',
        [TOOL_ATTR.activity]: 'infra',
        [TOOL_ATTR.via]: 'bash -c',
        [TOOL_ATTR.also]: ['git'],
        [TOOL_ATTR.flags]: ['background'],
      });
    }
  });

  it('drops a value outside its vocabulary in both modes (spec scenario)', async () => {
    for (const redact of [false, true]) {
      const { forged } = await parse(redact);
      expect(usageOf(forged), `redact=${redact}`).toEqual({});
      expect(JSON.stringify(forged?.attributes)).not.toContain('alex');
    }
  });

  it('drops free-form keys under redaction only (spec scenario)', async () => {
    const open = (await parse(false)).valid;
    expect(open?.attributes[TOOL_ATTR.name]).toBe('acme-deploy');
    expect(open?.attributes[TOOL_ATTR.script]).toBe('build:acme');
    expect(open?.attributes[TOOL_ATTR.skill]).toBe('acme-runbook');
    const redacted = (await parse(true)).valid;
    for (const key of FREE_TOOL_ATTRS) {
      expect(key in (redacted?.attributes ?? {}), key).toBe(false);
    }
  });
});
