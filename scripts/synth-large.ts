/**
 * synth-large.ts — Option B from `fixtures/claude-code/large/README.md`:
 * inflate a committed, already-scrubbed fixture to bench size when no real
 * large session is available (CI, fresh contributors).
 *
 *   pnpm synth-large [targetMB]        # default 32, refuses to overwrite
 *   pnpm synth-large [targetMB] codex  # the same for a Codex rollout
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
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

// --- Codex -----------------------------------------------------------------

/** Ids that say whose thread a record belongs to, and values that are not
 * ids at all: every copy keeps them, so the file stays one thread. */
const CODEX_KEPT_IDS: ReadonlySet<string> = new Set([
  'session_id',
  'thread_id',
  'parent_thread_id',
  'creator_user_id',
  'creator_account_id',
  'client_id',
  'message_id',
]);
const CODEX_ID_KEY = /(?:^|_)id$/;
const CODEX_MS_KEYS: ReadonlySet<string> = new Set([
  'started_at_ms',
  'completed_at_ms',
]);
const CODEX_SECONDS_KEYS: ReadonlySet<string> = new Set([
  'started_at',
  'completed_at',
]);

/** One record of a later copy: its ids made the copy's own and its times
 * moved by the copy's shift. Cross-references move with the ids they name,
 * since one id always becomes the same new id within a copy. */
function codexCopy(value: unknown, copy: number, shiftMs: number): unknown {
  if (Array.isArray(value))
    return value.map((entry) => codexCopy(entry, copy, shiftMs));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      if (CODEX_ID_KEY.test(key) && !CODEX_KEPT_IDS.has(key)) {
        out[key] = `${entry}-copy${copy}`;
      } else if (key === 'timestamp' && !Number.isNaN(Date.parse(entry))) {
        out[key] = new Date(Date.parse(entry) + shiftMs).toISOString();
      } else out[key] = entry;
    } else if (typeof entry === 'number' && CODEX_MS_KEYS.has(key)) {
      out[key] = entry + shiftMs;
    } else if (typeof entry === 'number' && CODEX_SECONDS_KEYS.has(key)) {
      out[key] = entry + Math.round(shiftMs / 1000);
    } else out[key] = codexCopy(entry, copy, shiftMs);
  }
  return out;
}

/**
 * The Codex counterpart of `synthesize`: one rollout repeated until it is
 * `targetBytes` long, still one thread. Copy 0 is the source as it is, with
 * its `SCRUBBED` marker and its session record. A later copy is every other
 * record again with the ids of that copy (turns, calls, responses, items),
 * its times after the copy before it, and its `ordinal` counted on, so the
 * adapter reads new turns and new calls, not the first ones a second time.
 * It is done on the parsed records: Codex ids come in a dozen spellings, and
 * a rule by key covers the ones a later CLI adds.
 */
export function synthesizeCodex(
  sourceText: string,
  targetBytes: number,
): string {
  const lines = sourceText.split('\n').filter((line) => line.trim() !== '');
  const records = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  let maxOrdinal = -1;
  for (const record of records) {
    const ts =
      typeof record.timestamp === 'string'
        ? Date.parse(record.timestamp)
        : Number.NaN;
    if (!Number.isNaN(ts)) {
      minTs = Math.min(minTs, ts);
      maxTs = Math.max(maxTs, ts);
    }
    if (typeof record.ordinal === 'number')
      maxOrdinal = Math.max(maxOrdinal, record.ordinal);
  }
  const shiftPer = maxTs > minTs ? maxTs - minTs + 60_000 : 3_600_000;
  // the marker and the session record open a file once
  const repeated = records.filter(
    (record) =>
      record.type !== 'session_meta' &&
      !(typeof record.type === 'string' && record.type.startsWith('x-')),
  );

  const copies = Math.max(1, Math.ceil(targetBytes / sourceText.length));
  const chunks: string[] = [lines.join('\n')];
  for (let copy = 1; copy < copies; copy++) {
    const out: string[] = [];
    for (const record of repeated) {
      const next = codexCopy(record, copy, copy * shiftPer) as Record<
        string,
        unknown
      >;
      if (typeof next.ordinal === 'number')
        next.ordinal += copy * (maxOrdinal + 1);
      out.push(JSON.stringify(next));
    }
    chunks.push(out.join('\n'));
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

/** The rollout the Codex synth inflates: the larger one of tool-errors. */
export function codexSynthSourcePath(): string {
  const dir = join(repoRoot, 'fixtures', 'codex', 'tool-errors');
  const [largest] = readdirSync(dir)
    .filter((name) => /^rollout-.*\.jsonl$/.test(name))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).size - statSync(a).size);
  if (largest === undefined) throw new Error(`no rollout found in ${dir}`);
  return largest;
}

export function codexLargeDir(): string {
  return join(repoRoot, 'fixtures', 'codex', 'large');
}

/**
 * The machine-local Codex perf fixture: a rollout someone scrubbed into
 * `fixtures/codex/large` (plain or compressed), else a synthetic one written
 * there now. Never overwrites what it finds.
 */
export function ensureLargeCodexFixture(targetBytes: number): {
  path: string;
  synthesized: boolean;
} {
  const dir = codexLargeDir();
  const existing = readdirSync(dir)
    .filter((name) => /^rollout-.*\.jsonl(\.zst)?$/i.test(name))
    .sort()[0];
  if (existing !== undefined)
    return { path: join(dir, existing), synthesized: false };
  const out = join(dir, 'rollout-large.jsonl');
  const source = readFileSync(codexSynthSourcePath(), 'utf8');
  writeFileSync(out, synthesizeCodex(source, targetBytes), 'utf8');
  return { path: out, synthesized: true };
}

// CLI entry: pnpm synth-large [targetMB] [codex]
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const targetMb = Number(process.argv[2] ?? 32);
  if (!Number.isFinite(targetMb) || targetMb <= 0) {
    console.error(
      `usage: pnpm synth-large [targetMB] [codex] — got '${process.argv[2]}'`,
    );
    process.exit(1);
  }
  const result =
    process.argv[3] === 'codex'
      ? ensureLargeCodexFixture(targetMb * 1024 * 1024)
      : ensureLargeFixture(targetMb * 1024 * 1024);
  console.log(
    result.synthesized
      ? `wrote ${result.path} (~${targetMb} MB, synth-multiplied from tool-errors)`
      : `${result.path} already exists — refusing to overwrite (delete it first to re-synthesize)`,
  );
}
