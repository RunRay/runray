/**
 * scrub-fixture.ts — turn a real agent log into a committable fixture.
 *
 * Privacy posture (docs/04-SAMPLE-LOGS.md §5, AGENTS.md hard rules):
 *   DEFAULT-SCRUB. Every string is replaced with deterministic lorem of the
 *   SAME character length, EXCEPT an allowlist of structural keys that must
 *   stay byte-identical (ids, timestamps, roles, models, flags). Erring toward
 *   scrubbing means an unexpected field becomes a visible golden-test change,
 *   never an invisible privacy leak. Numbers/booleans/null are always kept, so
 *   token/usage counts — the whole point of the fixture — survive untouched.
 *
 *   Paths get canonicalized to /home/user/project/… with each segment
 *   length-preserved but lorem'd, so no real repo/file names remain. A final
 *   pass redacts the current OS username/hostname and key-shaped strings
 *   (sk-…, Bearer …, 32+ hex) everywhere.
 *
 * Determinism: lorem is seeded from a hash of the source text, so identical
 * input always yields identical output — a precondition for byte-stable
 * goldens (docs/02-DATA-MODEL.md, AGENTS.md "Determinism").
 *
 * Usage:
 *   pnpm scrub <raw-file|dir|db> [-o <out>] [--source claude-code|opencode|codex|otlp]
 *             [--session <ses_id>]
 * If the input sits under a `raw/` directory and -o is omitted, the output
 * path is derived by dropping the `raw` segment. A directory input scrubs
 * every .json/.jsonl beneath it into a mirrored tree (multi-file stores:
 * opencode file storage, claude-code session+subagents); each output file
 * carries its own marker, and non-JSON files are skipped, never copied.
 * A .db input (OpenCode sqlite) requires --session and rebuilds a fresh,
 * scrubbed db with only the tables the adapter reads (see scrubSqlite).
 * A Codex rollout (`rollout-*.jsonl`, plain or `.zst`; --source codex) has
 * its own rules, in scrub-codex.ts.
 *
 * NEVER edit the output by hand. Re-run this script instead.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  type CodexScrubResult,
  ROLLOUT_FILE,
  scrubCodexFile,
} from './scrub-codex.js';
import {
  anonId,
  fnv1a,
  loremToken,
  MARKER,
  metaRecord,
  redactSecrets,
  type Secrets,
  scrubPath,
  scrubText,
} from './scrub-lib.js';

const PRESERVE_KEYS = new Set<string>([
  // identity / linkage
  'uuid',
  'parentUuid',
  'leafUuid',
  'sessionId',
  'session_id',
  'id',
  'tool_use_id',
  'toolUseID',
  // .meta.json sidecar joins (CC ≥2.2): these anchor background agents to
  // their spawning tool_use / enclosing agent — scrubbing them to lorem
  // silently unlinks every background subtree in the fixture
  'toolUseId',
  'parentAgentId',
  'spawnDepth',
  'agentType',
  'requestId',
  'request_id',
  'message_id',
  'parentID',
  'parentId',
  // classification / structural enums
  'type',
  'role',
  'model',
  'name', // tool + mcp identifiers — needed by adapters, not private
  'stop_reason',
  'stopReason',
  'stop_sequence',
  'costSource',
  'userType',
  'service_tier',
  // subagent join + metadata (CC >= 2.1 Agent tool; see 02-DATA-MODEL Open Q1)
  'agentId',
  'status',
  'resolvedModel',
  'subagent_type', // agent-type identifier, same rationale as tool names
  // timing / versions
  'timestamp',
  'created_at',
  'createdAt',
  'version',
  // flags handled as strings in some formats
  'isSidechain',
  'isMeta',
  'is_error',
  'isError',
]);

const PATH_KEYS = new Set<string>([
  'cwd',
  'path',
  'file_path',
  'filePath',
  'filepath',
  'notebook_path',
  'projectPath',
  'root',
  'outputFile',
]);

/** OpenCode file-storage / `opencode export` structural keys (camelCase ids,
 * classification enums) that the shared PRESERVE_KEYS misses. Scoped to source
 * `opencode` so the claude-code path — and its goldens — stay byte-identical. */
const OPENCODE_PRESERVE_KEYS = new Set<string>([
  'sessionID',
  'messageID',
  'projectID',
  'providerID',
  'modelID',
  'variant', // v1.4+ nests model as model.{providerID,modelID,variant}
  'callID',
  'mode',
  'finish',
  'agent',
  'tool', // tool name on tool parts, same rationale as `name`
]);
const OPENCODE_PATH_KEYS = new Set<string>(['directory']);

interface KeySets {
  preserve: Set<string>;
  path: Set<string>;
}

/** Merge source-specific keys onto the shared allowlists; other sources are
 * unchanged (their goldens cannot flap). */
function activeKeys(source: string): KeySets {
  if (source === 'opencode')
    return {
      preserve: new Set([...PRESERVE_KEYS, ...OPENCODE_PRESERVE_KEYS]),
      path: new Set([...PATH_KEYS, ...OPENCODE_PATH_KEYS]),
    };
  return { preserve: PRESERVE_KEYS, path: PATH_KEYS };
}

interface Stats {
  strings: number;
  sidechains: number;
  toolErrors: number;
}

function scrubValue(
  value: unknown,
  keyName: string | null,
  secrets: Secrets,
  stats: Stats,
  keys: KeySets,
): unknown {
  if (typeof value === 'string') {
    stats.strings++;
    let out: string;
    if (keyName !== null && keys.preserve.has(keyName)) out = value;
    else if (keyName !== null && keys.path.has(keyName)) out = scrubPath(value);
    else out = scrubText(value);
    return redactSecrets(out, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, keyName, secrets, stats, keys));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.isSidechain === true) stats.sidechains++;
    if (record.is_error === true || record.isError === true) stats.toolErrors++;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = scrubValue(v, k, secrets, stats, keys);
    }
    return out;
  }
  return value; // number | boolean | null — preserved
}

// ---------------------------------------------------------------------------
// OTLP/JSON scrubbing (source=otlp; docs/04-SAMPLE-LOGS.md §3)
//
// OTLP encodes EVERYTHING as a generic tree —
//   {resourceSpans:[{resource,scopeSpans:[{scope,spans:[
//     {traceId,spanId,parentSpanId,startTimeUnixNano,…,
//      attributes:[{key,value:{stringValue|intValue|…}}]}]}]}]}
// — so the default-scrub above would corrupt a real capture: it would lorem the
// hex trace/span ids, lorem the string-encoded *UnixNano timestamps, lorem the
// attribute KEYS (destroying `gen_ai.*` passthrough), and lorem int64 token
// counts (OTLP encodes int64 as JSON strings, so they are NOT the numbers the
// generic path preserves). This dedicated path keeps structural fields
// byte-identical, anonymizes user/account identity attributes, and scrubs only
// free-text values — any UNKNOWN attribute key still defaults to scrubbed, so
// the privacy posture stays default-scrub.
// ---------------------------------------------------------------------------

/** Attribute keys whose string value is a public, structural identifier —
 * kept byte-identical so goldens exercise real model/tool/enum shapes. */
const OTLP_KEEP_KEYS = new Set<string>([
  // provider / model (pricing matches on these)
  'gen_ai.system',
  'gen_ai.provider.name',
  'gen_ai.operation.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'model',
  // response classification (enums, not content)
  'gen_ai.response.finish_reasons',
  'stop_reason',
  'decision',
  'success',
  'speed',
  'source',
  'span.type',
  // opaque ids (same policy as PRESERVE_KEYS: real ids exercise joins/grouping)
  'session.id',
  'agent_id', // subagent correlation id — the OTLP subagent join, like tool_use_id
  'gen_ai.response.id',
  'gen_ai.tool.call.id',
  'tool_use_id',
  'tool_name',
  'gen_ai.tool.name',
  'request_id',
  'client_request_id',
  'attempt',
  'interaction.sequence',
  // environment (non-identifying)
  'service.name',
  'service.version',
  'os.type',
  'os.version',
  'host.arch',
  'terminal.type',
]);

/** Attribute keys carrying user/account identity — replaced with deterministic
 * anonymous stand-ins so no real PII lands in git while shape is preserved. */
const OTLP_IDENTITY_KEYS = new Set<string>([
  'user.email',
  'user.id',
  'user.name',
  'user.account_id',
  'user.account_uuid',
  'organization.id',
  'host.name',
]);

/** Span/scope/resource fields kept byte-identical (linkage, timing, enums). */
const OTLP_STRUCT_KEEP_KEYS = new Set<string>([
  'traceId',
  'spanId',
  'parentSpanId',
  'traceState',
  'flags',
  'name', // span / scope / event name — a label, never user content
  'kind',
  'code', // status.code enum
  'version', // scope.version
  'schemaUrl',
  'startTimeUnixNano',
  'endTimeUnixNano',
  'timeUnixNano',
  'droppedAttributesCount',
  'droppedEventsCount',
  'droppedLinksCount',
]);

interface OtlpStats {
  spans: number;
  keptValues: number;
  scrubbedValues: number;
  anonymized: number;
}

/** Scrub one OTLP AnyValue given its attribute key context. */
function scrubOtlpValue(
  key: string,
  value: Record<string, unknown>,
  secrets: Secrets,
  stats: OtlpStats,
): Record<string, unknown> {
  if (typeof value.stringValue === 'string') {
    const s = value.stringValue;
    if (OTLP_IDENTITY_KEYS.has(key)) {
      stats.anonymized++;
      return { stringValue: anonId(s) };
    }
    if (OTLP_KEEP_KEYS.has(key) || key === 'model' || key.endsWith('.model')) {
      stats.keptValues++;
      return { stringValue: redactSecrets(s, secrets, { hex: false }) };
    }
    stats.scrubbedValues++;
    return { stringValue: redactSecrets(scrubText(s), secrets) };
  }
  if (value.arrayValue !== null && typeof value.arrayValue === 'object') {
    const arr = value.arrayValue as { values?: Record<string, unknown>[] };
    return {
      arrayValue: {
        values: (arr.values ?? []).map((v) =>
          scrubOtlpValue(key, v, secrets, stats),
        ),
      },
    };
  }
  if (value.kvlistValue !== null && typeof value.kvlistValue === 'object') {
    const kv = value.kvlistValue as { values?: unknown };
    return {
      kvlistValue: { values: scrubOtlpAttributes(kv.values, secrets, stats) },
    };
  }
  // base64 blobs can carry arbitrary content — blank them, never trust opaque bytes
  if (typeof value.bytesValue === 'string') {
    stats.scrubbedValues++;
    return { bytesValue: '' };
  }
  // intValue / doubleValue / boolValue — numeric, kept
  stats.keptValues++;
  return value;
}

function scrubOtlpAttributes(
  attrs: unknown,
  secrets: Secrets,
  stats: OtlpStats,
): unknown[] {
  if (!Array.isArray(attrs)) return [];
  return attrs.map((a) => {
    const attr = a as { key?: unknown; value?: unknown };
    const key = typeof attr.key === 'string' ? attr.key : '';
    const value =
      attr.value !== null && typeof attr.value === 'object'
        ? scrubOtlpValue(
            key,
            attr.value as Record<string, unknown>,
            secrets,
            stats,
          )
        : attr.value;
    return { key: attr.key, value };
  });
}

/** Walk the OTLP tree: keep structural keys, special-case attributes, and
 * default any unknown string field to scrubbed (privacy-first). */
function scrubOtlpNode(
  node: unknown,
  secrets: Secrets,
  stats: OtlpStats,
): unknown {
  if (Array.isArray(node))
    return node.map((n) => scrubOtlpNode(n, secrets, stats));
  if (node === null || typeof node !== 'object') return node;
  const rec = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'attributes') {
      out[k] = scrubOtlpAttributes(v, secrets, stats);
    } else if (k === 'spans' && Array.isArray(v)) {
      stats.spans += v.length;
      out[k] = v.map((n) => scrubOtlpNode(n, secrets, stats));
    } else if (OTLP_STRUCT_KEEP_KEYS.has(k)) {
      out[k] = v; // linkage / timing / classification — byte-identical
    } else if (typeof v === 'string') {
      out[k] = redactSecrets(scrubText(v), secrets); // unknown string → scrub
    } else {
      out[k] = scrubOtlpNode(v, secrets, stats);
    }
  }
  return out;
}

function scrubOtlp(
  doc: Record<string, unknown>,
  secrets: Secrets,
): { output: Record<string, unknown>; stats: OtlpStats } {
  const stats: OtlpStats = {
    spans: 0,
    keptValues: 0,
    scrubbedValues: 0,
    anonymized: 0,
  };
  const resourceSpans = scrubOtlpNode(doc.resourceSpans, secrets, stats);
  return { output: { resourceSpans }, stats };
}

interface Options {
  input: string;
  out: string | null;
  source: string;
  session: string | null;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  let out: string | null = null;
  let source = '';
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-o' || arg === '--out') out = argv[++i] ?? null;
    else if (arg === '--source') source = argv[++i] ?? '';
    else if (arg === '--session') session = argv[++i] ?? null;
    else if (arg?.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else if (arg) positional.push(arg);
  }
  const input = positional[0];
  if (!input)
    throw new Error(
      'usage: pnpm scrub <raw-file|dir|db> [-o <out>] [--source <id>] [--session <ses_id>]',
    );
  if (!source)
    source = ROLLOUT_FILE.test(basename(input))
      ? 'codex'
      : input.endsWith('.jsonl')
        ? 'claude-code'
        : 'opencode';
  return { input, out, source, session };
}

function deriveOut(input: string): string | null {
  // Collapse runs of separators — pnpm on Windows can forward doubled
  // backslashes, which would otherwise split into empty path segments.
  const parts = input.split(/[\\/]+/);
  const idx = parts.lastIndexOf('raw');
  if (idx < 0) return null;
  parts.splice(idx, 1);
  return parts.join('/');
}

interface FileResult {
  output: string;
  stats: Stats;
  otlpStats: OtlpStats | null;
  effectiveSource: string;
}

/** Scrub one file's content (JSONL, OTLP-envelope JSON, or generic JSON). */
function scrubFile(
  inputPath: string,
  raw: string,
  source: string,
  secrets: Secrets,
): FileResult {
  const stats: Stats = { strings: 0, sidechains: 0, toolErrors: 0 };
  const keys = activeKeys(source);

  if (inputPath.endsWith('.jsonl')) {
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const scrubbed = lines.map((line) =>
      JSON.stringify(scrubValue(JSON.parse(line), null, secrets, stats, keys)),
    );
    return {
      output: `${[JSON.stringify(metaRecord(source)), ...scrubbed].join('\n')}\n`,
      stats,
      otlpStats: null,
      effectiveSource: source,
    };
  }
  const parsedRaw = JSON.parse(raw) as Record<string, unknown>;
  // OTLP is detected by its envelope, so a `.json` capture scrubs correctly
  // even without an explicit --source otlp.
  if (source === 'otlp' || 'resourceSpans' in parsedRaw) {
    const result = scrubOtlp(parsedRaw, secrets);
    return {
      output: `${JSON.stringify({ [`_${MARKER.toLowerCase()}`]: MARKER, _scrubMeta: metaRecord('otlp'), ...result.output }, null, 2)}\n`,
      stats,
      otlpStats: result.stats,
      effectiveSource: 'otlp',
    };
  }
  const parsed = scrubValue(parsedRaw, null, secrets, stats, keys) as Record<
    string,
    unknown
  >;
  return {
    output: `${JSON.stringify({ [`_${MARKER.toLowerCase()}`]: MARKER, _scrubMeta: metaRecord(source), ...parsed }, null, 2)}\n`,
    stats,
    otlpStats: null,
    effectiveSource: source,
  };
}

function logFileStats(result: FileResult, inBytes: number): void {
  if (result.otlpStats) {
    const o = result.otlpStats;
    console.log(
      `  source=otlp  spans=${o.spans}  values kept=${o.keptValues}  scrubbed=${o.scrubbedValues}  identity anonymized=${o.anonymized}`,
    );
  } else {
    console.log(
      `  source=${result.effectiveSource}  strings scrubbed=${result.stats.strings}`,
    );
    console.log(
      `  structural markers: isSidechain=${result.stats.sidechains}  toolErrors=${result.stats.toolErrors}`,
    );
  }
  console.log(`  bytes: ${inBytes} in -> ${result.output.length} out`);
}

function verifyBlock(secrets: Secrets, outPath: string): void {
  console.log('\nVERIFY BEFORE COMMITTING (docs/04-SAMPLE-LOGS.md §5):');
  console.log(`  grep -ri "${secrets.username}" ${outPath}   # must be empty`);
  console.log('  - confirm no real repo/file names remain, files still parse');
  console.log(`  - the ${MARKER} marker is present in every file`);
}

/** The Codex form of the block above. A rollout may be written compressed,
 * and `grep` on a `.jsonl.zst` finds nothing whatever is inside it, so the
 * check to run is the test that reads the files through the rollout reader. */
function verifyCodexBlock(secrets: Secrets, outPath: string): void {
  console.log('\nVERIFY BEFORE COMMITTING (docs/04-SAMPLE-LOGS.md §5):');
  console.log('  pnpm vitest run scripts/codex-fixtures   # must pass');
  console.log(
    '  - it reads every rollout under fixtures/codex, compressed ones too, and',
  );
  console.log(
    `    searches the new or changed ones for "${secrets.username}" and the host name`,
  );
  console.log(
    `  - grep cannot see inside a .jsonl.zst; on a plain file: grep -ri "${secrets.username}" ${outPath}`,
  );
  console.log('  - read the scrubbed file yourself before committing it');
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out.sort();
}

/**
 * Directory mode: scrub every .json/.jsonl under the input tree into a
 * mirrored output tree, each file carrying its own marker (the convention the
 * committed claude-code subagents fixture established). Non-JSON files are
 * SKIPPED, not copied — unknown formats default to "never lands in git"
 * (same posture as default-scrub, and what the claude-code fixture did with
 * meta/txt files).
 */
function scrubDirectory(opts: Options, outDir: string, secrets: Secrets): void {
  const inRoot = resolve(opts.input);
  const outRoot = resolve(outDir);
  if (outRoot === inRoot || `${outRoot}${sep}`.startsWith(`${inRoot}${sep}`)) {
    throw new Error(
      'refusing to write inside the raw input tree; choose another -o',
    );
  }
  const files = walkFiles(inRoot);
  let written = 0;
  const skipped: string[] = [];
  const totals: Stats = { strings: 0, sidechains: 0, toolErrors: 0 };
  for (const file of files) {
    const rel = relative(inRoot, file);
    if (!(file.endsWith('.json') || file.endsWith('.jsonl'))) {
      skipped.push(rel);
      continue;
    }
    const raw = readFileSync(file, 'utf8');
    const result = scrubFile(file, raw, opts.source, secrets);
    const target = join(outRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, result.output, 'utf8');
    totals.strings += result.stats.strings;
    totals.sidechains += result.stats.sidechains;
    totals.toolErrors += result.stats.toolErrors;
    written++;
    console.log(`scrubbed ${rel.replace(/\\/g, '/')}`);
  }
  console.log(
    `\n${written} file(s) scrubbed -> ${outRoot}  (source=${opts.source}, strings scrubbed=${totals.strings})`,
  );
  if (skipped.length > 0) {
    console.log(
      `SKIPPED (non-JSON never lands in git; extract what matters or scrub separately):`,
    );
    for (const s of skipped) console.log(`  - ${s.replace(/\\/g, '/')}`);
  }
  verifyBlock(secrets, outRoot);
}

/**
 * SQLite mode (OpenCode `opencode.db`, task 2.3): dump → scrub → rebuild.
 * Reads the raw db strictly read-only, extracts ONE root session (--session)
 * plus its descendant sessions, scrubs rows with the same opencode key rules
 * as the JSON eras, and writes a FRESH db containing only the three tables the
 * adapter reads (schema pinned to what OpenCode 1.1.56–1.2.14 creates) plus an
 * `x_tracepulse_scrub` marker table — so `grep SCRUBBED` works on the binary
 * too. Free-text session columns that the adapter never reads (share_url,
 * revert, permission, metadata, summary_diffs) are nulled, not scrubbed:
 * default-drop beats default-trust for unread content.
 */
async function scrubSqlite(
  opts: Options,
  outPath: string,
  secrets: Secrets,
): Promise<void> {
  if (opts.session === null) {
    throw new Error(
      'scrubbing a .db requires --session <ses_id> (one root session per fixture)',
    );
  }
  const { default: Database } = await import('better-sqlite3');
  const src = new Database(opts.input, { readonly: true, fileMustExist: true });
  const keys = activeKeys('opencode');
  const stats: Stats = { strings: 0, sidechains: 0, toolErrors: 0 };

  interface SessionRow {
    [k: string]: unknown;
    id: string;
    directory: string | null;
    slug: string | null;
    title: string | null;
  }
  const sessions: SessionRow[] = [];
  const queue = [opts.session];
  while (queue.length > 0) {
    const id = queue.shift();
    const row = src.prepare('SELECT * FROM session WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    if (row === undefined) throw new Error(`session not found: ${id}`);
    sessions.push(row);
    for (const child of src
      .prepare('SELECT id FROM session WHERE parent_id = ? ORDER BY id')
      .all(row.id) as { id: string }[]) {
      queue.push(child.id);
    }
  }
  const sessionIds = sessions.map((s) => s.id);
  const placeholders = sessionIds.map(() => '?').join(',');
  const messages = src
    .prepare(
      `SELECT * FROM message WHERE session_id IN (${placeholders}) ORDER BY id`,
    )
    .all(...sessionIds) as Record<string, unknown>[];
  const parts = src
    .prepare(
      `SELECT * FROM part WHERE session_id IN (${placeholders}) ORDER BY id`,
    )
    .all(...sessionIds) as Record<string, unknown>[];
  src.close();

  const scrubData = (data: unknown): string =>
    JSON.stringify(
      scrubValue(JSON.parse(String(data)), null, secrets, stats, keys),
    );

  rmSync(outPath, { force: true });
  mkdirSync(dirname(outPath), { recursive: true });
  const out = new Database(outPath);
  out.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY, project_id text NOT NULL, parent_id text,
      slug text NOT NULL, directory text NOT NULL, title text NOT NULL,
      version text NOT NULL, share_url text,
      summary_additions integer, summary_deletions integer, summary_files integer,
      summary_diffs text, revert text, permission text,
      time_created integer NOT NULL, time_updated integer NOT NULL, metadata text
    );
    CREATE TABLE message (
      id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
    CREATE TABLE x_tracepulse_scrub (marker text, source text, generated_by text, note text);
  `);
  out
    .prepare('INSERT INTO x_tracepulse_scrub VALUES (?, ?, ?, ?)')
    .run(
      MARKER,
      'opencode',
      'scripts/scrub-fixture.ts',
      'Synthetic content; usage/token counts and structure preserved. Never edit by hand.',
    );
  const insSession = out.prepare(
    `INSERT INTO session VALUES (
      @id, @project_id, @parent_id, @slug, @directory, @title, @version, NULL,
      @summary_additions, @summary_deletions, @summary_files, NULL, NULL, NULL,
      @time_created, @time_updated, NULL)`,
  );
  for (const s of [...sessions].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    stats.strings += 3;
    insSession.run({
      ...s,
      slug: s.slug === null ? '' : loremToken(s.slug.length, fnv1a(s.slug)),
      directory: s.directory === null ? '' : scrubPath(s.directory),
      title: s.title === null ? '' : redactSecrets(scrubText(s.title), secrets),
    });
  }
  const insMessage = out.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  for (const m of messages) {
    insMessage.run(
      m.id,
      m.session_id,
      m.time_created,
      m.time_updated,
      scrubData(m.data),
    );
  }
  const insPart = out.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  for (const p of parts) {
    insPart.run(
      p.id,
      p.message_id,
      p.session_id,
      p.time_created,
      p.time_updated,
      scrubData(p.data),
    );
  }
  out.close();

  console.log(`scrubbed ${basename(opts.input)} -> ${outPath}`);
  console.log(
    `  source=opencode(sqlite)  sessions=${sessions.length}  messages=${messages.length}  parts=${parts.length}  strings scrubbed=${stats.strings}`,
  );
  verifyBlock(secrets, outPath);
}

function logCodexStats(result: CodexScrubResult): void {
  const { stats, dropped } = result;
  console.log(
    `  source=codex  records=${stats.records}  strings scrubbed=${stats.strings}  blobs replaced=${stats.blobs}  path keys=${stats.pathKeys}`,
  );
  if (dropped.length > 0)
    console.log(
      `  DROPPED ${dropped.length} line(s) that are not JSON: ${dropped.join(', ')}`,
    );
  // Names of keys are printed here, on your terminal, and nowhere else: in
  // the output they are lorem. Each is a field this script does not know.
  for (const [label, map] of [
    ['UNKNOWN keys (scrubbed with their subtree)', stats.unknownKeys],
    ['GUARDED values (structural key, value not id-shaped)', stats.guardedKeys],
  ] as const) {
    if (map.size === 0) continue;
    const list = [...map]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, n]) => `${k}×${n}`)
      .join(', ');
    console.log(`  ${label}: ${list}`);
  }
}

/**
 * Codex mode (`--source codex`, design T14 of add-codex-adapter): one
 * rollout file, or every rollout under a directory into a mirrored tree
 * (a root thread and its reviewer threads). Rules in scrub-codex.ts.
 */
async function scrubCodex(
  opts: Options,
  outPath: string,
  secrets: Secrets,
): Promise<void> {
  if (!statSync(opts.input).isDirectory()) {
    const result = await scrubCodexFile(opts.input, outPath, secrets);
    console.log(`scrubbed ${basename(opts.input)} -> ${outPath}`);
    logCodexStats(result);
    verifyCodexBlock(secrets, outPath);
    return;
  }
  const inRoot = resolve(opts.input);
  const outRoot = resolve(outPath);
  if (outRoot === inRoot || `${outRoot}${sep}`.startsWith(`${inRoot}${sep}`)) {
    throw new Error(
      'refusing to write inside the raw input tree; choose another -o',
    );
  }
  const skipped: string[] = [];
  let written = 0;
  for (const file of walkFiles(inRoot)) {
    const rel = relative(inRoot, file);
    if (!ROLLOUT_FILE.test(basename(file))) {
      skipped.push(rel);
      continue;
    }
    const result = await scrubCodexFile(file, join(outRoot, rel), secrets);
    console.log(`scrubbed ${rel.replace(/\\/g, '/')}`);
    logCodexStats(result);
    written++;
  }
  console.log(`\n${written} rollout(s) scrubbed -> ${outRoot}  (source=codex)`);
  if (skipped.length > 0) {
    console.log('SKIPPED (not a rollout; never lands in git):');
    for (const s of skipped) console.log(`  - ${s.replace(/\\/g, '/')}`);
  }
  verifyCodexBlock(secrets, outRoot);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const outPath = opts.out ?? deriveOut(opts.input);
  if (!outPath) {
    throw new Error(
      'could not derive output path (input is not under a raw/ dir); pass -o <out-file> explicitly',
    );
  }
  if (outPath === opts.input)
    throw new Error('refusing to overwrite the raw input; choose another -o');

  const secrets: Secrets = { username: userInfo().username, host: hostname() };

  if (opts.source === 'codex') {
    await scrubCodex(opts, outPath, secrets);
    return;
  }
  if (statSync(opts.input).isDirectory()) {
    scrubDirectory(opts, outPath, secrets);
    return;
  }
  if (opts.input.endsWith('.db')) {
    await scrubSqlite(opts, outPath, secrets);
    return;
  }

  const raw = readFileSync(opts.input, 'utf8');
  const result = scrubFile(opts.input, raw, opts.source, secrets);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, result.output, 'utf8');

  console.log(`scrubbed ${basename(opts.input)} -> ${outPath}`);
  logFileStats(result, raw.length);
  verifyBlock(secrets, outPath);
}

await main();
