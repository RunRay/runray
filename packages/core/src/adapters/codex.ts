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
import {
  isCompressedRollout,
  isRolloutFileName,
  isZstdUnavailable,
  readRolloutLines,
} from '../rollout-lines.js';
import { HARNESS_TOOLS } from '../tools/registry.js';
import type { ShellDialect } from '../tools/shell.js';
import { errorPreview } from './error-preview.js';
import { durationBetween, extendContainers } from './span-time.js';
import { toolTargetAttributes } from './target.js';
import { guessShellDialect, shellScriptAttributes } from './usage.js';

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
 * own: its file joins the candidate of its root thread, and in the run it
 * is one `subagent` span with its own turns and calls beneath it, hung on
 * the turn of its parent that started it (design D2, T10).
 *
 * What `parse()` emits: the session span, one `turn` span per turn the
 * rollout brackets (design D3, T6), one `llm_call` span per API response
 * (T4, T5) and one tool span per thing the harness did (D4, T7), a
 * command's span with the identity of the program it ran (T8) and a file
 * change's with the lines it changed (T9); then the same for each child
 * thread, under its `subagent` span.
 *
 * Tool spans are harness actions, not model calls. Current Codex gives the
 * model one tool, `exec`, whose input is a script; what the script ran is
 * recorded as `item_completed` events (a command, a file change, an MCP
 * call, a web search). Each of those is a span. The model's own call is a
 * span only when no action came of it.
 *
 * Two token eras. A current rollout has a `token_usage_record` per
 * response, and that is the only thing tokens are read from. A rollout from
 * before those records existed has only the running `token_count` event;
 * there a call is emitted each time the event's thread total moves.
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
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}
/**
 * One word of the harness's own vocabulary: a reason, an error code, the
 * kind of an extension or of a subagent. These reach fields that survive
 * redaction, so a value is taken only when it has the shape of such a word.
 * Every value surveyed has (`interrupted`, `usage_limit_exceeded`,
 * `web.search`, `guardian`); a sentence in the same place is not one, and
 * is dropped unread.
 */
const HARNESS_WORD = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
function word(v: unknown): string | undefined {
  return typeof v === 'string' && HARNESS_WORD.test(v) ? v : undefined;
}
/** A token counter: a whole number, never below zero. */
function count(v: unknown): number {
  const n = num(v);
  return n === undefined ? 0 : Math.max(0, Math.round(n));
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
    else if (entry.isFile() && isRolloutFileName(entry.name)) out.push(path);
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

/** The file is not a rollout. `parse()` refuses a root for it; for a
 * child's file it is a run warning. */
class NotARollout extends Error {
  constructor(why: string) {
    super(`not a Codex rollout: ${why}`);
  }
}

interface ParseContext {
  spans: RawSpan[];
  warnings: RunWarning[];
  redact: boolean;
}

/** Where a thread's first turn says it came from. */
interface FirstTurn {
  startedAt: string;
  /** `turn_attribution.parent_turn_id`: a turn of the parent thread. */
  parentTurnId: string | undefined;
  /** `root_turn_id`: a turn of the root thread. */
  rootTurnId: string | undefined;
}

/** What one rollout said about its thread. */
interface ThreadSummary {
  threadId: string;
  /** The thread it names as its parent. */
  parentThreadId: string | undefined;
  cwd: string | undefined;
  gitBranch: string | undefined;
  /** Turns the file started. */
  turns: number;
  /** Model calls the file recorded. */
  llmCalls: number;
  /** The span everything of the thread hangs from: the session span of a
   * root thread, the subagent span of a child. */
  top: RawSpan;
  /** The thread's turn spans, by the id the rollout gives each turn. */
  turnSpans: Map<string, RawSpan>;
  firstTurn: FirstTurn | undefined;
}

interface TurnState {
  span: RawSpan;
  open: boolean;
  /** The turn already has its prompt; later user messages are not it. */
  prompted: boolean;
  /** The call of this turn whose output was read last. */
  lastClosed: CallState | undefined;
}

/** How a model-level call ended, read from its output record. */
interface CallOutcome {
  status: 'ok' | 'error' | 'cancelled';
  statusReason?: string;
  exitCode?: number;
  outputBytes?: number;
  /** How long the output says the command ran. */
  durationMs?: number;
  /** The start of what a failure said. */
  preview?: string;
}

/** A model-level tool call: a `…_call` record and, once read, its output. */
interface CallState {
  id: string;
  name: string;
  line: number;
  at: string | undefined;
  /** The turn it was made in. */
  turn: TurnState | undefined;
  /** The response being read when it was made, in each token era. */
  response: ResponseSoFar;
  legacyResponse: ResponseSoFar;
  /** Harness actions attributed to it, and how many of them failed. */
  actions: number;
  failedActions: number;
  /** What its span carries if it becomes one: the identity of the command
   * for a call to a shell tool, of the file for a patch of one file,
   * nothing for any other. */
  attributes: Record<string, unknown>;
  /** The patch it applied, when it is a legacy patch call. */
  change: ChangeSummary | undefined;
  /** The span of the harness action that carries this call's id. */
  own: RawSpan | undefined;
  /** When it stopped waiting for its output: the output was read, or the
   * next turn began without one. */
  until: string | undefined;
  /** What its output said; none read yet when absent. */
  outcome: CallOutcome | undefined;
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A record's own time in the one form this file works with: ISO-8601, UTC,
 * milliseconds. Codex writes exactly that (all 121,445 surveyed records).
 * Anything else that still parses is converted to it, and anything that
 * does not is no time at all. One form matters because times are compared
 * as strings below: `…00Z` sorts after `…00.500Z`.
 */
function timeOf(record: Json): string | undefined {
  const raw = str(record.timestamp);
  if (raw === undefined) return undefined;
  if (ISO_UTC_MS.test(raw)) return raw;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
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
 * What a child thread is, from `session_meta.source` (design T10). The
 * approval reviewer is `{subagent: {other: "guardian"}}`, on all 183 child
 * threads surveyed. Any other child is named by what kind of subagent the
 * harness says it is: the key under `subagent`, or `subagent` itself where
 * it is a bare word. The value under a key is never the name: `other` holds
 * free text.
 */
function agentNameOf(source: unknown): string {
  const subagent = isObj(source) ? source.subagent : undefined;
  if (!isObj(subagent)) return word(subagent) ?? 'unknown';
  if (subagent.other === 'guardian') return 'guardian';
  return word(Object.keys(subagent)[0]) ?? 'unknown';
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
  return word(isObj(info) ? Object.keys(info)[0] : info);
}

/** The start of the first text the model wrote in an assistant message. */
function assistantTextOf(message: Json): string | undefined {
  if (!Array.isArray(message.content)) return undefined;
  for (const part of message.content) {
    if (!isObj(part) || part.type !== 'output_text') continue;
    const text = str(part.text)?.trim();
    if (text !== undefined && text !== '') return text.slice(0, PREVIEW_CHARS);
  }
  return undefined;
}

type TokenCounts = NonNullable<RawSpan['llm']>['tokens'];

/**
 * Codex's counters to the schema's disjoint ones (design T5). Codex counts
 * cached input inside `input_tokens` and reasoning inside `output_tokens`;
 * the schema keeps each apart, so the five parts sum to Codex's
 * `total_tokens`. A record whose parts exceed their whole clamps to zero
 * instead of going negative. `reasoning` is left out when zero, as in the
 * OpenCode adapter.
 */
function tokensOf(usage: Json): TokenCounts {
  const cacheRead = count(usage.cached_input_tokens);
  const cacheWrite = count(usage.cache_write_input_tokens);
  const reasoning = count(usage.reasoning_output_tokens);
  return {
    input: Math.max(0, count(usage.input_tokens) - cacheRead - cacheWrite),
    output: Math.max(0, count(usage.output_tokens) - reasoning),
    cacheRead,
    cacheWrite,
    ...(reasoning === 0 ? {} : { reasoning }),
  };
}

/** What has been read of the response being written: everything since the
 * last point at which a response is known to have ended. */
interface ResponseSoFar {
  /** The start of its first assistant text. */
  preview: string | undefined;
  /** Line of its first assistant message. */
  messageLine: number | undefined;
  /** Line of its first tool call. */
  callLine: number | undefined;
  /** The earliest its request can have been sent: the end of the response
   * before it, or the tool output handed back since. */
  floor: string | undefined;
  /** Its `llm_call`, once there is one. Usually that is when the response
   * is over and nothing more is read into it; in a rollout that writes the
   * token event first, the call exists before its items do. */
  span: RawSpan | undefined;
}

function newResponse(floor: string | undefined): ResponseSoFar {
  return {
    preview: undefined,
    messageLine: undefined,
    callLine: undefined,
    floor,
    span: undefined,
  };
}

// ---------------------------------------------------------------------------
// Tools: harness actions and the calls that led to them (design D4, T7)
// ---------------------------------------------------------------------------

/** A time the harness gives as milliseconds since the epoch. */
function isoOfMs(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** `{secs, nanos}`, the way the harness writes how long something took. */
function durationMsOf(v: unknown): number | undefined {
  if (!isObj(v)) return undefined;
  const secs = num(v.secs);
  const nanos = num(v.nanos);
  if (secs === undefined && nanos === undefined) return undefined;
  return Math.max(0, (secs ?? 0) * 1000 + (nanos ?? 0) / 1e6);
}

/** The first of the values that is text with something in it. */
function firstText(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

interface ActionIdentity {
  name: string;
  kind: 'tool_call' | 'mcp_call';
  mcpServer?: string;
}

/**
 * What an `item_completed` item is as a tool, or nothing when the item is
 * not something the harness did (reasoning, a message, a compaction, a type
 * a later Codex adds). The names are the harness's own, the ones the
 * tool-usage registry lists: `exec_command` for a command, `apply_patch`
 * for a file change, an extension's kind verbatim (`web.search`,
 * `clock.sleep`, `image_gen.generation`), and for an MCP call the tool's
 * name with its server next to it.
 */
function actionIdentity(item: Json): ActionIdentity | undefined {
  switch (item.type) {
    case 'CommandExecution':
      return { name: 'exec_command', kind: 'tool_call' };
    case 'FileChange':
      return { name: 'apply_patch', kind: 'tool_call' };
    case 'ImageView':
      return { name: 'view_image', kind: 'tool_call' };
    case 'Extension':
      return { name: word(item.kind) ?? 'extension', kind: 'tool_call' };
    case 'McpToolCall': {
      const mcpServer = str(item.server);
      return {
        name: str(item.tool) ?? 'mcp_tool',
        kind: 'mcp_call',
        ...(mcpServer === undefined ? {} : { mcpServer }),
      };
    }
    default:
      return undefined;
  }
}

/** A failure given as its text or as `{message}`. */
function messageOf(v: unknown): string | undefined {
  return typeof v === 'string' ? v : isObj(v) ? str(v.message) : undefined;
}

/** What a failed action said: the command's output, the patch tool's
 * stderr, the text parts of an MCP result. */
function failureTextOf(item: Json): string | undefined {
  if (item.type === 'McpToolCall') {
    const content = isObj(item.result) ? item.result.content : undefined;
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = isObj(part) ? firstText(part.text) : undefined;
        if (text !== undefined) return text;
      }
    }
    return firstText(messageOf(item.error));
  }
  return firstText(
    item.aggregated_output,
    item.formatted_output,
    item.stderr,
    item.stdout,
    messageOf(item.failure),
    messageOf(item.error),
  );
}

/** The size of the text an MCP tool returned: the text parts of
 * `result.content` (an image part is not text and is not counted). */
function mcpTextBytes(item: Json): number | undefined {
  const content = isObj(item.result) ? item.result.content : undefined;
  if (!Array.isArray(content)) return undefined;
  let bytes = 0;
  for (const part of content) {
    if (isObj(part) && typeof part.text === 'string') {
      bytes += Buffer.byteLength(part.text, 'utf8');
    }
  }
  return bytes;
}

/**
 * The one tool output a run keeps is the start of a failure's text, as in
 * the other adapters; under redaction it is null. A failure that said
 * nothing has no `content` in either mode: the two parses of one file must
 * differ in values only, never in which fields exist, or the sanitized
 * forms of the two could not be told to match (redaction parity).
 */
function failureContent(
  redact: boolean,
  preview: string | undefined,
): Pick<RawSpan, 'content'> {
  if (preview === undefined) return {};
  return { content: { outputPreview: redact ? null : preview } };
}

function previewOf(text: string | undefined): string | undefined {
  return text === undefined || text.trim() === ''
    ? undefined
    : errorPreview(text, PREVIEW_CHARS);
}

/** The text of an output record: a string, or the text parts of a list
 * (an image part has none). */
function outputTextOf(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return undefined;
  let text: string | undefined;
  for (const part of output) {
    if (isObj(part) && typeof part.text === 'string') {
      text = (text ?? '') + part.text;
    }
  }
  return text;
}

// --- commands: the script inside the shell wrapper (design T8) -------------

/** A command as its shell reads it. */
interface Script {
  text: string;
  dialect: ShellDialect;
  /** The source does not name the shell; the dialect is read off the text
   * and the thread. */
  guessed: boolean;
}

const POWERSHELL_WRAPPERS: ReadonlySet<string> = new Set([
  'pwsh',
  'powershell',
]);
const POSIX_WRAPPERS: ReadonlySet<string> = new Set([
  'bash',
  'zsh',
  'sh',
  'dash',
]);

/** A program as its argv names it: no directory, no `.exe`, lowercase. */
function programOf(arg0: string): string {
  const name = arg0.split(/[\\/]/).at(-1) ?? arg0;
  return name.toLowerCase().replace(/\.exe$/, '');
}

/**
 * The script of a Codex command, taken out of the shell it is handed to.
 *
 * A command is an argv that starts with its shell: `pwsh.exe -Command …`
 * (8,232 of 8,407 actions), `cmd.exe /c …` (175), and in the legacy era
 * `powershell.exe -NoProfile -Command …` or `bash -lc …`. The script is
 * what follows the switch that hands the shell a command (the last element
 * in every command surveyed), read the way that shell takes it: PowerShell
 * and `cmd` join everything after the switch into one command line, a
 * POSIX shell takes the next word alone. The wrapper names the dialect.
 * `cmd` has none of the two dialects, so its script is read by how it
 * looks, as a hook command is.
 *
 * An argv with no shell in front is the command itself (`git status`). It
 * is written back as one POSIX command line, each argument quoted where it
 * needs to be, so that a `;` inside a commit message stays inside it. Its
 * program is written without its directory when the path would not survive
 * being read back as one word.
 *
 * A legacy `shell_command` gives the script as a bare string with nothing
 * that names the shell. Codex runs those in PowerShell on Windows, so a
 * thread working in a Windows directory says more than the text does: all
 * 331 are in such threads, 172 of them without a backslash to go by.
 */
function scriptOf(command: unknown, windows: boolean): Script | undefined {
  if (typeof command === 'string') {
    const text = command.trim();
    if (text === '') return undefined;
    return {
      text,
      dialect: windows ? 'powershell' : guessShellDialect(text),
      guessed: true,
    };
  }
  if (!Array.isArray(command)) return undefined;
  const argv = command.filter((a): a is string => typeof a === 'string');
  const [arg0, ...rest] = argv;
  if (arg0 === undefined) return undefined;
  const program = programOf(arg0);
  if (POWERSHELL_WRAPPERS.has(program)) {
    const text = handedTo(rest, /^-(?:c|command)$/i, true);
    if (text !== undefined) {
      return { text, dialect: 'powershell', guessed: false };
    }
  } else if (POSIX_WRAPPERS.has(program)) {
    const text = handedTo(rest, /^-[A-Za-z]*c$/, false);
    if (text !== undefined) return { text, dialect: 'posix', guessed: false };
  } else if (program === 'cmd') {
    const text = handedTo(rest, /^\/[ck]$/i, true);
    if (text !== undefined) {
      return { text, dialect: guessShellDialect(text), guessed: true };
    }
  }
  const head = /[\s\\]/.test(arg0) ? program : arg0;
  return {
    text: [head, ...rest.map(posixWord)].join(' '),
    dialect: 'posix',
    guessed: false,
  };
}

/**
 * The script a shell wrapper was handed: what follows the switch that
 * introduces a command, all of it joined when the shell joins it, else the
 * one word after the switch. With no such switch the shell was given a
 * script file and its arguments (`bash build.sh --fast`): what is left
 * after the shell's own options. Nothing when the wrapper stands alone.
 */
function handedTo(
  rest: string[],
  commandSwitch: RegExp,
  joinsTheRest: boolean,
): string | undefined {
  const at = rest.findIndex((arg) => commandSwitch.test(arg));
  if (at < 0) {
    const file = rest.findIndex((arg) => !arg.startsWith('-'));
    return file < 0 ? undefined : rest.slice(file).join(' ');
  }
  const after = rest.slice(at + 1);
  return joinsTheRest && after.length > 0 ? after.join(' ') : after[0];
}

/** An argument as a POSIX shell would need it written to read it back as
 * one word. */
function posixWord(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)
    ? arg
    : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * What a command's span carries: the target identity and the tool usage of
 * its script (the same attributes a Claude Code `Bash` or `PowerShell` call
 * gets, so `pnpm test` is one tool in every source). The script itself is
 * read here and not kept, redacted or not. A command that cannot be read
 * is still a classified shell call, of an activity nobody could tell.
 */
function commandAttributes(
  name: string,
  command: unknown,
  windows: boolean,
  redact: boolean,
): Record<string, unknown> {
  const script = scriptOf(command, windows);
  if (script === undefined) {
    return shellScriptAttributes('', 'posix', false, redact);
  }
  return {
    ...toolTargetAttributes('codex', name, { command: script.text }, redact),
    ...shellScriptAttributes(
      script.text,
      script.dialect,
      script.guessed,
      redact,
    ),
  };
}

/** The arguments a function call was made with: JSON in a string. */
function argsOfCall(payload: Json): Json | undefined {
  let args: unknown = payload.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  return isObj(args) ? args : undefined;
}

/** The command a call to a shell tool was made with: `command` (an argv or
 * a string) in the legacy tools, `cmd` in `exec_command`. */
function commandOf(args: Json | undefined): unknown {
  return args?.command ?? args?.cmd;
}

/**
 * A path a call gives, as a path from the root. A path that is already one
 * is left exactly as written, which is how the other adapters hash theirs.
 * A relative one is taken from the directory the call ran in, with `.` and
 * `..` resolved; the separators do not matter to the result's identity
 * (`target.ts` hashes the POSIX form), so they are written as `/`.
 */
function rootedPath(path: string, base: string | undefined): string {
  if (base === undefined || /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)) return path;
  const out: string[] = [];
  for (const segment of `${base}/${path}`.split(/[\\/]/)) {
    if (segment === '.' || (segment === '' && out.length > 0)) continue;
    if (segment === '..' && out.length > 1 && out.at(-1) !== '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

// --- file changes: what a patch did (design T9) ----------------------------

/** What a file change did, summed over the paths it names. */
interface ChangeSummary {
  paths: string[];
  added: number;
  removed: number;
}

/** Lines of a text. A final line break ends the last line; it does not
 * start another. */
function linesOf(text: unknown): number {
  if (typeof text !== 'string' || text === '') return 0;
  let breaks = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    breaks++;
  }
  return text.endsWith('\n') ? breaks : breaks + 1;
}

const SIZED_HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Added and removed lines of a unified diff. Only lines inside a hunk
 * count, and a hunk that states its size (`@@ -20,3 +20,4 @@`, every hunk
 * Codex writes) ends when that many lines have been read. So the `---` and
 * `+++` lines that head a diff are never counted, and a removed line whose
 * own text begins with `--` is. A diff with no hunk header at all is
 * counted line by line, its header lines left out.
 */
function diffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let sawHunk = false;
  let inHunk = false;
  let sized = false;
  let oldLeft = 0;
  let newLeft = 0;
  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const size = SIZED_HUNK.exec(line);
      sawHunk = true;
      inHunk = true;
      sized = size !== null;
      oldLeft = size === null ? 0 : Number(size[1] ?? 1);
      newLeft = size === null ? 0 : Number(size[2] ?? 1);
      continue;
    }
    if (!inHunk) continue;
    const mark = line[0];
    if (mark === '\\') continue; // "\ No newline at end of file"
    if (sized && oldLeft <= 0 && newLeft <= 0) {
      inHunk = false; // the hunk is complete: what follows is not its line
    } else if (mark === '+') {
      added++;
      newLeft--;
    } else if (mark === '-') {
      removed++;
      oldLeft--;
    } else {
      oldLeft--;
      newLeft--;
    }
  }
  if (sawHunk) return { added, removed };
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/**
 * A `FileChange` item's `changes`: path → `{type: 'add', content}`,
 * `{type: 'delete', content}` or `{type: 'update', unified_diff}`. An added
 * file adds its lines, a deleted one removes them, an update is counted
 * from its diff.
 */
function changesOf(changes: unknown): ChangeSummary | undefined {
  if (!isObj(changes)) return undefined;
  const summary: ChangeSummary = { paths: [], added: 0, removed: 0 };
  for (const [path, change] of Object.entries(changes)) {
    summary.paths.push(path);
    if (!isObj(change)) continue;
    if (change.type === 'add') summary.added += linesOf(change.content);
    else if (change.type === 'delete') {
      summary.removed += linesOf(change.content);
    } else if (typeof change.unified_diff === 'string') {
      const lines = diffLines(change.unified_diff);
      summary.added += lines.added;
      summary.removed += lines.removed;
    }
  }
  return summary;
}

const PATCH_BEGIN = '*** Begin Patch';
const PATCH_END = '*** End Patch';
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/;

/**
 * The same summary from the text of a patch, the form the legacy era has
 * instead of a `FileChange` item:
 *
 *   *** Begin Patch
 *   *** Update File: src/totals.ts
 *   @@
 *   -old line
 *   +new line
 *   *** End Patch
 *
 * A deleted file has no body there, so its lines are not known.
 */
function patchOf(text: string): ChangeSummary | undefined {
  const from = text.indexOf(PATCH_BEGIN);
  if (from < 0) return undefined;
  const to = text.indexOf(PATCH_END, from);
  const summary: ChangeSummary = { paths: [], added: 0, removed: 0 };
  for (const line of text.slice(from, to < 0 ? undefined : to).split('\n')) {
    if (line.startsWith('***')) {
      const path = PATCH_FILE.exec(line)?.[1];
      if (path !== undefined) summary.paths.push(path);
    } else if (line.startsWith('+')) summary.added++;
    else if (line.startsWith('-')) summary.removed++;
  }
  return summary;
}

/**
 * The patch a legacy call applied, if that is what the call did. Three
 * forms were seen, none with a harness action of its own: the `apply_patch`
 * tool with the patch as its input (300), a `shell` call whose argv is
 * `["apply_patch", <patch>]` (238), and a shell script that starts with
 * `apply_patch` and holds the patch in a here-document (30).
 */
function patchOfCall(
  name: string,
  payload: Json,
  command: unknown,
  windows: boolean,
): ChangeSummary | undefined {
  if (name === 'apply_patch') {
    const input = str(payload.input);
    return input === undefined ? undefined : patchOf(input);
  }
  if (HARNESS_TOOLS.get(name)?.role !== 'shell') return undefined;
  if (Array.isArray(command)) {
    const [program, patch] = command;
    if (typeof program === 'string' && programOf(program) === 'apply_patch') {
      return typeof patch === 'string' ? patchOf(patch) : undefined;
    }
  }
  const script = scriptOf(command, windows)?.text;
  return script !== undefined && /^\s*apply_patch\b/.test(script)
    ? patchOf(script)
    : undefined;
}

/**
 * File-write identity for a change of exactly one path (the mean is 2.2
 * paths per change; with several there is no one target, as for OpenCode's
 * `apply_patch`). A relative path, which a legacy patch may give, is taken
 * from the directory the change was made in, so the same file has the same
 * key however the patch spells it.
 */
function changeAttributes(
  change: ChangeSummary | undefined,
  base: string | undefined,
  redact: boolean,
): Record<string, unknown> {
  const [path, ...others] = change?.paths ?? [];
  if (path === undefined || others.length > 0) return {};
  return toolTargetAttributes(
    'codex',
    'apply_patch',
    { path: rootedPath(path, base) },
    redact,
  );
}

// The lines the harness puts in front of an output. A script's:
//   Script completed | Script failed | Script terminated |
//   Script running with cell ID 12
//   Wall time 1.4 seconds
//   Output:
// and a legacy command's:
//   Exit code: 1
//   Wall time: 1.4 seconds
//   Output:
const SCRIPT_HEAD =
  /^Script (completed|failed|terminated|running with cell ID \d+)$/;
const EXIT_HEAD = /^Exit code: (-?\d+)$/;
const WALL_HEAD = /^Wall time:? (\d+(?:\.\d+)?) seconds$/;
/** What the harness answers a call the person stopped. */
const ABORTED_BY_USER = /^aborted by user/i;
/**
 * Calls of the era before harness actions were recorded: there the call is
 * the command, and a successful one always reports an exit code, so an
 * output without one is a refusal. This is a narrower list than the
 * registry's shell tools on purpose. Any call to a shell tool has its
 * command classified, but the refusal rule is a measurement (71 of 71) on
 * these three names only: the output format of the other shell tools was
 * not seen, and guessing it wrong would turn every command into an error.
 */
const COMMAND_CALLS: ReadonlySet<string> = new Set([
  'shell',
  'shell_command',
  'apply_patch',
]);

interface OutputHead {
  /** `completed`, `failed`, … for a script; absent for a command. */
  script?: string;
  exitCode?: number;
  wallMs?: number;
  /** The text after the head. */
  body: string;
}

function headOf(text: string): OutputHead | undefined {
  let pos = 0;
  const nextLine = (): { text: string; after: number } => {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl;
    return {
      text: text.slice(pos, end).replace(/\r$/, ''),
      after: nl < 0 ? text.length : nl + 1,
    };
  };
  const first = nextLine();
  const script = SCRIPT_HEAD.exec(first.text)?.[1];
  const exit = EXIT_HEAD.exec(first.text)?.[1];
  if (script === undefined && exit === undefined) return undefined;
  pos = first.after;
  const second = nextLine();
  const wall = WALL_HEAD.exec(second.text)?.[1];
  if (wall !== undefined) pos = second.after;
  const third = nextLine();
  if (third.text === 'Output:') pos = third.after;
  return {
    ...(script === undefined ? {} : { script }),
    ...(exit === undefined ? {} : { exitCode: Number(exit) }),
    ...(wall === undefined ? {} : { wallMs: Number(wall) * 1000 }),
    body: text.slice(pos),
  };
}

/**
 * How a call ended, from its output record. Four shapes were seen:
 *
 * - a script's output with its head lines: `Script failed` is the failure;
 * - a legacy command's output as JSON, `{output, metadata: {exit_code,
 *   duration_seconds}}`, or as text under an `Exit code:` head: a non-zero
 *   exit code is the failure, and the duration is the command's own (the
 *   records around it are written in one batch, so their times are not);
 * - plain text from a legacy command call, with neither: the harness could
 *   not run it (arguments it could not parse, a patch it refused), since a
 *   command that ran always reports an exit code (71 of 71 in the survey);
 * - plain text from any other call (`update_plan`, `view_image`): no
 *   outcome to read, so the call went through.
 *
 * `outputBytes` is the size of the text the model was handed, or of the
 * `output` field inside the JSON form.
 */
function outcomeOf(name: string, output: unknown): CallOutcome {
  const text = outputTextOf(output);
  if (text === undefined) return { status: 'ok' };
  const bytes = (shown: string) => Buffer.byteLength(shown, 'utf8');

  if (typeof output === 'string' && output.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      // not JSON after all: read as text below
    }
    if (isObj(parsed) && isObj(parsed.metadata)) {
      const body = typeof parsed.output === 'string' ? parsed.output : '';
      const exitCode = int(parsed.metadata.exit_code);
      const seconds = num(parsed.metadata.duration_seconds);
      const failed = exitCode !== undefined && exitCode !== 0;
      const preview = failed ? previewOf(body) : undefined;
      return {
        status: failed ? 'error' : 'ok',
        ...(exitCode === undefined ? {} : { exitCode }),
        outputBytes: bytes(body),
        ...(seconds === undefined
          ? {}
          : { durationMs: Math.max(0, seconds * 1000) }),
        ...(preview === undefined ? {} : { preview }),
      };
    }
  }

  const head = headOf(text);
  if (head !== undefined) {
    const failed =
      head.script === 'failed' ||
      (head.exitCode !== undefined && head.exitCode !== 0);
    const preview = failed ? previewOf(head.body) : undefined;
    return {
      status: failed ? 'error' : 'ok',
      ...(head.exitCode === undefined ? {} : { exitCode: head.exitCode }),
      outputBytes: bytes(text),
      // a script's wall time includes its waits; the call's two records
      // already bracket it, so only a command's own duration is taken
      ...(head.script === undefined && head.wallMs !== undefined
        ? { durationMs: head.wallMs }
        : {}),
      ...(preview === undefined ? {} : { preview }),
    };
  }

  const stopped = ABORTED_BY_USER.test(text);
  if (!stopped && !COMMAND_CALLS.has(name)) {
    return { status: 'ok', outputBytes: bytes(text) };
  }
  const preview = previewOf(text);
  return {
    // stopping a call is the person's decision, not the tool failing: the
    // same status and reason the other adapters give a declined call
    ...(stopped
      ? { status: 'cancelled', statusReason: 'user-rejected' }
      : { status: 'error' }),
    outputBytes: bytes(text),
    ...(preview === undefined ? {} : { preview }),
  };
}

/**
 * Reads one rollout and emits its spans: the thread's own span, a `turn`
 * span per turn and an `llm_call` span per response.
 *
 * An `llm_call` is one `token_usage_record` (design T4): its tokens are the
 * record's own `usage`, never a difference of the running thread total,
 * which in a child thread starts from what the parent had used. It belongs
 * to the turn the record names, or to the turn started last when the file
 * never started that one. Response items with no usage record after them
 * (an aborted response) give no call.
 *
 * Turns are matched by id, never by position (design T6): a completion or
 * an abort for an id the file never started is ignored, which five reviewer
 * threads in the survey need. A turn still open at the end of the file is
 * `in_progress`.
 */
async function emitThread(
  file: string,
  ctx: ParseContext,
  /** The thread is read as a child of the run's root: its top span is a
   * `subagent` span, which `emitChildren` hangs on the parent thread. */
  child: boolean,
): Promise<ThreadSummary> {
  let session: RawSpan | undefined;
  let summary: ThreadSummary | undefined;
  let sawText = false;
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  const turns = new Map<string, TurnState>();
  /** The turn records belong to: the one started last and not yet ended. */
  let current: TurnState | undefined;
  /** The turn started last, ended or not. */
  let latest: TurnState | undefined;

  let provider = 'unknown';
  /** The approval reviewer's thread: what its turns are asked is written by
   * the harness, never by a person (4 fixed texts over 1,764 turns), so no
   * turn of it has a prompt to preview. */
  let reviewer = false;
  /** The thread works in a Windows directory (a drive or a UNC path). */
  let windows = false;
  /** `turn_context` names the model of a turn, and may do so again. */
  const modelOfTurn = new Map<string, string>();
  let lastModel: string | undefined;
  const spanIds = new Set<string>();
  /** An id no other span of the file has: the second record to claim one
   * takes its line into its id. */
  const uniqueId = (id: string, line: number): string => {
    const spanId = spanIds.has(id) ? `${id}:${line}` : id;
    spanIds.add(spanId);
    return spanId;
  };

  // Model-level calls by `call_id`, and the tool spans read so far. Tool
  // spans are held back until the file is read, for two reasons: whether a
  // call is left without an action is known only then (an action can be
  // written after its call's output, 27 times after its turn's end), and so
  // is the token era, which decides which `llm_call` made the call.
  const calls = new Map<string, CallState>();
  /** Every call, in the order they were made. */
  const callOrder: CallState[] = [];
  /** Calls with no output yet, in the order they were made. */
  let openCalls: CallState[] = [];
  const toolSpans: { span: RawSpan; call: CallState | undefined }[] = [];
  /** The call that was waiting for its output at a given moment. Calls do
   * not overlap in what was surveyed, so the latest one made by then is the
   * only candidate; a few more are looked at in case two ever run at once. */
  const callOpenAt = (when: string): CallState | undefined => {
    for (let i = callOrder.length - 1, tried = 0; i >= 0 && tried < 16; i--) {
      const call = callOrder[i];
      if (call === undefined || call.at === undefined || call.at > when) {
        continue;
      }
      if (call.until === undefined || when <= call.until) return call;
      tried++;
    }
    return undefined;
  };

  // Both eras are followed while reading, because which one a file is in is
  // known only at its end: a file with usage records ignores token events.
  let response = newResponse(undefined);
  let legacyResponse = newResponse(undefined);
  const legacyCalls: RawSpan[] = [];
  let lastThreadTotal: string | undefined;
  // A legacy rollout writes a response's token event on either side of the
  // response's items: before them in CLI 0.47, which records the items in
  // one batch once the tool has run (106 turns surveyed, every one), after
  // them in the later releases (36 turns). Which it is shows at a turn's
  // first token event: has the model written anything in the turn yet?
  let tokenFirst: boolean | undefined;
  let wroteInTurn = false;

  /** In the token-first order the call is emitted before its items are
   * read; what they say is filled in as they arrive. */
  const fillIn = (so: ResponseSoFar): void => {
    const span = so.span;
    if (span === undefined) return;
    const line = so.messageLine ?? so.callLine;
    if (line !== undefined) span.provenance = { file, line };
    if (!ctx.redact && so.preview !== undefined) {
      span.content = { outputPreview: so.preview };
    }
  };

  const llmCall = (
    id: string,
    turn: TurnState | undefined,
    namedTurnId: string | undefined,
    usage: Json,
    so: ResponseSoFar,
    at: string | undefined,
    line: number,
    sessionSpan: RawSpan,
  ): RawSpan => {
    const endedAt = at ?? lastAt ?? sessionSpan.startedAt;
    // The response began when its request was sent: at the turn's start, or
    // when the last tool output was handed back, or when the response before
    // it ended, whichever is latest. That includes the wait for the first
    // token, which is model time.
    let startedAt = turn?.span.startedAt ?? so.floor ?? endedAt;
    if (so.floor !== undefined && so.floor > startedAt) startedAt = so.floor;
    if (startedAt > endedAt) startedAt = endedAt;
    const model =
      (namedTurnId === undefined ? undefined : modelOfTurn.get(namedTurnId)) ??
      (turn === undefined ? undefined : modelOfTurn.get(turn.span.id)) ??
      lastModel ??
      'unknown';
    const durationMs = durationBetween(startedAt, endedAt);
    return {
      // no response id repeats in 13,535 records; if one ever does, both
      // records are calls
      id: uniqueId(id, line),
      parentId: turn?.span.id ?? sessionSpan.id,
      kind: 'llm_call',
      name: model,
      status: 'ok',
      startedAt,
      endedAt,
      ...(durationMs === undefined ? {} : { durationMs }),
      llm: {
        provider,
        model,
        tokens: tokensOf(usage),
        // Codex records no cost; the cost engine prices the tokens
        costSource: 'unknown',
      },
      ...(ctx.redact
        ? { content: { outputPreview: null } }
        : so.preview === undefined
          ? {}
          : { content: { outputPreview: so.preview } }),
      attributes: {},
      // the record a reader wants behind this span: what the model said,
      // else the call it made, else the usage record itself
      provenance: { file, line: so.messageLine ?? so.callLine ?? line },
    };
  };

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
        throw new NotARollout('its first record is not a session_meta record');
      }
      // the id comes from the record; the name is a fallback for a record
      // without one, so the run still has a stable identity
      const threadId =
        str(payload.id) ?? basename(file).replace(/\.jsonl(\.zst)?$/i, '');
      const git = isObj(payload.git) ? payload.git : undefined;
      // what the thread is holds whether it is read as a child or, with its
      // parent not scanned, as a run of its own
      const kind = agentNameOf(payload.source);
      reviewer = kind === 'guardian';
      const agent = child ? kind : undefined;
      session = {
        id: threadId,
        parentId: null, // a child's is set once its parent thread is known
        kind: agent === undefined ? 'session' : 'subagent',
        name: agent === undefined ? 'session' : `subagent:${agent}`,
        status: 'ok',
        startedAt: EPOCH, // set once the file is read
        agent: {
          ...(agent === undefined ? {} : { name: agent }),
          sessionId: threadId,
        },
        attributes: {},
        provenance: { file, line },
      };
      summary = {
        threadId,
        parentThreadId: str(payload.parent_thread_id),
        cwd: str(payload.cwd),
        gitBranch: git === undefined ? undefined : str(git.branch),
        turns: 0,
        llmCalls: 0,
        top: session,
        turnSpans: new Map(),
        firstTurn: undefined,
      };
      provider = str(payload.model_provider) ?? 'unknown';
      windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(summary.cwd ?? '');
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
        current = { span, open: true, prompted: false, lastClosed: undefined };
        latest = current;
        turns.set(id, current);
        summary.turnSpans.set(id, span);
        if (summary.firstTurn === undefined) {
          const attribution = isObj(payload.turn_attribution)
            ? payload.turn_attribution
            : undefined;
          summary.firstTurn = {
            startedAt: span.startedAt,
            parentTurnId: str(attribution?.parent_turn_id),
            rootTurnId: str(payload.root_turn_id),
          };
        }
        summary.turns++;
        ctx.spans.push(span);
        // whatever was read before belongs to no response of this turn
        response = newResponse(undefined);
        legacyResponse = newResponse(undefined);
        tokenFirst = undefined;
        wroteInTurn = false;
        // a call still unanswered when the next turn starts will not be
        // answered in it: actions of the new turn are not its own
        for (const call of openCalls) call.until = at ?? lastAt;
        openCalls = [];
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
          const reason = word(payload.reason);
          if (reason !== undefined) span.statusReason = reason;
        } else if (isObj(payload.error)) {
          span.status = 'error';
          const code = errorCodeOf(payload.error);
          if (code !== undefined) span.statusReason = code;
        } else {
          span.status = 'ok';
        }
      } else if (event === 'token_count') {
        // the running counter: the only token source of a legacy rollout
        const info = isObj(payload.info) ? payload.info : undefined;
        if (info === undefined || !isObj(info.last_token_usage)) continue;
        // a file with a usage record is not legacy: nothing to follow
        if (summary.llmCalls > 0) continue;
        const total = JSON.stringify(info.total_token_usage);
        if (total === lastThreadTotal) continue; // repeated: no new response
        lastThreadTotal = total;
        // Before the first turn the counter is not this thread's work: a
        // child thread opens with the total and the last usage its parent
        // had reached. It is the baseline the next event is compared with,
        // never a call, or the parent's tokens would be counted twice.
        if (summary.turns === 0) continue;
        const ordinal = num(record.ordinal);
        tokenFirst ??= !wroteInTurn;
        // token first: what has been read since the last event belongs to
        // the response before this one, and only its floor carries over
        const read = tokenFirst
          ? newResponse(legacyResponse.floor)
          : legacyResponse;
        const span = llmCall(
          `${summary.threadId}:tokens:${ordinal ?? `line-${line}`}`,
          current ?? latest,
          undefined,
          info.last_token_usage,
          read,
          at,
          line,
          session,
        );
        legacyCalls.push(span);
        // the call is that of the items read before it, or (token first)
        // of the items still to come
        const next = newResponse(at ?? lastAt);
        if (tokenFirst) next.span = span;
        else legacyResponse.span = span;
        legacyResponse = next;
      } else if (event === 'item_completed') {
        // something the harness did: a tool span (design D4)
        const item = isObj(payload.item) ? payload.item : undefined;
        const identity = item === undefined ? undefined : actionIdentity(item);
        if (item === undefined || identity === undefined) continue;
        const namedTurn = str(payload.turn_id);
        const turn =
          (namedTurn === undefined ? undefined : turns.get(namedTurn)) ??
          current;
        // Whose action it is (design T7): the call it names; else the call
        // that was waiting for its output when the action started; else,
        // for an action with no start time or one started between calls,
        // the call waiting now, then the call of the same turn that got its
        // output last. The record is written when the action ends, and a
        // command can outlive the call that launched it: 1,061 of 11,649
        // ended while a later call was waiting, or just after one.
        const itemId = str(item.id);
        const began = isoOfMs(num(payload.started_at_ms));
        const named = itemId === undefined ? undefined : calls.get(itemId);
        const call =
          named ??
          (began === undefined ? undefined : callOpenAt(began)) ??
          openCalls.at(-1) ??
          turn?.lastClosed;
        const failed = item.status === 'failed';
        if (call !== undefined) {
          call.actions++;
          if (failed) call.failedActions++;
        }

        const endedAt =
          isoOfMs(num(payload.completed_at_ms)) ?? at ?? lastAt ?? EPOCH;
        const tookMs = durationMsOf(item.duration) ?? num(item.durationMs);
        // its own start where recorded, else its end less how long it took,
        // else the moment its call was made
        let startedAt =
          began ??
          (tookMs === undefined
            ? undefined
            : isoOfMs(Date.parse(endedAt) - tookMs)) ??
          call?.at ??
          endedAt;
        if (startedAt > endedAt) startedAt = endedAt;
        const durationMs = durationBetween(startedAt, endedAt);
        const exitCode = int(item.exit_code);
        // what the model was shown: of a command's output (the older item
        // has only the whole of it), or the text an MCP tool returned
        const shown =
          typeof item.formatted_output === 'string'
            ? Buffer.byteLength(item.formatted_output, 'utf8')
            : typeof item.aggregated_output === 'string'
              ? Buffer.byteLength(item.aggregated_output, 'utf8')
              : mcpTextBytes(item);
        const change =
          item.type === 'FileChange' ? changesOf(item.changes) : undefined;
        toolSpans.push({
          call,
          span: {
            id: uniqueId(itemId ?? `${summary.threadId}:action:${line}`, line),
            // replaced by the call's response once the file is read
            parentId: turn?.span.id ?? session.id,
            kind: identity.kind,
            name: identity.name,
            status: failed ? 'error' : 'ok',
            startedAt,
            endedAt,
            ...(durationMs === undefined ? {} : { durationMs }),
            tool: {
              name: identity.name,
              ...(identity.mcpServer === undefined
                ? {}
                : { mcpServer: identity.mcpServer }),
              isError: failed,
              ...(exitCode === undefined ? {} : { exitCode }),
              ...(shown === undefined ? {} : { outputBytes: shown }),
              // a change that failed changed no line
              ...(change === undefined || failed
                ? {}
                : { linesAdded: change.added, linesRemoved: change.removed }),
            },
            ...(failed
              ? failureContent(ctx.redact, previewOf(failureTextOf(item)))
              : {}),
            attributes:
              item.type === 'CommandExecution'
                ? commandAttributes(
                    identity.name,
                    item.command,
                    windows,
                    ctx.redact,
                  )
                : changeAttributes(change, summary.cwd, ctx.redact),
            provenance: { file, line },
          },
        });
        // an action that carries its call's id is that call, done
        if (named !== undefined) named.own = toolSpans.at(-1)?.span;
      }
    } else if (type === 'turn_context') {
      const model = str(payload.model);
      if (model === undefined) continue;
      lastModel = model;
      // a legacy turn_context names no turn: it speaks for the open one
      const turnId = str(payload.turn_id) ?? current?.span.id;
      if (turnId !== undefined) modelOfTurn.set(turnId, model);
    } else if (type === 'token_usage_record') {
      // one per API response, written after the response's items
      if (!isObj(payload.usage)) continue;
      const namedTurnId = str(payload.turn_id);
      const turn =
        (namedTurnId === undefined ? undefined : turns.get(namedTurnId)) ??
        latest;
      summary.llmCalls++;
      // what the token events gave so far is of no use any more
      if (summary.llmCalls === 1) legacyCalls.length = 0;
      const span = llmCall(
        str(payload.response_id) ?? `${summary.threadId}:response:${line}`,
        turn,
        namedTurnId,
        payload.usage,
        response,
        at,
        line,
        session,
      );
      ctx.spans.push(span);
      response.span = span;
      response = newResponse(at ?? lastAt);
    } else if (type === 'response_item') {
      const item = str(payload.type);
      if (item === 'message') {
        if (payload.role === 'assistant') {
          wroteInTurn = true;
          for (const so of [response, legacyResponse]) {
            so.messageLine ??= line;
            so.preview ??= assistantTextOf(payload);
          }
          fillIn(legacyResponse);
        } else if (
          payload.role === 'user' &&
          current !== undefined &&
          !current.prompted &&
          !reviewer
        ) {
          const prompt = promptOf(payload);
          if (prompt !== undefined) {
            current.prompted = true;
            if (!ctx.redact) current.span.content = { promptPreview: prompt };
          }
        }
      } else if (item === 'reasoning') {
        wroteInTurn = true;
      } else if (item?.endsWith('_call')) {
        wroteInTurn = true;
        response.callLine ??= line;
        legacyResponse.callLine ??= line;
        fillIn(legacyResponse);
        // A call the harness answers carries a `call_id` (a hosted tool's
        // record does not). It is open until its output is read.
        const callId = str(payload.call_id);
        if (callId !== undefined && !calls.has(callId)) {
          const name = str(payload.name) ?? item.slice(0, -'_call'.length);
          // In the legacy era no action is recorded for a command or a
          // patch: the call is the thing done. A call that applied a patch
          // is `apply_patch` whatever tool carried it (a `shell` call does
          // in 268 cases); any other call to a shell tool is its command.
          // The script or the patch is read now, and only what it amounts
          // to is kept until the file is read.
          const shell = HARNESS_TOOLS.get(name)?.role === 'shell';
          const args = shell ? argsOfCall(payload) : undefined;
          const command = commandOf(args);
          const change = patchOfCall(name, payload, command, windows);
          // a legacy call may name the directory it runs in
          const workdir = str(args?.workdir) ?? str(args?.cwd);
          const call: CallState = {
            id: callId,
            name: change === undefined ? name : 'apply_patch',
            line,
            at: at ?? lastAt,
            turn: current,
            response,
            legacyResponse,
            actions: 0,
            failedActions: 0,
            attributes:
              change !== undefined
                ? changeAttributes(
                    change,
                    workdir === undefined
                      ? summary.cwd
                      : rootedPath(workdir, summary.cwd),
                    ctx.redact,
                  )
                : shell
                  ? commandAttributes(name, command, windows, ctx.redact)
                  : {},
            change,
            own: undefined,
            until: undefined,
            outcome: undefined,
          };
          calls.set(callId, call);
          callOrder.push(call);
          openCalls.push(call);
        }
      } else if (item?.endsWith('_output')) {
        // A tool output is handed back: the next response starts here. Not
        // the response that made the call, though. Its usage is sometimes
        // written after its call's output (always in CLI 0.77 to 0.147),
        // and a response cannot begin when its own tool has finished.
        const handedBack = at ?? lastAt;
        const callId = str(payload.call_id);
        const call = callId === undefined ? undefined : calls.get(callId);
        const startsAfter = (
          so: ResponseSoFar,
          madeBy: ResponseSoFar | undefined,
        ): void => {
          if (madeBy === so && so.span === undefined) return;
          so.floor = handedBack;
        };
        startsAfter(response, call?.response);
        startsAfter(legacyResponse, call?.legacyResponse);
        // The first output closes its call. 5 `exec` calls in the survey
        // have more, written later for a script they had left running; the
        // call was answered by the first.
        if (call !== undefined && call.outcome === undefined) {
          openCalls = openCalls.filter((c) => c !== call);
          call.until = handedBack;
          call.outcome = outcomeOf(call.name, payload.output);
          if (call.turn !== undefined) call.turn.lastClosed = call;
          // A tool the model called directly (an MCP tool, a sleep, an
          // image generation) is recorded as an action with the call's id.
          // This output is then exactly what the model was handed for it:
          // its size is the span's, and when the action failed without a
          // text of its own, the failure is named here.
          const own = call.own;
          if (own?.tool !== undefined) {
            if (call.outcome.outputBytes !== undefined) {
              own.tool.outputBytes = call.outcome.outputBytes;
            }
            if (own.status === 'error' && own.content === undefined) {
              Object.assign(
                own,
                failureContent(
                  ctx.redact,
                  previewOf(outputTextOf(payload.output)),
                ),
              );
            }
          }
        }
      }
    }
  }

  if (session === undefined || summary === undefined) {
    // an empty file is Codex's own, created and not yet written to; a file
    // with text and no record in it is something else under a rollout name
    if (!sawText) throw new NoSessionYet('empty Codex rollout');
    throw new NotARollout('no line of it is a JSON record');
  }
  // A child's span starts with its first turn, not with its file: the
  // reviewer's thread is opened long before it is first consulted, and
  // nothing in the file before that turn is the thread's own work.
  const startedAt =
    (child ? summary.firstTurn?.startedAt : undefined) ?? firstAt;
  session.startedAt = startedAt ?? EPOCH;
  if (lastAt !== undefined && startedAt !== undefined) {
    session.endedAt = lastAt;
    const durationMs = durationBetween(startedAt, lastAt);
    if (durationMs !== undefined) session.durationMs = durationMs;
  }
  if (child) {
    for (const turn of turns.values()) {
      if (turn.span.status === 'error') session.status = 'error';
    }
  }
  const usageEra = summary.llmCalls > 0;
  if (!usageEra) {
    // no usage record in the file: a legacy rollout, read from its counter
    summary.llmCalls = legacyCalls.length;
    ctx.spans.push(...legacyCalls);
  }

  // A call nothing was attributed to is a span of its own, named after the
  // call: a script that only polled a process, a `wait`, an `update_plan`,
  // and every command of the era before actions were recorded.
  //
  // So is a call that failed or was stopped although every action of it
  // went through: a script that ran its commands and then threw. Its
  // actions are spans already, but none of them says that the model was
  // handed a failure (18 of 120 failed scripts in the survey). An action
  // that carries the call's id is the call, so there is nothing to add.
  for (const call of calls.values()) {
    const outcome = call.outcome;
    const unseenFailure =
      call.own === undefined &&
      call.failedActions === 0 &&
      (outcome?.status === 'error' || outcome?.status === 'cancelled');
    if (call.actions > 0 && !unseenFailure) continue;
    const endedAt = outcome === undefined ? undefined : call.until;
    let startedAt = call.at ?? session.startedAt;
    if (endedAt !== undefined) {
      if (outcome?.durationMs !== undefined) {
        startedAt =
          isoOfMs(Date.parse(endedAt) - outcome.durationMs) ?? startedAt;
      }
      if (startedAt > endedAt) startedAt = endedAt;
    }
    const durationMs = durationBetween(startedAt, endedAt);
    // no output in the file: still running, as far as the file knows
    const status = outcome?.status ?? 'in_progress';
    toolSpans.push({
      call,
      span: {
        id: uniqueId(call.id, call.line),
        parentId: session.id, // set below
        kind: 'tool_call',
        name: call.name,
        status,
        ...(outcome?.statusReason === undefined
          ? {}
          : { statusReason: outcome.statusReason }),
        startedAt,
        ...(endedAt === undefined ? {} : { endedAt }),
        ...(durationMs === undefined ? {} : { durationMs }),
        tool: {
          name: call.name,
          isError: status === 'error',
          ...(outcome?.exitCode === undefined
            ? {}
            : { exitCode: outcome.exitCode }),
          ...(outcome?.outputBytes === undefined
            ? {}
            : { outputBytes: outcome.outputBytes }),
          ...(call.change === undefined || status !== 'ok'
            ? {}
            : {
                linesAdded: call.change.added,
                linesRemoved: call.change.removed,
              }),
        },
        ...(status === 'error' || status === 'cancelled'
          ? failureContent(ctx.redact, outcome?.preview)
          : {}),
        attributes: call.attributes,
        provenance: { file, line: call.line },
      },
    });
  }

  // A tool span hangs from the `llm_call` of the response that made its
  // call. A response with no call of its own (aborted before its usage was
  // written) leaves its tools on the turn, and an action no call explains
  // stays where it was put: on its turn, or on the session.
  for (const { span, call } of toolSpans) {
    if (call !== undefined) {
      const made = usageEra ? call.response.span : call.legacyResponse.span;
      span.parentId = made?.id ?? call.turn?.span.id ?? session.id;
    }
    ctx.spans.push(span);
  }
  return summary;
}

/**
 * The turn of its parent thread a child thread belongs under (design T10):
 *
 *   1. the turn its first turn names in `turn_attribution.parent_turn_id`;
 *   2. the turn it names in `root_turn_id`, when the parent is a root
 *      thread (the id is a turn of the root, so it says nothing about a
 *      parent that is itself a child);
 *   3. when it names neither, the one turn of the parent that was running
 *      as its first turn began.
 *
 * Releases differ in what they write: of 147 reviewer threads with a turn,
 * 22 carry both ids (and they agree on all 318 turns), 97 only
 * `root_turn_id`, 28 neither. Every one of the 249 turns of those 28 began
 * while exactly one turn of its parent was running.
 *
 * A thread that names a turn its parent does not have is not placed by the
 * clock: what it says is wrong, and that is worth a warning, not a guess.
 */
function anchorOf(
  child: ThreadSummary,
  parent: ThreadSummary,
): { turn: RawSpan } | { why: string } {
  const first = child.firstTurn;
  const named = [
    first?.parentTurnId,
    parent.parentThreadId === undefined ? first?.rootTurnId : undefined,
  ].filter((id) => id !== undefined);
  for (const id of named) {
    const turn = parent.turnSpans.get(id);
    if (turn !== undefined) return { turn };
  }
  if (named.length > 0) {
    return { why: 'the turn it names is not in its parent thread' };
  }
  const began = first?.startedAt;
  // in the order they were started; a turn the file never closed stopped
  // running, at the latest, when the next one started
  const turns = [...parent.turnSpans.values()];
  const running =
    began === undefined
      ? []
      : turns.filter((turn, index) => {
          if (turn.startedAt > began) return false;
          if (turn.endedAt !== undefined) return began <= turn.endedAt;
          const next = turns[index + 1];
          return next === undefined || began < next.startedAt;
        });
  const [turn] = running;
  return turn !== undefined && running.length === 1
    ? { turn }
    : {
        why: 'it names no turn, and no single turn of its parent was running when it began',
      };
}

/**
 * Why a file could not be read, in words that are safe in a run; nothing
 * when the error is not about the file at all. A system error's message
 * names the path it failed on, and a warning's message is kept as written
 * by redaction and by the sanitizer, which replace only its `file`. So a
 * system error (`ENOENT`, a zlib code) gives its code, and only the two
 * refusals of this reader give their message. A Node error whose code
 * begins with `ERR_` reports a wrong call, which is a defect here.
 */
function unreadableBecause(err: unknown): string | undefined {
  if (err instanceof NotARollout || isZstdUnavailable(err)) return err.message;
  const code = isObj(err) ? err.code : undefined;
  return typeof code === 'string' && !code.startsWith('ERR_')
    ? code
    : undefined;
}

/**
 * Reads the candidate's other files, each a child thread, into the run
 * (design D2, T10). A child is one `subagent` span with its own turns and
 * calls beneath it, hung on the turn of its parent thread that `anchorOf`
 * finds, or on the parent's own span with a run warning when there is none.
 *
 * One span per thread, not per parent turn it worked in: a reviewer thread
 * is one conversation with one context, and that is what a `subagent` span
 * stands for in the rules that follow a context from call to call. The
 * price is the position of its later turns: 67 of 119 reviewer threads
 * surveyed answered in more than one turn of their parent, and all of their
 * turns sit under the turn the first one names.
 *
 * A child with no turn is the reviewer started and never consulted (36 of
 * 183): no span and no warning, whatever its file holds.
 */
async function emitChildren(
  candidate: Candidate,
  root: ThreadSummary,
  ctx: ParseContext,
): Promise<void> {
  const threads = new Map([[root.threadId, root]]);
  const taken = new Set(ctx.spans.map((s) => s.id));
  const children: ThreadSummary[] = [];
  for (const file of candidate.files) {
    if (file === candidate.runRef) continue;
    const own: ParseContext = { spans: [], warnings: [], redact: ctx.redact };
    let child: ThreadSummary;
    try {
      child = await emitThread(file, own, true);
    } catch (err) {
      if (err instanceof NoSessionYet) continue;
      // The root's file failing is the run failing; a child's file that
      // cannot be read is a gap in it. Any other error is a defect of this
      // reader and fails the run, as it would in the root's file: a warning
      // would hide it behind missing tokens.
      const reason = unreadableBecause(err);
      if (reason === undefined) throw err;
      ctx.warnings.push({ message: `child thread not read: ${reason}`, file });
      continue;
    }
    // the same thread twice (a copy of a file) is read once
    if (child.turns === 0 || threads.has(child.threadId)) continue;
    // Ids are unique within a file. No id of a child was also its parent's
    // in what was surveyed; one that is takes the thread's id in front, so
    // the run never holds two spans under one id.
    const renamed = new Map<string, string>();
    for (const span of own.spans) {
      if (taken.has(span.id)) {
        renamed.set(span.id, `${child.threadId}:${span.id}`);
      }
    }
    for (const span of own.spans) {
      span.id = renamed.get(span.id) ?? span.id;
      if (span.parentId !== null) {
        span.parentId = renamed.get(span.parentId) ?? span.parentId;
      }
      taken.add(span.id);
    }
    threads.set(child.threadId, child);
    children.push(child);
    ctx.spans.push(...own.spans);
    ctx.warnings.push(...own.warnings);
  }

  /** The thread a child hangs on, when following parents from it ends at
   * the root. Detection never groups a parent cycle; a candidate built by
   * hand could, and its threads would hang on each other and on nothing. */
  const parentOf = (child: ThreadSummary): ThreadSummary | undefined => {
    const parent =
      child.parentThreadId === undefined
        ? undefined
        : threads.get(child.parentThreadId);
    const seen = new Set([child.threadId]);
    for (let up = parent; up !== undefined && up !== root; ) {
      if (seen.has(up.threadId)) return undefined;
      seen.add(up.threadId);
      up =
        up.parentThreadId === undefined
          ? undefined
          : threads.get(up.parentThreadId);
    }
    return parent;
  };
  for (const child of children) {
    const parent = parentOf(child);
    const anchor =
      parent === undefined
        ? { why: 'its parent thread is not in this run' }
        : anchorOf(child, parent);
    if ('turn' in anchor) {
      child.top.parentId = anchor.turn.id;
      continue;
    }
    const onto = parent ?? root;
    child.top.parentId = onto.top.id;
    ctx.warnings.push({
      message: `child thread ${child.threadId} attached to ${
        onto === root ? 'the session' : `thread ${onto.threadId}`
      }: ${anchor.why}`,
      file: child.top.provenance.file,
    });
  }
}

async function parse(
  candidate: Candidate,
  opts: ParseOptions,
): Promise<RawRun> {
  const ctx: ParseContext = { spans: [], warnings: [], redact: opts.redact };
  const thread = await emitThread(candidate.runRef, ctx, false);
  // A rollout that holds its first record and no turn is a session nobody
  // has prompted yet: nothing is wrong and there is nothing to show.
  if (thread.turns === 0 && thread.llmCalls === 0) {
    throw new NoSessionYet('Codex rollout with no turn yet');
  }
  await emitChildren(candidate, thread, ctx);
  // A session and a subagent end no earlier than what happened under them:
  // a child thread can outlast the last record of its parent's file, and an
  // action's own end time can fall after the record that reports it. A
  // subagent also starts no later: its span opens with the thread's first
  // turn, and a file may hold a call recorded before that. The session
  // starts with its file, and turns stay as the rollout brackets them.
  extendContainers(
    ctx.spans,
    (_span, container) => container.kind === 'subagent',
  );
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
