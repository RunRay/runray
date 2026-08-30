/**
 * synth-large.ts — Option B from `fixtures/claude-code/large/README.md`:
 * inflate a committed, already-scrubbed fixture to bench size when no real
 * large session is available (CI, fresh contributors).
 *
 *   pnpm synth-large [targetMB]        # default 32, refuses to overwrite
 *
 * Naive concatenation would duplicate record ids and break tree
 * reconstruction, tool pairing, and assistant-record merging, so every copy
 * deterministically rewrites its identifiers (uuids plus the `toolu_`/`msg_`/
 * `req_` families), keeps the original `sessionId` so the file stays one
 * session, and shifts timestamps so the copies form one long chronological
 * run. Copy 0 is the untouched original — the `SCRUBBED` marker and content
 * survive; no new text is invented.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// tool pairing (`toolu_`), assistant-record merging (`msg_`), request
// grouping (`req_`) — every id family the adapter joins on must diverge
// per copy or copies collapse into copy 0's spans
const OPAQUE_ID_RE = /\b(toolu|msg|req)_[A-Za-z0-9]+/g;
const TIMESTAMP_RE = /"timestamp":"([^"]+)"/g;
const SESSION_RE = /"sessionId":"[0-9a-f-]{36}"/g;

/** Deterministic id remap: stable per (id, copy), never collides with copy 0. */
function remap(id: string, copy: number): string {
  const hex = createHash('sha1').update(`${id}:${copy}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function synthesize(sourceText: string, targetBytes: number): string {
  const sessionId = SESSION_RE.exec(sourceText)?.[0];
  SESSION_RE.lastIndex = 0;

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const match of sourceText.matchAll(TIMESTAMP_RE)) {
    const ts = Date.parse(match[1] ?? '');
    if (Number.isNaN(ts)) continue;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  }
  // gap between copies keeps spans strictly chronological
  const shiftPer = maxTs > minTs ? maxTs - minTs + 60_000 : 3_600_000;

  const copies = Math.max(1, Math.ceil(targetBytes / sourceText.length));
  const chunks: string[] = [sourceText.trimEnd()];
  for (let copy = 1; copy < copies; copy++) {
    let text = sourceText
      .replace(UUID_RE, (id) => remap(id, copy))
      .replace(
        OPAQUE_ID_RE,
        (id, prefix: string) =>
          `${prefix}_${createHash('sha1').update(`${id}:${copy}`).digest('hex').slice(0, 24)}`,
      )
      .replace(TIMESTAMP_RE, (_, iso: string) => {
        const ts = Date.parse(iso);
        return `"timestamp":"${Number.isNaN(ts) ? iso : new Date(ts + copy * shiftPer).toISOString()}"`;
      });
    if (sessionId !== undefined) text = text.replace(SESSION_RE, sessionId);
    chunks.push(text.trimEnd());
  }
  return `${chunks.join('\n')}\n`;
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Single-file source fixture the synth inflates: tool-errors' transcript. */
export function synthSourcePath(): string {
  const dir = join(repoRoot, 'fixtures', 'claude-code', 'tool-errors');
  const jsonl = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  if (jsonl === undefined) {
    throw new Error(`no .jsonl fixture found in ${dir}`);
  }
  return join(dir, jsonl);
}

export function largeFixturePath(): string {
  return join(repoRoot, 'fixtures', 'claude-code', 'large', 'large.jsonl');
}

/** Write a synthetic large fixture; refuses to overwrite an existing one. */
export function ensureLargeFixture(targetBytes: number): {
  path: string;
  synthesized: boolean;
} {
  const out = largeFixturePath();
  if (existsSync(out)) return { path: out, synthesized: false };
  const source = readFileSync(synthSourcePath(), 'utf8');
  writeFileSync(out, synthesize(source, targetBytes), 'utf8');
  return { path: out, synthesized: true };
}

// CLI entry: pnpm synth-large [targetMB]
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const targetMb = Number(process.argv[2] ?? 32);
  if (!Number.isFinite(targetMb) || targetMb <= 0) {
    console.error(
      `usage: pnpm synth-large [targetMB] — got '${process.argv[2]}'`,
    );
    process.exit(1);
  }
  const result = ensureLargeFixture(targetMb * 1024 * 1024);
  console.log(
    result.synthesized
      ? `wrote ${result.path} (~${targetMb} MB, synth-multiplied from tool-errors)`
      : `${result.path} already exists — refusing to overwrite (delete it first to re-synthesize)`,
  );
}
