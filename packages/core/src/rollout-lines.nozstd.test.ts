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

const {
  isZstdUnavailable,
  readRolloutLines,
  zstdAvailable,
  zstdUnavailableMessage,
} = await import('./rollout-lines.js');

async function texts(file: string): Promise<string[]> {
  const out: string[] = [];
  for await (const { text } of readRolloutLines(file)) out.push(text);
  return out;
}

it('fails a compressed rollout with one error naming the Node version, and still reads plain ones', async () => {
  expect(zstdAvailable()).toBe(false);

  const dir = mkdtempSync(join(tmpdir(), 'runray-rollout-nozstd-'));
  try {
    const text = '{"type":"session_meta"}\n{"type":"last"}\n';
    const plain = join(dir, 'rollout-a.jsonl');
    const packed = join(dir, 'rollout-b.jsonl.zst');
    writeFileSync(plain, text);
    writeFileSync(packed, zstdCompressSync(Buffer.from(text, 'utf8')));

    const failure = await texts(packed).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isZstdUnavailable(failure)).toBe(true);
    expect((failure as Error).message).toBe(
      zstdUnavailableMessage(process.versions.node),
    );
    expect((failure as Error).message).toBe(
      'reading a compressed Codex rollout (.jsonl.zst) needs Node 22.15 or later ' +
        `(zstd support in node:zlib); this is Node ${process.versions.node} — upgrade Node to read it. ` +
        'Plain .jsonl rollouts and the other sources are unaffected.',
    );

    expect(await texts(plain)).toEqual([
      '{"type":"session_meta"}',
      '{"type":"last"}',
    ]);

    // the unavailable runtime is reported before the file is opened: a
    // compressed path that does not exist gives the same error, not ENOENT
    await expect(
      texts(join(dir, 'rollout-missing.jsonl.zst')),
    ).rejects.toSatisfy(isZstdUnavailable);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
