import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { NumberedLine } from './lines.js';
import {
  isCompressedRollout,
  isRolloutFileName,
  isZstdUnavailable,
  readRolloutLines,
  ZstdUnavailableError,
  zstdAvailable,
  zstdUnavailableMessage,
} from './rollout-lines.js';

async function collect(
  lines: AsyncIterable<NumberedLine>,
): Promise<NumberedLine[]> {
  const out: NumberedLine[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

/** Runs `fn` with a temp directory holding the named files, then removes
 * it. On Windows the removal fails while a handle is still open, so a test
 * that returns normally has also proven the reader closed its files. */
async function withFiles<T>(
  files: Record<string, string | Buffer>,
  fn: (paths: Record<string, string>) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'runray-rollout-'));
  try {
    const paths: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
      paths[name] = join(dir, name);
      writeFileSync(paths[name], content);
    }
    return await fn(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PLAIN = 'rollout-2026-10-13T09-00-00-0000.jsonl';
const ZST = `${PLAIN}.zst`;

/** One JSON record per line, the way Codex writes them. */
function jsonl(records: unknown[]): string {
  return records.map((r) => `${JSON.stringify(r)}\n`).join('');
}

describe('isRolloutFileName', () => {
  it('takes the names Codex gives a rollout, plain or compressed', () => {
    for (const name of [
      'rollout-2026-09-17T19-11-16-01a0b059-e3b9-7a20-87cc-da1f5e28e984.jsonl',
      'rollout-2026-09-17T19-11-16-01a0b059-e3b9-7a20-87cc-da1f5e28e984.jsonl.zst',
      'rollout-x.jsonl',
      'ROLLOUT-X.JSONL.ZST',
    ])
      expect(isRolloutFileName(name), name).toBe(true);
  });

  it('takes nothing else: other JSONL, other rollout-like names, a path', () => {
    for (const name of [
      '0c0f6d2e-55f7-4d8a-9d6b-3a2a7f0f8a11.jsonl',
      'agent-a1b2c3.jsonl',
      'notes.jsonl',
      'rollout.jsonl',
      'rollout-x.json',
      'rollout-x.jsonl.bak',
      'rollout-x.jsonlzst',
      'my-rollout-x.jsonl',
      'sessions/rollout-x.jsonl',
    ])
      expect(isRolloutFileName(name), name).toBe(false);
  });
});

describe('isCompressedRollout', () => {
  it('goes by the file name', () => {
    expect(isCompressedRollout(PLAIN)).toBe(false);
    expect(isCompressedRollout(ZST)).toBe(true);
    expect(isCompressedRollout(ZST.toUpperCase())).toBe(true);
  });
});

describe('readRolloutLines', () => {
  it('runs on a Node with zstd, or the tests below prove nothing', () => {
    expect(zstdAvailable()).toBe(true);
  });

  it('reads identical lines from a plain and a compressed file', async () => {
    const text = jsonl([
      { type: 'session_meta', payload: { id: 'a' } },
      { type: 'turn_context', payload: { model: 'm' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ]);
    await withFiles(
      { [PLAIN]: text, [ZST]: zstdCompressSync(Buffer.from(text, 'utf8')) },
      async (paths) => {
        const plain = await collect(readRolloutLines(paths[PLAIN] as string));
        const packed = await collect(readRolloutLines(paths[ZST] as string));
        expect(plain.map((l) => l.line)).toEqual([1, 2, 3]);
        expect(plain.map((l) => JSON.parse(l.text).type)).toEqual([
          'session_meta',
          'turn_context',
          'event_msg',
        ]);
        expect(packed).toEqual(plain);
      },
    );
  });

  it('keeps a record whole when a string holds U+2028, U+2029 or a character that straddles a read chunk', async () => {
    // Raw separators, as `JSON.stringify` writes them. The padding is
    // 3-byte characters only and longer than several 64 KiB read chunks, so
    // chunk boundaries fall inside characters, inside this one record.
    const output = `before middle after ${'€'.repeat(100_000)} \u{1F600}`;
    const record = { type: 'response_item', payload: { output } };
    const text = jsonl([{ type: 'session_meta' }, record, { type: 'last' }]);
    expect(text).toContain(' ');
    expect(text).toContain(' ');

    await withFiles(
      { [PLAIN]: text, [ZST]: zstdCompressSync(Buffer.from(text, 'utf8')) },
      async (paths) => {
        for (const name of [PLAIN, ZST]) {
          const lines = await collect(readRolloutLines(paths[name] as string));
          expect(lines.map((l) => l.line)).toEqual([1, 2, 3]);
          const parsed = JSON.parse(lines[1]?.text ?? '');
          expect(parsed.payload.output === output, name).toBe(true);
        }
      },
    );
  });

  it('strips a byte-order mark from line one only', async () => {
    const text = `﻿{"type":"session_meta"}\n{"v":"﻿kept"}\n`;
    await withFiles(
      { [PLAIN]: text, [ZST]: zstdCompressSync(Buffer.from(text, 'utf8')) },
      async (paths) => {
        for (const name of [PLAIN, ZST]) {
          const lines = await collect(readRolloutLines(paths[name] as string));
          expect(lines.map((l) => l.text)).toEqual([
            '{"type":"session_meta"}',
            '{"v":"﻿kept"}',
          ]);
        }
      },
    );
  });

  it('yields blank lines, so line numbers are those of the file', async () => {
    await withFiles({ [PLAIN]: '{"a":1}\n\n{"b":2}\n' }, async (paths) => {
      expect(await collect(readRolloutLines(paths[PLAIN] as string))).toEqual([
        { line: 1, text: '{"a":1}' },
        { line: 2, text: '' },
        { line: 3, text: '{"b":2}' },
      ]);
    });
  });

  it('stops after line one without decoding the rest of a compressed file', async () => {
    // A sound zstd frame of about 1 MiB that does not compress, followed by
    // bytes that are not zstd. Reading to the end must fail on the tail;
    // reading only the first record must not reach it.
    const first = '{"type":"session_meta","payload":{"id":"root"}}';
    const body = `${first}\n${Array.from({ length: 32 }, () =>
      JSON.stringify({ blob: randomBytes(24_000).toString('base64') }),
    ).join('\n')}\n`;
    const frame = zstdCompressSync(Buffer.from(body, 'utf8'));
    expect(frame.length).toBeGreaterThan(512 * 1024);
    const damaged = Buffer.concat([frame, Buffer.alloc(4096, 0x21)]);

    await withFiles({ [ZST]: damaged }, async (paths) => {
      const file = paths[ZST] as string;
      await expect(collect(readRolloutLines(file))).rejects.toMatchObject({
        code: 'ZSTD_error_prefix_unknown',
      });

      const seen: NumberedLine[] = [];
      for await (const entry of readRolloutLines(file)) {
        seen.push(entry);
        break;
      }
      expect(seen).toEqual([{ line: 1, text: first }]);
    });
  });

  it('stops after line one of a plain file and releases it', async () => {
    const text = `{"type":"session_meta"}\n${'{"pad":"x"}\n'.repeat(200_000)}`;
    await withFiles({ [PLAIN]: text }, async (paths) => {
      const file = paths[PLAIN] as string;
      expect(statSync(file).size).toBeGreaterThan(2 * 1024 * 1024);
      const iterator = readRolloutLines(file);
      expect(await iterator.next()).toEqual({
        done: false,
        value: { line: 1, text: '{"type":"session_meta"}' },
      });
      expect(await iterator.return()).toEqual({ done: true, value: undefined });
      // the generator is finished: nothing more comes out of it
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    });
  });

  it('reads every frame of a file that holds several, also when a record spans two', async () => {
    // node:zlib's decoder stops at the end of the first frame; a reader
    // that stopped with it would lose the rest of the session silently.
    const records = Array.from({ length: 6 }, (_, i) => ({
      i,
      text: `record ${i} €  `,
    }));
    const bytes = Buffer.from(jsonl(records), 'utf8');
    // cut inside record 2 and again inside the 3-byte character of record 4
    const cutA = bytes.indexOf('record 2') + 3;
    const cutB = bytes.indexOf('€', bytes.indexOf('record 4')) + 1;
    const packed = Buffer.concat(
      [
        bytes.subarray(0, cutA),
        bytes.subarray(cutA, cutB),
        Buffer.alloc(0),
        bytes.subarray(cutB),
      ].map((part) => zstdCompressSync(part)),
    );

    await withFiles({ [PLAIN]: bytes, [ZST]: packed }, async (paths) => {
      const plain = await collect(readRolloutLines(paths[PLAIN] as string));
      const framed = await collect(readRolloutLines(paths[ZST] as string));
      expect(framed.map((l) => JSON.parse(l.text))).toEqual(records);
      expect(framed).toEqual(plain);
    });
  });

  it('reads a compressed file that was cut short as the lines before the cut', async () => {
    // The decoder reports no error for an unfinished frame, so this is what
    // a caller gets: whole lines, then one that may be incomplete. The
    // parser turns an incomplete last line into a warning, as it does for a
    // plain rollout that is still being written.
    const records = Array.from({ length: 40 }, (_, i) => ({
      i,
      blob: randomBytes(24_000).toString('base64'),
    }));
    const frame = zstdCompressSync(Buffer.from(jsonl(records), 'utf8'));
    await withFiles(
      { [ZST]: frame.subarray(0, frame.length >> 1) },
      async (paths) => {
        const lines = await collect(readRolloutLines(paths[ZST] as string));
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.length).toBeLessThan(40);
        const whole = lines.slice(0, -1);
        expect(whole.map((l) => JSON.parse(l.text).i)).toEqual(
          whole.map((_, i) => i),
        );
      },
    );
  });

  it('reads an empty file as no lines, plain or compressed', async () => {
    await withFiles(
      { [PLAIN]: '', [ZST]: zstdCompressSync(Buffer.alloc(0)) },
      async (paths) => {
        expect(await collect(readRolloutLines(paths[PLAIN] as string))).toEqual(
          [],
        );
        expect(await collect(readRolloutLines(paths[ZST] as string))).toEqual(
          [],
        );
      },
    );
  });

  it('rejects with the file-system error when the file is missing, plain or compressed', async () => {
    const dir = join(tmpdir(), 'runray-rollout-missing');
    for (const name of [PLAIN, ZST]) {
      await expect(
        collect(readRolloutLines(join(dir, name))),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

describe('ZstdUnavailableError', () => {
  it('names the Node version it ran on and what to do', () => {
    const err = new ZstdUnavailableError('22.11.0');
    expect(err.message).toBe(zstdUnavailableMessage('22.11.0'));
    expect(err.message).toContain('Node 22.11.0');
    expect(err.message).toContain('Node 22.15 or later');
    expect(err.message).toContain('.jsonl.zst');
    expect(err.name).toBe('ZstdUnavailableError');
    expect(isZstdUnavailable(err)).toBe(true);
    expect(isZstdUnavailable(new Error(err.message))).toBe(false);
  });

  it('defaults to the running Node version', () => {
    expect(new ZstdUnavailableError().message).toContain(
      `Node ${process.versions.node}`,
    );
  });
});
