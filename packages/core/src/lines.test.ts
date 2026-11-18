import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type NumberedLine, readLines, splitLines } from './lines.js';

/** The chunks as a stream, each delivered as its own read. */
async function* stream(
  chunks: ReadonlyArray<Uint8Array | string>,
): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
  }
}

async function collect(
  lines: AsyncIterable<NumberedLine>,
): Promise<NumberedLine[]> {
  const out: NumberedLine[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

const texts = async (chunks: ReadonlyArray<Uint8Array | string>) =>
  (await collect(splitLines(stream(chunks)))).map((l) => l.text);

describe('splitLines', () => {
  it('numbers lines from 1 and drops the terminator', async () => {
    expect(await collect(splitLines(stream(['a\nb\nc\n'])))).toEqual([
      { line: 1, text: 'a' },
      { line: 2, text: 'b' },
      { line: 3, text: 'c' },
    ]);
  });

  it('yields a final line that has no terminator, and no phantom line after one that has', async () => {
    expect(await texts(['a\nb'])).toEqual(['a', 'b']);
    expect(await texts(['a\nb\n'])).toEqual(['a', 'b']);
    expect(await texts([])).toEqual([]);
    expect(await texts([''])).toEqual([]);
  });

  it('yields blank lines so the numbering stays that of the file', async () => {
    expect(await collect(splitLines(stream(['a\n\n\nb\n'])))).toEqual([
      { line: 1, text: 'a' },
      { line: 2, text: '' },
      { line: 3, text: '' },
      { line: 4, text: 'b' },
    ]);
  });

  it('does not end a line at U+2028, U+2029, NEL, VT or FF', async () => {
    const line = 'a b c\u0085d\u000be\u000cf';
    expect(await collect(splitLines(stream([`${line}\nnext\n`])))).toEqual([
      { line: 1, text: line },
      { line: 2, text: 'next' },
    ]);
  });

  it('treats CRLF as one terminator, also when a chunk ends between CR and LF', async () => {
    expect(await texts(['a\r\nb\r\n'])).toEqual(['a', 'b']);
    expect(await texts(['a\r', '\nb\r', '\n'])).toEqual(['a', 'b']);
    // a final CR with no LF after it is still only a terminator
    expect(await texts(['a\r\nb\r'])).toEqual(['a', 'b']);
  });

  it('drops one trailing CR only, and leaves a CR inside a line alone', async () => {
    expect(await texts(['a\r\r\nb\rc\n'])).toEqual(['a\r', 'b\rc']);
  });

  it('keeps a byte-order mark on line one for the caller', async () => {
    expect(await texts(['﻿{"a":1}\n'])).toEqual(['﻿{"a":1}']);
  });

  it('decodes a multi-byte character split across chunks at every byte', async () => {
    // 2-, 3- and 4-byte sequences, and U+2028 itself (E2 80 A8)
    const line = 'é€\u{1F600} z';
    const bytes = Buffer.from(`${line}\nnext\n`, 'utf8');
    for (let cut = 1; cut < bytes.length; cut++) {
      const got = await texts([bytes.subarray(0, cut), bytes.subarray(cut)]);
      expect(got, `cut at byte ${cut}`).toEqual([line, 'next']);
    }
    // one byte per chunk
    expect(await texts(Array.from(bytes, (b) => Uint8Array.of(b)))).toEqual([
      line,
      'next',
    ]);
  });

  it('assembles a line spread over many chunks', async () => {
    const parts = Array.from({ length: 50 }, (_, i) => `part${i};`);
    expect(await texts([...parts, '\n', 'tail'])).toEqual([
      parts.join(''),
      'tail',
    ]);
  });

  it('accepts a plain Uint8Array view with a byte offset', async () => {
    const backing = new TextEncoder().encode('xxa\nb\nyy');
    const view = new Uint8Array(backing.buffer, 2, 4); // "a\nb\n"
    expect(await texts([view])).toEqual(['a', 'b']);
  });
});

describe('readLines', () => {
  function withFile<T>(
    content: string | Buffer,
    fn: (file: string) => Promise<T>,
  ): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'runray-lines-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, content);
    return fn(file).finally(() =>
      rmSync(dir, { recursive: true, force: true }),
    );
  }

  it('reads a file larger than one read chunk without splitting characters', async () => {
    // 3-byte characters only, so every 64 KiB boundary falls inside one
    const long = '€'.repeat(100_000);
    const got = await withFile(`${long}\nshort\n`, (file) =>
      collect(readLines(file)),
    );
    expect(got.map((l) => l.line)).toEqual([1, 2]);
    expect(got[0]?.text === long).toBe(true);
    expect(got[1]?.text).toBe('short');
  });

  it('lets the consumer stop early and releases the file', async () => {
    await withFile('one\ntwo\nthree\n', async (file) => {
      const seen: string[] = [];
      for await (const { line, text } of readLines(file)) {
        seen.push(text);
        if (line === 2) break;
      }
      expect(seen).toEqual(['one', 'two']);
      // withFile removes the directory next: on Windows that fails while a
      // handle is still open, so reaching the end proves the close
    });
  });

  it('rejects the iteration when the file cannot be opened', async () => {
    const missing = join(tmpdir(), 'runray-lines-missing', 'nope.jsonl');
    await expect(collect(readLines(missing))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
