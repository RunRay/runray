/**
 * scrub-codex.ts — the Codex rollout rules of scrub-fixture.ts
 * (`--source codex`; design T14 of the add-codex-adapter change).
 *
 * A rollout is JSONL, one `{timestamp, ordinal, type, payload}` record per
 * line. The generic default-scrub cannot be used on it as it is:
 *
 * - File paths are object KEYS (`FileChange.changes`), and the generic
 *   walker never touches keys.
 * - Arbitrary payloads are stored as native JSON (MCP call arguments and
 *   results, tool schemas, the world state), so a key such as `name`, `id`
 *   or `status` that is structural in Codex's own schema is user data two
 *   levels further down. Preserving by key name alone would leak it.
 * - Diffs and patch envelopes carry meaning in the first character of each
 *   line, and the adapter counts those lines.
 * - A command is an argv whose first elements are the shell wrapper.
 * - Some fields are megabytes the adapter never reads (encrypted reasoning,
 *   base instructions, inline images).
 *
 * So this is a schema-aware walker with the same posture as the rest of the
 * script, default-scrub, applied to keys as well as values:
 *
 *   STRUCTURAL mode — Codex's own schema. A key is kept only when it is in
 *   KNOWN_KEYS; its string value is kept only when the key is in
 *   PRESERVE_KEYS and the value is identifier-shaped. Everything else is
 *   same-length lorem. An unknown key is replaced by lorem, its subtree is
 *   scrubbed as content, and its name is reported to the person running the
 *   script — a new Codex field shows up as a visible gap in the fixture,
 *   never as an unreviewed value in git.
 *
 *   CONTENT mode — payloads Codex does not define (OPAQUE_KEYS and anything
 *   unknown). Every key and every string is lorem; numbers, booleans, null
 *   and the nesting survive.
 *
 * Numbers are always kept: token counts, durations and exit codes are the
 * point of the fixture.
 *
 * The CLI wiring (arguments, output paths, the report) lives in
 * scrub-fixture.ts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  isCompressedRollout,
  readRolloutLines,
} from '../packages/core/src/rollout-lines.js';
import {
  anonId,
  fnv1a,
  loremLine,
  loremToken,
  MARKER,
  metaRecord,
  redactSecrets,
  type Secrets,
  scrubText,
} from './scrub-lib.js';

/** What a megabyte blob the adapter never reads is replaced with. */
export const BLOB_PLACEHOLDER = '[scrubbed: opaque content removed]';

/** Key names of Codex's own record schema, outside the opaque subtrees.
 * Taken from a key-path survey of 250 rollouts (CLI 0.47 to 0.162). */
const KNOWN_KEYS = new Set<string>(
  (
    'access action actionName active_permission_profile aggregated_output appName approval_policy ' +
    'approvals_reviewer arguments assistant_context balance base_instructions branch ' +
    'cache_write_input_tokens cached_input_tokens call_id changes cli_version client_authored ' +
    'client_id codex_error_info collaboration_mode collaboration_mode_kind command commit_hash ' +
    'comp_hash compaction_response_id complete completed_at completed_at_ms connectorId content ' +
    'content_item_kinds context_window create_time creator_account_id creator_user_id credits ' +
    'current_date cwd cyber_access_program delivery detail developer_instructions ' +
    'disabled_plugin_ids duration durationMs duration_ms dynamic_tools effort encrypted_content ' +
    'entries error error_reason exclude_slash_tmp exclude_tmpdir_env_var executed_tool_calls ' +
    'execution exit_code failure fallback_token_limit_override file_system ' +
    'file_system_sandbox_policy first_turn_id first_window_id formatted_output full git ' +
    'guardian_history guardian_retained_omissions guardian_source_order_guidance guardian_sources ' +
    'has_credits history_mode id image_url individual_limit info initiating_agent_path input ' +
    'input_tokens internal_chat_message_metadata_passthrough item kind last_agent_message ' +
    'last_started_turn_id last_token_usage latest_token_usage_record limit_id limit_name linkId ' +
    'mcp_attribution message message_id metadata missing_path_behavior mode model ' +
    'model_context_window model_provider model_provider_id multi_agent_version name namespace ' +
    'nanos network network_access ordinal originator other output output_tokens parent_thread_id ' +
    'parent_turn_id parsed_cmd path payload permission_profile personality phase plan_type ' +
    'pluginId plugin_id previous_turn_settings previous_window_id primary process_id query ' +
    'questions rate_limit_reached_type rate_limits raw_content readOnlyHint realtime_active ' +
    'reason reasoning_effort reasoning_output_tokens reasoning_summary replacement_history ' +
    'replacement_history_metadata repository_url resets_at response_id result results ' +
    'resume_metadata retained_context retained_source revisedPrompt revision role root_turn_id ' +
    'runtime_workspace_roots sandbox_policy savedPath secondary secs server server_name ' +
    'service_tier session_id settings source sources spend_control_reached started_at ' +
    'started_at_ms state status stderr stdout subagent subagent_history_start_ordinal summary ' +
    'summary_text text text_elements thread_id thread_settings thread_source thread_token_usage ' +
    'time_to_first_token_ms timestamp timezone tool tool_calls_complete tool_name tools ' +
    'total_token_usage total_tokens transparentBackground turn_attribution turn_id ' +
    'turn_token_usage turn_trigger type unlimited usage used_percent user_input_order ' +
    'user_instructions value window_id window_minutes window_number workspace_roots ' +
    'writable_roots'
  ).split(' '),
);

/** Keys whose string value is an id, an enum or a version the adapter joins
 * or branches on. Kept only when the value passes `SAFE_VALUE`. */
const PRESERVE_KEYS = new Set<string>([
  // linkage
  'id',
  'call_id',
  'turn_id',
  'root_turn_id',
  'parent_turn_id',
  'last_started_turn_id',
  'response_id',
  'compaction_response_id',
  'thread_id',
  'parent_thread_id',
  'session_id',
  'window_id',
  'first_window_id',
  'previous_window_id',
  // classification
  'type',
  'kind',
  'role',
  'phase',
  'status',
  'reason',
  'codex_error_info',
  'thread_source',
  'turn_trigger',
  'name', // tool name; a `name` inside a payload is in content mode
  'namespace',
  'server',
  'tool',
  'model',
  'model_provider',
  // provenance of the log itself
  'timestamp',
  'cli_version',
  'originator',
]);

/** An id, enum, model or version: no path separator, no address, no line
 * break. A preserved key whose value is anything else is scrubbed. */
const SAFE_VALUE = /^[A-Za-z0-9 _.:+-]{1,80}$/;

const PATH_KEYS = new Set<string>([
  'cwd',
  'path',
  'workdir',
  'move_path',
  'savedPath',
  'writable_roots',
  'workspace_roots',
  'runtime_workspace_roots',
]);

/** Subtrees Codex stores but does not define, plus history and state the
 * adapter never reads. Scrubbed in content mode: keys and strings alike. */
const OPAQUE_KEYS = new Set<string>([
  'result',
  'parsed_cmd',
  'dynamic_tools',
  'state',
  'replacement_history',
  'guardian_history',
  'retained_context',
  'replacement_history_metadata',
  'tools',
  'results',
  'action',
  'questions',
  'text_elements',
  'raw_content',
  'executed_tool_calls',
]);

/** Megabytes the adapter never reads: every string beneath becomes the
 * placeholder. */
const BLOB_KEYS = new Set<string>([
  'encrypted_content',
  'base_instructions',
  'image_url',
]);

const IDENTITY_KEYS = new Set<string>([
  'creator_account_id',
  'creator_user_id',
]);

/** Parameter names of Codex's built-in tools that are kept in a call's
 * JSON-encoded `arguments`. Any other parameter name is lorem. */
const ARGUMENT_KEYS = new Set<string>([
  'command',
  'workdir',
  'timeout_ms',
  'yield_time_ms',
  'max_tokens',
  'duration_ms',
  'justification',
  'sandbox_permissions',
  'prefix_rule',
  'explanation',
  'plan',
]);

/** Shell wrappers a command's argv may start with (design T8). */
const WRAPPERS = new Set<string>([
  'pwsh',
  'powershell',
  'bash',
  'zsh',
  'sh',
  'dash',
  'cmd',
]);

/** Lines the harness writes around a tool's output. They carry the outcome
 * the adapter reads (`Script failed`, `Exit code: 1`), not user content. */
const OUTPUT_FRAMES: RegExp[] = [
  /^Script (completed|failed|terminated)$/,
  /^Script error:$/,
  /^Script running with cell ID \d+$/,
  /^Wall time:? \d+(\.\d+)? seconds$/,
  /^Exit code: -?\d+$/,
  /^Total output lines: \d+$/,
  /^Output:$/,
  /^Plan updated$/,
  /^Success\. Updated the following files:$/,
];

export interface CodexStats {
  records: number;
  strings: number;
  blobs: number;
  pathKeys: number;
  /** Keys outside KNOWN_KEYS found in Codex's own structure, with counts. */
  unknownKeys: Map<string, number>;
  /** PRESERVE_KEYS whose value was not identifier-shaped, with counts. */
  guardedKeys: Map<string, number>;
}

export function newCodexStats(): CodexStats {
  return {
    records: 0,
    strings: 0,
    blobs: 0,
    pathKeys: 0,
    unknownKeys: new Map(),
    guardedKeys: new Map(),
  };
}

interface Ctx {
  secrets: Secrets;
  stats: CodexStats;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** A long run of base64 or a data URL: an image or an encrypted payload. */
function looksLikeBlob(value: string): boolean {
  if (value.startsWith('data:')) return true;
  return value.length >= 512 && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

/** Free text: same-length lorem, or the placeholder for a blob. */
function text(value: string, ctx: Ctx): string {
  ctx.stats.strings++;
  if (looksLikeBlob(value)) {
    ctx.stats.blobs++;
    return BLOB_PLACEHOLDER;
  }
  return redactSecrets(scrubText(value), ctx.secrets);
}

/**
 * Canonicalise a path as `scrubPath` does, with a stricter rule for what
 * counts as a file extension. `scrubPath` keeps whatever follows the last
 * dot of a segment, so a dot-directory (`.acme-internal`) or a dotted name
 * (`report.client-name`) survives whole. Here an extension is kept only
 * when it looks like one: after a non-empty stem, up to eight letters or
 * digits. Codex paths use this everywhere; the shared function is left as
 * it is so the other sources scrub to the same bytes as before.
 */
export function scrubCodexPath(value: string): string {
  const unified = value.replace(/\\/g, '/');
  const hadDrive = /^[A-Za-z]:/.test(unified);
  const rest = unified.replace(/^[A-Za-z]:/, '');
  const isAbsolute = hadDrive || rest.startsWith('/');
  const segments = rest
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => {
      if (seg === '.' || seg === '..') return seg;
      const dot = seg.lastIndexOf('.');
      const ext =
        dot > 0 && /^\.[A-Za-z0-9]{1,8}$/.test(seg.slice(dot))
          ? seg.slice(dot)
          : '';
      const stem = seg.slice(0, seg.length - ext.length);
      return loremToken(stem.length, fnv1a(seg)) + ext;
    });
  return isAbsolute
    ? ['/home/user/project', ...segments].join('/')
    : segments.join('/');
}

function pathValue(value: string, ctx: Ctx): string {
  ctx.stats.strings++;
  return redactSecrets(scrubCodexPath(value), ctx.secrets);
}

/** Lorem for an object key, unique within its object. */
function loremKey(key: string, taken: Set<string>): string {
  const base = loremToken(Math.max(key.length, 1), fnv1a(key));
  let out = base;
  for (let n = 2; taken.has(out); n++) out = `${base}_${n}`;
  taken.add(out);
  return out;
}

/** CONTENT mode: nothing is trusted, keys included. */
function content(value: unknown, ctx: Ctx): unknown {
  if (typeof value === 'string') return text(value, ctx);
  if (Array.isArray(value)) return value.map((item) => content(item, ctx));
  if (isObject(value)) {
    const out: Json = {};
    const taken = new Set<string>();
    for (const [k, v] of Object.entries(value)) {
      out[loremKey(k, taken)] = content(v, ctx);
    }
    return out;
  }
  return value;
}

/** Every string beneath becomes the placeholder; keys are Codex's. */
function blob(value: unknown, ctx: Ctx): unknown {
  if (typeof value === 'string') {
    ctx.stats.strings++;
    ctx.stats.blobs++;
    return BLOB_PLACEHOLDER;
  }
  if (Array.isArray(value)) return value.map((item) => blob(item, ctx));
  if (isObject(value)) {
    const out: Json = {};
    const taken = new Set<string>();
    for (const [k, v] of Object.entries(value)) {
      out[KNOWN_KEYS.has(k) || k === 'provenance' ? k : loremKey(k, taken)] =
        blob(v, ctx);
    }
    return out;
  }
  return value;
}

/**
 * A unified diff or an `apply_patch` envelope. Marker lines and the first
 * character of every change line keep their shape, so the number of added
 * and removed lines is the same before and after; the text is lorem and
 * the file paths are canonicalised.
 */
export function scrubDiffText(value: string, secrets: Secrets): string {
  const out = value.split('\n').map((raw) => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    const rest = (from: number): string =>
      loremLine(line.length - from, fnv1a(line));

    if (/^\*\*\* (Begin Patch|End Patch|End of File)$/.test(line)) return raw;
    const file =
      /^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.*)$/.exec(
        line,
      );
    if (file) return `${file[1]}${scrubCodexPath(file[2] ?? '')}${cr}`;
    const hunk = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk) {
      // `@@ -1,2 +1,3 @@ section heading`: the space is part of the marker
      const at = hunk[0].length + (line[hunk[0].length] === ' ' ? 1 : 0);
      return `${line.slice(0, at)}${rest(at)}${cr}`;
    }
    if (line === '@@') return raw;
    if (line.startsWith('@@ ')) return `@@ ${rest(3)}${cr}`;
    if (line.startsWith('\\ ')) return raw; // "\ No newline at end of file"
    // a change line whose own text begins with `++` or `--` reads as a
    // header to a line counter; keep it reading that way
    if (line.startsWith('+++') || line.startsWith('---'))
      return `${line.slice(0, 3)}${rest(3)}${cr}`;
    const first = line[0];
    if (first === '+' || first === '-' || first === ' ')
      return `${first}${rest(1)}${cr}`;
    return `${loremLine(line.length, fnv1a(line))}${cr}`;
  });
  return redactSecrets(out.join('\n'), secrets);
}

function looksLikePatch(value: string): boolean {
  return value.startsWith('*** Begin Patch');
}

/** Output shown to the model: harness frame lines stay, the rest is lorem
 * of the same length. */
export function scrubOutputText(value: string, secrets: Secrets): string {
  if (looksLikeBlob(value)) return BLOB_PLACEHOLDER;
  const out = value.split('\n').map((raw) => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    if (OUTPUT_FRAMES.some((frame) => frame.test(line))) return raw;
    return `${loremLine(line.length, fnv1a(line))}${cr}`;
  });
  return redactSecrets(out.join('\n'), secrets);
}

/** `C:\Program Files\PowerShell\7\pwsh.exe` → the drive, lorem directories
 * of the same lengths, and the program name the adapter recognises. */
function scrubProgramPath(value: string, secrets: Secrets): string {
  const parts = value.split(/([\\/])/);
  if (parts.length === 1) return value;
  const last = parts.length - 1;
  const out = parts.map((part, i) => {
    if (i % 2 === 1 || i === last) return part; // separator or program name
    if (part === '' || (i === 0 && /^[A-Za-z]:$/.test(part))) return part;
    return loremToken(part.length, fnv1a(part));
  });
  return redactSecrets(out.join(''), secrets);
}

function programName(arg0: string): string {
  const base = arg0.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

/**
 * A command argv. Behind a known shell wrapper the program and its flags
 * are structure and the last element is the script; `apply_patch` keeps its
 * name and its patch keeps its shape. Any other argv is the command itself
 * and is scrubbed element by element.
 */
export function scrubArgv(argv: unknown[], ctx: Ctx): unknown[] {
  const first = argv[0];
  if (typeof first !== 'string' || !argv.every((a) => typeof a === 'string'))
    return argv.map((item) => content(item, ctx));
  const args = argv as string[];
  const program = programName(first);

  if (program === 'apply_patch') {
    ctx.stats.strings++;
    return [
      scrubProgramPath(first, ctx.secrets),
      ...args.slice(1).map((a) => patchOrText(a, ctx)),
    ];
  }
  if (WRAPPERS.has(program) && args.length >= 2) {
    ctx.stats.strings += args.length - 1;
    const last = args.length - 1;
    return args.map((arg, i) => {
      if (i === 0) return scrubProgramPath(arg, ctx.secrets);
      if (i === last) return text(arg, ctx);
      return /^[-/][A-Za-z]{1,24}$/.test(arg) ? arg : text(arg, ctx);
    });
  }
  return args.map((arg) => text(arg, ctx));
}

function patchOrText(value: string, ctx: Ctx): string {
  if (!looksLikePatch(value)) return text(value, ctx);
  ctx.stats.strings++;
  return scrubDiffText(value, ctx.secrets);
}

/** `FileChange.changes`: an object keyed by file path. */
function scrubChanges(changes: Json, ctx: Ctx): Json {
  const out: Json = {};
  const taken = new Set<string>();
  for (const [file, change] of Object.entries(changes)) {
    ctx.stats.pathKeys++;
    const base = redactSecrets(scrubCodexPath(file), ctx.secrets);
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}.${n}`;
    taken.add(key);
    if (!isObject(change)) {
      out[key] = content(change, ctx);
      continue;
    }
    const entry: Json = {};
    const entryTaken = new Set<string>();
    for (const [k, v] of Object.entries(change)) {
      if (k === 'type') entry[k] = preserved(k, v, ctx);
      else if (k === 'unified_diff' && typeof v === 'string') {
        ctx.stats.strings++;
        entry[k] = scrubDiffText(v, ctx.secrets);
      } else if (k === 'content' && typeof v === 'string')
        entry[k] = text(v, ctx); // newline positions kept: same line count
      else if (k === 'move_path')
        entry[k] = typeof v === 'string' ? pathValue(v, ctx) : content(v, ctx);
      else entry[loremKey(k, entryTaken)] = content(v, ctx);
    }
    out[key] = entry;
  }
  return out;
}

/** A PRESERVE_KEYS value: kept when identifier-shaped, lorem otherwise. */
function preserved(key: string, value: unknown, ctx: Ctx): unknown {
  if (typeof value !== 'string') return structural(value, key, ctx);
  ctx.stats.strings++;
  if (SAFE_VALUE.test(value)) return redactSecrets(value, ctx.secrets);
  bump(ctx.stats.guardedKeys, key);
  return redactSecrets(scrubText(value), ctx.secrets);
}

/** `session_meta.git`: nothing of the repository survives. */
function scrubGit(git: Json, ctx: Ctx): Json {
  const out: Json = {};
  const taken = new Set<string>();
  for (const [k, v] of Object.entries(git)) {
    if (typeof v !== 'string') {
      out[KNOWN_KEYS.has(k) ? k : loremKey(k, taken)] = content(v, ctx);
      continue;
    }
    ctx.stats.strings++;
    if (k === 'repository_url') out[k] = 'https://example.com/user/project.git';
    else if (k === 'commit_hash') out[k] = '0'.repeat(v.length);
    else if (k === 'branch') out[k] = loremToken(v.length, fnv1a(v));
    else out[loremKey(k, taken)] = redactSecrets(scrubText(v), ctx.secrets);
  }
  return out;
}

/**
 * `session_meta.source`: a client name, or `{subagent: {<kind>: …}}`. The
 * adapter names a child thread after the key under `subagent` and after
 * `other`, so identifier-shaped keys and that one value are structure.
 */
function scrubSource(source: unknown, ctx: Ctx, depth = 0): unknown {
  if (typeof source === 'string') {
    ctx.stats.strings++;
    return depth === 0 && /^[A-Za-z0-9_-]{1,32}$/.test(source)
      ? source
      : redactSecrets(scrubText(source), ctx.secrets);
  }
  if (!isObject(source)) return content(source, ctx);
  const out: Json = {};
  const taken = new Set<string>();
  for (const [k, v] of Object.entries(source)) {
    const key = /^[a-z_]{1,32}$/.test(k) ? k : loremKey(k, taken);
    if (k === 'other' && typeof v === 'string' && /^[a-z_]{1,32}$/.test(v)) {
      ctx.stats.strings++;
      out[key] = v;
    } else out[key] = scrubSource(v, ctx, depth + 1);
  }
  return out;
}

/** A call's `arguments`, JSON-encoded in a string. */
function scrubArgumentsJson(value: string, ctx: Ctx): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return text(value, ctx);
  }
  if (!isObject(parsed)) return text(value, ctx);
  ctx.stats.strings++;
  const out: Json = {};
  const taken = new Set<string>();
  for (const [k, v] of Object.entries(parsed)) {
    if (k === 'command') {
      out[k] = Array.isArray(v)
        ? scrubArgv(v, ctx)
        : typeof v === 'string'
          ? text(v, ctx)
          : content(v, ctx);
    } else if (k === 'workdir' && typeof v === 'string') {
      out[k] = pathValue(v, ctx);
    } else {
      out[ARGUMENT_KEYS.has(k) ? k : loremKey(k, taken)] = content(v, ctx);
    }
  }
  return JSON.stringify(out);
}

/**
 * An `…_output` payload's `output`. The legacy form is a JSON string
 * `{"output": …, "metadata": {"exit_code", "duration_seconds"}}` whose
 * numbers the adapter reads; anything else is text shown to the model.
 */
function scrubOutput(value: unknown, ctx: Ctx): unknown {
  if (typeof value === 'string') {
    ctx.stats.strings++;
    const legacy = parseLegacyOutput(value);
    if (legacy === null) return scrubOutputText(value, ctx.secrets);
    const out: Json = {};
    const taken = new Set<string>();
    for (const [k, v] of Object.entries(legacy)) {
      if (k === 'output' && typeof v === 'string')
        out[k] = scrubOutputText(v, ctx.secrets);
      else if (k === 'metadata' && isObject(v)) {
        const meta: Json = {};
        const metaTaken = new Set<string>();
        for (const [mk, mv] of Object.entries(v)) {
          const keep = mk === 'exit_code' || mk === 'duration_seconds';
          meta[keep ? mk : loremKey(mk, metaTaken)] = content(mv, ctx);
        }
        out[k] = meta;
      } else out[loremKey(k, taken)] = content(v, ctx);
    }
    return JSON.stringify(out);
  }
  if (!Array.isArray(value)) return content(value, ctx);
  return value.map((item) => {
    if (!isObject(item)) return content(item, ctx);
    const out: Json = {};
    const taken = new Set<string>();
    for (const [k, v] of Object.entries(item)) {
      if (k === 'type') out[k] = preserved(k, v, ctx);
      else if (k === 'text' && typeof v === 'string') {
        ctx.stats.strings++;
        out[k] = scrubOutputText(v, ctx.secrets);
      } else if (k === 'image_url') out[k] = blob(v, ctx);
      else if (k === 'detail') out[k] = content(v, ctx);
      else out[loremKey(k, taken)] = content(v, ctx);
    }
    return out;
  });
}

function parseLegacyOutput(value: string): Json | null {
  if (!value.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      isObject(parsed) &&
      typeof parsed.output === 'string' &&
      isObject(parsed.metadata)
    )
      return parsed;
  } catch {
    // not JSON: plain text shown to the model
  }
  return null;
}

/** STRUCTURAL mode: one value under a key of Codex's own schema. */
function structural(value: unknown, key: string | null, ctx: Ctx): unknown {
  if (typeof value === 'string') {
    if (key !== null && PRESERVE_KEYS.has(key))
      return preserved(key, value, ctx);
    if (key !== null && PATH_KEYS.has(key)) return pathValue(value, ctx);
    return text(value, ctx);
  }
  if (Array.isArray(value))
    return value.map((item) => structural(item, key, ctx));
  if (!isObject(value)) return value;

  const out: Json = {};
  const taken = new Set<string>();
  for (const [k, v] of Object.entries(value)) {
    if (!KNOWN_KEYS.has(k)) {
      bump(ctx.stats.unknownKeys, k);
      out[loremKey(k, taken)] = content(v, ctx);
    } else if (BLOB_KEYS.has(k)) out[k] = blob(v, ctx);
    else if (IDENTITY_KEYS.has(k)) {
      ctx.stats.strings++;
      out[k] = typeof v === 'string' ? anonId(v) : content(v, ctx);
    } else if (k === 'changes' && isObject(v)) out[k] = scrubChanges(v, ctx);
    else if (k === 'git' && isObject(v)) out[k] = scrubGit(v, ctx);
    else if (k === 'source') out[k] = sourceOrText(v, value, ctx);
    else if (k === 'command' && Array.isArray(v)) out[k] = scrubArgv(v, ctx);
    else if (k === 'arguments')
      out[k] =
        typeof v === 'string' ? scrubArgumentsJson(v, ctx) : content(v, ctx);
    else if (k === 'input' && typeof v === 'string')
      out[k] = patchOrText(v, ctx);
    else if (k === 'output') out[k] = scrubOutput(v, ctx);
    else if (OPAQUE_KEYS.has(k)) out[k] = content(v, ctx);
    else out[k] = structural(v, k, ctx);
  }
  return out;
}

/** `source` is the thread's origin in `session_meta` and a free label on a
 * command item; only the former is structure. */
function sourceOrText(value: unknown, parent: Json, ctx: Ctx): unknown {
  const isSessionMeta = 'cli_version' in parent || 'originator' in parent;
  return isSessionMeta ? scrubSource(value, ctx) : content(value, ctx);
}

/** Scrub one parsed rollout record. */
export function scrubCodexRecord(
  record: unknown,
  secrets: Secrets,
  stats: CodexStats,
): unknown {
  stats.records++;
  return structural(record, null, { secrets, stats });
}

export interface CodexScrubResult {
  /** The scrubbed rollout: the marker record, then one record per line. */
  output: string;
  stats: CodexStats;
  /** 1-based numbers of input lines that were not JSON and were dropped. */
  dropped: number[];
}

/**
 * Scrub the lines of one rollout. Blank lines are dropped; so is a line
 * that is not JSON (the cut-off last line of a session still being
 * written), and its number is returned so the caller can say so.
 */
export function scrubCodexLines(
  lines: Iterable<{ line: number; text: string }>,
  secrets: Secrets,
): CodexScrubResult {
  const stats = newCodexStats();
  const dropped: number[] = [];
  const out: string[] = [JSON.stringify(metaRecord('codex'))];
  for (const { line, text: raw } of lines) {
    if (raw.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      dropped.push(line);
      continue;
    }
    out.push(JSON.stringify(scrubCodexRecord(record, secrets, stats)));
  }
  return { output: `${out.join('\n')}\n`, stats, dropped };
}

/** True for the marker record this script writes as line one. */
export function isScrubMarkerLine(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return isObject(parsed) && parsed.marker === MARKER;
  } catch {
    return false;
  }
}

/** File names Codex gives a rollout, plain or compressed. */
export const ROLLOUT_FILE = /^rollout-.*\.jsonl(\.zst)?$/;

/**
 * Scrub one rollout file into `output`. The input is read plain or
 * zstd-compressed by its name; the output is written compressed when ITS
 * name ends in `.zst`, so a derived path keeps the form of the input and
 * `-o` can change it. The marker record is line one in both forms.
 */
export async function scrubCodexFile(
  input: string,
  output: string,
  secrets: Secrets,
): Promise<CodexScrubResult> {
  const lines: { line: number; text: string }[] = [];
  for await (const entry of readRolloutLines(input)) lines.push(entry);
  const result = scrubCodexLines(lines, secrets);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    isCompressedRollout(output)
      ? zstdCompressSync(Buffer.from(result.output, 'utf8'))
      : result.output,
  );
  return result;
}
