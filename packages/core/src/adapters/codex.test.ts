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
import { readRolloutLines } from '../rollout-lines.js';
import { identityContext, toolIdentity } from '../tools/identity.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { extractToolTarget } from './target.js';

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

  it('brings times of any precision to one form, so they order as times do', async () => {
    const stamped = (timestamp: string, type: string, payload: unknown) =>
      JSON.stringify({ timestamp, type, payload });
    const { raw } = await parseLines([
      stamped('2026-10-13T09:00:00Z', 'session_meta', { id: ROOT }),
      // whole seconds, then microseconds half a second later: as strings
      // `…05.500000Z` sorts before `…05Z`
      stamped('2026-10-13T09:00:05Z', 'event_msg', {
        type: 'task_started',
        turn_id: TURN_A,
      }),
      stamped('2026-10-13T09:00:05.500000Z', 'response_item', {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'ok',
      }),
      stamped('2026-10-13T09:00:06Z', 'token_usage_record', {
        response_id: 'resp_1',
        turn_id: TURN_A,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);
    const call = raw.spans.find((s) => s.kind === 'llm_call');
    expect(call).toMatchObject({
      startedAt: '2026-10-13T09:00:05.500Z',
      endedAt: '2026-10-13T09:00:06.000Z',
      durationMs: 500,
    });
    expect(raw.spans[0]).toMatchObject({
      startedAt: '2026-10-13T09:00:00.000Z',
      endedAt: '2026-10-13T09:00:06.000Z',
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

// ---------------------------------------------------------------------------
// parse(): model calls and tokens
// ---------------------------------------------------------------------------

const llmCallsOf = (raw: RawRun) =>
  raw.spans.filter((s) => s.kind === 'llm_call');

/** Counters the way Codex writes them: cached inside input, reasoning
 * inside output, and a total of input plus output. */
const usageOf = (
  input: number,
  cached: number,
  output: number,
  reasoning: number,
  cacheWrite = 0,
) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: cacheWrite,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});
const SMALL = usageOf(100, 0, 10, 0);

const turnContext = (sec: number, model: string, turn?: string) =>
  rec(sec, 'turn_context', {
    ...(turn === undefined ? {} : { turn_id: turn }),
    model,
    cwd: 'C:\\work\\billing-portal',
  });
const usageRecord = (
  sec: number,
  turn: string | undefined,
  responseId: string,
  usage: unknown = SMALL,
  threadTotal?: number,
) =>
  rec(sec, 'token_usage_record', {
    response_id: responseId,
    ...(turn === undefined ? {} : { turn_id: turn }),
    usage,
    ...(threadTotal === undefined
      ? {}
      : { thread_token_usage: { total_tokens: threadTotal } }),
  });
const assistantMessage = (sec: number, ...texts: string[]) =>
  rec(sec, 'response_item', {
    type: 'message',
    role: 'assistant',
    content: texts.map((text) => ({ type: 'output_text', text })),
  });
const toolCall = (sec: number, callId: string) =>
  rec(sec, 'response_item', {
    type: 'custom_tool_call',
    call_id: callId,
    name: 'exec',
    input: 'text(await tools.exec_command({cmd: "pnpm test"}))',
  });
const toolOutput = (sec: number, callId: string) =>
  rec(sec, 'response_item', {
    type: 'custom_tool_call_output',
    call_id: callId,
    output: 'Script completed\nOutput:\n12 passed',
  });
/** A running token event; `total` is the thread total after it. */
const tokenCount = (sec: number, last: unknown, total: number) =>
  rec(sec, 'event_msg', {
    type: 'token_count',
    info: {
      last_token_usage: last,
      total_token_usage: { total_tokens: total },
    },
  });

describe('codex llm calls', () => {
  it('emits one call per usage record, under its turn, named after the turn model', async () => {
    const { raw, file } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A), // line 2
      turnContext(1, 'gpt-5.2-codex', TURN_A),
      userMessage(1, 'Round the VAT to two places'),
      rec(3, 'response_item', { type: 'reasoning', encrypted_content: 'x' }),
      assistantMessage(4, '  ', '\nI will run the tests first.\n'), // line 6
      toolCall(4, 'call_1'),
      usageRecord(5, TURN_A, 'resp_1'), // line 8
      toolOutput(9, 'call_1'),
      toolCall(12, 'call_2'), // line 10
      usageRecord(13, TURN_A, 'resp_2'),
      toolOutput(14, 'call_2'),
      assistantMessage(18, `Done. ${'All green. '.repeat(40)}`), // line 13
      usageRecord(20, TURN_A, 'resp_3'),
      completed(21, TURN_A),
    ]);
    expect(raw.warnings).toEqual([]);
    expect(llmCallsOf(raw)).toEqual([
      {
        id: 'resp_1',
        parentId: TURN_A,
        kind: 'llm_call',
        name: 'gpt-5.2-codex',
        status: 'ok',
        // from the start of the turn to the usage record
        startedAt: at(1),
        endedAt: at(5),
        durationMs: 4000,
        llm: {
          provider: 'openai',
          model: 'gpt-5.2-codex',
          tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
          costSource: 'unknown',
        },
        content: { outputPreview: 'I will run the tests first.' },
        attributes: {},
        provenance: { file, line: 6 },
      },
      {
        id: 'resp_2',
        parentId: TURN_A,
        kind: 'llm_call',
        name: 'gpt-5.2-codex',
        status: 'ok',
        // from the tool output handed back to the usage record
        startedAt: at(9),
        endedAt: at(13),
        durationMs: 4000,
        llm: {
          provider: 'openai',
          model: 'gpt-5.2-codex',
          tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
          costSource: 'unknown',
        },
        attributes: {},
        // no text in this response: the call it made stands for it
        provenance: { file, line: 10 },
      },
      {
        id: 'resp_3',
        parentId: TURN_A,
        kind: 'llm_call',
        name: 'gpt-5.2-codex',
        status: 'ok',
        startedAt: at(14),
        endedAt: at(20),
        durationMs: 6000,
        llm: {
          provider: 'openai',
          model: 'gpt-5.2-codex',
          tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
          costSource: 'unknown',
        },
        content: {
          outputPreview: `Done. ${'All green. '.repeat(40)}`.slice(0, 200),
        },
        attributes: {},
        provenance: { file, line: 13 },
      },
    ]);
  });

  it('starts a call where the one before it ended when no tool ran between them', async () => {
    const { raw, file } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      turnContext(1, 'gpt-5.2-codex', TURN_A),
      usageRecord(4, TURN_A, 'resp_1'), // line 4: nothing before it
      usageRecord(9, TURN_A, 'resp_2'),
    ]);
    expect(llmCallsOf(raw)).toMatchObject([
      {
        id: 'resp_1',
        startedAt: at(1),
        endedAt: at(4),
        provenance: { file, line: 4 },
      },
      { id: 'resp_2', startedAt: at(4), endedAt: at(9) },
    ]);
    expect(llmCallsOf(raw)[0]).not.toHaveProperty('content');
  });

  it('takes the model from the turn, following a change within it', async () => {
    const { raw } = await parseLines([
      sessionMeta(0, { model_provider: 'azure' }),
      // a context written before the turn it names has started
      turnContext(0, 'gpt-5.2-codex', TURN_A),
      started(1, TURN_A),
      usageRecord(2, TURN_A, 'resp_1'),
      turnContext(3, 'gpt-5.5', TURN_A),
      usageRecord(4, TURN_A, 'resp_2'),
      completed(5, TURN_A),
      started(6, TURN_B),
      // no context for this turn: the last model named stands
      usageRecord(7, TURN_B, 'resp_3'),
    ]);
    expect(llmCallsOf(raw).map((s) => [s.name, s.llm?.provider])).toEqual([
      ['gpt-5.2-codex', 'azure'],
      ['gpt-5.5', 'azure'],
      ['gpt-5.5', 'azure'],
    ]);
  });

  it('says unknown where the file names no model and no provider', async () => {
    const { raw } = await parseLines([
      rec(0, 'session_meta', { id: ROOT, model_provider: null }),
      started(1, TURN_A),
      usageRecord(2, TURN_A, 'resp_1'),
    ]);
    expect(llmCallsOf(raw)[0]).toMatchObject({
      name: 'unknown',
      llm: { provider: 'unknown', model: 'unknown' },
    });
  });

  it('puts a call whose turn the file never started under the turn started last', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_B),
      turnContext(1, 'codex-auto-review', TURN_B),
      turnContext(1, 'gpt-5.2-codex', TURN_STRAY),
      usageRecord(3, TURN_STRAY, 'resp_stray'),
      usageRecord(4, undefined, 'resp_unnamed'),
      completed(5, TURN_B),
      // after the turn ended: still the turn started last
      usageRecord(6, TURN_STRAY, 'resp_late'),
    ]);
    expect(
      llmCallsOf(raw).map((s) => [s.id, s.parentId, s.name, s.startedAt]),
    ).toEqual([
      // the context written for the named turn still gives the model
      ['resp_stray', TURN_B, 'gpt-5.2-codex', at(1)],
      ['resp_unnamed', TURN_B, 'codex-auto-review', at(3)],
      ['resp_late', TURN_B, 'gpt-5.2-codex', at(4)],
    ]);
    expect(raw.warnings).toEqual([]);
  });

  it('puts a call made before any turn under the session, and still makes a run of it', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      turnContext(1, 'gpt-5.2-codex'),
      usageRecord(2, undefined, 'resp_1'),
    ]);
    expect(raw.spans.map((s) => s.kind)).toEqual(['session', 'llm_call']);
    expect(llmCallsOf(raw)[0]).toMatchObject({
      parentId: ROOT,
      name: 'gpt-5.2-codex',
      startedAt: at(2),
      endedAt: at(2),
      durationMs: 0,
    });
  });

  it('emits no call for a response with no usage record before its turn was aborted', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      turnContext(1, 'gpt-5.2-codex', TURN_A),
      assistantMessage(2, 'First answer.'),
      usageRecord(3, TURN_A, 'resp_1'),
      // the second response: a message and a call, then the abort
      assistantMessage(5, 'Let me check one more thing.'),
      toolCall(5, 'call_9'),
      aborted(6, TURN_A, 'interrupted'),
      started(7, TURN_B),
      turnContext(7, 'gpt-5.2-codex', TURN_B),
      usageRecord(9, TURN_B, 'resp_2'),
    ]);
    expect(llmCallsOf(raw)).toHaveLength(2);
    expect(llmCallsOf(raw)[0]?.content).toEqual({
      outputPreview: 'First answer.',
    });
    // what the aborted response wrote is not the next turn's output
    expect(llmCallsOf(raw)[1]).toMatchObject({
      id: 'resp_2',
      parentId: TURN_B,
      startedAt: at(7),
    });
    expect(llmCallsOf(raw)[1]).not.toHaveProperty('content');
  });

  it('keeps span ids unique when a record has no response id or repeats one', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      usageRecord(2, TURN_A, 'resp_1'),
      usageRecord(3, TURN_A, 'resp_1'), // line 4
      rec(4, 'token_usage_record', { turn_id: TURN_A, usage: SMALL }), // line 5
      rec(5, 'token_usage_record', { turn_id: TURN_A }), // no usage: no call
    ]);
    expect(llmCallsOf(raw).map((s) => s.id)).toEqual([
      'resp_1',
      'resp_1:4',
      `${ROOT}:response:5`,
    ]);
  });

  it('emits null output previews under redaction and no text of the response', async () => {
    const { raw } = await parseLines(
      [
        sessionMeta(0),
        started(1, TURN_A),
        assistantMessage(2, 'The VAT bug is in the invoice totals'),
        usageRecord(3, TURN_A, 'resp_1'),
        usageRecord(4, TURN_A, 'resp_2'),
      ],
      true,
    );
    for (const call of llmCallsOf(raw)) {
      expect(call.content).toEqual({ outputPreview: null });
    }
    expect(JSON.stringify(raw)).not.toContain('invoice');
  });
});

describe('codex token conversion', () => {
  const tokensFor = async (usage: unknown) => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      turnContext(1, 'gpt-5.2-codex', TURN_A),
      usageRecord(2, TURN_A, 'resp_1', usage),
      completed(3, TURN_A),
    ]);
    return { raw, tokens: llmCallsOf(raw)[0]?.llm?.tokens };
  };

  it('takes cached input out of input and reasoning out of output', async () => {
    const usage = usageOf(10_000, 8_000, 500, 300);
    expect(usage.total_tokens).toBe(10_500);
    const { raw, tokens } = await tokensFor(usage);
    expect(tokens).toEqual({
      input: 2_000,
      cacheRead: 8_000,
      cacheWrite: 0,
      output: 200,
      reasoning: 300,
    });

    // the five parts are Codex's total, and the hit rate is the cache's
    const run = normalize(priceRun(raw));
    expect(run.totals.tokens.total).toBe(10_500);
    expect(run.totals.cache.hitRate).toBe(0.8);
    expect(RunSchema.safeParse(run).error).toBeUndefined();
  });

  it('takes cache writes out of input as well', async () => {
    const { tokens } = await tokensFor(usageOf(10_000, 6_000, 500, 0, 1_500));
    expect(tokens).toEqual({
      input: 2_500,
      cacheRead: 6_000,
      cacheWrite: 1_500,
      output: 500,
    });
  });

  it('leaves reasoning out when there was none', async () => {
    const { tokens } = await tokensFor(usageOf(100, 0, 10, 0));
    expect(tokens).not.toHaveProperty('reasoning');
  });

  it.each([
    [
      'cached input above input',
      usageOf(1_000, 1_400, 50, 0),
      { input: 0, cacheRead: 1_400, cacheWrite: 0, output: 50 },
    ],
    [
      'reasoning above output',
      usageOf(1_000, 0, 50, 80),
      { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 80 },
    ],
    [
      'counters that are missing, negative, fractional or not numbers',
      {
        input_tokens: 99.6,
        cached_input_tokens: -5,
        output_tokens: '12',
        reasoning_output_tokens: null,
      },
      { input: 100, cacheRead: 0, cacheWrite: 0, output: 0 },
    ],
    [
      'no counters at all',
      {},
      { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    ],
  ])('never goes below zero: %s', async (_label, usage, expected) => {
    const { raw, tokens } = await tokensFor(usage);
    expect(tokens).toEqual(expected);
    expect(RunSchema.safeParse(normalize(priceRun(raw))).error).toBeUndefined();
  });

  it('reads the per-response usage, not the difference of the thread total', async () => {
    // a child thread: its first record already shows what the parent used
    const { raw } = await parseLines([
      sessionMeta(0, { parent_thread_id: ABSENT }),
      started(1, TURN_A),
      turnContext(1, 'codex-auto-review', TURN_A),
      usageRecord(2, TURN_A, 'resp_1', usageOf(1_000, 0, 100, 0), 4_196_105),
      usageRecord(
        3,
        TURN_A,
        'resp_2',
        usageOf(2_000, 1_000, 200, 0),
        4_198_305,
      ),
      completed(4, TURN_A),
    ]);
    const run = normalize(priceRun(raw));
    expect(run.totals.tokens.total).toBe(1_100 + 2_200);
    expect(llmCallsOf(raw).map((s) => s.llm?.tokens.input)).toEqual([
      1_000, 1_000,
    ]);
  });
});

describe('codex legacy token events', () => {
  it('emits one call per token event whose thread total moved', async () => {
    const { raw, file } = await parseLines([
      rec(0, 'session_meta', { id: ROOT, model_provider: null }),
      started(1, TURN_A),
      // a legacy context names no turn
      turnContext(1, 'gpt-5'),
      rec(1, 'event_msg', { type: 'token_count', info: null }),
      assistantMessage(3, 'Looking at the rounding code.'), // line 5
      rec(3, 'response_item', {
        type: 'function_call',
        name: 'shell',
        call_id: 'call_1',
        arguments: '{"command":["bash","-lc","ls"]}',
      }),
      tokenCount(4, usageOf(1_000, 400, 50, 20), 1_050), // line 7
      tokenCount(4, usageOf(1_000, 400, 50, 20), 1_050), // the same total again
      rec(6, 'response_item', {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"output":"a.ts","metadata":{"exit_code":0}}',
      }),
      tokenCount(6, usageOf(1_000, 400, 50, 20), 1_050), // and again
      tokenCount(9, usageOf(2_000, 1_000, 80, 0), 3_130), // line 11
      completed(10, TURN_A),
    ]);
    expect(raw.warnings).toEqual([]);
    expect(llmCallsOf(raw)).toEqual([
      {
        id: `${ROOT}:tokens:4`,
        parentId: TURN_A,
        kind: 'llm_call',
        name: 'gpt-5',
        status: 'ok',
        startedAt: at(1),
        endedAt: at(4),
        durationMs: 3000,
        llm: {
          provider: 'unknown',
          model: 'gpt-5',
          tokens: {
            input: 600,
            output: 30,
            cacheRead: 400,
            cacheWrite: 0,
            reasoning: 20,
          },
          costSource: 'unknown',
        },
        content: { outputPreview: 'Looking at the rounding code.' },
        attributes: {},
        provenance: { file, line: 5 },
      },
      {
        id: `${ROOT}:tokens:9`,
        parentId: TURN_A,
        kind: 'llm_call',
        name: 'gpt-5',
        status: 'ok',
        // from the tool output handed back
        startedAt: at(6),
        endedAt: at(9),
        durationMs: 3000,
        llm: {
          provider: 'unknown',
          model: 'gpt-5',
          tokens: { input: 1_000, output: 80, cacheRead: 1_000, cacheWrite: 0 },
          costSource: 'unknown',
        },
        attributes: {},
        provenance: { file, line: 11 },
      },
    ]);
    const run = normalize(priceRun(raw));
    expect(run.totals.tokens.total).toBe(3_130);
  });

  it('reads the items after a token event as that response when the event comes first', async () => {
    // CLI 0.47 writes the token event when the response ends and its items
    // afterwards, in one batch with the tool output
    const { raw } = await parseLines([
      rec(0, 'session_meta', { id: ROOT, model_provider: 'openai' }),
      started(1, TURN_A),
      turnContext(1, 'gpt-5'),
      tokenCount(3, usageOf(1_000, 0, 50, 0), 1_050), // line 4
      assistantMessage(6, 'Listing the invoices folder.'), // line 5
      rec(6, 'response_item', {
        type: 'function_call',
        name: 'shell',
        call_id: 'call_1',
        arguments: '{"command":["bash","-lc","ls"]}',
      }),
      rec(6, 'response_item', {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"output":"a.ts","metadata":{"exit_code":0}}',
      }),
      tokenCount(8, usageOf(2_000, 1_000, 80, 0), 3_130), // line 8
      rec(8, 'response_item', { type: 'reasoning', summary: [] }),
      assistantMessage(8, 'Two files, both small.'), // line 10
      completed(9, TURN_A),
      started(10, TURN_B),
      tokenCount(12, usageOf(3_000, 2_000, 10, 0), 6_140), // line 13
      rec(12, 'response_item', {
        type: 'function_call',
        name: 'shell',
        call_id: 'call_2', // line 14
        arguments: '{"command":["bash","-lc","pwd"]}',
      }),
      aborted(13, TURN_B, 'interrupted'),
    ]);
    expect(
      llmCallsOf(raw).map((s) => ({
        id: s.id,
        parentId: s.parentId,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        content: s.content,
        line: s.provenance.line,
      })),
    ).toEqual([
      {
        id: `${ROOT}:tokens:3`,
        parentId: TURN_A,
        startedAt: at(1),
        endedAt: at(3),
        content: { outputPreview: 'Listing the invoices folder.' },
        line: 5,
      },
      {
        id: `${ROOT}:tokens:8`,
        parentId: TURN_A,
        // from the tool output handed back
        startedAt: at(6),
        endedAt: at(8),
        content: { outputPreview: 'Two files, both small.' },
        line: 10,
      },
      {
        id: `${ROOT}:tokens:12`,
        parentId: TURN_B,
        startedAt: at(10),
        endedAt: at(12),
        // no text: the record behind the span is the call it made
        content: undefined,
        line: 14,
      },
    ]);
    expect(normalize(priceRun(raw)).totals.tokens.total).toBe(6_140);

    const { raw: redacted } = await parseLines(
      [
        sessionMeta(0),
        started(1, TURN_A),
        tokenCount(3, SMALL, 110),
        assistantMessage(6, 'Listing the invoices folder.'),
        completed(7, TURN_A),
      ],
      true,
    );
    expect(llmCallsOf(redacted).map((s) => s.content)).toEqual([
      { outputPreview: null },
    ]);
  });

  it('ignores token events in a rollout that has usage records', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      // a token event before the first usage record, as a child thread has
      tokenCount(0, usageOf(9_000, 0, 900, 0), 9_900),
      started(1, TURN_A),
      turnContext(1, 'gpt-5.2-codex', TURN_A),
      usageRecord(2, TURN_A, 'resp_1'),
      tokenCount(2, SMALL, 10_010),
      usageRecord(4, TURN_A, 'resp_2'),
      tokenCount(4, SMALL, 10_120),
      tokenCount(5, SMALL, 10_230),
      completed(6, TURN_A),
    ]);
    expect(llmCallsOf(raw).map((s) => s.id)).toEqual(['resp_1', 'resp_2']);
    expect(normalize(priceRun(raw)).totals.tokens.total).toBe(220);
  });

  it('does not take the counter a child thread inherited for a call of its own', async () => {
    // A reviewer thread opens with the total and the last usage its parent
    // had reached. Here its only turn was aborted before any usage record
    // was written, so the file has no usage records and reads as legacy.
    const inherited = tokenCount(0, usageOf(90_000, 80_000, 900, 0), 4_195_005);
    const { raw } = await parseLines([
      sessionMeta(0, { parent_thread_id: ABSENT }),
      inherited,
      started(1, TURN_A),
      turnContext(1, 'codex-auto-review', TURN_A),
      inherited, // written again inside the turn: still no new response
      aborted(3, TURN_A, 'interrupted'),
    ]);
    expect(llmCallsOf(raw)).toEqual([]);
    expect(turnsOf(raw)).toHaveLength(1);
    expect(normalize(priceRun(raw)).totals.tokens.total).toBe(0);
  });

  it('counts from the inherited total on: the first event that moves it is a call', async () => {
    const { raw } = await parseLines([
      sessionMeta(0, { parent_thread_id: ABSENT }),
      tokenCount(0, usageOf(90_000, 80_000, 900, 0), 4_195_005),
      started(1, TURN_A),
      turnContext(1, 'codex-auto-review', TURN_A),
      tokenCount(3, usageOf(1_000, 0, 100, 0), 4_196_105),
      completed(4, TURN_A),
    ]);
    expect(llmCallsOf(raw).map((s) => s.llm?.tokens)).toEqual([
      { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  it('skips a token event with no counters and names a call by its line when the record has no ordinal', async () => {
    const event = (info: unknown) =>
      JSON.stringify({
        timestamp: at(2),
        type: 'event_msg',
        payload: { type: 'token_count', info },
      });
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      event(null),
      event({ total_token_usage: { total_tokens: 5 } }), // no last usage
      event('not an object'),
      event({
        last_token_usage: SMALL,
        total_token_usage: { total_tokens: 110 },
      }),
    ]);
    expect(llmCallsOf(raw).map((s) => s.id)).toEqual([`${ROOT}:tokens:line-6`]);
  });
});

// ---------------------------------------------------------------------------
// parse(): tools
// ---------------------------------------------------------------------------

const toolsOf = (raw: RawRun) =>
  raw.spans.filter((s) => s.kind === 'tool_call' || s.kind === 'mcp_call');
/** The target key a shell call of any source gets for a command that
 * starts with `token`. */
const targetKeyOf = (token: string) =>
  extractToolTarget('claude-code', 'Bash', { command: token })?.key;
/** Name, parent and status of every tool span, in file order. */
const toolRows = (raw: RawRun) =>
  toolsOf(raw).map((s) => `${s.name} < ${s.parentId} ${s.status}`);

const functionCall = (
  sec: number,
  callId: string,
  name: string,
  args: unknown = {},
) =>
  rec(sec, 'response_item', {
    type: 'function_call',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  });
const functionOutput = (sec: number, callId: string, output: unknown) =>
  rec(sec, 'response_item', {
    type: 'function_call_output',
    call_id: callId,
    output,
  });
/** A script's output the way current Codex writes it: a head part, then
 * what the script printed. */
const scriptOutput = (
  sec: number,
  callId: string,
  head = 'Script completed',
  body = '12 passed',
) =>
  rec(sec, 'response_item', {
    type: 'custom_tool_call_output',
    call_id: callId,
    output: [
      { type: 'input_text', text: `${head}\nWall time 1.4 seconds\nOutput:\n` },
      { type: 'input_text', text: body },
    ],
  });
/** Something the harness did, recorded when it ended at second `sec`. It
 * started at second `from`; with no `from` the record has no start time. */
const action = (
  sec: number,
  turn: string | undefined,
  item: Record<string, unknown>,
  from?: number,
) =>
  rec(sec, 'event_msg', {
    type: 'item_completed',
    thread_id: ROOT,
    ...(turn === undefined ? {} : { turn_id: turn }),
    item,
    ...(from === undefined ? {} : { started_at_ms: Date.parse(at(from)) }),
    completed_at_ms: Date.parse(at(sec)),
  });
const command = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'CommandExecution',
  id,
  command: ['pwsh.exe', '-Command', 'pnpm test --filter invoices'],
  cwd: 'C:\\work\\billing-portal',
  status: 'completed',
  exit_code: 0,
  aggregated_output: '12 passed\n',
  formatted_output: '12 passed\n',
  duration: { secs: 1, nanos: 0 },
  ...extra,
});

describe('codex tool spans', () => {
  it('emits a span per command a script ran, under the call of the response that made it, and none for the script', async () => {
    const { raw, file } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      turnContext(1, 'gpt-5.2-codex', TURN_A),
      toolCall(2, 'call_1'),
      usageRecord(3, TURN_A, 'resp_1'),
      action(4, TURN_A, command('exec-1'), 3), // line 6
      action(6, TURN_A, command('exec-2'), 5), // line 7
      toolOutput(7, 'call_1'),
      usageRecord(9, TURN_A, 'resp_2'),
      completed(10, TURN_A),
    ]);
    const span = (id: string, from: number, to: number, line: number) => ({
      id,
      parentId: 'resp_1',
      kind: 'tool_call',
      name: 'exec_command',
      status: 'ok',
      startedAt: at(from),
      endedAt: at(to),
      durationMs: 1000,
      tool: {
        name: 'exec_command',
        isError: false,
        exitCode: 0,
        outputBytes: 10,
      },
      // what `pnpm test --filter invoices` is, not the text of it
      attributes: {
        'runray.targetKey': targetKeyOf('pnpm'),
        'runray.targetKind': 'command',
        'runray.target': 'pnpm',
        'runray.toolActivity': 'test',
        'runray.tool': 'pnpm',
        'runray.toolSub': 'run',
        'runray.toolScript': 'test',
      },
      provenance: { file, line },
    });
    expect(toolsOf(raw)).toEqual([
      span('exec-1', 3, 4, 6),
      span('exec-2', 5, 6, 7),
    ]);
  });

  it('emits a span for a call nothing came of, from the call to its output', async () => {
    const { raw, file } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      toolCall(2, 'call_1'), // line 3
      usageRecord(3, TURN_A, 'resp_1'),
      toolOutput(5, 'call_1'),
      completed(6, TURN_A),
    ]);
    expect(toolsOf(raw)).toEqual([
      {
        id: 'call_1',
        parentId: 'resp_1',
        kind: 'tool_call',
        name: 'exec',
        status: 'ok',
        startedAt: at(2),
        endedAt: at(5),
        durationMs: 3000,
        tool: {
          name: 'exec',
          isError: false,
          outputBytes: 'Script completed\nOutput:\n12 passed'.length,
        },
        attributes: {},
        provenance: { file, line: 3 },
      },
    ]);
  });

  it('reads a failed command as an error with its exit code and the line that names the failure', async () => {
    const lines = [
      sessionMeta(0),
      started(1, TURN_A),
      toolCall(2, 'call_1'),
      usageRecord(3, TURN_A, 'resp_1'),
      action(
        5,
        TURN_A,
        command('exec-1', {
          status: 'failed',
          exit_code: 1,
          aggregated_output:
            'compiling invoices\nerror TS2322: totals do not match\n',
          formatted_output: 'error TS2322: totals do not match\n',
        }),
        3,
      ),
      scriptOutput(6, 'call_1', 'Script failed', 'Script error:\nExit code: 1'),
      completed(7, TURN_A),
    ];
    const { raw } = await parseLines(lines);
    expect(toolsOf(raw)).toHaveLength(1);
    expect(toolsOf(raw)[0]).toMatchObject({
      name: 'exec_command',
      status: 'error',
      tool: { isError: true, exitCode: 1 },
      content: { outputPreview: 'error TS2322: totals do not match\n' },
    });

    const { raw: redacted } = await parseLines(lines, true);
    expect(toolsOf(redacted)[0]).toMatchObject({
      status: 'error',
      tool: { isError: true, exitCode: 1 },
      content: { outputPreview: null },
    });
    for (const text of ['TS2322', 'invoices', 'pwsh', '--filter']) {
      expect(JSON.stringify(redacted)).not.toContain(text);
    }
    // the script and the command are never stored, redacted or not: only
    // the name of the program the script ran
    for (const text of ['pwsh', '--filter', 'exec_command({']) {
      expect(JSON.stringify(raw.spans)).not.toContain(text);
    }
  });

  it('reads an MCP action as an mcp_call named after the tool, with its server', async () => {
    const mcp = (id: string, extra: Record<string, unknown> = {}) => ({
      type: 'McpToolCall',
      id,
      server: 'linear',
      tool: 'list_issues',
      arguments: { team: 'billing-secret' },
      status: 'completed',
      result: { content: [{ type: 'text', text: '[]' }], isError: false },
      duration: { secs: 0, nanos: 250_000_000 },
      ...extra,
    });
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      // called directly: the action carries the call's id
      functionCall(2, 'call_m', 'list_issues', { team: 'billing-secret' }),
      usageRecord(3, TURN_A, 'resp_1'),
      action(4, TURN_A, mcp('call_m'), 3),
      functionOutput(4, 'call_m', [{ type: 'input_text', text: '[]' }]),
      // called from a script: the action has an id of its own
      toolCall(5, 'call_2'),
      usageRecord(6, TURN_A, 'resp_2'),
      action(
        8,
        TURN_A,
        mcp('exec-9', {
          status: 'failed',
          result: {
            content: [
              { type: 'image', data: 'AAAA' },
              { type: 'text', text: 'Error: team not found' },
            ],
            isError: true,
          },
        }),
      ),
      toolOutput(9, 'call_2'),
      completed(10, TURN_A),
    ]);
    expect(toolsOf(raw)).toMatchObject([
      {
        id: 'call_m',
        parentId: 'resp_1',
        kind: 'mcp_call',
        name: 'list_issues',
        status: 'ok',
        startedAt: at(3),
        endedAt: at(4),
        tool: { name: 'list_issues', mcpServer: 'linear', isError: false },
      },
      {
        id: 'exec-9',
        parentId: 'resp_2',
        kind: 'mcp_call',
        name: 'list_issues',
        status: 'error',
        // no start time: the end less how long the call took
        startedAt: '2026-10-13T09:00:07.750Z',
        endedAt: at(8),
        durationMs: 250,
        tool: { mcpServer: 'linear', isError: true },
        content: { outputPreview: 'Error: team not found' },
      },
    ]);
    expect(JSON.stringify(raw.spans)).not.toContain('billing-secret');
  });

  it('gives an action written after its call output to that call, which is then no span', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      toolCall(2, 'call_1'),
      usageRecord(3, TURN_A, 'resp_1'),
      toolOutput(4, 'call_1'),
      // no call is open, and the record has no start time
      action(5, TURN_A, command('exec-1')),
      completed(6, TURN_A),
    ]);
    expect(toolRows(raw)).toEqual(['exec_command < resp_1 ok']);
    // without a start time: the end less the second the command took
    expect(toolsOf(raw)[0]).toMatchObject({
      startedAt: at(4),
      endedAt: at(5),
    });
  });

  it('gives a command that outlived its call to the call that launched it, not to the one waiting when it ended', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      toolCall(2, 'call_1'),
      usageRecord(3, TURN_A, 'resp_1'),
      scriptOutput(4, 'call_1', 'Script running with cell ID 7', ''),
      functionCall(6, 'call_2', 'wait', { cell_id: 7 }),
      usageRecord(7, TURN_A, 'resp_2'),
      // started while call_1 was waiting, ended while call_2 is
      action(9, TURN_A, command('exec-1'), 3),
      functionOutput(10, 'call_2', [
        {
          type: 'input_text',
          text: 'Script completed\nWall time 4.0 seconds\nOutput:\n',
        },
      ]),
      completed(11, TURN_A),
    ]);
    expect(toolRows(raw)).toEqual([
      'exec_command < resp_1 ok',
      'wait < resp_2 ok',
    ]);
  });

  it('hangs an action no call explains from its turn, and from the session outside any turn', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      action(1, undefined, command('exec-0'), 0),
      started(2, TURN_A),
      action(4, TURN_A, command('exec-1'), 3),
      completed(5, TURN_A),
      started(6, TURN_B),
      toolCall(7, 'call_1'),
      usageRecord(8, TURN_B, 'resp_1'),
      toolOutput(9, 'call_1'),
      // written after its turn ended and naming it: not turn B's call
      action(10, TURN_A, command('exec-2')),
      completed(11, TURN_B),
    ]);
    expect(toolRows(raw)).toEqual([
      `exec_command < ${ROOT} ok`,
      `exec_command < ${TURN_A} ok`,
      `exec_command < ${TURN_A} ok`,
      'exec < resp_1 ok',
    ]);
  });

  it('leaves the tools of a response with no usage record on the turn', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      toolCall(2, 'call_1'),
      action(4, TURN_A, command('exec-1'), 3),
      toolOutput(5, 'call_1'),
      toolCall(6, 'call_2'),
      rec(7, 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'call_2',
        output: 'aborted by user after 1.2s',
      }),
      aborted(7, TURN_A, 'interrupted'),
    ]);
    expect(llmCallsOf(raw)).toEqual([]);
    expect(toolsOf(raw)).toMatchObject([
      { name: 'exec_command', parentId: TURN_A, status: 'ok' },
      {
        name: 'exec',
        parentId: TURN_A,
        // stopping a call is the person's decision, not a tool failure
        status: 'cancelled',
        statusReason: 'user-rejected',
        tool: { name: 'exec', isError: false },
        content: { outputPreview: 'aborted by user after 1.2s' },
      },
    ]);
  });

  it('reads a legacy shell call as the command: exit code and duration from the output', async () => {
    const shellOutput = (exitCode: number, seconds: number, output: string) =>
      JSON.stringify({
        output,
        metadata: { exit_code: exitCode, duration_seconds: seconds },
      });
    const { raw, file } = await parseLines([
      rec(0, 'session_meta', { id: ROOT, model_provider: 'openai' }),
      started(1, TURN_A),
      turnContext(1, 'gpt-5'),
      // CLI 0.47: the token event, then the response's items in one batch
      tokenCount(3, usageOf(1_000, 0, 50, 0), 1_050),
      functionCall(6, 'call_1', 'shell', {
        command: ['bash', '-lc', 'ls src/invoices'],
      }), // line 5
      functionOutput(
        6,
        'call_1',
        shellOutput(2, 1.5, 'ls: cannot access src/invoices: No such file\n'),
      ),
      tokenCount(8, usageOf(2_000, 0, 80, 0), 3_130),
      functionCall(9, 'call_2', 'shell', { command: ['bash', '-lc', 'pwd'] }),
      functionOutput(9, 'call_2', shellOutput(0, 0.25, '/work\n')),
      tokenCount(10, usageOf(3_000, 0, 10, 0), 6_140),
      completed(11, TURN_A),
    ]);
    expect(toolsOf(raw)).toEqual([
      {
        id: 'call_1',
        parentId: `${ROOT}:tokens:3`,
        kind: 'tool_call',
        name: 'shell',
        status: 'error',
        // the two records carry one time: the duration is the output's
        startedAt: '2026-10-13T09:00:04.500Z',
        endedAt: at(6),
        durationMs: 1500,
        tool: { name: 'shell', isError: true, exitCode: 2, outputBytes: 45 },
        content: {
          outputPreview: 'ls: cannot access src/invoices: No such file\n',
        },
        attributes: {
          'runray.targetKey': targetKeyOf('ls'),
          'runray.targetKind': 'command',
          'runray.target': 'ls',
          'runray.toolActivity': 'explore',
          'runray.tool': 'ls',
        },
        provenance: { file, line: 5 },
      },
      {
        id: 'call_2',
        parentId: `${ROOT}:tokens:8`,
        kind: 'tool_call',
        name: 'shell',
        status: 'ok',
        startedAt: '2026-10-13T09:00:08.750Z',
        endedAt: at(9),
        durationMs: 250,
        tool: { name: 'shell', isError: false, exitCode: 0, outputBytes: 6 },
        attributes: {
          'runray.targetKey': targetKeyOf('pwd'),
          'runray.targetKind': 'command',
          'runray.target': 'pwd',
          'runray.toolActivity': 'system',
          'runray.tool': 'pwd',
        },
        provenance: { file, line: 8 },
      },
    ]);
  });

  it('hangs a legacy call from its own response when the token event is written after the items', async () => {
    const { raw } = await parseLines([
      rec(0, 'session_meta', { id: ROOT }),
      started(1, TURN_A),
      turnContext(1, 'gpt-5.5'),
      // CLI 0.77 and later: the items, then the token event; the output
      // is read before the event here
      functionCall(2, 'call_1', 'shell_command', { command: 'git status' }),
      functionOutput(
        4,
        'call_1',
        'Exit code: 128\nWall time: 1 seconds\nOutput:\nfatal: not a git repository\n',
      ),
      tokenCount(5, usageOf(1_000, 0, 50, 0), 1_050),
      assistantMessage(7, 'Not a repository.'),
      tokenCount(8, usageOf(2_000, 0, 80, 0), 3_130),
      completed(9, TURN_A),
    ]);
    expect(toolsOf(raw)).toMatchObject([
      {
        name: 'shell_command',
        parentId: `${ROOT}:tokens:5`,
        status: 'error',
        startedAt: at(3),
        endedAt: at(4),
        tool: { isError: true, exitCode: 128 },
        content: { outputPreview: 'fatal: not a git repository\n' },
      },
    ]);
    // a response does not begin when its own tool has finished
    expect(llmCallsOf(raw).map((s) => [s.id, s.startedAt, s.endedAt])).toEqual([
      [`${ROOT}:tokens:5`, at(1), at(5)],
      [`${ROOT}:tokens:8`, at(5), at(8)],
    ]);
  });

  it('counts harness actions, not model calls, as tool calls', async () => {
    const lines = [sessionMeta(0), started(1, TURN_A)];
    let actions = 0;
    for (let i = 0; i < 10; i++) {
      const sec = 2 + i * 4;
      lines.push(toolCall(sec, `call_${i}`));
      lines.push(usageRecord(sec + 1, TURN_A, `resp_${i}`));
      // ten calls, twelve actions: the first two ran two commands each
      for (let n = 0; n < (i < 2 ? 2 : 1); n++) {
        lines.push(
          action(sec + 2, TURN_A, command(`exec-${actions++}`), sec + 1),
        );
      }
      lines.push(toolOutput(sec + 3, `call_${i}`));
    }
    lines.push(completed(50, TURN_A));
    const { raw } = await parseLines(lines);
    expect(actions).toBe(12);
    expect(normalize(priceRun(raw)).totals.counts.toolCalls).toBe(12);
  });

  it('reads how a call ended from the head of its output', async () => {
    const outcome = async (name: string, output: unknown, redact = false) => {
      const { raw } = await parseLines(
        [
          sessionMeta(0),
          started(1, TURN_A),
          functionCall(2, 'call_1', name),
          usageRecord(3, TURN_A, 'resp_1'),
          functionOutput(6, 'call_1', output),
          completed(7, TURN_A),
        ],
        redact,
      );
      const [span] = toolsOf(raw);
      return {
        status: span?.status,
        tool: span?.tool,
        startedAt: span?.startedAt,
        preview: span?.content?.outputPreview,
      };
    };
    const failed = [
      {
        type: 'input_text',
        text: 'Script failed\nWall time 0.1 seconds\nOutput:\n',
      },
      {
        type: 'input_text',
        text: 'Script error:\nReferenceError: total is not defined',
      },
    ];
    expect(await outcome('exec', failed)).toEqual({
      status: 'error',
      // both text parts, head lines included: what the model was handed
      tool: { name: 'exec', isError: true, outputBytes: 43 + 51 },
      // a script's wall time is not taken: the two records bracket it
      startedAt: at(2),
      preview: 'Script error:\nReferenceError: total is not defined',
    });
    expect((await outcome('exec', failed, true)).preview).toBeNull();

    expect(
      await outcome(
        'wait',
        'Script running with cell ID 3\nWall time 30.0 seconds\nOutput:\n',
      ),
    ).toMatchObject({ status: 'ok', tool: { isError: false } });
    expect(
      await outcome(
        'wait',
        'Script terminated\nWall time 0.0 seconds\nOutput:\n',
      ),
    ).toMatchObject({ status: 'ok' });

    // a legacy command reports its exit code and its own duration
    const clean =
      'Exit code: 0\nWall time: 2.5 seconds\nOutput:\nOn branch main\n';
    expect(await outcome('shell_command', clean)).toEqual({
      status: 'ok',
      tool: {
        name: 'shell_command',
        isError: false,
        exitCode: 0,
        outputBytes: clean.length,
      },
      startedAt: '2026-10-13T09:00:03.500Z',
      preview: undefined,
    });
    // one that reports neither was never run
    expect(
      await outcome(
        'shell',
        'failed to parse function arguments: missing field',
      ),
    ).toMatchObject({
      status: 'error',
      tool: { name: 'shell', isError: true },
      preview: 'failed to parse function arguments: missing field',
    });
    // any other call has no outcome to read
    expect(await outcome('update_plan', 'Plan updated')).toEqual({
      status: 'ok',
      tool: { name: 'update_plan', isError: false, outputBytes: 12 },
      startedAt: at(2),
      preview: undefined,
    });
    expect(
      await outcome('view_image', [
        { type: 'input_image', image_url: 'data:x' },
      ]),
    ).toEqual({
      status: 'ok',
      tool: { name: 'view_image', isError: false },
      startedAt: at(2),
      preview: undefined,
    });
    // text that only looks like the JSON form is text
    expect(await outcome('update_plan', '{"ok": true}')).toMatchObject({
      status: 'ok',
      tool: { outputBytes: 12 },
    });
  });

  it('keeps a call with no output in progress, and closes a call on its first output only', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      toolCall(2, 'call_1'),
      usageRecord(3, TURN_A, 'resp_1'),
      scriptOutput(4, 'call_1', 'Script running with cell ID 2', ''),
      // written when the script left running ended
      rec(6, 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'call_1',
        output: 'Script failed\nOutput:\nlate',
      }),
      toolCall(7, 'call_2'), // line 7
      usageRecord(8, TURN_A, 'resp_2'),
    ]);
    expect(toolsOf(raw)).toMatchObject([
      { id: 'call_1', status: 'ok', startedAt: at(2), endedAt: at(4) },
      {
        id: 'call_2',
        parentId: 'resp_2',
        status: 'in_progress',
        startedAt: at(7),
      },
    ]);
    expect(toolsOf(raw)[1]).not.toHaveProperty('endedAt');
    expect(toolsOf(raw)[1]).not.toHaveProperty('durationMs');
  });

  it('does not give the actions of a new turn to a call the turn before left unanswered', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      toolCall(2, 'call_1'),
      aborted(3, TURN_A, 'interrupted'),
      started(4, TURN_B),
      action(6, TURN_B, command('exec-1')),
      action(8, TURN_B, command('exec-2'), 7),
      completed(9, TURN_B),
    ]);
    expect(toolRows(raw)).toEqual([
      `exec_command < ${TURN_B} ok`,
      `exec_command < ${TURN_B} ok`,
      `exec < ${TURN_A} in_progress`,
    ]);
  });

  it('names file changes, image views and extensions after the harness tool, and skips items that are no action', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      toolCall(2, 'call_1'),
      usageRecord(3, TURN_A, 'resp_1'),
      action(4, TURN_A, { type: 'Reasoning', id: 'rs_1', summary_text: [] }),
      action(4, TURN_A, { type: 'AgentMessage', id: 'msg_1', content: [] }),
      action(4, TURN_A, { type: 'TodoList', id: 'exec-0', items: [] }),
      action(
        5,
        TURN_A,
        {
          type: 'FileChange',
          id: 'exec-1',
          changes: {
            'C:\\work\\billing-portal\\src\\totals.ts': {
              type: 'add',
              content: 'x\n',
            },
          },
          status: 'failed',
          stdout: '',
          stderr: 'Failed to find expected lines in totals.ts\n',
        },
        4,
      ),
      action(
        6,
        TURN_A,
        { type: 'ImageView', id: 'exec-2', path: 'C:\\shots\\a.png' },
        6,
      ),
      action(
        7,
        TURN_A,
        {
          type: 'Extension',
          kind: 'web.search',
          id: 'exec-3',
          query: 'vat rounding rules',
        },
        6,
      ),
      toolOutput(8, 'call_1'),
      // called directly: the extension item carries the call id
      functionCall(9, 'call_s', 'sleep', { duration_ms: 2000 }),
      usageRecord(10, TURN_A, 'resp_2'),
      action(12, TURN_A, {
        type: 'Extension',
        kind: 'clock.sleep',
        id: 'call_s',
        durationMs: 2000,
      }),
      functionOutput(12, 'call_s', 'Slept'),
      // the same id twice: both are spans
      toolCall(13, 'call_3'),
      usageRecord(14, TURN_A, 'resp_3'),
      action(15, TURN_A, command('exec-1'), 14), // line 18
      toolOutput(16, 'call_3'),
      completed(17, TURN_A),
    ]);
    expect(
      toolsOf(raw).map((s) => [s.id, s.kind, s.name, s.parentId, s.status]),
    ).toEqual([
      ['exec-1', 'tool_call', 'apply_patch', 'resp_1', 'error'],
      ['exec-2', 'tool_call', 'view_image', 'resp_1', 'ok'],
      ['exec-3', 'tool_call', 'web.search', 'resp_1', 'ok'],
      ['call_s', 'tool_call', 'clock.sleep', 'resp_2', 'ok'],
      ['exec-1:18', 'tool_call', 'exec_command', 'resp_3', 'ok'],
    ]);
    const [patch, , , sleep] = toolsOf(raw);
    expect(patch?.content).toEqual({
      outputPreview: 'Failed to find expected lines in totals.ts\n',
    });
    expect(patch?.tool).toEqual({ name: 'apply_patch', isError: true });
    // no start time: the end less the time slept
    expect(sleep).toMatchObject({ startedAt: at(10), endedAt: at(12) });
    for (const text of [
      'totals.ts',
      'a.png',
      'vat rounding',
      'billing-portal',
    ]) {
      expect(
        JSON.stringify(toolsOf(raw).filter((s) => s !== patch)),
      ).not.toContain(text);
    }
  });
});

describe('codex commands', () => {
  const POSIX_HOME = '/home/dev/billing-portal';

  /** The span of one command action with the given `command`. */
  const commandSpan = async (
    argv: unknown,
    { redact = false, cwd }: { redact?: boolean; cwd?: string } = {},
  ) => {
    const { raw } = await parseLines(
      [
        sessionMeta(0, cwd === undefined ? {} : { cwd }),
        started(1, TURN_A),
        toolCall(2, 'call_1'),
        usageRecord(3, TURN_A, 'resp_1'),
        action(4, TURN_A, command('exec-1', { command: argv }), 3),
        toolOutput(5, 'call_1'),
        completed(6, TURN_A),
      ],
      redact,
    );
    return toolsOf(raw)[0];
  };
  /** The span of one legacy call to a shell tool, the era's command. */
  const callSpan = async (name: string, args: unknown, cwd?: string) => {
    const { raw } = await parseLines([
      sessionMeta(0, cwd === undefined ? {} : { cwd }),
      started(1, TURN_A),
      functionCall(2, 'call_1', name, args),
      tokenCount(3, SMALL, 110),
      functionOutput(4, 'call_1', '{"output":"","metadata":{"exit_code":0}}'),
      completed(5, TURN_A),
    ]);
    return toolsOf(raw)[0];
  };

  /** What a Claude Code `PowerShell` call with this command is stamped with. */
  async function claudePowerShell(commandText: string) {
    const project = join(tempDir(), 'project');
    mkdirSync(project, { recursive: true });
    const lines = [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 'sess-ps',
        timestamp: at(0),
        cwd: 'C:\\work\\billing-portal',
        message: { role: 'user', content: 'run the tests' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 'sess-ps',
        timestamp: at(1),
        cwd: 'C:\\work\\billing-portal',
        message: {
          id: 'msg_ps',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            {
              type: 'tool_use',
              id: 'tu_ps',
              name: 'PowerShell',
              input: { command: commandText },
            },
          ],
        },
      },
    ];
    writeFileSync(
      join(project, 'sess-ps.jsonl'),
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    );
    const [candidate] = await claudeCodeAdapter.detect([project]);
    const raw = await claudeCodeAdapter.parse(candidate as Candidate, {
      redact: false,
    });
    return raw.spans.find((s) => s.name === 'PowerShell')?.attributes;
  }

  it('takes the script out of a PowerShell wrapper: the identity of `pnpm test`, as in a Claude Code PowerShell call', async () => {
    const span = await commandSpan(['pwsh.exe', '-Command', 'pnpm test']);
    expect(span?.attributes).toEqual({
      'runray.targetKey': targetKeyOf('pnpm'),
      'runray.targetKind': 'command',
      'runray.target': 'pnpm',
      'runray.toolActivity': 'test',
      'runray.tool': 'pnpm',
      'runray.toolSub': 'run',
      'runray.toolScript': 'test',
    });
    // the same identity, key for key, as the other source's own shell tool
    expect(span?.attributes).toEqual(await claudePowerShell('pnpm test'));
    // the wrapper is not the identity, wherever it is installed
    const installed = await commandSpan([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      '-NoProfile',
      '-Command',
      'pnpm test',
    ]);
    expect(installed?.attributes).toEqual(span?.attributes);
    expect(span?.attributes['runray.targetKey']).not.toBe(targetKeyOf('pwsh'));
  });

  it('gives two commands behind the same wrapper two identities', async () => {
    const status = await commandSpan(['pwsh.exe', '-Command', 'git status']);
    const build = await commandSpan(['pwsh.exe', '-Command', 'pnpm build']);
    expect(status?.attributes['runray.targetKey']).toBe(targetKeyOf('git'));
    expect(build?.attributes['runray.targetKey']).toBe(targetKeyOf('pnpm'));
    expect(status?.attributes['runray.targetKey']).not.toBe(
      build?.attributes['runray.targetKey'],
    );
    expect(status?.attributes).toMatchObject({
      'runray.tool': 'git',
      'runray.toolSub': 'status',
      'runray.toolActivity': 'vcs',
    });
  });

  it('reads the script of a POSIX wrapper in the POSIX dialect', async () => {
    const cargo = await commandSpan(['bash', '-lc', 'cargo test']);
    expect(cargo?.attributes).toMatchObject({
      'runray.tool': 'cargo',
      'runray.toolSub': 'test',
      'runray.targetKey': targetKeyOf('cargo'),
    });
    // a backslash before a line break continues the line in bash, and is
    // an argument of its own in PowerShell: the wrapper decides which
    const continued = 'cargo \\\n  test';
    for (const shell of ['bash', '/usr/bin/zsh', 'sh', 'dash']) {
      const span = await commandSpan([shell, '-c', continued]);
      expect(span?.attributes['runray.toolSub'], shell).toBe('test');
    }
    const powershell = await commandSpan(['pwsh', '-Command', continued]);
    expect(powershell?.attributes['runray.tool']).toBe('cargo');
    expect(powershell?.attributes).not.toHaveProperty('runray.toolSub');
  });

  it('reads a script given as a bare string in PowerShell when the text or the thread says Windows', async () => {
    // the spec's example: a Windows path in the text
    const listed = await callSpan(
      'shell_command',
      { command: 'Get-ChildItem C:\\repo\\src | Select-Object -First 5' },
      POSIX_HOME,
    );
    expect(listed).toMatchObject({
      name: 'shell_command',
      attributes: {
        'runray.tool': 'get-childitem',
        'runray.toolActivity': 'explore',
        'runray.targetKey': targetKeyOf('Get-ChildItem'),
        'runray.targetKind': 'command',
      },
    });
    // a program by its Windows path is one word in PowerShell and several
    // glued together in POSIX: this tells the dialects apart
    const byPath = { command: 'C:\\tools\\node.exe build.mjs' };
    expect(
      (await callSpan('shell_command', byPath, POSIX_HOME))?.attributes,
    ).toMatchObject({ 'runray.tool': 'node', 'runray.toolSub': 'script' });
    // no backslash to go by: the thread's directory decides
    const quiet = { command: 'cargo \\\n  test', workdir: 'src' };
    expect(
      (await callSpan('shell_command', quiet, POSIX_HOME))?.attributes[
        'runray.toolSub'
      ],
    ).toBe('test');
    for (const windows of ['C:\\work\\billing-portal', '\\\\nas\\work']) {
      const span = await callSpan('shell_command', quiet, windows);
      expect(span?.attributes['runray.tool'], windows).toBe('cargo');
      expect(span?.attributes, windows).not.toHaveProperty('runray.toolSub');
    }
  });

  it('reads an argv with no shell in front as the command itself', async () => {
    expect((await commandSpan(['git', 'status']))?.attributes).toEqual({
      'runray.targetKey': targetKeyOf('git'),
      'runray.targetKind': 'command',
      'runray.target': 'git',
      'runray.toolActivity': 'vcs',
      'runray.tool': 'git',
      'runray.toolSub': 'status',
    });
    // a program path that would not read back as one word loses its folder
    const installed = await commandSpan([
      'C:\\Program Files\\Git\\bin\\git.exe',
      'status',
    ]);
    expect(installed?.attributes).toMatchObject({
      'runray.tool': 'git',
      'runray.toolSub': 'status',
      'runray.targetKey': targetKeyOf('git'),
    });
    // a shell with nothing behind it is a program like any other
    expect((await commandSpan(['bash']))?.attributes).toMatchObject({
      'runray.targetKey': targetKeyOf('bash'),
    });
  });

  it('keeps the identity and drops every word of the script under redaction', async () => {
    const argv = ['pwsh.exe', '-Command', 'pnpm test --filter invoices-eu'];
    const open = await commandSpan(argv);
    const redacted = await commandSpan(argv, { redact: true });
    expect(redacted?.attributes).toEqual({
      'runray.targetKey': open?.attributes['runray.targetKey'],
      'runray.targetKind': 'command',
      'runray.toolActivity': 'test',
      'runray.tool': 'pnpm',
      'runray.toolSub': 'run',
    });
    expect(redacted?.attributes).not.toHaveProperty('runray.target');
    for (const span of [open, redacted]) {
      for (const value of Object.values(span?.attributes ?? {})) {
        expect(String(value)).not.toContain('invoices-eu');
        expect(String(value)).not.toContain('--filter');
        expect(String(value)).not.toContain('pwsh');
      }
    }
  });

  it('reads the script handed to cmd by how it looks', async () => {
    const dir = await commandSpan(['cmd.exe', '/c', 'dir /b src']);
    expect(dir?.attributes).toMatchObject({
      'runray.tool': 'ls',
      'runray.targetKey': targetKeyOf('dir'),
    });
    const byPath = await commandSpan([
      'C:\\Windows\\System32\\cmd.exe',
      '/c',
      'C:\\tools\\node.exe build.mjs',
    ]);
    expect(byPath?.attributes).toMatchObject({ 'runray.tool': 'node' });
  });

  it('resolves in the tool-usage view to programs, not to the wrapper or the script tool', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      toolCall(2, 'call_1'),
      usageRecord(3, TURN_A, 'resp_1'),
      action(
        4,
        TURN_A,
        command('exec-1', { command: ['pwsh.exe', '-Command', 'pnpm test'] }),
        3,
      ),
      action(
        5,
        TURN_A,
        command('exec-2', {
          command: ['pwsh.exe', '-Command', 'acme-deploy --prod'],
        }),
        4,
      ),
      action(
        6,
        TURN_A,
        { type: 'Extension', kind: 'web.search', id: 'exec-3', query: 'q' },
        5,
      ),
      action(
        7,
        TURN_A,
        {
          type: 'McpToolCall',
          id: 'exec-4',
          server: 'linear',
          tool: 'list_issues',
          status: 'completed',
        },
        6,
      ),
      toolOutput(8, 'call_1'),
      functionCall(9, 'call_2', 'wait', { cell_id: 1 }),
      usageRecord(10, TURN_A, 'resp_2'),
      functionOutput(11, 'call_2', 'Script completed\nOutput:\n'),
      functionCall(12, 'call_3', 'request_user_input_async', {}),
      usageRecord(13, TURN_A, 'resp_3'),
      functionOutput(14, 'call_3', '{"accepted":true}'),
      toolCall(15, 'call_4'),
      usageRecord(16, TURN_A, 'resp_4'),
      toolOutput(17, 'call_4'),
      completed(18, TURN_A),
    ]);
    const run = normalize(priceRun(raw));
    const context = identityContext(run.spans);
    const rows = run.spans.flatMap((span) => {
      const id = toolIdentity(span, context);
      if (id === undefined) return [];
      const sub = id.sub === undefined ? '' : ` ${id.sub}`;
      return [`${id.family}:${id.key}${sub} (${id.activity})`];
    });
    expect(rows).toEqual([
      'shell:pnpm run (test)',
      'shell:other-command (other)',
      'harness:web.search (web)',
      'mcp:linear list_issues (integration)',
      'harness:wait (other)',
      'harness:request_user_input_async (human)',
      'harness:exec (other)',
    ]);
  });

  it('classifies a legacy shell call from its argv, wrapper and all', async () => {
    const span = await callSpan('shell', {
      command: [
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-Command',
        'npm run build',
      ],
      timeout_ms: 120_000,
    });
    expect(span).toMatchObject({
      name: 'shell',
      attributes: {
        'runray.tool': 'npm',
        'runray.toolActivity': 'build',
        'runray.targetKey': targetKeyOf('npm'),
      },
    });
    const posix = await callSpan('shell', {
      command: ['bash', '-lc', 'ls src'],
    });
    expect(posix?.attributes).toMatchObject({ 'runray.tool': 'ls' });
  });

  it('marks a command it cannot read as classified, of an activity nobody could tell', async () => {
    for (const unreadable of [undefined, 42, [], [7], '   ']) {
      const span = await commandSpan(unreadable);
      expect(span?.attributes, String(unreadable)).toEqual({
        'runray.toolActivity': 'other',
      });
    }
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      rec(2, 'response_item', {
        type: 'function_call',
        call_id: 'call_1',
        name: 'shell',
        arguments: '{"command": [',
      }),
      functionOutput(3, 'call_1', 'failed to parse function arguments'),
      completed(4, TURN_A),
    ]);
    expect(toolsOf(raw)[0]).toMatchObject({
      name: 'shell',
      status: 'error',
      attributes: { 'runray.toolActivity': 'other' },
    });
  });

  it('stamps nothing on a call that is not to a shell tool', async () => {
    const plan = await callSpan('update_plan', { command: 'pnpm test' });
    expect(plan).toMatchObject({ name: 'update_plan', attributes: {} });
  });
});

describe('codex MCP calls and extensions', () => {
  const mcp = (id: string, extra: Record<string, unknown> = {}) => ({
    type: 'McpToolCall',
    id,
    server: 'linear',
    tool: 'list_issues',
    arguments: { team: 'billing-secret' },
    pluginId: 'linear@acme',
    status: 'completed',
    result: {
      content: [
        { type: 'text', text: '[{"id":"BIL-1"}]' },
        { type: 'image', data: 'AAAAAAAAAAAAAAAA', mimeType: 'image/png' },
        { type: 'text', text: 'more' },
      ],
      isError: false,
    },
    duration: { secs: 0, nanos: 500_000_000 },
    ...extra,
  });
  /** A tool the model called directly: the call, the harness action that
   * carries the call's id, and the output handed back. */
  const direct = (
    name: string,
    item: Record<string, unknown>,
    output: unknown,
  ) => [
    sessionMeta(0),
    started(1, TURN_A),
    functionCall(2, 'call_1', name, { any: 'argument-text' }),
    usageRecord(3, TURN_A, 'resp_1'),
    action(5, TURN_A, { ...item, id: 'call_1' }, 3),
    functionOutput(5, 'call_1', output),
    completed(6, TURN_A),
  ];
  /** The same action run from inside an `exec` script. */
  const scripted = (item: Record<string, unknown>) => [
    sessionMeta(0),
    started(1, TURN_A),
    toolCall(2, 'call_1'),
    usageRecord(3, TURN_A, 'resp_1'),
    action(5, TURN_A, { ...item, id: 'exec-1' }, 3),
    toolOutput(6, 'call_1'),
    completed(7, TURN_A),
  ];
  const only = async (lines: string[], redact = false) => {
    const { raw } = await parseLines(lines, redact);
    expect(toolsOf(raw)).toHaveLength(1);
    return { span: toolsOf(raw)[0], raw };
  };

  it('reads an MCP tool run from a script: its server, its tool, and the size of the text it returned', async () => {
    const { span, raw } = await only(scripted(mcp('exec-1')));
    expect(span).toEqual({
      id: 'exec-1',
      parentId: 'resp_1',
      kind: 'mcp_call',
      name: 'list_issues',
      status: 'ok',
      startedAt: at(3),
      endedAt: at(5),
      durationMs: 2000,
      tool: {
        name: 'list_issues',
        mcpServer: 'linear',
        isError: false,
        // the two text parts; the image is not text
        outputBytes: '[{"id":"BIL-1"}]'.length + 'more'.length,
      },
      attributes: {},
      provenance: { file: span?.provenance.file, line: 5 },
    });
    // arguments, results and the plugin id stay in the file
    for (const text of ['billing-secret', 'BIL-1', 'AAAA', 'linear@acme']) {
      expect(JSON.stringify(raw.spans)).not.toContain(text);
    }
    const identity = toolIdentity(
      normalize(priceRun(raw)).spans.find(
        (s) => s.kind === 'mcp_call',
      ) as never,
    );
    expect(identity).toMatchObject({
      family: 'mcp',
      key: 'linear',
      sub: 'list_issues',
      activity: 'integration',
    });
  });

  it('gives an MCP tool the model called directly the size of what it was handed back', async () => {
    const handed = [
      {
        type: 'input_text',
        text: '[{"id":"BIL-1"}] and a note the harness added',
      },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ];
    const { span } = await only(direct('list_issues', mcp('call_1'), handed));
    expect(span).toMatchObject({
      id: 'call_1',
      kind: 'mcp_call',
      name: 'list_issues',
      status: 'ok',
      tool: {
        mcpServer: 'linear',
        outputBytes: '[{"id":"BIL-1"}] and a note the harness added'.length,
      },
    });
  });

  it('previews a failed MCP call from its result, or from the output of its call when the result has no text', async () => {
    const failing = {
      status: 'failed',
      result: {
        content: [{ type: 'text', text: 'Error: team not found' }],
        isError: true,
      },
    };
    const fromResult = await only(scripted(mcp('exec-1', failing)));
    expect(fromResult.span).toMatchObject({
      status: 'error',
      tool: { isError: true, outputBytes: 21 },
      content: { outputPreview: 'Error: team not found' },
    });
    const noText = { status: 'failed', result: { content: [], isError: true } };
    const fromOutput = await only(
      direct('list_issues', mcp('call_1', noText), [
        { type: 'input_text', text: 'tool call failed: connection reset' },
      ]),
    );
    expect(fromOutput.span).toMatchObject({
      status: 'error',
      content: { outputPreview: 'tool call failed: connection reset' },
    });
    // an `error` field instead of a result
    const errored = await only(
      scripted(
        mcp('exec-1', {
          status: 'failed',
          result: null,
          error: { message: 'timed out after 60s' },
        }),
      ),
    );
    expect(errored.span?.content).toEqual({
      outputPreview: 'timed out after 60s',
    });
    expect(errored.span?.tool).not.toHaveProperty('outputBytes');
    // under redaction a failure has a null preview, wherever its text is
    for (const lines of [
      scripted(mcp('exec-1', failing)),
      direct('list_issues', mcp('call_1', noText), 'tool call failed'),
    ]) {
      const { span, raw } = await only(lines, true);
      expect(span?.content).toEqual({ outputPreview: null });
      expect(JSON.stringify(raw.spans)).not.toContain('team not found');
      expect(JSON.stringify(raw.spans)).not.toContain('tool call failed');
    }
  });

  it('reads a web search as a span named web.search and keeps the query out', async () => {
    const { span, raw } = await only(
      scripted({
        type: 'Extension',
        kind: 'web.search',
        query: 'vat rounding rules poland',
        action: { type: 'search', query: 'vat rounding rules poland' },
        results: [{ title: 'Ministry page', url: 'https://example.test/vat' }],
      }),
    );
    expect(span).toMatchObject({
      id: 'exec-1',
      parentId: 'resp_1',
      kind: 'tool_call',
      name: 'web.search',
      status: 'ok',
      startedAt: at(3),
      endedAt: at(5),
      tool: { name: 'web.search', isError: false },
      attributes: {},
    });
    expect(span?.tool).not.toHaveProperty('outputBytes');
    for (const text of ['rounding', 'Ministry', 'example.test']) {
      expect(JSON.stringify(raw.spans)).not.toContain(text);
    }
    expect(toolIdentity(span as never)).toMatchObject({
      family: 'harness',
      key: 'web.search',
      activity: 'web',
    });
  });

  it('reads a sleep as a span named clock.sleep, not as the call that asked for it', async () => {
    const { span } = await only(
      direct(
        'sleep',
        { type: 'Extension', kind: 'clock.sleep', durationMs: 2000 },
        'Slept for 2000 ms',
      ),
    );
    expect(span).toMatchObject({
      id: 'call_1',
      parentId: 'resp_1',
      kind: 'tool_call',
      name: 'clock.sleep',
      status: 'ok',
      startedAt: at(3),
      endedAt: at(5),
      durationMs: 2000,
      tool: { name: 'clock.sleep', isError: false, outputBytes: 17 },
    });
  });

  it('reads an image generation as a span named image_gen.generation, failed or not', async () => {
    const generation = (extra: Record<string, unknown>) => ({
      type: 'Extension',
      kind: 'image_gen.generation',
      revisedPrompt: 'a lighthouse at dusk, watercolour',
      transparentBackground: null,
      failure: null,
      ...extra,
    });
    const done = await only(
      direct(
        'imagegen',
        generation({
          status: 'completed',
          result: 'iVBORw0KGgoAAAANSUhEUg',
          savedPath: 'C:\\Users\\dev\\Pictures\\lighthouse.png',
        }),
        [
          { type: 'input_text', text: 'Image saved.' },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0K' },
        ],
      ),
    );
    expect(done.span).toMatchObject({
      id: 'call_1',
      kind: 'tool_call',
      name: 'image_gen.generation',
      status: 'ok',
      tool: { name: 'image_gen.generation', isError: false, outputBytes: 12 },
    });
    for (const text of ['lighthouse', 'iVBOR', 'Pictures']) {
      expect(JSON.stringify(done.raw.spans)).not.toContain(text);
    }
    // a failed generation says nothing itself; its call's output does
    const failed = await only(
      direct(
        'imagegen',
        generation({ status: 'failed', result: '' }),
        'Image generation failed: the request was rejected',
      ),
    );
    expect(failed.span).toMatchObject({
      status: 'error',
      tool: { isError: true },
      content: {
        outputPreview: 'Image generation failed: the request was rejected',
      },
    });
    // its own reason, when it gives one
    const reasoned = await only(
      scripted(generation({ status: 'failed', failure: 'quota exceeded' })),
    );
    expect(reasoned.span?.content).toEqual({ outputPreview: 'quota exceeded' });
  });

  it('reads an image view as a span named view_image and keeps the path out', async () => {
    const { span, raw } = await only(
      scripted({ type: 'ImageView', path: 'C:\\shots\\checkout-page.png' }),
    );
    expect(span).toMatchObject({
      id: 'exec-1',
      kind: 'tool_call',
      name: 'view_image',
      status: 'ok',
      tool: { name: 'view_image', isError: false },
      attributes: {},
    });
    expect(JSON.stringify(raw.spans)).not.toContain('checkout');
    expect(toolIdentity(span as never)).toMatchObject({ activity: 'explore' });
  });

  it('names an extension of a kind it has not seen by that kind', async () => {
    const { span } = await only(
      scripted({
        type: 'Extension',
        kind: 'calendar.lookup',
        status: 'failed',
      }),
    );
    expect(span).toMatchObject({
      name: 'calendar.lookup',
      status: 'error',
      tool: { name: 'calendar.lookup', isError: true },
    });
    const nameless = await only(scripted({ type: 'Extension' }));
    expect(nameless.span?.name).toBe('extension');
  });
});

describe('codex file changes', () => {
  const TOTALS = 'C:\\work\\billing-portal\\src\\totals.ts';
  const README = 'C:\\work\\billing-portal\\README.md';
  /** The key a Claude Code `Edit` of the same file gets. */
  const fileKeyOf = (path: string) =>
    extractToolTarget('claude-code', 'Edit', { file_path: path })?.key;
  const update = (unified_diff: string) => ({
    type: 'update',
    unified_diff,
    move_path: null,
  });
  const fileChange = (
    changes: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'FileChange',
    id: 'exec-1',
    changes,
    status: 'completed',
    stdout: 'Success. Updated the following files:\nM src/totals.ts\n',
    stderr: '',
    ...extra,
  });
  /** The span of one file change action. */
  const changeSpan = async (item: Record<string, unknown>, redact = false) => {
    const { raw } = await parseLines(
      [
        sessionMeta(0),
        started(1, TURN_A),
        toolCall(2, 'call_1'),
        usageRecord(3, TURN_A, 'resp_1'),
        action(4, TURN_A, item, 3),
        toolOutput(5, 'call_1'),
        completed(6, TURN_A),
      ],
      redact,
    );
    expect(toolsOf(raw)).toHaveLength(1);
    return { span: toolsOf(raw)[0], raw };
  };
  const linesOf = async (diff: string) => {
    const { span } = await changeSpan(fileChange({ [TOTALS]: update(diff) }));
    return [span?.tool?.linesAdded, span?.tool?.linesRemoved];
  };

  it('counts an update from its diff and gives a change of one file that file as its target', async () => {
    const diff = '@@ -1,3 +1,5 @@\n a\n-b\n+B\n+c\n+d\n e\n';
    const { span } = await changeSpan(fileChange({ [TOTALS]: update(diff) }));
    expect(span).toMatchObject({
      kind: 'tool_call',
      name: 'apply_patch',
      status: 'ok',
      tool: {
        name: 'apply_patch',
        isError: false,
        linesAdded: 3,
        linesRemoved: 1,
      },
    });
    expect(span?.attributes).toEqual({
      'runray.targetKey': fileKeyOf(TOTALS),
      'runray.targetKind': 'file-write',
      'runray.target': 'totals.ts',
    });
    // the same file under any spelling of its separators
    expect(span?.attributes['runray.targetKey']).toBe(
      fileKeyOf('C:/work/billing-portal/src/totals.ts'),
    );
  });

  it('does not count the header lines of a diff, and does count a changed line that looks like one', async () => {
    // headers in front of the first hunk
    expect(
      await linesOf(
        '--- a/src/totals.ts\n+++ b/src/totals.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n',
      ),
    ).toEqual([1, 1]);
    // a removed SQL comment and an added `++` line, inside a hunk
    expect(
      await linesOf(
        '@@ -1,2 +1,2 @@\n--- drop the legacy table\n+++i;\n keep\n',
      ),
    ).toEqual([1, 1]);
    // headers of a second file after a complete hunk
    expect(
      await linesOf(
        '@@ -1 +1 @@\n-a\n+b\n--- a/other.ts\n+++ b/other.ts\n@@ -4,2 +4,3 @@\n x\n+y\n z\n',
      ),
    ).toEqual([2, 1]);
    // several hunks, CRLF line ends and the no-newline marker
    expect(
      await linesOf(
        '@@ -1,2 +1,2 @@\r\n-a\r\n+b\r\n c\r\n@@ -9 +9,2 @@\r\n d\r\n+e\r\n\\ No newline at end of file\r\n',
      ),
    ).toEqual([2, 1]);
    // a hunk that does not state its size, as a patch body writes it
    expect(await linesOf('@@\n-a\n+b\n+c\n d\n')).toEqual([2, 1]);
    // no hunk header at all: line by line, headers left out
    expect(await linesOf('--- a/x\n+++ b/x\n-a\n+b\n+c\n')).toEqual([2, 1]);
    expect(await linesOf('')).toEqual([0, 0]);
  });

  it('sums the lines over every file of a change, and names no target when there are several', async () => {
    const tenLines = `${Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const { span } = await changeSpan(
      fileChange({
        [README]: { type: 'add', content: tenLines },
        [TOTALS]: update('@@ -4,2 +4,4 @@\n a\n+b\n+c\n d\n'),
      }),
    );
    expect(span?.tool).toEqual({
      name: 'apply_patch',
      isError: false,
      linesAdded: 12,
      linesRemoved: 0,
    });
    expect(span?.attributes).toEqual({});
  });

  it('counts a deleted file as removed lines and an added one with no final line break in full', async () => {
    const removed = await changeSpan(
      fileChange({ [README]: { type: 'delete', content: 'a\nb\nc\n' } }),
    );
    expect(removed.span?.tool).toMatchObject({
      linesAdded: 0,
      linesRemoved: 3,
    });
    const added = await changeSpan(
      fileChange({ [README]: { type: 'add', content: 'a\nb' } }),
    );
    expect(added.span?.tool).toMatchObject({ linesAdded: 2, linesRemoved: 0 });
    const empty = await changeSpan(
      fileChange({ [README]: { type: 'add', content: '' } }),
    );
    expect(empty.span?.tool).toMatchObject({ linesAdded: 0, linesRemoved: 0 });
  });

  it('reads a failed change as an error with no line counts', async () => {
    const { span } = await changeSpan(
      fileChange(
        { [TOTALS]: update('@@ -1 +1,2 @@\n a\n+b\n') },
        {
          status: 'failed',
          stdout: '',
          stderr: 'Failed to find expected lines in src/totals.ts\n',
        },
      ),
    );
    expect(span).toMatchObject({
      name: 'apply_patch',
      status: 'error',
      content: {
        outputPreview: 'Failed to find expected lines in src/totals.ts\n',
      },
    });
    expect(span?.tool).toEqual({ name: 'apply_patch', isError: true });
    // which file it was aimed at is still its identity
    expect(span?.attributes['runray.targetKey']).toBe(fileKeyOf(TOTALS));
  });

  it('keeps the file key and drops the file name and every changed line under redaction', async () => {
    const item = fileChange({
      [TOTALS]: update(
        '@@ -1 +1,2 @@\n const vat = 0.23;\n+const secretRate = 0.08;\n',
      ),
    });
    const { span, raw } = await changeSpan(item, true);
    expect(span?.attributes).toEqual({
      'runray.targetKey': fileKeyOf(TOTALS),
      'runray.targetKind': 'file-write',
    });
    expect(span?.tool).toMatchObject({ linesAdded: 1, linesRemoved: 0 });
    for (const text of ['totals', 'secretRate', 'vat']) {
      expect(JSON.stringify(raw.spans)).not.toContain(text);
    }
    // no line of a diff is kept unredacted either: only the file's name
    const open = await changeSpan(item);
    expect(JSON.stringify(open.raw.spans)).not.toContain('secretRate');
    expect(open.span?.attributes['runray.target']).toBe('totals.ts');
  });

  const PATCH = [
    '*** Begin Patch',
    '*** Update File: src/totals.ts',
    '@@',
    ' const vat = 0.23;',
    '-const net = gross;',
    '+const net = gross / (1 + vat);',
    '+const tax = gross - net;',
    '*** End Patch',
  ].join('\n');
  const TWO_FILES = [
    '*** Begin Patch',
    '*** Add File: docs/vat.md',
    '+# VAT',
    '+Rates per country.',
    '*** Delete File: docs/old.md',
    '*** End Patch',
  ].join('\n');
  /** One legacy call and its output, parsed. */
  const legacySpans = async (call: string, output: unknown) => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      tokenCount(2, SMALL, 110),
      call,
      functionOutput(3, 'call_1', output),
      completed(4, TURN_A),
    ]);
    return toolsOf(raw);
  };
  const DONE = JSON.stringify({
    output: 'Success. Updated the following files:\nM src/totals.ts\n',
    metadata: { exit_code: 0, duration_seconds: 0.5 },
  });

  it('reads a legacy shell call that runs apply_patch as the file change it is', async () => {
    const spans = await legacySpans(
      functionCall(3, 'call_1', 'shell', { command: ['apply_patch', PATCH] }),
      DONE,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      id: 'call_1',
      kind: 'tool_call',
      name: 'apply_patch',
      status: 'ok',
      tool: {
        name: 'apply_patch',
        isError: false,
        exitCode: 0,
        linesAdded: 2,
        linesRemoved: 1,
      },
    });
    // a path the patch gives from the working directory is the same file
    // as the one a current rollout names in full; no command identity
    expect(spans[0]?.attributes).toEqual({
      'runray.targetKey': fileKeyOf(TOTALS),
      'runray.targetKind': 'file-write',
      'runray.target': 'totals.ts',
    });
  });

  it('reads the other two legacy forms the same way: the patch tool and a here-document', async () => {
    const tool = await legacySpans(
      rec(3, 'response_item', {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'apply_patch',
        input: PATCH,
      }),
      DONE,
    );
    const heredoc = await legacySpans(
      functionCall(3, 'call_1', 'shell', {
        command: ['bash', '-lc', `apply_patch <<'EOF'\n${PATCH}\nEOF`],
      }),
      DONE,
    );
    for (const [span] of [tool, heredoc]) {
      expect(span).toMatchObject({
        name: 'apply_patch',
        tool: { linesAdded: 2, linesRemoved: 1 },
        attributes: { 'runray.targetKey': fileKeyOf(TOTALS) },
      });
      expect(span?.attributes).not.toHaveProperty('runray.toolActivity');
    }
    // two files: no one target; a deleted file's lines are not in a patch
    const [several] = await legacySpans(
      functionCall(3, 'call_1', 'shell', {
        command: ['apply_patch', TWO_FILES],
      }),
      DONE,
    );
    expect(several?.tool).toMatchObject({ linesAdded: 2, linesRemoved: 0 });
    expect(several?.attributes).toEqual({});
  });

  it('gives a legacy patch the harness refused no line counts', async () => {
    const [span] = await legacySpans(
      functionCall(3, 'call_1', 'shell', { command: ['apply_patch', PATCH] }),
      'apply_patch verification failed: Failed to find expected lines',
    );
    expect(span).toMatchObject({ name: 'apply_patch', status: 'error' });
    expect(span?.tool).toEqual({
      name: 'apply_patch',
      isError: true,
      outputBytes: 62,
    });
  });

  it('keeps a command that only mentions apply_patch a command', async () => {
    const [span] = await legacySpans(
      functionCall(3, 'call_1', 'shell', {
        command: ['bash', '-lc', 'rg apply_patch src'],
      }),
      DONE,
    );
    expect(span).toMatchObject({
      name: 'shell',
      attributes: { 'runray.tool': 'rg' },
    });
    expect(span?.tool).not.toHaveProperty('linesAdded');
  });

  it('emits one span for a legacy patch call that also has a file change item', async () => {
    const { raw } = await parseLines([
      sessionMeta(0),
      started(1, TURN_A),
      tokenCount(2, SMALL, 110),
      rec(3, 'response_item', {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'apply_patch',
        input: PATCH,
      }),
      // the item carries the call's id and the paths in full
      action(4, TURN_A, {
        ...fileChange({
          [TOTALS]: update('@@ -1,2 +1,3 @@\n a\n-b\n+B\n+c\n'),
        }),
        id: 'call_1',
      }),
      functionOutput(4, 'call_1', DONE),
      completed(5, TURN_A),
    ]);
    expect(toolsOf(raw)).toHaveLength(1);
    expect(toolsOf(raw)[0]).toMatchObject({
      id: 'call_1',
      name: 'apply_patch',
      tool: { linesAdded: 2, linesRemoved: 1 },
      attributes: { 'runray.targetKey': fileKeyOf(TOTALS) },
    });
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
        const [session] = raw.spans;
        expect(new Set(raw.spans.map((s) => s.id)).size).toBe(raw.spans.length);
        for (const turn of turnsOf(raw)) {
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

  it('emits null previews and nothing else as content on every fixture under redaction', async () => {
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
          } else if (span.kind === 'llm_call') {
            expect(span.content).toEqual({ outputPreview: null });
          } else if (span.status === 'error' || span.status === 'cancelled') {
            // a tool that failed: its preview is the one output kept
            expect(span.content).toEqual({ outputPreview: null });
          } else expect(span).not.toHaveProperty('content');
        }
      }
    }
  });

  /** Tool spans of a run counted by name (an MCP call as `mcp`), failures
   * apart. */
  const toolTally = (raw: RawRun) => {
    const out: Record<string, number> = {};
    for (const s of toolsOf(raw)) {
      const name = s.kind === 'mcp_call' ? 'mcp' : s.name;
      const key = s.status === 'ok' ? name : `${name} ${s.status}`;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };

  const ACTION_TYPES = new Set([
    'CommandExecution',
    'FileChange',
    'McpToolCall',
    'Extension',
    'ImageView',
  ]);

  /** Harness actions and the calls nothing came of, counted from the file
   * apart from the adapter: calls as time windows, the action's owner
   * looked up among them. */
  async function toolCountsOf(file: string) {
    interface Call {
      from: number;
      to: number;
      turn: string | undefined;
      answered: boolean;
      actions: number;
    }
    const calls = new Map<string, Call>();
    const lastAnswered = new Map<string, Call>();
    const turnIds = new Set<string>();
    let waiting: Call[] = [];
    let current: string | undefined;
    let actions = 0;
    for await (const { text } of readRolloutLines(file)) {
      if (text === '') continue;
      const record = JSON.parse(text);
      const payload = record.payload ?? {};
      const now = Date.parse(record.timestamp);
      if (record.type === 'event_msg') {
        if (payload.type === 'task_started') {
          current = payload.turn_id;
          turnIds.add(payload.turn_id);
          for (const call of waiting) call.to = now;
          waiting = [];
        } else if (
          payload.type === 'task_complete' ||
          payload.type === 'turn_aborted'
        ) {
          if (payload.turn_id === current) current = undefined;
        } else if (
          payload.type === 'item_completed' &&
          ACTION_TYPES.has(payload.item?.type)
        ) {
          actions++;
          const turn = turnIds.has(payload.turn_id) ? payload.turn_id : current;
          const began: number | undefined = payload.started_at_ms;
          const owner =
            calls.get(payload.item.id) ??
            (began === undefined
              ? undefined
              : [...calls.values()]
                  .reverse()
                  .find((c) => c.from <= began && began <= c.to)) ??
            waiting.at(-1) ??
            (turn === undefined ? undefined : lastAnswered.get(turn));
          if (owner !== undefined) owner.actions++;
        }
      } else if (
        record.type === 'response_item' &&
        typeof payload.call_id === 'string'
      ) {
        if (payload.type.endsWith('_call')) {
          const call: Call = {
            from: now,
            to: Number.POSITIVE_INFINITY,
            turn: current,
            answered: false,
            actions: 0,
          };
          calls.set(payload.call_id, call);
          waiting.push(call);
        } else if (payload.type.endsWith('_output')) {
          const call = calls.get(payload.call_id);
          if (call === undefined || call.answered) continue;
          call.answered = true;
          call.to = now;
          waiting = waiting.filter((c) => c !== call);
          if (call.turn !== undefined) lastAnswered.set(call.turn, call);
        }
      }
    }
    const bare = [...calls.values()].filter((c) => c.actions === 0).length;
    return { actions, calls: calls.size, bare };
  }

  it('emits as many tool spans as the file has actions and calls nothing came of', async () => {
    for (const variant of [
      'simple',
      'guardian',
      'tool-errors',
      'legacy',
      'compaction',
    ]) {
      for (const raw of await parseVariant(variant)) {
        const counts = await toolCountsOf(raw.source.files[0] ?? '');
        expect(toolsOf(raw), variant).toHaveLength(
          counts.actions + counts.bare,
        );
        if (variant === 'tool-errors') {
          // both kinds are there to be counted, and most calls are no span
          expect(counts.actions).toBeGreaterThan(100);
          expect(counts.bare).toBeGreaterThan(10);
          expect(counts.bare).toBeLessThan(counts.calls / 2);
        }
      }
    }
  });

  it('reads the tools the fixtures README lists', async () => {
    // simple: 14 commands, 2 file changes, 1 MCP call, 17 extension items,
    // every one of them run by an `exec` script that is no span itself
    const [simple] = await parseVariant('simple');
    expect(toolTally(simple as RawRun)).toEqual({
      exec_command: 14,
      apply_patch: 2,
      mcp: 1,
      'web.search': 17,
    });

    // guardian: 69 commands of which 7 failed, 15 file changes, 3 MCP calls
    const [guardian] = await parseVariant('guardian');
    expect(toolTally(guardian as RawRun)).toMatchObject({
      exec_command: 62,
      'exec_command error': 7,
      apply_patch: 15,
      mcp: 3,
    });

    // tool-errors: 17 failed commands and 1 failed file change in the
    // first thread; 10 failed commands, 4 failed MCP calls and 3 failed
    // scripts in the second. A failed script is a span only when no
    // command of it was recorded, which leaves 2 of the first thread's 3.
    const [first, second] = await parseVariant('tool-errors');
    expect(toolTally(first as RawRun)).toMatchObject({
      'exec_command error': 17,
      'apply_patch error': 1,
      'exec error': 2,
    });
    expect(toolTally(second as RawRun)).toMatchObject({
      'exec_command error': 10,
      'mcp error': 4,
      'exec error': 3,
    });

    // legacy: the call is the command. 23 `shell` calls: 7 of them send a
    // patch as `["apply_patch", …]` and are file changes, 2 of which the
    // harness refused; 2 of the other 16 end with a non-zero exit. Then 5
    // `shell_command` calls.
    const [old, newer] = await parseVariant('legacy');
    expect(toolTally(old as RawRun)).toEqual({
      shell: 14,
      'shell error': 2,
      apply_patch: 5,
      'apply_patch error': 2,
      update_plan: 2,
    });
    expect(
      toolsOf(old as RawRun).filter((s) => (s.tool?.exitCode ?? 0) !== 0),
    ).toHaveLength(2);
    expect(toolTally(newer as RawRun)).toEqual({
      shell_command: 4,
      'shell_command error': 1,
      view_image: 3,
      'image_gen.generation': 2,
      load_workspace_dependencies: 1,
    });

    // compaction: a reviewer thread, which runs no tools
    const [review] = await parseVariant('compaction');
    expect(toolsOf(review as RawRun)).toEqual([]);
  });

  /** Lines the file changes of a rollout added and removed, counted from
   * the file apart from the adapter: every `+` and `-` line of a diff
   * (Codex writes no header lines into one), every line of an added or a
   * deleted file. Failed changes changed nothing. */
  async function changedLinesOf(file: string) {
    const lineCount = (text: string) =>
      text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    let added = 0;
    let removed = 0;
    let changes = 0;
    let singlePath = 0;
    for await (const { text } of readRolloutLines(file)) {
      if (!text.includes('"FileChange"')) continue;
      const item = JSON.parse(text).payload?.item;
      if (item?.type !== 'FileChange') continue;
      changes++;
      const entries = Object.values(item.changes) as Array<{
        type: string;
        content?: string;
        unified_diff?: string;
      }>;
      if (entries.length === 1) singlePath++;
      if (item.status === 'failed') continue;
      for (const change of entries) {
        if (change.type === 'add') added += lineCount(change.content ?? '');
        else if (change.type === 'delete') {
          removed += lineCount(change.content ?? '');
        } else {
          for (const line of (change.unified_diff ?? '').split('\n')) {
            if (line.startsWith('+')) added++;
            else if (line.startsWith('-')) removed++;
          }
        }
      }
    }
    return { added, removed, changes, singlePath };
  }

  it('reads the MCP calls and every extension kind of the fixtures', async () => {
    /** MCP spans as `server/tool`, the others by name; failures apart. */
    const kinds = (raw: RawRun | undefined) => {
      const out: Record<string, number> = {};
      for (const s of toolsOf(raw as RawRun)) {
        const isMcp = s.kind === 'mcp_call';
        if (!isMcp && !/[.]|^view_image$/.test(s.name)) continue;
        const name = isMcp ? `${s.tool?.mcpServer}/${s.name}` : s.name;
        const key = s.status === 'ok' ? name : `${name} ${s.status}`;
        out[key] = (out[key] ?? 0) + 1;
      }
      return out;
    };
    const [simple] = await parseVariant('simple');
    expect(kinds(simple)).toEqual({
      'codex_app/open_in_codex': 1,
      'web.search': 17,
    });

    const [guardian] = await parseVariant('guardian');
    expect(kinds(guardian)).toEqual({
      'codex_app/list_threads': 1,
      'codex_app/open_in_codex': 1,
      'codex_app/read_thread': 1,
      'clock.sleep': 6,
      'web.search': 2,
    });
    // each sleep is the `sleep` call the model made, which is no span
    const sleeps = toolsOf(guardian as RawRun).filter(
      (s) => s.name === 'clock.sleep',
    );
    expect(sleeps.every((s) => s.id.startsWith('call_'))).toBe(true);
    expect(sleeps.every((s) => (s.durationMs ?? 0) >= 1000)).toBe(true);
    expect(toolsOf(guardian as RawRun).some((s) => s.name === 'sleep')).toBe(
      false,
    );

    // the second tool-errors thread drives a browser through an MCP
    // server: 54 calls the model made directly, 4 of them failed
    const [, second] = await parseVariant('tool-errors');
    expect(kinds(second)).toEqual({
      'codex_app/load_workspace_dependencies': 1,
      'codex_app/open_in_codex': 2,
      'cua_repl/js': 50,
      'cua_repl/js error': 4,
      view_image: 1,
    });
    const js = toolsOf(second as RawRun).filter((s) => s.name === 'js');
    expect(js).toHaveLength(54);
    for (const span of js) {
      expect(span.kind).toBe('mcp_call');
      // what the model was handed back for the call
      expect(span.tool?.outputBytes).toBeGreaterThan(0);
      expect(span.attributes).toEqual({});
      if (span.status === 'error') {
        expect(span.content?.outputPreview).toBeTypeOf('string');
      } else expect(span).not.toHaveProperty('content');
    }

    // image generations of the legacy thread that has them
    const [, newer] = await parseVariant('legacy');
    const generations = toolsOf(newer as RawRun).filter(
      (s) => s.name === 'image_gen.generation',
    );
    expect(generations).toHaveLength(2);
    expect(generations.every((s) => s.status === 'ok')).toBe(true);
    expect(toolsOf(newer as RawRun).some((s) => s.name === 'imagegen')).toBe(
      false,
    );

    // in the tool-usage view: MCP by server, the rest by their kind
    const run = normalize(priceRun(second as RawRun));
    const context = identityContext(run.spans);
    const families = new Set(
      run.spans.flatMap((s) => {
        const id = toolIdentity(s, context);
        return id?.family === 'mcp' ? [`${id.key} (${id.activity})`] : [];
      }),
    );
    expect([...families].sort()).toEqual([
      'codex_app (integration)',
      'cua_repl (integration)',
    ]);
  });

  it('counts the lines the file changes of a rollout added and removed', async () => {
    for (const variant of ['simple', 'guardian', 'tool-errors']) {
      for (const raw of await parseVariant(variant)) {
        const expected = await changedLinesOf(raw.source.files[0] ?? '');
        const patches = toolsOf(raw).filter((s) => s.name === 'apply_patch');
        expect(patches, variant).toHaveLength(expected.changes);
        expect(expected.added, variant).toBeGreaterThan(0);
        expect(normalize(priceRun(raw)).totals.codeChanges, variant).toEqual({
          linesAdded: expected.added,
          linesRemoved: expected.removed,
        });
        // file identity exactly where the change names one file
        expect(
          patches.filter((s) => s.attributes['runray.targetKey'] !== undefined),
          variant,
        ).toHaveLength(expected.singlePath);
      }
    }
    // the legacy era has the patch text only: 5 patches went through
    const [old] = await parseVariant('legacy');
    const totals = normalize(priceRun(old as RawRun)).totals.codeChanges;
    expect(totals?.linesAdded).toBeGreaterThan(0);
    expect(totals?.linesRemoved).toBeGreaterThan(0);
  });

  it('hangs every tool span from a call or a turn of its file, with times in order', async () => {
    for (const variant of ['simple', 'guardian', 'tool-errors', 'legacy']) {
      for (const raw of await parseVariant(variant)) {
        const byId = new Map(raw.spans.map((s) => [s.id, s]));
        for (const tool of toolsOf(raw)) {
          const parent = byId.get(tool.parentId ?? '');
          expect(['llm_call', 'turn']).toContain(parent?.kind);
          expect(tool.tool?.name).toBe(tool.name);
          expect(tool.tool?.isError).toBe(tool.status === 'error');
          expect(tool.endedAt).toBeDefined();
          expect(tool.startedAt <= (tool.endedAt ?? '')).toBe(true);
          // a command is classified, whatever its (scrubbed) script; a
          // file change has the identity of its file when it has one file;
          // no other tool carries an attribute
          if (['exec_command', 'shell', 'shell_command'].includes(tool.name)) {
            expect(tool.attributes['runray.toolActivity']).toBeTypeOf('string');
          } else if (tool.name === 'apply_patch') {
            if (Object.keys(tool.attributes).length > 0) {
              expect(tool.attributes).toEqual({
                'runray.targetKey': expect.stringMatching(/^[0-9a-f]{16}$/),
                'runray.targetKind': 'file-write',
                'runray.target': expect.any(String),
              });
            }
            // line counts on success, and only then
            expect(tool.tool?.linesAdded !== undefined).toBe(
              tool.status === 'ok',
            );
            expect(tool.tool?.linesRemoved !== undefined).toBe(
              tool.status === 'ok',
            );
          } else expect(tool.attributes).toEqual({});
          expect(tool.provenance.line).toBeGreaterThan(1);
          if (tool.status !== 'ok') {
            expect(
              tool.content?.outputPreview?.length ?? 0,
            ).toBeLessThanOrEqual(200);
          }
        }
      }
    }
  });

  /** Tokens of every model call of a run, the five parts added up. */
  const tokenSum = (raw: RawRun) =>
    llmCallsOf(raw).reduce((sum, s) => {
      const t = s.llm?.tokens;
      return t === undefined
        ? sum
        : sum +
            t.input +
            t.output +
            t.cacheRead +
            t.cacheWrite +
            (t.reasoning ?? 0);
    }, 0);

  /** What the file itself says, read apart from the adapter: the number of
   * usage records, the thread total in the last of them, and the running
   * total in the last token event. */
  async function countersOf(file: string) {
    let usageRecords = 0;
    let threadTotal: number | undefined;
    let runningTotal: number | undefined;
    for await (const { text } of readRolloutLines(file)) {
      if (text === '') continue;
      const record = JSON.parse(text);
      const payload = record.payload ?? {};
      if (record.type === 'token_usage_record') {
        usageRecords++;
        threadTotal = payload.thread_token_usage?.total_tokens;
      } else if (record.type === 'event_msg' && payload.info) {
        runningTotal = payload.info.total_token_usage?.total_tokens;
      }
    }
    return { usageRecords, threadTotal, runningTotal };
  }

  it('sums the calls of a root thread to the thread total its last usage record shows', async () => {
    for (const variant of ['simple', 'zstd', 'guardian', 'tool-errors']) {
      for (const raw of await parseVariant(variant)) {
        const file = raw.source.files[0] ?? '';
        const counters = await countersOf(file);
        expect(counters.usageRecords, variant).toBeGreaterThan(0);
        expect(llmCallsOf(raw), variant).toHaveLength(counters.usageRecords);
        expect(tokenSum(raw), variant).toBe(counters.threadTotal);
      }
    }
  });

  it('sums the calls of a legacy rollout to the last running total of its token events', async () => {
    const [old, newer] = await parseVariant('legacy');
    for (const raw of [old, newer] as RawRun[]) {
      const counters = await countersOf(raw.source.files[0] ?? '');
      expect(counters.usageRecords).toBe(0);
      expect(tokenSum(raw)).toBe(counters.runningTotal);
    }
    // 56 token events in the first file: one has no counters and 27 repeat
    // the total before them; none of the 12 in the second repeats
    expect(llmCallsOf(old as RawRun)).toHaveLength(28);
    expect(llmCallsOf(newer as RawRun)).toHaveLength(12);
    expect(llmCallsOf(old as RawRun)[0]?.llm).toMatchObject({
      provider: 'unknown',
      model: 'gpt-5',
    });
    expect(llmCallsOf(newer as RawRun)[0]?.llm).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.5',
    });
  });

  it('gives the last call of a legacy turn the text the turn ended on, in either record order', async () => {
    // the first file (CLI 0.47) writes a token event before the items of
    // its response, the second (CLI 0.147) after them
    for (const raw of (await parseVariant('legacy')) as RawRun[]) {
      let turnsWithCalls = 0;
      for (const turn of turnsOf(raw)) {
        const last = llmCallsOf(raw)
          .filter((s) => s.parentId === turn.id)
          .sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''))
          .at(-1);
        if (last === undefined) continue;
        turnsWithCalls++;
        expect(last.content?.outputPreview).toBeTypeOf('string');
      }
      expect(turnsWithCalls).toBe(3);
    }
  });

  it('sums the calls of a thread that inherited its total to its own usage, not to that total', async () => {
    const [raw] = await parseVariant('compaction');
    const counters = await countersOf(raw?.source.files[0] ?? '');
    expect(llmCallsOf(raw as RawRun)).toHaveLength(6);
    expect(tokenSum(raw as RawRun)).toBe(705_676);
    expect(counters.threadTotal).toBe(4_900_681);
  });

  it('gives every call a model, a turn of its file as parent and times inside the session', async () => {
    for (const variant of [
      'simple',
      'guardian',
      'tool-errors',
      'legacy',
      'compaction',
    ]) {
      for (const raw of await parseVariant(variant)) {
        const [session] = raw.spans;
        const turnIds = new Set(turnsOf(raw).map((t) => t.id));
        for (const call of llmCallsOf(raw)) {
          expect(call.llm?.model).not.toBe('unknown');
          expect(call.name).toBe(call.llm?.model);
          expect(call.llm?.costSource).toBe('unknown');
          expect(turnIds.has(call.parentId ?? '')).toBe(true);
          expect(call.endedAt).toBeDefined();
          expect(call.startedAt <= (call.endedAt ?? '')).toBe(true);
          expect(call.startedAt >= (session?.startedAt ?? '')).toBe(true);
          expect((call.endedAt ?? '') <= (session?.endedAt ?? '')).toBe(true);
          expect(call.provenance.line).toBeGreaterThan(1);
        }
      }
    }
  });

  it('carries the calls into the run totals and leaves the reviewer model unpriced', async () => {
    const [simple] = await parseVariant('simple');
    const run = normalize(priceRun(simple as RawRun), { baseDir: repoRoot });
    expect(run.totals.counts.llmCalls).toBe(20);
    expect(run.totals.tokens.total).toBe(2_359_675);

    const [review] = await parseVariant('compaction');
    const reviewRun = normalize(priceRun(review as RawRun), {
      baseDir: repoRoot,
    });
    expect(reviewRun.totals.costUSD.total).toBe(0);
    expect(
      reviewRun.spans
        .filter((s) => s.kind === 'llm_call')
        .every((s) => s.llm?.costSource === 'unknown'),
    ).toBe(true);
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
