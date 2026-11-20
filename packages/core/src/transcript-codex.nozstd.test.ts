import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';

// A Node 22 older than 22.15: `node:zlib` without its zstd decoder. In its
// own file because the mock holds for the whole module graph.
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  const without = { ...actual, createZstdDecompress: undefined };
  return { ...without, default: without };
});

const { readTranscriptSlice } = await import('./transcript.js');

it('says which Node reads a compressed rollout when this one cannot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runray-slice-nozstd-'));
  try {
    const record = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    });
    const plain = join(dir, 'rollout-a.jsonl');
    const packed = join(dir, 'rollout-b.jsonl.zst');
    writeFileSync(plain, `${record}\n`);
    writeFileSync(packed, zstdCompressSync(Buffer.from(`${record}\n`)));

    const slice = await readTranscriptSlice(
      { file: packed, line: 1 },
      'codex',
      { redact: false },
    );
    expect(slice.status).toBe('unavailable');
    if (slice.status !== 'unavailable') return;
    expect(slice.reason).toContain('needs Node 22.15 or later');
    expect(slice.reason).not.toContain(dir);

    // a plain rollout is read all the same
    expect(
      await readTranscriptSlice({ file: plain, line: 1 }, 'codex', {
        redact: false,
      }),
    ).toEqual({
      status: 'ok',
      segments: [{ label: 'assistant', text: 'hello' }],
      truncated: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
