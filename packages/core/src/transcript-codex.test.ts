import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import type { RawRun, RawSpan } from './adapter.js';
import { codexAdapter } from './adapters/codex.js';
import { readTranscriptSlice, type TranscriptSlice } from './transcript.js';

/**
 * Transcript slices for Codex spans (add-codex-adapter 5.4, cli spec
 * "Transcript slices for Codex spans"). The scenarios run on the scrubbed
 * fixtures through the adapter, so a slice is asked for exactly as the
 * server asks: by a span's own provenance. What each record type shows is
 * tested on rollouts written here, where the text is known.
 */

const fixtures = fileURLToPath(
  new URL('../../../fixtures/codex', import.meta.url),
);
const SIMPLE = join(
  fixtures,
  'simple',
  'rollout-2026-09-17T19-11-16-01a0b059-e3b9-7a20-87cc-da1f5e28e984.jsonl',
);

const tmp = mkdtempSync(join(tmpdir(), 'runray-codex-slice-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The committed variant folders: `large` is a machine-local perf fixture. */
const committedVariants = (): string[] =>
  readdirSync(fixtures, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'large')
    .map((entry) => join(fixtures, entry.name));

async function parseAll(...roots: string[]): Promise<RawRun[]> {
  const runs: RawRun[] = [];
  for (const candidate of await codexAdapter.detect(roots))
    runs.push(await codexAdapter.parse(candidate, { redact: false }));
  return runs;
}

const sliceOf = (span: RawSpan, redact = false): Promise<TranscriptSlice> =>
  readTranscriptSlice(span.provenance, 'codex', { redact });

function okSegments(slice: TranscriptSlice) {
  if (slice.status !== 'ok')
    throw new Error(`expected an ok slice, got ${JSON.stringify(slice)}`);
  return slice.segments;
}

const labels = (slice: TranscriptSlice) =>
  okSegments(slice).map((segment) => segment.label);

describe('transcript slices of Codex spans, on the fixtures', () => {
  it('gives a command span its command and its output', async () => {
    const [run] = await parseAll(join(fixtures, 'tool-errors'));
    const command = run?.spans.find((s) => s.tool?.name === 'exec_command');
    if (command === undefined) throw new Error('fixture has no command span');

    const slice = await sliceOf(command);
    expect(labels(slice)).toEqual(['command', 'output']);
    const [asked, came] = okSegments(slice);
    expect(asked?.text.length).toBeGreaterThan(0);
    expect(came?.text.length).toBeGreaterThan(0);
    expect(slice.status === 'ok' && slice.truncated).toBe(false);
  });

  it('gives a command of the era before actions its call and what came back', async () => {
    const runs = await parseAll(join(fixtures, 'legacy'));
    const shell = runs
      .flatMap((run) => run.spans)
      .find((s) => s.tool?.name === 'shell' && s.status === 'ok');
    if (shell === undefined) throw new Error('fixture has no shell call');
    expect(labels(await sliceOf(shell))).toEqual([
      'tool call shell',
      'tool output',
    ]);
  });

  it('serves every kind of span of every fixture, each segment labelled and none empty', async () => {
    const seen = new Set<string>();
    for (const run of await parseAll(...committedVariants())) {
      // one span of each kind and name per run: every shape, a short test
      const perRun = new Set<string>();
      for (const span of run.spans) {
        const shape = `${span.kind} ${span.tool?.name ?? span.kind}`;
        if (perRun.has(shape)) continue;
        perRun.add(shape);
        seen.add(span.kind);
        const slice = await sliceOf(span);
        expect(slice.status, shape).toBe('ok');
        for (const segment of okSegments(slice)) {
          expect(segment.label.trim(), shape).not.toBe('');
          expect(segment.text.trim(), shape).not.toBe('');
        }
      }
    }
    expect([...seen].sort()).toEqual([
      'llm_call',
      'mcp_call',
      'session',
      'subagent',
      'tool_call',
      'turn',
    ]);
  });

  it('gives a turn what the person wrote, and a model call what the model wrote or did', async () => {
    const [run] = await parseAll(join(fixtures, 'simple'));
    const turn = run?.spans.find((s) => s.kind === 'turn');
    const calls = run?.spans.filter((s) => s.kind === 'llm_call') ?? [];
    if (turn === undefined) throw new Error('fixture has no turn');
    expect(labels(await sliceOf(turn))).toEqual(['user']);
    const said = new Set<string>();
    for (const call of calls)
      said.add(labels(await sliceOf(call))[0]?.split(' ')[0] ?? '');
    expect([...said].sort()).toEqual(['assistant', 'tool']);
  });

  it('reads a compressed rollout into the segments the plain file gives', async () => {
    const [plain] = await parseAll(join(fixtures, 'simple'));
    const [packed] = await parseAll(join(fixtures, 'zstd'));
    if (plain === undefined || packed === undefined)
      throw new Error('fixtures simple and zstd must both parse');
    expect(packed.spans.length).toBe(plain.spans.length);
    expect(packed.spans[0]?.provenance.file).toMatch(/\.jsonl\.zst$/);
    for (const [i, span] of plain.spans.entries()) {
      const twin = packed.spans[i];
      if (twin === undefined) throw new Error('unreachable');
      expect(await sliceOf(twin), span.id).toEqual(await sliceOf(span));
    }
  });

  it('says so when the rollout was compressed after the run was built', async () => {
    const plain = join(
      tmp,
      'rollout-2026-09-17T19-11-16-compressed-since.jsonl',
    );
    copyFileSync(SIMPLE, plain);
    const [run] = await parseAll(tmp);
    const span = run?.spans.find((s) => s.kind === 'llm_call');
    if (span === undefined) throw new Error('unreachable');
    expect((await sliceOf(span)).status).toBe('ok');

    writeFileSync(`${plain}.zst`, zstdCompressSync(readFileSync(plain)));
    unlinkSync(plain);
    const compressed = await sliceOf(span);
    expect(compressed).toEqual({
      status: 'unavailable',
      reason:
        'the rollout was compressed after this view was built; rebuild the view to read it',
    });

    // gone altogether: the code, never the path
    unlinkSync(`${plain}.zst`);
    expect(await sliceOf(span)).toEqual({
      status: 'unavailable',
      reason: 'source log unavailable: ENOENT',
    });
  });

  it('refuses under redaction without opening the file', async () => {
    const [run] = await parseAll(join(fixtures, 'simple'));
    for (const span of run?.spans ?? [])
      expect(await sliceOf(span, true)).toEqual({ status: 'redacted' });
    // a file that is not there would be `unavailable` had it been opened
    const nowhere = { file: join(tmp, 'rollout-nowhere.jsonl.zst'), line: 1 };
    expect(
      await readTranscriptSlice(nowhere, 'codex', { redact: true }),
    ).toEqual({ status: 'redacted' });
    expect(
      (await readTranscriptSlice(nowhere, 'codex', { redact: false })).status,
    ).toBe('unavailable');
  });
});

// --- what each record type shows -------------------------------------------

type Json = Record<string, unknown>;

let written = 0;
/** Writes the records as a rollout, one per line, and returns a reader of
 * the slice behind a line (1-based, as provenance counts). */
function rolloutOf(records: Array<Json | string>, zst = false) {
  const text = `${records
    .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
    .join('\n')}\n`;
  const file = join(
    tmp,
    `rollout-inline-${written++}.jsonl${zst ? '.zst' : ''}`,
  );
  writeFileSync(file, zst ? zstdCompressSync(Buffer.from(text, 'utf8')) : text);
  return (line?: number) =>
    readTranscriptSlice(
      { file, ...(line === undefined ? {} : { line }) },
      'codex',
      { redact: false },
    );
}

const event = (payload: Json): Json => ({ type: 'event_msg', payload });
const item = (payload: Json): Json => ({ type: 'response_item', payload });
const message = (role: string, ...parts: Json[]): Json =>
  item({ type: 'message', role, content: parts });
const inputText = (text: string): Json => ({ type: 'input_text', text });
const completed = (action: Json): Json =>
  event({ type: 'item_completed', turn_id: 'turn-1', item: action });
const textOf = async (slice: Promise<TranscriptSlice>) =>
  JSON.stringify(okSegments(await slice));

const BASE64 = 'iVBORw0KGgoAAAANSUhEUgAA'.repeat(60);

describe('what a Codex record shows', () => {
  it('a session: what it was and its instructions, never whose it was', async () => {
    const slice = rolloutOf([
      {
        type: 'session_meta',
        payload: {
          id: 'thread-1',
          timestamp: '2026-10-13T09:00:00.000Z',
          cwd: '/home/user/project',
          originator: 'codex_cli',
          cli_version: '0.200.0',
          model_provider: 'openai',
          creator_account_id: 'ACCOUNT-SENTINEL',
          creator_user_id: 'USER-SENTINEL',
          git: {
            repository_url: 'https://example.test/REPO-SENTINEL.git',
            commit_hash: 'COMMIT-SENTINEL',
            branch: 'BRANCH-SENTINEL',
          },
          base_instructions: { text: 'You are Codex. INSTRUCTIONS-TEXT' },
        },
      },
    ])(1);
    const segments = okSegments(await slice);
    expect(segments.map((s) => s.label)).toEqual(['session', 'instructions']);
    expect(JSON.parse(segments[0]?.text ?? '')).toEqual({
      id: 'thread-1',
      timestamp: '2026-10-13T09:00:00.000Z',
      cwd: '/home/user/project',
      originator: 'codex_cli',
      cli_version: '0.200.0',
      model_provider: 'openai',
    });
    expect(segments[1]?.text).toBe('You are Codex. INSTRUCTIONS-TEXT');
    expect(JSON.stringify(segments)).not.toMatch(/SENTINEL/);
  });

  it('a turn: the text of the person in its first prompt, the harness blocks left out', async () => {
    const slice = rolloutOf([
      event({ type: 'task_started', turn_id: 'turn-1' }),
      message('developer', inputText('DEVELOPER-TEXT')),
      message(
        'user',
        inputText('<environment_context>ENV-TEXT</environment_context>'),
      ),
      message(
        'user',
        inputText(
          '<in-app-browser-context>TAB</in-app-browser-context>\nfix the build',
        ),
        { type: 'input_image', image_url: `data:image/png;base64,${BASE64}` },
        inputText('and run the tests'),
      ),
      message('user', inputText('a later message of the turn')),
      event({ type: 'task_complete', turn_id: 'turn-1' }),
    ])(1);
    expect(okSegments(await slice)).toEqual([
      { label: 'user', text: 'fix the build\n\nand run the tests' },
    ]);
  });

  it('a turn with no prompt of its own: its record, not the next turn’s prompt', async () => {
    const at = rolloutOf([
      event({ type: 'task_started', turn_id: 'turn-1', started_at: 1 }),
      message('assistant', { type: 'output_text', text: 'compacting' }),
      event({ type: 'task_complete', turn_id: 'turn-1' }),
      event({ type: 'task_started', turn_id: 'turn-2', started_at: 2 }),
      message('user', inputText('NEXT-TURN-PROMPT')),
    ]);
    expect(okSegments(await at(1))).toEqual([
      {
        label: 'turn',
        text: JSON.stringify({ turn_id: 'turn-1', started_at: 1 }, null, 2),
      },
    ]);
    expect(okSegments(await at(4))).toEqual([
      { label: 'user', text: 'NEXT-TURN-PROMPT' },
    ]);
    // a turn still open at the end of the file
    const open = rolloutOf([
      event({ type: 'task_started', turn_id: 'turn-9' }),
    ]);
    expect(labels(await open(1))).toEqual(['turn']);
  });

  it('a call the model made: its arguments and the output with the same call id', async () => {
    const at = rolloutOf([
      item({
        type: 'function_call',
        name: 'shell',
        call_id: 'call-a',
        arguments: '{"command":["bash","-lc","ls"]}',
      }),
      item({
        type: 'function_call',
        name: 'wait',
        call_id: 'call-b',
        arguments: '{}',
      }),
      item({
        type: 'function_call_output',
        call_id: 'call-b',
        output: 'B-OUT',
      }),
      // not an output record, though it names the call
      message('assistant', { type: 'output_text', text: 'see call-a' }),
      item({
        type: 'function_call_output',
        call_id: 'call-a',
        output: '{"output":"A-OUT\\n","metadata":{"exit_code":0}}',
      }),
      item({
        type: 'function_call_output',
        call_id: 'call-a',
        output: 'LATER',
      }),
      item({
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'call-c',
        input: '*** Begin Patch\n*** End Patch',
      }),
      item({
        type: 'custom_tool_call_output',
        call_id: 'call-c',
        output: [
          { type: 'text', text: 'Success. ' },
          { type: 'text', text: 'Updated the file.' },
        ],
      }),
    ]);
    expect(okSegments(await at(1))).toEqual([
      {
        label: 'tool call shell',
        text: JSON.stringify({ command: ['bash', '-lc', 'ls'] }, null, 2),
      },
      { label: 'tool output', text: 'A-OUT\n' },
    ]);
    expect(okSegments(await at(2))).toEqual([
      { label: 'tool call wait', text: '{}' },
      { label: 'tool output', text: 'B-OUT' },
    ]);
    expect(okSegments(await at(7))).toEqual([
      {
        label: 'tool call apply_patch',
        text: '*** Begin Patch\n*** End Patch',
      },
      { label: 'tool output', text: 'Success. Updated the file.' },
    ]);
  });

  it('a call still unanswered, a hosted call, an output that is an image', async () => {
    const at = rolloutOf([
      item({
        type: 'function_call',
        name: 'exec',
        call_id: 'call-open',
        arguments: 'not json',
      }),
      item({
        type: 'web_search_call',
        action: { query: 'QUERY-TEXT' },
        status: 'completed',
      }),
      item({
        type: 'function_call',
        name: 'view_image',
        call_id: 'call-img',
        arguments: '{}',
      }),
      item({
        type: 'function_call_output',
        call_id: 'call-img',
        output: [
          { type: 'input_image', image_url: `data:image/png;base64,${BASE64}` },
        ],
      }),
    ]);
    expect(okSegments(await at(1))).toEqual([
      { label: 'tool call exec', text: 'not json' },
    ]);
    expect(okSegments(await at(2))).toEqual([
      {
        label: 'tool call web_search',
        text: JSON.stringify({ action: { query: 'QUERY-TEXT' } }, null, 2),
      },
    ]);
    expect(okSegments(await at(3))).toEqual([
      { label: 'tool call view_image', text: '{}' },
      { label: 'tool output', text: '(not text)' },
    ]);
  });

  it('a message: its text under its role, an image named and not shown', async () => {
    const at = rolloutOf([
      message(
        'assistant',
        { type: 'output_text', text: 'ANSWER-ONE' },
        { type: 'output_text', text: 'ANSWER-TWO' },
      ),
      message('user', inputText('LOOK'), {
        type: 'input_image',
        image_url: `data:image/png;base64,${BASE64}`,
      }),
      item({ type: 'reasoning', summary: [], encrypted_content: BASE64 }),
      item({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'THOUGHT' }],
      }),
    ]);
    expect(okSegments(await at(1))).toEqual([
      { label: 'assistant', text: 'ANSWER-ONE' },
      { label: 'assistant', text: 'ANSWER-TWO' },
    ]);
    expect(okSegments(await at(2))).toEqual([
      { label: 'user', text: 'LOOK' },
      { label: 'user input_image', text: '(not text)' },
    ]);
    expect(await textOf(at(2))).not.toContain('iVBOR');
    expect(okSegments(await at(3))).toEqual([
      { label: 'reasoning', text: '(stored encrypted, not readable)' },
    ]);
    expect(okSegments(await at(4))).toEqual([
      { label: 'reasoning', text: 'THOUGHT' },
    ]);
  });

  it('a usage record: the counts, not the account’s rate limits', async () => {
    const at = rolloutOf([
      {
        type: 'token_usage_record',
        payload: {
          response_id: 'resp-1',
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      },
      event({
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 7 },
          total_token_usage: { input_tokens: 70 },
        },
        rate_limits: { plan_type: 'PLAN-SENTINEL' },
      }),
    ]);
    expect(okSegments(await at(1))).toEqual([
      {
        label: 'usage',
        text: JSON.stringify({ input_tokens: 10, output_tokens: 2 }, null, 2),
      },
    ]);
    expect(okSegments(await at(2))).toEqual([
      { label: 'usage', text: JSON.stringify({ input_tokens: 7 }, null, 2) },
    ]);
  });

  it('an action: a command, a file change, an MCP call, an image, an extension', async () => {
    const at = rolloutOf([
      completed({
        type: 'CommandExecution',
        id: 'item-1',
        command: ['pwsh', '-Command', 'pnpm test'],
        aggregated_output: 'ALL-OF-IT',
        formatted_output: 'WHAT-THE-MODEL-SAW',
        exit_code: 1,
        status: 'failed',
      }),
      completed({
        type: 'CommandExecution',
        command: 'true',
        aggregated_output: '',
      }),
      completed({
        type: 'FileChange',
        status: 'completed',
        stdout: 'Success.\n',
        stderr: '',
        changes: {
          '/home/user/project/a.ts': {
            type: 'update',
            unified_diff: '@@ -1 +1 @@\n-a\n+b',
          },
          '/home/user/project/new.ts': { type: 'add', content: 'export {};\n' },
          '/home/user/project/gone.ts': { type: 'delete', content: '' },
        },
      }),
      completed({
        type: 'McpToolCall',
        server: 'github',
        tool: 'search',
        arguments: { q: 'QUERY' },
        result: {
          content: [
            { type: 'text', text: 'FOUND-ONE ' },
            { type: 'image', data: BASE64 },
            { type: 'text', text: 'FOUND-TWO' },
          ],
        },
      }),
      completed({
        type: 'McpToolCall',
        server: 'github',
        tool: 'fetch',
        arguments: {},
        status: 'failed',
        error: { message: 'MCP-FAILURE' },
      }),
      completed({ type: 'ImageView', path: '/home/user/project/shot.png' }),
      completed({
        type: 'Extension',
        kind: 'image_gen.generation',
        status: 'completed',
        revisedPrompt: 'a red square',
        savedPath: '/home/user/project/out.png',
        result: BASE64,
      }),
      completed({
        type: 'Extension',
        kind: 'web.search',
        query: 'QUERY',
        results: [{ title: 'TITLE', url: 'https://example.test/' }],
      }),
      completed({ type: 'Extension', kind: 'clock.sleep', durationMs: 5000 }),
    ]);
    expect(okSegments(await at(1))).toEqual([
      { label: 'command', text: 'pwsh -Command "pnpm test"' },
      { label: 'output', text: 'ALL-OF-IT' },
    ]);
    expect(okSegments(await at(2))).toEqual([
      { label: 'command', text: 'true' },
      { label: 'output', text: '(empty)' },
    ]);
    expect(okSegments(await at(3))).toEqual([
      { label: 'change /home/user/project/a.ts', text: '@@ -1 +1 @@\n-a\n+b' },
      { label: 'change /home/user/project/new.ts', text: 'export {};\n' },
      { label: 'change /home/user/project/gone.ts', text: '(empty)' },
      { label: 'output', text: 'Success.\n' },
    ]);
    expect(okSegments(await at(4))).toEqual([
      {
        label: 'tool call github.search',
        text: JSON.stringify({ q: 'QUERY' }, null, 2),
      },
      { label: 'tool output', text: 'FOUND-ONE FOUND-TWO' },
    ]);
    expect(okSegments(await at(5))).toEqual([
      { label: 'tool call github.fetch', text: '{}' },
      { label: 'tool output', text: 'MCP-FAILURE' },
    ]);
    expect(okSegments(await at(6))).toEqual([
      { label: 'image', text: '/home/user/project/shot.png' },
    ]);
    expect(okSegments(await at(7))).toEqual([
      {
        label: 'tool call image_gen.generation',
        text: JSON.stringify(
          {
            revisedPrompt: 'a red square',
            savedPath: '/home/user/project/out.png',
          },
          null,
          2,
        ),
      },
      { label: 'tool output', text: '(not text)' },
    ]);
    expect(okSegments(await at(8))).toEqual([
      {
        label: 'tool call web.search',
        text: JSON.stringify({ query: 'QUERY' }, null, 2),
      },
      {
        label: 'tool output',
        text: JSON.stringify(
          [{ title: 'TITLE', url: 'https://example.test/' }],
          null,
          2,
        ),
      },
    ]);
    expect(okSegments(await at(9))).toEqual([
      {
        label: 'tool call clock.sleep',
        text: JSON.stringify({ durationMs: 5000 }, null, 2),
      },
    ]);
  });

  it('shows an argv as a line that reads back into the same arguments', async () => {
    const at = rolloutOf([
      completed({
        type: 'CommandExecution',
        command: ['bash', '-lc', 'cd api && cargo test'],
      }),
      completed({
        type: 'CommandExecution',
        command: ['git', 'commit', '-m', 'say "hi"', '', 'C:\\repo\\a b'],
      }),
      completed({ type: 'CommandExecution', command: 'ls -la | wc -l' }),
    ]);
    // joined bare it would read as `bash -lc cd` and then a second command
    expect(okSegments(await at(1))[0]?.text).toBe(
      'bash -lc "cd api && cargo test"',
    );
    expect(okSegments(await at(2))[0]?.text).toBe(
      'git commit -m "say \\"hi\\"" "" "C:\\repo\\a b"',
    );
    // a command recorded as one string is shown as recorded
    expect(okSegments(await at(3))[0]?.text).toBe('ls -la | wc -l');
  });

  it('unwraps the legacy shell output only, and shows any other JSON whole', async () => {
    const failed = '{"output":"","error":"connection refused"}';
    const at = rolloutOf([
      item({
        type: 'function_call',
        name: 'shell',
        call_id: 'c1',
        arguments: '{}',
      }),
      item({
        type: 'function_call_output',
        call_id: 'c1',
        output: '{"output":"ok\\n","metadata":{"exit_code":0}}',
      }),
      item({
        type: 'function_call',
        name: 'exec',
        call_id: 'c2',
        arguments: '{}',
      }),
      item({ type: 'function_call_output', call_id: 'c2', output: failed }),
    ]);
    expect(okSegments(await at(1))[1]).toEqual({
      label: 'tool output',
      text: 'ok\n',
    });
    // the error next to an empty `output` is what the reader came for
    expect(okSegments(await at(3))[1]).toEqual({
      label: 'tool output',
      text: failed,
    });
  });

  it('does not end a turn at the late completion of an earlier one', async () => {
    const at = rolloutOf([
      event({ type: 'task_started', turn_id: 'turn-2' }),
      event({ type: 'task_complete', turn_id: 'turn-1' }),
      event({ type: 'turn_aborted', turn_id: 'turn-0' }),
      message('user', inputText('the prompt of turn two')),
      event({ type: 'task_complete', turn_id: 'turn-2' }),
    ]);
    expect(okSegments(await at(1))).toEqual([
      { label: 'user', text: 'the prompt of turn two' },
    ]);
    // a completion that names no turn is taken as this turn's
    const unnamed = rolloutOf([
      event({ type: 'task_started', turn_id: 'turn-2' }),
      event({ type: 'task_complete' }),
      message('user', inputText('NOT-THIS-TURN')),
    ]);
    expect(labels(await unnamed(1))).toEqual(['turn']);
  });

  it('names binary data inside a JSON segment and base64 wrapped across lines', async () => {
    const wrapped = Array.from({ length: 12 }, () => BASE64.slice(0, 76)).join(
      '\n',
    );
    const names = Array.from({ length: 80 }, (_, i) => `module_${i}`).join(
      '\n',
    );
    const at = rolloutOf([
      completed({
        type: 'McpToolCall',
        server: 'files',
        tool: 'upload',
        arguments: { name: 'shot.png', data: BASE64, note: 'a screenshot' },
        result: { content: [{ type: 'text', text: 'stored' }] },
      }),
      completed({
        type: 'Extension',
        kind: 'image_gen.generation',
        savedPath: '/home/user/project/out.png',
        image: { b64_json: `data:image/png;base64,${BASE64}` },
      }),
      completed({
        type: 'CommandExecution',
        command: 'base64 shot.png',
        aggregated_output: `${wrapped}\niVBORw0=\n`,
      }),
      completed({
        type: 'CommandExecution',
        command: 'ls src',
        aggregated_output: names,
      }),
    ]);
    expect(okSegments(await at(1))[0]).toEqual({
      label: 'tool call files.upload',
      text: JSON.stringify(
        { name: 'shot.png', data: '(not text)', note: 'a screenshot' },
        null,
        2,
      ),
    });
    expect(await textOf(at(2))).not.toContain('iVBOR');
    expect(await textOf(at(2))).toContain('out.png');
    expect(okSegments(await at(3))[1]).toEqual({
      label: 'output',
      text: '(not text)',
    });
    // lines of names are text, however many and however free of spaces
    expect(okSegments(await at(4))[1]?.text).toBe(names);
  });

  it('is unavailable, with the reason, for a line it cannot serve', async () => {
    const at = rolloutOf([
      {
        type: 'turn_context',
        payload: { model: 'gpt-6-astra', cwd: '/home/user/project' },
      },
      '{"type":"response_item","payload":',
      { type: 'world_state' },
      '[1, 2, 3]',
    ]);
    const reasonAt = async (line?: number) => {
      const slice = await at(line);
      return slice.status === 'unavailable' ? slice.reason : slice.status;
    };
    expect(await reasonAt(1)).toBe(
      'line 1 is not a record a span is read from',
    );
    expect(await reasonAt(2)).toBe('line 2 is not valid JSON');
    expect(await reasonAt(3)).toBe(
      'line 3 is not a record a span is read from',
    );
    expect(await reasonAt(4)).toBe('line 4 is not valid JSON');
    expect(await reasonAt(5)).toBe('line 5 is beyond the end of the file');
    expect(await reasonAt()).toBe('provenance carries no line number');
  });

  it('caps a long output at the size every source is held to', async () => {
    const at = rolloutOf(
      [
        completed({
          type: 'CommandExecution',
          command: 'cat big.log',
          aggregated_output: 'line of a log\n'.repeat(120_000),
        }),
      ],
      true,
    );
    const slice = await at(1);
    expect(slice.status === 'ok' && slice.truncated).toBe(true);
    const size = okSegments(slice).reduce((sum, s) => sum + s.text.length, 0);
    expect(size).toBe(1024 * 1024);
  });
});
