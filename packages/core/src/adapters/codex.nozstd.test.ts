import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';

// A Node 22 older than 22.15: `node:zlib` without its zstd decoder. Only the
// decoder is taken away, so the test can still write a compressed file. This
// lives in its own file because the mock holds for the whole module graph.
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  const without = { ...actual, createZstdDecompress: undefined };
  return { ...without, default: without };
});

const { codexAdapter } = await import('./codex.js');
const { isZstdUnavailable } = await import('../rollout-lines.js');

const ROOT = '0199f3a0-0000-7000-8000-000000000001';
const CHILD = '0199f3a0-0000-7000-8000-000000000002';
const meta = (id: string, parent?: string) =>
  `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id,
      ...(parent === undefined ? {} : { parent_thread_id: parent }),
    },
  })}\n`;

it('keeps a compressed rollout it cannot read as a candidate, and still groups the plain ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runray-codex-nozstd-'));
  try {
    const root = join(dir, `rollout-2026-10-13T09-00-00-${ROOT}.jsonl`);
    const child = join(dir, `rollout-2026-10-13T09-05-00-${CHILD}.jsonl`);
    // the same child once more, compressed: without a decoder its thread is
    // unknown, so it can neither be grouped nor stand in for the plain file
    const packed = join(dir, `rollout-2026-10-13T09-05-00-${CHILD}.jsonl.zst`);
    writeFileSync(root, meta(ROOT));
    writeFileSync(child, meta(CHILD, ROOT));
    writeFileSync(packed, zstdCompressSync(Buffer.from(meta(CHILD, ROOT))));

    const candidates = await codexAdapter.detect([dir]);
    expect(candidates.map((c) => c.runRef)).toEqual([root, packed]);
    expect(candidates[0]?.files).toEqual([root, child]);
    expect(candidates[1]?.files).toEqual([packed]);

    // parse() gives the reason discovery reports for the skipped file: one
    // message naming the Node version that reads it, not a corrupt-file one
    const [, compressed] = candidates;
    if (compressed === undefined) throw new Error('unreachable');
    const failure = await codexAdapter
      .parse(compressed, { redact: false })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(isZstdUnavailable(failure)).toBe(true);
    expect((failure as Error).message).toContain('needs Node 22.15 or later');
    expect((failure as Error).message).toContain(process.versions.node);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
