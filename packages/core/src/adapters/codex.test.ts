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
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Candidate } from '../adapter.js';
import { codexAdapter } from './codex.js';

/**
 * Codex adapter tests (change `add-codex-adapter`). Discovery runs against
 * the scrubbed fixtures and against rollouts written inline into temp
 * directories: a first record is all discovery reads, so a thread is one
 * line here.
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
