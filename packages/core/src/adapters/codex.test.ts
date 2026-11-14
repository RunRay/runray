import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { RunSchema } from '@runray/schema';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type Candidate, NoSessionYet, type RawRun } from '../adapter.js';
import { normalize } from '../normalize.js';
import { priceRun } from '../pricing/index.js';
import { codexAdapter } from './codex.js';

/**
 * Codex adapter tests (change `add-codex-adapter`). Discovery runs against
 * the scrubbed fixtures and against rollouts written inline into temp
 * directories: a first record is all discovery reads, so a thread is one
 * line here. Parsing runs against the same fixtures and against rollouts
 * built record by record, one behaviour each.
 */

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const fixtures = join(repoRoot, 'fixtures', 'codex');

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'runray-codex-'));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const ROOT = '0199f3a0-0000-7000-8000-000000000001';
const CHILD = '0199f3a0-0000-7000-8000-000000000002';
const GRANDCHILD = '0199f3a0-0000-7000-8000-000000000003';
const OTHER = '0199f3a0-0000-7000-8000-000000000004';
const ABSENT = '0199f3a0-0000-7000-8000-00000000ffff';

/** The first record of a thread, as one JSONL line. */
function meta(id: string, parent?: string): string {
  return `${JSON.stringify({
    timestamp: '2026-10-13T09:00:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      id,
      ...(parent === undefined ? {} : { parent_thread_id: parent }),
      cwd: '/home/user/project',
    },
  })}\n`;
}

/** Writes a rollout the way Codex names it and returns its path. */
function rollout(
  dir: string,
  id: string,
  opts: { parent?: string; time?: string; zst?: boolean; text?: string } = {},
): string {
  mkdirSync(dir, { recursive: true });
  const time = opts.time ?? '2026-10-13T09-00-00';
  const file = join(
    dir,
    `rollout-${time}-${id}.jsonl${opts.zst ? '.zst' : ''}`,
  );
  const text = opts.text ?? meta(id, opts.parent);
  writeFileSync(
    file,
    opts.zst ? zstdCompressSync(Buffer.from(text, 'utf8')) : text,
  );
  return file;
}

const detect = (...roots: string[]): Promise<Candidate[]> =>
  codexAdapter.detect(roots);
const names = (files: string[]) => files.map((f) => basename(f));

describe('codex default roots', () => {
  const saved = process.env.CODEX_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  });

  it('is the sessions directory of ~/.codex, not the Codex home', () => {
    delete process.env.CODEX_HOME;
    expect(codexAdapter.defaultRoots()).toEqual([
      join(homedir(), '.codex', 'sessions'),
    ]);
  });

  it('moves with CODEX_HOME', () => {
    const home = tempDir();
    process.env.CODEX_HOME = home;
    expect(codexAdapter.defaultRoots()).toEqual([join(home, 'sessions')]);
  });

  it('treats an empty CODEX_HOME as unset', () => {
    process.env.CODEX_HOME = '';
    expect(codexAdapter.defaultRoots()).toEqual([
      join(homedir(), '.codex', 'sessions'),
    ]);
  });

  it('discovers with no path: one candidate per root thread, in dated folders', async () => {
    const home = tempDir();
    const day = join(home, 'sessions', '2026', '10', '13');
    const a = rollout(day, ROOT);
    const b = rollout(day, OTHER, { time: '2026-10-13T10-00-00' });
    process.env.CODEX_HOME = home;

    const candidates = await detect();
    expect(candidates.map((c) => c.runRef)).toEqual([a, b]);
    for (const c of candidates) {
      expect(c.format).toBe('codex-jsonl');
      expect(c.files).toEqual([c.runRef]);
    }
  });

  it('finds nothing, without failing, when the sessions directory is absent', async () => {
    process.env.CODEX_HOME = join(tempDir(), 'no-such-home');
    expect(await detect()).toEqual([]);
  });
});

describe('codex detect', () => {
  it('opens rollouts only: databases and other files in a scanned folder are not candidates', async () => {
    const home = tempDir();
    const day = join(home, 'sessions', '2026', '10', '13');
    const file = rollout(day, ROOT);
    // next to sessions/, as in a real Codex home
    writeFileSync(join(home, 'state_5.sqlite'), 'not a database');
    writeFileSync(join(home, 'thread_history_2.sqlite'), 'not a database');
    writeFileSync(join(home, 'session_index.jsonl'), meta(OTHER));
    // next to the rollout
    writeFileSync(join(day, 'notes.jsonl'), meta(OTHER));
    writeFileSync(join(day, 'rollout-notes.txt'), meta(OTHER));
    writeFileSync(join(day, 'my-rollout-1.jsonl'), meta(OTHER));

    const candidates = await detect(home);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.runRef).toBe(file);
    expect(candidates[0]?.files).toEqual([file]);
  });

  it('yields one candidate for a thread stored in both forms, read from the plain file', async () => {
    const dir = tempDir();
    const packed = rollout(dir, ROOT, { zst: true });
    const plain = rollout(dir, ROOT);

    const candidates = await detect(dir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.runRef).toBe(plain);
    expect(candidates[0]?.files).toEqual([plain]);
    expect(candidates[0]?.sizeBytes).toBe(statSync(plain).size);
    expect(candidates[0]?.files).not.toContain(packed);
  });

  it('takes the thread id from the record, not from the file name', async () => {
    const dir = tempDir();
    // two names, one thread: still one candidate
    const first = rollout(dir, ROOT, { time: '2026-10-13T09-00-00' });
    mkdirSync(join(dir, 'zz-copy'));
    writeFileSync(join(dir, 'zz-copy', 'rollout-renamed.jsonl'), meta(ROOT));
    // one name pattern, a different thread inside: a second candidate
    const other = join(dir, `rollout-2026-10-13T11-00-00-${ROOT}.jsonl`);
    writeFileSync(other, meta(OTHER));

    const candidates = await detect(dir);
    expect(candidates.map((c) => c.runRef)).toEqual([first, other].sort());
  });

  it('reads the first record of a compressed rollout', async () => {
    const dir = tempDir();
    const root = rollout(dir, ROOT, { zst: true });
    const child = rollout(dir, CHILD, {
      parent: ROOT,
      zst: true,
      time: '2026-10-13T09-05-00',
    });

    const candidates = await detect(dir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.files).toEqual([root, child]);
  });

  it('groups a child, and a child of that child, under their root thread', async () => {
    const dir = tempDir();
    // a later day folder for the grandchild, as Codex would write it
    const root = rollout(join(dir, '2026', '10', '13'), ROOT);
    const child = rollout(join(dir, '2026', '10', '13'), CHILD, {
      parent: ROOT,
      time: '2026-10-13T09-05-00',
    });
    const grandchild = rollout(join(dir, '2026', '10', '14'), GRANDCHILD, {
      parent: CHILD,
      time: '2026-10-14T08-00-00',
    });
    const unrelated = rollout(join(dir, '2026', '10', '14'), OTHER, {
      time: '2026-10-14T09-00-00',
    });

    const candidates = await detect(dir);
    expect(candidates.map((c) => c.runRef)).toEqual([root, unrelated]);
    expect(candidates[0]?.files).toEqual([root, child, grandchild]);
    expect(candidates[1]?.files).toEqual([unrelated]);
  });

  it('makes a child whose parent was not scanned a candidate of its own, with its own children', async () => {
    const dir = tempDir();
    const orphan = rollout(dir, CHILD, { parent: ABSENT });
    const under = rollout(dir, GRANDCHILD, {
      parent: CHILD,
      time: '2026-10-13T09-30-00',
    });

    const candidates = await detect(dir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.runRef).toBe(orphan);
    expect(candidates[0]?.files).toEqual([orphan, under]);
  });

  it('finds a parent in another scanned root', async () => {
    const a = tempDir();
    const b = tempDir();
    const root = rollout(a, ROOT);
    const child = rollout(b, CHILD, { parent: ROOT });

    expect((await detect(b)).map((c) => c.runRef)).toEqual([child]);
    const both = await detect(b, a);
    expect(both).toHaveLength(1);
    expect(both[0]?.files).toEqual([root, child]);
  });

  it('lists a file once when the roots overlap', async () => {
    const dir = tempDir();
    const file = rollout(join(dir, '2026', '10', '13'), ROOT);
    const candidates = await detect(dir, join(dir, '2026'));
    expect(candidates.map((c) => c.runRef)).toEqual([file]);
  });

  it('takes mtime as the newest and size as the sum over the files of a candidate', async () => {
    const dir = tempDir();
    const root = rollout(dir, ROOT);
    const child = rollout(dir, CHILD, {
      parent: ROOT,
      time: '2026-10-13T09-05-00',
      text: `${meta(CHILD, ROOT)}{"type":"event_msg","payload":{}}\n`,
    });
    utimesSync(root, new Date(1_760_000_000_000), new Date(1_760_000_000_000));
    utimesSync(child, new Date(1_770_000_000_000), new Date(1_770_000_000_000));

    const [candidate] = await detect(dir);
    expect(candidate?.mtimeMs).toBe(1_770_000_000_000);
    expect(candidate?.sizeBytes).toBe(
      statSync(root).size + statSync(child).size,
    );
  });

  it('returns candidates sorted by their root file, the same on every call', async () => {
    const dir = tempDir();
    const late = rollout(join(dir, '2026', '10', '20'), OTHER, {
      time: '2026-10-20T09-00-00',
    });
    const early = rollout(join(dir, '2026', '09', '30'), ROOT, {
      time: '2026-09-30T09-00-00',
    });
    const child = rollout(join(dir, '2026', '10', '01'), CHILD, {
      parent: ROOT,
      time: '2026-10-01T09-00-00',
    });

    const first = await detect(dir);
    expect(first.map((c) => c.runRef)).toEqual([early, late]);
    expect(first[0]?.files).toEqual([early, child]);
    expect(await detect(dir)).toEqual(first);
  });

  it('keeps a file that is not a rollout as a candidate of its own, for parse() to refuse', async () => {
    const dir = tempDir();
    const root = rollout(dir, ROOT);
    const notMeta = rollout(dir, 'x', {
      text: '{"type":"event_msg","payload":{"type":"task_started"}}\n',
    });
    const notJson = rollout(dir, 'y', { text: 'plain text, no records\n' });
    const empty = rollout(dir, 'z', { text: '' });
    const notZstd = join(dir, 'rollout-w.jsonl.zst');
    writeFileSync(notZstd, 'these bytes are not a zstd frame');

    const candidates = await detect(dir);
    expect(candidates.map((c) => c.runRef)).toEqual(
      [root, notMeta, notJson, empty, notZstd].sort(),
    );
    for (const c of candidates) expect(c.files).toEqual([c.runRef]);
  });

  it('steps over a scrub marker, blank lines and a byte-order mark before the first record', async () => {
    const dir = tempDir();
    const marker = '{"type":"x-tracepulse-scrub","marker":"SCRUBBED"}\n';
    const root = rollout(dir, ROOT, { text: `${marker}\n${meta(ROOT)}` });
    const child = rollout(dir, CHILD, {
      parent: ROOT,
      time: '2026-10-13T09-05-00',
      text: `﻿${meta(CHILD, ROOT)}`,
    });

    const candidates = await detect(dir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.files).toEqual([root, child]);
  });

  it('does not loop on threads that name each other as parent', async () => {
    const dir = tempDir();
    const a = rollout(dir, ROOT, { parent: CHILD });
    const b = rollout(dir, CHILD, {
      parent: ROOT,
      time: '2026-10-13T09-05-00',
    });
    const self = rollout(dir, OTHER, {
      parent: OTHER,
      time: '2026-10-13T09-10-00',
    });

    const candidates = await detect(dir);
    expect(candidates.map((c) => c.runRef)).toEqual([a, b, self]);
    for (const c of candidates) expect(c.files).toEqual([c.runRef]);
  });

  it('leaves raw/ and node_modules trees alone', async () => {
    const dir = tempDir();
    const file = rollout(dir, ROOT);
    rollout(join(dir, 'raw'), OTHER);
    rollout(join(dir, 'node_modules', 'pkg'), CHILD);

    expect((await detect(dir)).map((c) => c.runRef)).toEqual([file]);
  });
});

describe('codex detect on the fixtures', () => {
  const inVariant = async (variant: string) =>
    (await detect(join(fixtures, variant))).filter(
      (c) => !c.runRef.includes(`${sep}raw${sep}`),
    );

  it('finds one root thread in simple and the same thread, compressed, in zstd', async () => {
    const [simple] = await inVariant('simple');
    const [packed] = await inVariant('zstd');
    expect(simple?.files).toHaveLength(1);
    expect(packed?.files).toHaveLength(1);
    expect(simple?.runRef.endsWith('.jsonl')).toBe(true);
    expect(packed?.runRef.endsWith('.jsonl.zst')).toBe(true);
    expect(basename(packed?.runRef ?? '')).toBe(
      `${basename(simple?.runRef ?? '')}.zst`,
    );
  });

  it('puts the two reviewer threads of guardian under their root, across day folders', async () => {
    const candidates = await inVariant('guardian');
    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(names(candidate?.files ?? [])).toEqual([
      'rollout-2026-09-30T08-14-23-01a0f0f3-2c66-7151-960c-cf5b962ab51c.jsonl',
      'rollout-2026-09-30T08-18-09-01a0f0f6-9e8a-7852-8a51-f5ffa473ace1.jsonl',
      'rollout-2026-10-01T18-42-01-01a0f858-25e8-7ef0-b201-68a5044e9422.jsonl',
    ]);
    expect(candidate?.runRef).toBe(candidate?.files[0]);
    expect(candidate?.sizeBytes).toBe(
      (candidate?.files ?? []).reduce((sum, f) => sum + statSync(f).size, 0),
    );
    expect(candidate?.mtimeMs).toBe(
      Math.max(...(candidate?.files ?? []).map((f) => statSync(f).mtimeMs)),
    );
  });

  it('takes the reviewer thread of compaction, whose parent is not there, as a candidate', async () => {
    const candidates = await inVariant('compaction');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.files).toEqual([candidates[0]?.runRef]);
  });

  it('finds two root threads each in tool-errors and legacy', async () => {
    for (const variant of ['tool-errors', 'legacy']) {
      const candidates = await inVariant(variant);
      expect(candidates, variant).toHaveLength(2);
      for (const c of candidates) expect(c.files).toEqual([c.runRef]);
    }
  });

  it('over the whole set: seven candidates, simple and zstd counted once, from the plain file', async () => {
    const candidates = (await detect(fixtures)).filter(
      (c) => !c.runRef.includes(`${sep}raw${sep}`),
    );
    expect(candidates).toHaveLength(7);
    expect(candidates.every((c) => c.format === 'codex-jsonl')).toBe(true);
    expect(candidates.filter((c) => c.runRef.endsWith('.zst'))).toEqual([]);
    const sorted = [...candidates].sort((a, b) =>
      a.runRef < b.runRef ? -1 : a.runRef > b.runRef ? 1 : 0,
    );
    expect(candidates).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// parse(): session and turn spans, tolerant reading
// ---------------------------------------------------------------------------

const TURN_A = '0199f3a1-0000-7000-8000-00000000000a';
const TURN_B = '0199f3a1-0000-7000-8000-00000000000b';
const TURN_STRAY = '0199f3a1-0000-7000-8000-00000000dead';

/** Second `sec` of the test session, as Codex writes a record time. */
const at = (sec: number) =>
  new Date(Date.UTC(2026, 9, 13, 9, 0, sec)).toISOString();

/** One record line. The ordinal is the second: unique and increasing here. */
const rec = (sec: number, type: string, payload: unknown) =>
  JSON.stringify({ timestamp: at(sec), ordinal: sec, type, payload });

const sessionMeta = (sec: number, extra: Record<string, unknown> = {}) =>
  rec(sec, 'session_meta', {
    id: ROOT,
    cwd: 'C:\\work\\billing-portal',
    git: {
      branch: 'feat/rounding',
      commit_hash: 'c0ffee0000000000000000000000000000000000',
      repository_url: 'https://git.example/acme/billing-portal.git',
    },
    model_provider: 'openai',
    ...extra,
  });
const started = (sec: number, turn: string) =>
  rec(sec, 'event_msg', { type: 'task_started', turn_id: turn });
const completed = (
  sec: number,
  turn: string,
  extra: Record<string, unknown> = {},
) => rec(sec, 'event_msg', { type: 'task_complete', turn_id: turn, ...extra });
const aborted = (sec: number, turn: string, reason: string) =>
  rec(sec, 'event_msg', { type: 'turn_aborted', turn_id: turn, reason });
const userMessage = (sec: number, ...parts: string[]) =>
  rec(sec, 'response_item', {
    type: 'message',
    role: 'user',
    content: parts.map((text) => ({ type: 'input_text', text })),
  });

function candidateOf(file: string, files: string[] = [file]): Candidate {
  return {
    runRef: file,
    format: 'codex-jsonl',
    files,
    mtimeMs: 0,
    sizeBytes: 0,
  };
}

/** Writes the lines as one rollout and parses it. */
async function parseLines(
  lines: string[],
  redact = false,
): Promise<{ raw: RawRun; file: string }> {
  const file = rollout(tempDir(), ROOT, { text: `${lines.join('\n')}\n` });
  return { raw: await codexAdapter.parse(candidateOf(file), { redact }), file };
}

const turnsOf = (raw: RawRun) => raw.spans.filter((s) => s.kind === 'turn');

describe('codex session and turn spans', () => {
  it('names the run after the thread and takes the project from the first record', async () => {
    const { raw, file } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      completed(9, TURN_A),
    ]);

    expect(raw.source).toEqual({
      tool: 'codex',
      format: 'codex-jsonl',
      files: [file],
    });
    expect(raw.project).toEqual({
      name: 'billing-portal',
      path: 'C:\\work\\billing-portal',
      gitBranch: 'feat/rounding',
    });
    expect(raw.title).toBeUndefined();
    expect(raw.warnings).toEqual([]);

    const [session, ...rest] = raw.spans;
    expect(session).toEqual({
      id: ROOT,
      parentId: null,
      kind: 'session',
      name: 'session',
      status: 'ok',
      startedAt: at(0),
      endedAt: at(9),
      durationMs: 9000,
      agent: { sessionId: ROOT },
      attributes: {},
      provenance: { file, line: 1 },
    });
    expect(rest).toEqual([
      {
        id: TURN_A,
        parentId: ROOT,
        kind: 'turn',
        name: 'turn',
        status: 'ok',
        startedAt: at(1),
        endedAt: at(9),
        durationMs: 8000,
        attributes: {},
        provenance: { file, line: 2 },
      },
    ]);
  });

  it.each([
    ['/home/alice/work/billing-portal', 'billing-portal'],
    ['D:\\', 'D:\\'],
    ['/', '/'],
    ['/srv/app/', 'app'],
  ])('names the project of %s %s', async (cwd, name) => {
    const { raw } = await parseLines([
      sessionMeta(0, { cwd, git: undefined }),
      started(1, TURN_A),
    ]);
    expect(raw.project).toEqual({ name, path: cwd });
  });

  it('carries no project when the first record has no working directory', async () => {
    const { raw } = await parseLines([
      rec(0, 'session_meta', { id: ROOT }),
      started(1, TURN_A),
    ]);
    expect(raw.project).toBeUndefined();
  });

  it('marks a turn the person interrupted as cancelled, with the reason', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      aborted(4, TURN_A, 'interrupted'),
    ]);
    expect(turnsOf(raw)).toMatchObject([
      {
        id: TURN_A,
        status: 'cancelled',
        statusReason: 'interrupted',
        endedAt: at(4),
        durationMs: 3000,
      },
    ]);
  });

  it('marks a turn that completed with an error as error, with the error code', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      completed(5, TURN_A, {
        error: {
          message: 'You have hit your usage limit.',
          codex_error_info: 'usage_limit_exceeded',
        },
      }),
      started(6, TURN_B),
      // the other way such a code is written: an object keyed by it
      completed(8, TURN_B, {
        error: { codex_error_info: { http_connection_failed: { code: 502 } } },
      }),
    ]);
    expect(turnsOf(raw)).toMatchObject([
      { id: TURN_A, status: 'error', statusReason: 'usage_limit_exceeded' },
      { id: TURN_B, status: 'error', statusReason: 'http_connection_failed' },
    ]);
    // the message is prose and stays in the file
    expect(JSON.stringify(raw)).not.toContain('usage limit.');
  });

  it('leaves a turn the file ends inside in progress, with no end', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      completed(2, TURN_A),
      started(3, TURN_B),
      userMessage(4, 'Round the VAT to two places'),
    ]);
    const [a, b] = turnsOf(raw);
    expect(a).toMatchObject({ status: 'ok', endedAt: at(2) });
    expect(b).toMatchObject({ id: TURN_B, status: 'in_progress' });
    expect(b).not.toHaveProperty('endedAt');
    expect(b).not.toHaveProperty('durationMs');
    expect(raw.spans[0]?.endedAt).toBe(at(4));
  });

  it('ignores a completion for a turn that never started, between the start and the end of the real one', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_B),
      completed(3, TURN_STRAY),
      aborted(4, TURN_STRAY, 'interrupted'),
      completed(7, TURN_B),
    ]);
    expect(turnsOf(raw)).toMatchObject([
      { id: TURN_B, status: 'ok', startedAt: at(1), endedAt: at(7) },
    ]);
    expect(raw.spans).toHaveLength(2);
    expect(raw.warnings).toEqual([]);
  });

  it('matches turns by id, not by position', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      started(2, TURN_B),
      completed(5, TURN_A),
      // a second start and a second end of the same id change nothing
      started(6, TURN_A),
      completed(7, TURN_A, { error: { codex_error_info: 'other' } }),
      aborted(9, TURN_B, 'interrupted'),
    ]);
    expect(turnsOf(raw)).toMatchObject([
      { id: TURN_A, status: 'ok', startedAt: at(1), endedAt: at(5) },
      { id: TURN_B, status: 'cancelled', startedAt: at(2), endedAt: at(9) },
    ]);
  });

  it('takes the prompt preview from the first part the person wrote, past the harness context', async () => {
    const prompt = `Round the VAT to two places ${'and keep the tests green '.repeat(20)}`;
    const { raw } = await parseLines([
      sessionMeta(0),
      // before any turn: nobody's prompt
      userMessage(0, 'Earlier history handed to this thread'),
      started(1, TURN_A),
      userMessage(
        1,
        '<environment_context>\n  <cwd>C:\\work\\billing-portal</cwd>\n</environment_context>',
      ),
      rec(1, 'response_item', {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Follow the house style.' }],
      }),
      userMessage(
        2,
        '<recommended_plugins>\n- acme\n</recommended_plugins>',
        '  ',
        `\n${prompt}`,
        '<image name=[Image #1]>',
        '</image>',
      ),
      userMessage(3, 'A second message is not the prompt'),
      completed(9, TURN_A),
      started(10, TURN_B),
      userMessage(11, '<turn_aborted>\nThe user interrupted.\n</turn_aborted>'),
      completed(12, TURN_B),
    ]);
    const [a, b] = turnsOf(raw);
    expect(a?.content).toEqual({ promptPreview: prompt.slice(0, 200) });
    expect(a?.content?.promptPreview).toHaveLength(200);
    // a turn with harness context only has no prompt to show
    expect(b).not.toHaveProperty('content');
  });

  it('takes the text that follows a harness block inside the same part', async () => {
    const browser =
      '<in-app-browser-context url="http://localhost:3000/">\nopen tab\n</in-app-browser-context>';
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      // a block and nothing after it, then two blocks and the prompt
      userMessage(1, `${browser}\n`),
      userMessage(
        2,
        `${browser}\n<environment_context>\n</environment_context>\n\nWhy is the total not centred?\n`,
      ),
      completed(3, TURN_A),
      started(4, TURN_B),
      // a block that never closes takes the rest of its part with it
      userMessage(5, '<image name=[Image #1]>\nnot a prompt', '</image>'),
      completed(6, TURN_B),
    ]);
    const [a, b] = turnsOf(raw);
    expect(a?.content).toEqual({
      promptPreview: 'Why is the total not centred?',
    });
    expect(b).not.toHaveProperty('content');
  });

  it('does not take pasted markup for harness context', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      userMessage(2, '<div class="total">why is this not centred?</div>'),
    ]);
    expect(turnsOf(raw)[0]?.content).toEqual({
      promptPreview: '<div class="total">why is this not centred?</div>',
    });
  });

  it('emits a null prompt preview on every turn under redaction', async () => {
    const { raw } = await parseLines(
      [
        sessionMeta(0),
        started(1, TURN_A),
        userMessage(2, 'Round the VAT to two places'),
        completed(3, TURN_A),
        started(4, TURN_B),
        completed(5, TURN_B),
      ],
      true,
    );
    for (const turn of turnsOf(raw)) {
      expect(turn.content).toEqual({ promptPreview: null });
    }
    expect(raw.title).toBeUndefined();
    expect(JSON.stringify(raw.spans)).not.toContain('VAT');
  });

  it('emits nothing of the repository URL, the commit or other session fields', async () => {
    const { raw } = await parseLines([
      sessionMeta(0, {
        creator_account_id: 'acct_4f1d2c3b',
        creator_user_id: 'user_9a8b7c6d',
        base_instructions: { text: 'You are a coding agent for Acme.' },
      }),
      started(1, TURN_A),
      completed(2, TURN_A),
    ]);
    const serialised = JSON.stringify(raw);
    for (const needle of [
      'git.example',
      'c0ffee',
      'acct_4f1d2c3b',
      'user_9a8b7c6d',
      'Acme',
    ]) {
      expect(serialised, needle).not.toContain(needle);
    }
  });

  it.each([
    ['only its first record', [sessionMeta(0)]],
    [
      'records and no turn',
      [
        sessionMeta(0),
        rec(1, 'event_msg', { type: 'thread_settings_applied' }),
        completed(2, TURN_STRAY),
      ],
    ],
    ['nothing at all', []],
  ])(
    'skips a rollout with %s quietly (NoSessionYet)',
    async (_label, lines) => {
      const file = rollout(tempDir(), ROOT, {
        text: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
      });
      await expect(
        codexAdapter.parse(candidateOf(file), { redact: false }),
      ).rejects.toBeInstanceOf(NoSessionYet);
    },
  );
});

describe('codex parsing tolerates what it does not know', () => {
  it('skips a record type it has no rule for, without a warning', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      rec(0, 'world_state', { anything: [1, 2, 3] }),
      started(1, TURN_A),
      rec(2, 'a_record_type_from_next_year', { turn_id: TURN_A, deep: {} }),
      rec(2, 'event_msg', { type: 'an_event_from_next_year' }),
      rec(2, 'response_item', { type: 'an_item_from_next_year' }),
      JSON.stringify({ no: 'type, no payload, no timestamp' }),
      JSON.stringify(['a', 'list']),
      '17',
      completed(3, TURN_A),
    ]);
    expect(raw.warnings).toEqual([]);
    expect(raw.spans.map((s) => s.kind)).toEqual(['session', 'turn']);
    expect(turnsOf(raw)[0]).toMatchObject({ status: 'ok', endedAt: at(3) });
  });

  it('treats every field of a known record as optional', async () => {
    const { raw, file } = await parseLines([
      // no id, no cwd, no git, no time
      JSON.stringify({ type: 'session_meta', payload: {} }),
      // no turn id: the turn still exists and the next end closes it
      rec(1, 'event_msg', { type: 'task_started' }),
      rec(1, 'response_item', { type: 'message', role: 'user' }),
      rec(1, 'response_item', { type: 'message', role: 'user', content: 7 }),
      rec(1, 'response_item', {
        type: 'message',
        role: 'user',
        content: [null, { type: 'input_text' }, { type: 'input_image' }],
      }),
      rec(2, 'event_msg', { type: 'task_complete', error: null }),
      // no time on a record: it borrows the last one seen
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: TURN_B },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: TURN_B },
      }),
      rec(3, 'event_msg', undefined),
      rec(3, 'event_msg', 'not an object'),
    ]);
    expect(raw.warnings).toEqual([]);
    const threadId = basename(file, '.jsonl');
    expect(raw.spans[0]).toMatchObject({
      id: threadId,
      agent: { sessionId: threadId },
      startedAt: at(1),
      endedAt: at(3),
    });
    expect(raw.project).toBeUndefined();
    expect(turnsOf(raw)).toMatchObject([
      {
        id: `${threadId}:turn:2`,
        status: 'ok',
        startedAt: at(1),
        endedAt: at(2),
      },
      { id: TURN_B, status: 'cancelled', startedAt: at(2), endedAt: at(2) },
    ]);
    expect(turnsOf(raw)[1]).not.toHaveProperty('statusReason');
  });

  it('reads a record time that is not in the usual form, and ignores one that is no time', async () => {
    const { raw } = await parseLines([
      JSON.stringify({
        timestamp: '2026-10-13T11:00:00+02:00',
        type: 'session_meta',
        payload: { id: ROOT },
      }),
      JSON.stringify({
        timestamp: 'yesterday',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: TURN_A },
      }),
      completed(5, TURN_A),
    ]);
    expect(raw.spans[0]?.startedAt).toBe('2026-10-13T09:00:00.000Z');
    expect(turnsOf(raw)[0]).toMatchObject({
      startedAt: '2026-10-13T09:00:00.000Z',
      endedAt: at(5),
    });
  });

  it('reports a line that is not JSON as a warning with its line number, and keeps the run', async () => {
    const filler = Array.from({ length: 37 }, (_, i) =>
      rec(2, 'event_msg', { type: 'token_count', n: i }),
    );
    const { raw, file } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      ...filler, // lines 3 to 39
      '{"timestamp":"2026-10-13T09:00:03.000Z","type":"event_msg","payload":{"type":"task_comp',
      completed(4, TURN_A),
    ]);
    expect(raw.warnings).toEqual([
      { message: 'unparseable JSONL line', file, line: 40 },
    ]);
    expect(turnsOf(raw)[0]).toMatchObject({ status: 'ok', endedAt: at(4) });
  });

  it('reads a record with a raw line separator inside a string whole, and keeps later line numbers', async () => {
    const output = `first\u2028second\u2029third`;
    const line = rec(2, 'response_item', {
      type: 'function_call_output',
      call_id: 'call_1',
      output,
    });
    // the characters are in the file as themselves, not as escapes
    expect(line).toContain('\u2028');
    expect(line).toContain('\u2029');
    const { raw, file } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      line,
      completed(3, TURN_A),
      started(4, TURN_B),
    ]);
    expect(raw.warnings).toEqual([]);
    expect(turnsOf(raw)).toMatchObject([
      { id: TURN_A, status: 'ok', provenance: { file, line: 2 } },
      { id: TURN_B, status: 'in_progress', provenance: { file, line: 5 } },
    ]);
  });

  it.each([
    [
      'starts with another record',
      [started(1, TURN_A), completed(2, TURN_A)],
      'not a Codex rollout: its first record is not a session_meta record',
    ],
    [
      'has a session record with no payload first',
      [JSON.stringify({ type: 'session_meta' }), started(1, TURN_A)],
      'not a Codex rollout: its first record is not a session_meta record',
    ],
    [
      'holds text and no record',
      ['meeting notes, 13 October', '- ship the rounding fix'],
      'not a Codex rollout: no line of it is a JSON record',
    ],
  ])(
    'refuses a file that %s, with the reason',
    async (_label, lines, message) => {
      const file = rollout(tempDir(), 'x', { text: `${lines.join('\n')}\n` });
      const failure = await codexAdapter
        .parse(candidateOf(file), { redact: false })
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(NoSessionYet);
      expect((failure as Error).message).toBe(message);
    },
  );

  it('refuses bytes that are not zstd under a compressed name', async () => {
    const file = join(tempDir(), 'rollout-w.jsonl.zst');
    writeFileSync(file, 'these bytes are not a zstd frame');
    const failure = await codexAdapter
      .parse(candidateOf(file), { redact: false })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(NoSessionYet);
  });

  it('gives the same run from a plain and a compressed copy, but for the file name', async () => {
    const text = `${[
      sessionMeta(0),
      started(1, TURN_A),
      userMessage(2, 'Round the VAT to two places'),
      completed(3, TURN_A),
    ].join('\n')}\n`;
    const plain = rollout(tempDir(), ROOT, { text });
    const packed = rollout(tempDir(), ROOT, { text, zst: true });
    const a = await codexAdapter.parse(candidateOf(plain), { redact: false });
    const b = await codexAdapter.parse(candidateOf(packed), { redact: false });
    const swap = (raw: RawRun) =>
      JSON.parse(
        JSON.stringify(raw)
          .split(JSON.stringify(packed).slice(1, -1))
          .join(JSON.stringify(plain).slice(1, -1)),
      );
    expect(swap(b)).toEqual(JSON.parse(JSON.stringify(a)));
    expect(b.source.files).toEqual([packed]);
  });
});

describe('codex parse on the fixtures', () => {
  const candidatesIn = async (variant: string) =>
    (await detect(join(fixtures, variant))).filter(
      (c) => !c.runRef.includes(`${sep}raw${sep}`),
    );
  const parseVariant = async (variant: string, redact = false) => {
    const out: RawRun[] = [];
    for (const candidate of await candidatesIn(variant)) {
      out.push(await codexAdapter.parse(candidate, { redact }));
    }
    return out;
  };
  /** Turn statuses of a run, with the reason where there is one. */
  const statuses = (raw: RawRun) =>
    turnsOf(raw).map((t) =>
      t.statusReason === undefined ? t.status : `${t.status}:${t.statusReason}`,
    );

  it('reads the single turn of simple, its project and its thread id', async () => {
    const [raw] = await parseVariant('simple');
    expect(raw?.warnings).toEqual([]);
    expect(raw?.spans[0]).toMatchObject({
      id: '01a0b059-e3b9-7a20-87cc-da1f5e28e984',
      kind: 'session',
      agent: { sessionId: '01a0b059-e3b9-7a20-87cc-da1f5e28e984' },
    });
    expect(raw?.project?.path).toMatch(/^\/home\/user\/project/);
    expect(raw?.project?.gitBranch).toBeTypeOf('string');
    expect(statuses(raw as RawRun)).toEqual(['ok']);
    expect(turnsOf(raw as RawRun)[0]?.content?.promptPreview).toBeTypeOf(
      'string',
    );
  });

  it('reads the same spans from zstd as from simple, but for the file name', async () => {
    const [plain] = await parseVariant('simple');
    const [packed] = await parseVariant('zstd');
    const strip = (raw: RawRun | undefined) =>
      raw?.spans.map(({ provenance, ...rest }) => ({
        ...rest,
        line: provenance.line,
      }));
    expect(strip(packed)).toEqual(strip(plain));
    expect(packed?.project).toEqual(plain?.project);
    expect(packed?.source.files[0]?.endsWith('.jsonl.zst')).toBe(true);
  });

  it('reads the turn an API error ended and the turn the person interrupted in tool-errors', async () => {
    const [first, second] = await parseVariant('tool-errors');
    expect(statuses(first as RawRun)).toContain('error:usage_limit_exceeded');
    expect(statuses(second as RawRun)).toContain('cancelled:interrupted');
    expect(turnsOf(first as RawRun)).toHaveLength(2);
    expect(turnsOf(second as RawRun)).toHaveLength(9);
  });

  it('reads six turns from compaction, whose seventh completion names a turn it never started', async () => {
    const [raw] = await parseVariant('compaction');
    expect(statuses(raw as RawRun)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
    expect(raw?.warnings).toEqual([]);
  });

  it('reads the turns of the legacy formats', async () => {
    const [old, newer] = await parseVariant('legacy');
    expect(turnsOf(old as RawRun)).toHaveLength(4);
    expect(turnsOf(newer as RawRun)).toHaveLength(3);
    for (const raw of [old, newer]) expect(raw?.warnings).toEqual([]);
  });

  it('reads the two turns of the guardian root and lists all three files as its source', async () => {
    const [raw] = await parseVariant('guardian');
    expect(turnsOf(raw as RawRun)).toHaveLength(2);
    expect(raw?.source.files).toHaveLength(3);
  });

  it('skips the reviewer thread of guardian that never ran a turn', async () => {
    const [candidate] = await candidatesIn('guardian');
    const idle = candidate?.files[2] ?? '';
    await expect(
      codexAdapter.parse(candidateOf(idle), { redact: false }),
    ).rejects.toBeInstanceOf(NoSessionYet);
  });

  it('gives every turn an id of its own, times in order and a line in its file', async () => {
    for (const variant of [
      'simple',
      'guardian',
      'tool-errors',
      'legacy',
      'compaction',
    ]) {
      for (const raw of await parseVariant(variant)) {
        const [session, ...turns] = raw.spans;
        expect(new Set(raw.spans.map((s) => s.id)).size).toBe(raw.spans.length);
        for (const turn of turns) {
          expect(turn.kind).toBe('turn');
          expect(turn.parentId).toBe(session?.id);
          expect(turn.provenance.file).toBe(raw.source.files[0]);
          expect(turn.provenance.line).toBeGreaterThan(1);
          expect(turn.startedAt >= (session?.startedAt ?? '')).toBe(true);
          if (turn.endedAt !== undefined) {
            expect(turn.endedAt >= turn.startedAt).toBe(true);
            expect(turn.endedAt <= (session?.endedAt ?? '')).toBe(true);
          }
        }
      }
    }
  });

  it('emits a null prompt preview on every turn of every fixture under redaction', async () => {
    for (const variant of [
      'simple',
      'guardian',
      'tool-errors',
      'legacy',
      'compaction',
    ]) {
      for (const raw of await parseVariant(variant, true)) {
        expect(raw.title).toBeUndefined();
        for (const span of raw.spans) {
          if (span.kind === 'turn') {
            expect(span.content).toEqual({ promptPreview: null });
          } else expect(span).not.toHaveProperty('content');
        }
      }
    }
  });

  it('parses every fixture to the same bytes twice, into a run the schema accepts', async () => {
    for (const variant of [
      'simple',
      'zstd',
      'guardian',
      'tool-errors',
      'legacy',
      'compaction',
    ]) {
      for (const candidate of await candidatesIn(variant)) {
        const first = await codexAdapter.parse(candidate, { redact: false });
        const second = await codexAdapter.parse(candidate, { redact: false });
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));

        const run = normalize(priceRun(first), { baseDir: repoRoot });
        expect(
          JSON.stringify(normalize(priceRun(second), { baseDir: repoRoot })),
        ).toBe(JSON.stringify(run));
        expect(RunSchema.safeParse(run).error).toBeUndefined();
        expect(run.source.tool).toBe('codex');
        expect(run.source.format).toBe('codex-jsonl');
        expect(
          run.source.files.every((f) => f.startsWith('fixtures/codex/')),
        ).toBe(true);
      }
    }
  });
});
