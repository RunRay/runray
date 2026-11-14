import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  Candidate,
  ParseOptions,
  RawRun,
  RawSpan,
  RunWarning,
  SourceAdapter,
} from '../adapter.js';
import { NoSessionYet } from '../adapter.js';
import { isCompressedRollout, readRolloutLines } from '../rollout-lines.js';

/**
 * Codex adapter (change `add-codex-adapter`). Codex writes one "rollout" per
 * thread:
 *
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<start time>-<thread id>.jsonl
 *
 * (`~/.codex/sessions` when `CODEX_HOME` is unset) and later compresses it in
 * place to `.jsonl.zst`. Each line is one record,
 * `{timestamp, ordinal, type, payload}`, and the first one is `session_meta`.
 *
 * Rollouts are the only input (design T1). The SQLite files next to
 * `sessions/` are projections of them with names that change between
 * releases; none is opened, so the adapter needs no SQLite binding and cannot
 * lock a running Codex.
 *
 * A thread whose `session_meta` names a `parent_thread_id` is a child thread
 * (on every machine surveyed: the approval reviewer). It is not a run of its
 * own: its file joins the candidate of its root thread (design D2).
 *
 * What `parse()` emits so far: the session span and one `turn` span per
 * turn the rollout brackets (design D3, T6). Model calls, tools and child
 * threads follow in tasks 2.3 to 4.1; the records they read are skipped
 * here like any record the adapter has no rule for.
 *
 * Every field of every record is optional to this code. A record type it
 * does not know is skipped without a word, a line that is not JSON is a run
 * warning with its line number, and only a file whose first record is not
 * `session_meta` is refused.
 *
 * Not registered yet (task 5.2), so discovery does not reach it.
 */

const PREVIEW_CHARS = 200;
const EPOCH = '1970-01-01T00:00:00Z';

/** A rollout file name, plain or compressed. Anything else in a scanned
 * folder is never opened. */
const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl(\.zst)?$/i;

/** `YYYY/MM/DD` is three levels under the sessions root; the bound leaves
 * room for a root given a few levels above it (the Codex home, a backup
 * folder) and is the one the other adapters use. */
const MAX_DEPTH = 6;

/** The marker record `scripts/scrub-fixture.ts` writes on line one of a
 * fixture, under its current name and the two the project had before. */
const SCRUB_MARKER_TYPES = new Set([
  'x-runray-scrub',
  'x-tracepulse-scrub',
  'x-tracellm-scrub',
]);

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

function defaultRoots(): string[] {
  const env = process.env.CODEX_HOME;
  const home =
    env !== undefined && env !== '' ? env : join(homedir(), '.codex');
  // `sessions`, not the Codex home: the home holds databases Codex writes
  // every few seconds, and zero-config watch would rebuild on each write
  return [join(home, 'sessions')];
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Rollout files under a root, at any depth (`raw/` trees and node_modules
 * excluded). Symbolic links are not followed: a directory entry that is a
 * link is neither a directory nor a file here. */
async function findRollouts(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const name = basename(root);
  if (name === 'raw' || name === 'node_modules') return [];
  const out: string[] = [];
  for (const entry of await safeReaddir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await findRollouts(path, depth + 1)));
    else if (entry.isFile() && ROLLOUT_FILE_RE.test(entry.name)) out.push(path);
  }
  return out;
}

/** What discovery needs from a rollout: which thread it is and whose child. */
interface RolloutHead {
  threadId?: string;
  parentThreadId?: string;
}

/**
 * The first record of a rollout, read as a stream that stops there (the
 * largest first record surveyed is 49 KB; nothing after it is read or
 * decompressed). A leading scrub marker is stepped over.
 *
 * Never throws. A file that cannot be read here (not a rollout, cut short,
 * compressed on a runtime without zstd) comes back with no thread id, stays
 * a candidate of its own, and `parse()` reports the reason for it.
 */
async function readHead(file: string): Promise<RolloutHead> {
  try {
    for await (const { text } of readRolloutLines(file)) {
      if (text.trim() === '') continue;
      const record: unknown = JSON.parse(text);
      if (!isObj(record)) return {};
      const type = str(record.type);
      if (type !== undefined && SCRUB_MARKER_TYPES.has(type)) continue;
      if (type !== 'session_meta' || !isObj(record.payload)) return {};
      return {
        threadId: str(record.payload.id),
        parentThreadId: str(record.payload.parent_thread_id),
      };
    }
  } catch {
    // unreadable or not JSON: no head
  }
  return {};
}

async function statInto(
  files: string[],
): Promise<{ mtimeMs: number; sizeBytes: number }> {
  let mtimeMs = 0;
  let sizeBytes = 0;
  for (const f of files) {
    try {
      const s = await stat(f);
      mtimeMs = Math.max(mtimeMs, s.mtimeMs);
      sizeBytes += s.size;
    } catch {
      // gone since the scan: still listed; parse() will report it
    }
  }
  return { mtimeMs, sizeBytes };
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function detect(roots: string[]): Promise<Candidate[]> {
  const scanRoots = roots.length > 0 ? roots : defaultRoots();
  const found = new Set<string>();
  for (const root of scanRoots) {
    for (const file of await findRollouts(root)) found.add(file);
  }
  const files = [...found].sort(byText);

  // One file per thread. A thread in both forms is read from the plain file,
  // the one a live session appends to; between two files of the same form
  // the first in path order stands. Files with no thread id cannot collide.
  const fileOfThread = new Map<string, string>();
  const parentOfThread = new Map<string, string>();
  const unidentified: string[] = [];
  for (const file of files) {
    const head = await readHead(file);
    if (head.threadId === undefined) {
      unidentified.push(file);
      continue;
    }
    const standing = fileOfThread.get(head.threadId);
    const replaces =
      standing !== undefined &&
      isCompressedRollout(standing) &&
      !isCompressedRollout(file);
    if (standing !== undefined && !replaces) continue;
    fileOfThread.set(head.threadId, file);
    if (head.parentThreadId === undefined) parentOfThread.delete(head.threadId);
    else parentOfThread.set(head.threadId, head.parentThreadId);
  }

  // A child joins the candidate of its root thread, found by following
  // parent links, so a child of a child lands in the same run. A thread
  // whose parent was not scanned is the top of its own candidate (an orphan
  // child). A thread on a parent cycle stands alone: no file written by
  // Codex is, and standing alone cannot loop or lose it.
  const rootOf = (threadId: string): string => {
    const seen = new Set([threadId]);
    let current = threadId;
    for (;;) {
      const parent = parentOfThread.get(current);
      if (parent === undefined || !fileOfThread.has(parent)) return current;
      if (seen.has(parent)) return threadId;
      seen.add(parent);
      current = parent;
    }
  };
  const membersOfRoot = new Map<string, string[]>();
  for (const [threadId, file] of fileOfThread) {
    const root = rootOf(threadId);
    if (root === threadId) continue;
    const members = membersOfRoot.get(root);
    if (members === undefined) membersOfRoot.set(root, [file]);
    else members.push(file);
  }

  const candidates: Candidate[] = [];
  const add = async (rootFile: string, children: string[]) => {
    // the root first, then its children in path order, which is the order
    // they were started in (the name begins with the start time)
    const candidateFiles = [rootFile, ...children.sort(byText)];
    candidates.push({
      runRef: rootFile,
      format: 'codex-jsonl',
      files: candidateFiles,
      ...(await statInto(candidateFiles)),
    });
  };
  for (const file of unidentified) await add(file, []);
  for (const [threadId, file] of fileOfThread) {
    if (rootOf(threadId) !== threadId) continue;
    await add(file, membersOfRoot.get(threadId) ?? []);
  }
  return candidates.sort((a, b) => byText(a.runRef, b.runRef));
}

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

interface ParseContext {
  spans: RawSpan[];
  warnings: RunWarning[];
  redact: boolean;
}

/** What one rollout said about its thread. */
interface ThreadSummary {
  threadId: string;
  cwd: string | undefined;
  gitBranch: string | undefined;
  /** Turns the file started. */
  turns: number;
}

interface TurnState {
  span: RawSpan;
  open: boolean;
  /** The turn already has its prompt; later user messages are not it. */
  prompted: boolean;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** A record's own time as the schema wants it. Codex writes ISO-8601 in UTC
 * with milliseconds; anything else that still parses is converted, and
 * anything that does not is no time at all. */
function timeOf(record: Json): string | undefined {
  const raw = str(record.timestamp);
  if (raw === undefined) return undefined;
  if (ISO_UTC.test(raw)) return raw;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function durationBetween(
  startedAt: string,
  endedAt: string | undefined,
): number | undefined {
  if (endedAt === undefined) return undefined;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/** The last segment of a working directory, whichever separator it uses:
 * the rollout may come from another machine, so `node:path` of this one is
 * the wrong parser. A drive root or `/` has no last segment and names
 * itself (an empty name would collide with the UI's "all projects"). */
function projectName(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter((s) => s !== '');
  const last = segments.at(-1);
  return last === undefined ||
    (segments.length === 1 && /^[A-Za-z]:$/.test(last))
    ? cwd
    : last;
}

/**
 * Text the harness puts into the user's message, not the person: the
 * environment block, the note left by an interrupted turn, tool
 * descriptions for the reviewer, the wrapper around an attached image.
 * Each is its own content part and opens (or closes) with a tag. The
 * harness names its tags in several lowercase words joined by `_` or `-`,
 * which HTML a person pastes does not, so the name's shape is the test and
 * a tag added by a later Codex is covered; `image` is the one single-word
 * tag (seen across 250 rollouts: `environment_context`, `turn_aborted`,
 * `guardian_tool_descriptions`, `recommended_plugins`,
 * `in-app-browser-context`, `image` and three more). The cost is a prompt
 * that opens with a custom element (`<my-widget>`): it gets no preview.
 *
 * A block is usually the whole part. One is not: the browser context is
 * followed, in the same part, by what the person typed (110 of 110). So
 * the person's text is what is left after the leading blocks; a block that
 * never closes in its part (the opening half of an image wrapper) takes
 * the rest of the part with it.
 */
const HARNESS_BLOCK = /^<\/?([a-z]+(?:[_-][a-z]+)+|image)[\s>]/;

function personText(part: string): string | undefined {
  let rest = part.trim();
  for (;;) {
    if (rest === '') return undefined;
    const name = HARNESS_BLOCK.exec(rest)?.[1];
    if (name === undefined) return rest;
    const close = `</${name}>`;
    const closedAt = rest.indexOf(close);
    if (closedAt < 0) return undefined;
    rest = rest.slice(closedAt + close.length).trim();
  }
}

/** The start of what the person wrote in a user message, if anything. */
function promptOf(message: Json): string | undefined {
  if (!Array.isArray(message.content)) return undefined;
  for (const part of message.content) {
    if (!isObj(part) || part.type !== 'input_text') continue;
    const text = str(part.text);
    const written = text === undefined ? undefined : personText(text);
    if (written !== undefined) return written.slice(0, PREVIEW_CHARS);
  }
  return undefined;
}

/** `error.codex_error_info` is a code (`usage_limit_exceeded`); tolerated
 * as an object keyed by the code, the other way such an enum is written. */
function errorCodeOf(error: Json): string | undefined {
  const info = error.codex_error_info;
  if (isObj(info)) return Object.keys(info)[0];
  return str(info);
}

/**
 * Reads one rollout and emits its spans: the thread's own span, then a
 * `turn` span per turn in file order.
 *
 * Turns are matched by id, never by position (design T6): a completion or
 * an abort for an id the file never started is ignored, which five reviewer
 * threads in the survey need. A turn still open at the end of the file is
 * `in_progress`.
 */
async function emitThread(
  file: string,
  ctx: ParseContext,
): Promise<ThreadSummary> {
  let session: RawSpan | undefined;
  let summary: ThreadSummary | undefined;
  let sawText = false;
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  const turns = new Map<string, TurnState>();
  /** The turn records belong to: the one started last and not yet ended. */
  let current: TurnState | undefined;

  for await (const { line, text } of readRolloutLines(file)) {
    if (text.trim() === '') continue;
    sawText = true;
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      ctx.warnings.push({ message: 'unparseable JSONL line', file, line });
      continue;
    }
    if (!isObj(record)) continue;
    const type = str(record.type);
    if (type !== undefined && SCRUB_MARKER_TYPES.has(type)) continue;
    const payload = isObj(record.payload) ? record.payload : undefined;

    const at = timeOf(record);
    if (at !== undefined) {
      firstAt ??= at;
      lastAt = at;
    }

    if (session === undefined || summary === undefined) {
      if (type !== 'session_meta' || payload === undefined) {
        throw new Error(
          'not a Codex rollout: its first record is not a session_meta record',
        );
      }
      // the id comes from the record; the name is a fallback for a record
      // without one, so the run still has a stable identity
      const threadId =
        str(payload.id) ?? basename(file).replace(/\.jsonl(\.zst)?$/i, '');
      const git = isObj(payload.git) ? payload.git : undefined;
      summary = {
        threadId,
        cwd: str(payload.cwd),
        gitBranch: git === undefined ? undefined : str(git.branch),
        turns: 0,
      };
      session = {
        id: threadId,
        parentId: null,
        kind: 'session',
        name: 'session',
        status: 'ok',
        startedAt: EPOCH, // set once the file is read
        agent: { sessionId: threadId },
        attributes: {},
        provenance: { file, line },
      };
      ctx.spans.push(session);
      continue;
    }
    if (payload === undefined) continue;

    if (type === 'event_msg') {
      const event = str(payload.type);
      if (event === 'task_started') {
        const id = str(payload.turn_id) ?? `${summary.threadId}:turn:${line}`;
        if (turns.has(id)) continue; // no id is started twice; the first stands
        const span: RawSpan = {
          id,
          parentId: session.id,
          kind: 'turn',
          name: 'turn',
          status: 'in_progress',
          startedAt: at ?? lastAt ?? EPOCH,
          ...(ctx.redact ? { content: { promptPreview: null } } : {}),
          attributes: {},
          provenance: { file, line },
        };
        current = { span, open: true, prompted: false };
        turns.set(id, current);
        summary.turns++;
        ctx.spans.push(span);
      } else if (event === 'task_complete' || event === 'turn_aborted') {
        const id = str(payload.turn_id);
        const turn = id === undefined ? current : turns.get(id);
        if (turn === undefined || !turn.open) continue;
        turn.open = false;
        if (turn === current) current = undefined;
        const { span } = turn;
        span.endedAt = at ?? lastAt ?? span.startedAt;
        const durationMs = durationBetween(span.startedAt, span.endedAt);
        if (durationMs !== undefined) span.durationMs = durationMs;
        if (event === 'turn_aborted') {
          span.status = 'cancelled';
          const reason = str(payload.reason);
          if (reason !== undefined) span.statusReason = reason;
        } else if (isObj(payload.error)) {
          span.status = 'error';
          const code = errorCodeOf(payload.error);
          if (code !== undefined) span.statusReason = code;
        } else {
          span.status = 'ok';
        }
      }
    } else if (type === 'response_item') {
      if (
        payload.type === 'message' &&
        payload.role === 'user' &&
        current !== undefined &&
        !current.prompted
      ) {
        const prompt = promptOf(payload);
        if (prompt !== undefined) {
          current.prompted = true;
          if (!ctx.redact) current.span.content = { promptPreview: prompt };
        }
      }
    }
  }

  if (session === undefined || summary === undefined) {
    // an empty file is Codex's own, created and not yet written to; a file
    // with text and no record in it is something else under a rollout name
    if (!sawText) throw new NoSessionYet('empty Codex rollout');
    throw new Error('not a Codex rollout: no line of it is a JSON record');
  }
  session.startedAt = firstAt ?? EPOCH;
  if (lastAt !== undefined && firstAt !== undefined) {
    session.endedAt = lastAt;
    const durationMs = durationBetween(firstAt, lastAt);
    if (durationMs !== undefined) session.durationMs = durationMs;
  }
  return summary;
}

async function parse(
  candidate: Candidate,
  opts: ParseOptions,
): Promise<RawRun> {
  const ctx: ParseContext = { spans: [], warnings: [], redact: opts.redact };
  const thread = await emitThread(candidate.runRef, ctx);
  // A rollout that holds its first record and no turn is a session nobody
  // has prompted yet: nothing is wrong and there is nothing to show.
  if (thread.turns === 0) {
    throw new NoSessionYet('Codex rollout with no turn yet');
  }
  return {
    source: {
      tool: 'codex',
      format: 'codex-jsonl',
      files: candidate.files,
    },
    ...(thread.cwd === undefined
      ? {}
      : {
          project: {
            name: projectName(thread.cwd),
            path: thread.cwd,
            ...(thread.gitBranch === undefined
              ? {}
              : { gitBranch: thread.gitBranch }),
          },
        }),
    spans: ctx.spans,
    warnings: ctx.warnings,
  };
}

export const codexAdapter: SourceAdapter = {
  id: 'codex',

  defaultRoots,

  detect,

  parse,
};
