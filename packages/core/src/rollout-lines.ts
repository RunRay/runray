import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import * as zlib from 'node:zlib';
import { type NumberedLine, splitLines } from './lines.js';

/**
 * Numbered lines of a Codex rollout, plain (`.jsonl`) or zstd-compressed
 * (`.jsonl.zst`). Codex compresses older rollouts in place, so one session
 * directory holds both, and every reader of a rollout — discovery, the
 * parser, the transcript slice — goes through here.
 *
 * Lines end at LF only (see `lines.ts` for why this is not `node:readline`);
 * a byte-order mark on line one is stripped; blank lines are yielded so the
 * numbering is that of the file. The file is read as a stream: a consumer
 * that needs only the first record breaks out of the loop and the rest of
 * the file is neither read nor decompressed.
 *
 * Decompression is `node:zlib`, not a dependency. Its zstd support arrived
 * in Node 22.15.0 and the package supports Node 22 from 22.0, so it is
 * feature-detected: on an older runtime a compressed rollout fails with one
 * `ZstdUnavailableError` and plain rollouts read as before.
 *
 * Two behaviours of that decoder shape the code below (observed on Node
 * 24.14; design T3 of `add-codex-adapter` records them):
 * - It ends at the end of the FIRST frame and drops whatever follows without
 *   an error. A zstd file may be several frames back to back, so the reader
 *   starts a new decoder where the last one stopped until the file is used
 *   up. Bytes after a frame that are not a frame reject the iteration.
 * - It reports no error for a frame that is cut short. A compressed file
 *   that ends early therefore reads as the lines before the cut, the last
 *   of them possibly incomplete — the same thing a plain rollout that is
 *   still being written gives.
 */

const ZSTD_SUFFIX = '.zst';
const BOM = '﻿';

/** True when the file name says the rollout is zstd-compressed. */
export function isCompressedRollout(file: string): boolean {
  return file.toLowerCase().endsWith(ZSTD_SUFFIX);
}

type ZstdDecompressFactory = typeof zlib.createZstdDecompress;

/** Looked up on every call, never cached: it is one property read, and a
 * test can take the capability away without reloading the module. */
function zstdFactory(): ZstdDecompressFactory | undefined {
  const factory = (zlib as { createZstdDecompress?: unknown })
    .createZstdDecompress;
  return typeof factory === 'function'
    ? (factory as ZstdDecompressFactory)
    : undefined;
}

/** Whether this runtime can read compressed rollouts. */
export function zstdAvailable(): boolean {
  return zstdFactory() !== undefined;
}

export function zstdUnavailableMessage(nodeVersion: string): string {
  return (
    'reading a compressed Codex rollout (.jsonl.zst) needs Node 22.15 or later ' +
    `(zstd support in node:zlib); this is Node ${nodeVersion} — upgrade Node to read it. ` +
    'Plain .jsonl rollouts and the other sources are unaffected.'
  );
}

/** Thrown when a compressed rollout is read on a runtime without zstd.
 * Distinguishable so callers can report the file as skipped instead of
 * reporting it as corrupt. */
export class ZstdUnavailableError extends Error {
  readonly name = 'ZstdUnavailableError';
  constructor(nodeVersion: string = process.versions.node) {
    super(zstdUnavailableMessage(nodeVersion));
  }
}

export function isZstdUnavailable(err: unknown): err is ZstdUnavailableError {
  return err instanceof ZstdUnavailableError;
}

/**
 * Numbered lines of a rollout file. The file is opened on the first
 * iteration and closed when the iteration ends for any reason — exhaustion,
 * an early `break` or `return` in the consumer, or an error.
 *
 * Rejects with `ZstdUnavailableError` for a compressed file on a runtime
 * without zstd, before the file is opened; with the file-system error when
 * the file cannot be opened or read; and with the decoder's error when the
 * bytes are not zstd (lines decoded before that point have already been
 * yielded).
 */
export async function* readRolloutLines(
  file: string,
): AsyncGenerator<NumberedLine, void, undefined> {
  if (!isCompressedRollout(file)) {
    const source = createReadStream(file);
    try {
      yield* stripBom(splitLines(source));
    } finally {
      source.destroy();
    }
    return;
  }

  const createDecompress = zstdFactory();
  if (createDecompress === undefined) throw new ZstdUnavailableError();
  // one splitter over all frames: a line may begin in one and end in the next
  yield* stripBom(splitLines(decompressFrames(file, createDecompress)));
}

/** The decompressed bytes of every zstd frame in the file, in order. */
async function* decompressFrames(
  file: string,
  createDecompress: ZstdDecompressFactory,
): AsyncGenerator<Buffer, void, undefined> {
  let offset = 0;
  for (;;) {
    const source = createReadStream(file, { start: offset });
    const decoded = createDecompress();
    // `pipeline` carries an open or read error of the file into `decoded`,
    // so the loop below rejects with it. Its own callback has nothing to
    // add: every outcome, including the close that follows a frame end or
    // an early stop, is already seen by the consumer of `decoded`.
    pipeline(source, decoded, () => {});
    try {
      for await (const chunk of decoded) yield chunk as Buffer;
    } finally {
      source.destroy();
      decoded.destroy();
    }
    // `bytesWritten` is the input the decoder consumed, which stops at the
    // frame end. Nothing consumed means nothing was left to read.
    if (decoded.bytesWritten === 0) return;
    offset += decoded.bytesWritten;
  }
}

async function* stripBom(
  lines: AsyncIterable<NumberedLine>,
): AsyncGenerator<NumberedLine, void, undefined> {
  for await (const entry of lines) {
    yield entry.line === 1 && entry.text.startsWith(BOM)
      ? { line: 1, text: entry.text.slice(BOM.length) }
      : entry;
  }
}
