import { createReadStream } from 'node:fs';

/**
 * Streaming line reader for JSONL source logs.
 *
 * A line ends at the LF byte and nowhere else. `node:readline` also ends a
 * line at U+2028 and U+2029, which JSON allows unescaped inside a string and
 * `JSON.stringify` writes raw — so a record whose text holds one of them
 * came back as two fragments, neither of which parses, and the record was
 * lost. Splitting on bytes before decoding avoids that and keeps multi-byte
 * characters whole across read chunks: 0x0A never occurs inside a UTF-8
 * multi-byte sequence, so every line is decoded from complete bytes.
 *
 * Line numbers are 1-based and count LF-terminated lines plus a final
 * unterminated one, which matches `readline` for LF and CRLF files. One
 * trailing CR is dropped from each line. A lone CR is NOT a line ending here
 * (it was under `readline`); JSON escapes CR inside strings, so a JSONL file
 * only carries one as part of CRLF.
 *
 * The text is otherwise returned as decoded: a byte-order mark stays on line
 * one for the caller to strip, and blank lines are yielded (skipping them
 * would shift the numbering).
 *
 * No adapter imports — every source that stores JSONL can read through this.
 */

export interface NumberedLine {
  /** 1-based line number within the stream. */
  line: number;
  /** The line's text, without its LF or CRLF terminator. */
  text: string;
}

const LF = 0x0a;
const CR = 0x0d;

function decodeLine(bytes: Buffer): string {
  const end =
    bytes.length > 0 && bytes[bytes.length - 1] === CR
      ? bytes.length - 1
      : bytes.length;
  return bytes.toString('utf8', 0, end);
}

/**
 * Split a stream of byte chunks into numbered lines. Chunk boundaries may
 * fall anywhere, including inside a multi-byte character or between the CR
 * and the LF of one terminator.
 */
export async function* splitLines(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<NumberedLine, void, undefined> {
  // the head of a line whose LF has not arrived yet, in arrival order; one
  // concat per line keeps a multi-megabyte record linear, not quadratic
  let pending: Buffer[] = [];
  let line = 0;
  for await (const chunk of chunks) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (;;) {
      const lf = buf.indexOf(LF, start);
      if (lf === -1) break;
      const tail = buf.subarray(start, lf);
      const bytes =
        pending.length === 0 ? tail : Buffer.concat([...pending, tail]);
      pending = [];
      start = lf + 1;
      line += 1;
      yield { line, text: decodeLine(bytes) };
    }
    if (start < buf.length) pending.push(buf.subarray(start));
  }
  if (pending.length > 0) {
    line += 1;
    yield { line, text: decodeLine(Buffer.concat(pending)) };
  }
}

/**
 * Numbered lines of a file. The file is opened on the first iteration and
 * closed when the iteration ends for any reason — exhaustion, an early
 * `break` or `return` in the consumer, or an error. A file that cannot be
 * opened or read rejects the iteration with the underlying error.
 */
export async function* readLines(
  file: string,
): AsyncGenerator<NumberedLine, void, undefined> {
  const stream = createReadStream(file);
  try {
    yield* splitLines(stream);
  } finally {
    stream.destroy();
  }
}
