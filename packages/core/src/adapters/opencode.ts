import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type {
  Candidate,
  ParseOptions,
  RawRun,
  RawSpan,
  RunWarning,
  SourceAdapter,
} from '../adapter.js';
import { loadSqlite, type SqliteDatabase } from '../sqlite.js';
import { stripBom } from '../text.js';
import { errorPreview, isUserRejection } from './error-preview.js';
import { toolTargetAttributes } from './target.js';

/**
 * OpenCode adapter (task 2.3). Three storage eras behind one facade
 * (05-ARCHITECTURE §2.1), all observed 2026-07 on OpenCode 1.1.56–1.2.14:
 *
 *   file storage   <dataDir>/storage/session/<projectID>/ses_*.json
 *                  <dataDir>/storage/message/<sessionID>/msg_*.json
 *                  <dataDir>/storage/part/<messageID>/prt_*.json
 *   sqlite         <dataDir>/opencode.db — Drizzle tables session/message/part;
 *                  message.data / part.data hold the SAME JSON as the storage
 *                  files minus the id/fk columns (merged back on load)
 *   export json    `opencode export <sessionID>` → { info, messages:[{info,parts}] }
 *
 * The eras converge on one SessionBundle and one span emitter, which is what
 * makes the spec's cross-era guarantee ("identical normalized structure for
 * equivalent sessions") hold by construction. Both stores coexist on one
 * machine (dual-write during OpenCode's migration), so detect() dedupes: a
 * session found in a db wins over the same session id in file storage within
 * the same scan root.
 *
 * Subagents: child sessions carry `parentID`; the spawning `task` tool part
 * joins via `state.metadata.sessionId`. OpenCode stores `cost: 0` — never
 * trusted; the cost engine computes (docs/02-DATA-MODEL.md).
 */

const PREVIEW_CHARS = 200;
const EPOCH = '1970-01-01T00:00:00Z';

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function int(v: unknown): number {
  const n = num(v);
  return n === undefined ? 0 : Math.max(0, Math.round(n));
}
function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}
function lineCount(v: unknown): number {
  const s = str(v);
  return s ? s.split('\n').length : 0;
}

// ---------------------------------------------------------------------------
// Record shapes (pinned to what the three eras actually contain)
// ---------------------------------------------------------------------------

interface OcRecord {
  json: Json;
  provenance: { file: string; recordId: string };
}
interface SessionBundle {
  session: OcRecord;
  /** Sorted by id — msg_/prt_ ids are time-ordered, so this is chronological. */
  messages: OcRecord[];
  partsByMessage: Map<string, OcRecord[]>;
  children: SessionBundle[];
}

function timeOf(json: Json): {
  created?: number;
  updated?: number;
  completed?: number;
} {
  const t = isObj(json.time) ? json.time : {};
  return {
    created: num(t.created),
    updated: num(t.updated),
    completed: num(t.completed),
  };
}

/** Model/provider across eras: flat `modelID`/`providerID` (≤1.3) or nested
 * `model.{providerID,modelID}` (1.4+). */
function modelOf(json: Json): { model?: string; provider?: string } {
  const nested = isObj(json.model) ? json.model : undefined;
  return {
    model: str(json.modelID) ?? str(nested?.modelID),
    provider: str(json.providerID) ?? str(nested?.providerID),
  };
}

function byId(a: OcRecord, b: OcRecord): number {
  const x = str(a.json.id) ?? a.provenance.recordId;
  const y = str(b.json.id) ?? b.provenance.recordId;
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Era loaders → SessionBundle
// ---------------------------------------------------------------------------

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readJson(
  file: string,
  warnings: RunWarning[],
): Promise<Json | undefined> {
  try {
    // stripBom: `looksLikeExport` sniffs with a substring search, which a
    // leading U+FEFF does not disturb, so without this a BOM'd bundle matches
    // the sniff and then dies in JSON.parse — the file disappears and the
    // root reads as empty. The documented way to make one is a shell redirect
    // (`opencode export <id> > file`), which is exactly what adds the BOM on
    // Windows.
    const parsed: unknown = JSON.parse(stripBom(await readFile(file, 'utf8')));
    return isObj(parsed) ? parsed : undefined;
  } catch {
    warnings.push({ message: 'unparseable JSON file', file });
    return undefined;
  }
}

/** storage/ era: stitch session + message/<ses>/ + part/<msgId>/ trees. */
async function loadStorageBundle(
  storageDir: string,
  sessionFile: string,
  warnings: RunWarning[],
  visited: Set<string>,
): Promise<SessionBundle | undefined> {
  if (visited.has(sessionFile)) return undefined;
  visited.add(sessionFile);
  const sessionJson = await readJson(sessionFile, warnings);
  if (sessionJson === undefined) return undefined;
  const sessionId = str(sessionJson.id) ?? basename(sessionFile, '.json');

  const messages: OcRecord[] = [];
  const partsByMessage = new Map<string, OcRecord[]>();
  const msgDir = join(storageDir, 'message', sessionId);
  for (const entry of await safeReaddir(msgDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = join(msgDir, entry.name);
    const json = await readJson(file, warnings);
    if (json === undefined) continue;
    const msgId = str(json.id) ?? basename(entry.name, '.json');
    messages.push({ json, provenance: { file, recordId: msgId } });

    const partDir = join(storageDir, 'part', msgId);
    const parts: OcRecord[] = [];
    for (const p of await safeReaddir(partDir)) {
      if (!p.isFile() || !p.name.endsWith('.json')) continue;
      const pFile = join(partDir, p.name);
      const pJson = await readJson(pFile, warnings);
      if (pJson === undefined) continue;
      parts.push({
        json: pJson,
        provenance: {
          file: pFile,
          recordId: str(pJson.id) ?? basename(p.name, '.json'),
        },
      });
    }
    parts.sort(byId);
    partsByMessage.set(msgId, parts);
  }
  messages.sort(byId);

  // children: any session file (all projects) whose parentID is this session
  const children: SessionBundle[] = [];
  for (const file of await listSessionFiles(storageDir)) {
    if (file === sessionFile) continue;
    const json = await readJson(file, []);
    if (json === undefined || str(json.parentID) !== sessionId) continue;
    const child = await loadStorageBundle(storageDir, file, warnings, visited);
    if (child !== undefined) children.push(child);
  }
  children.sort((a, b) => byId(a.session, b.session));

  return {
    session: {
      json: sessionJson,
      provenance: { file: sessionFile, recordId: sessionId },
    },
    messages,
    partsByMessage,
    children,
  };
}

async function listSessionFiles(storageDir: string): Promise<string[]> {
  const out: string[] = [];
  const sessionRoot = join(storageDir, 'session');
  for (const project of await safeReaddir(sessionRoot)) {
    if (!project.isDirectory()) continue;
    for (const f of await safeReaddir(join(sessionRoot, project.name))) {
      if (f.isFile() && f.name.endsWith('.json'))
        out.push(join(sessionRoot, project.name, f.name));
    }
  }
  return out.sort();
}

/** export era: one self-contained { info, messages:[{info,parts}] } document. */
function loadExportBundle(file: string, doc: Json): SessionBundle | undefined {
  const info = isObj(doc.info) ? doc.info : undefined;
  if (info === undefined) return undefined;
  const sessionId = str(info.id) ?? basename(file, '.json');
  const messages: OcRecord[] = [];
  const partsByMessage = new Map<string, OcRecord[]>();
  if (Array.isArray(doc.messages)) {
    for (const m of doc.messages) {
      if (!isObj(m)) continue;
      const mInfo = isObj(m.info) ? m.info : m;
      const msgId = str(mInfo.id);
      if (msgId === undefined) continue;
      messages.push({ json: mInfo, provenance: { file, recordId: msgId } });
      const parts: OcRecord[] = [];
      if (Array.isArray(m.parts)) {
        for (const p of m.parts) {
          if (!isObj(p)) continue;
          const partId = str(p.id);
          if (partId === undefined) continue;
          parts.push({ json: p, provenance: { file, recordId: partId } });
        }
      }
      parts.sort(byId);
      partsByMessage.set(msgId, parts);
    }
  }
  messages.sort(byId);
  return {
    session: { json: info, provenance: { file, recordId: sessionId } },
    messages,
    partsByMessage,
    children: [], // `opencode export` serializes one session; children export separately
  };
}

// ---------------------------------------------------------------------------
// sqlite era (better-sqlite3, strictly read-only)
// ---------------------------------------------------------------------------

interface SqliteRow {
  id: string;
  session_id?: string;
  message_id?: string;
  parent_id?: string | null;
  data?: string;
  [k: string]: unknown;
}
type SqliteDb = SqliteDatabase<SqliteRow>;

/** Read-only open; a failure must be clear and actionable (trace-ingestion
 * spec) and must never create or lock the database. better-sqlite3 opens
 * lazily (a corrupt file only fails at the first statement), so probe here.
 *
 * `loadSqlite()` sits deliberately outside the try: a missing optional module
 * is not a broken database, and its own message is the actionable one. */
async function openDb(dbPath: string): Promise<SqliteDb> {
  const Ctor = await loadSqlite<SqliteRow>();
  let db: SqliteDb | undefined;
  try {
    db = new Ctor(dbPath, { readonly: true, fileMustExist: true });
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').all();
    return db;
  } catch (err) {
    db?.close();
    throw new Error(
      `cannot open OpenCode database read-only: ${dbPath} — ${err instanceof Error ? err.message : String(err)}. ` +
        'If OpenCode is running, close it and retry; the database is never modified or locked by runray.',
    );
  }
}

/** Rebuild the storage-file JSON shape from a row: data column + id/fk columns. */
function rowToJson(row: SqliteRow, extra: Json): Json | undefined {
  if (row.data === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (!isObj(parsed)) return undefined;
    return { id: row.id, ...extra, ...parsed };
  } catch {
    return undefined;
  }
}

/** session table stores fields as flat columns; fold them back to the file shape. */
function sessionRowToJson(row: SqliteRow): Json {
  const json: Json = {
    id: row.id,
    projectID: row.project_id,
    slug: row.slug,
    directory: row.directory,
    title: row.title,
    version: row.version,
    time: { created: row.time_created, updated: row.time_updated },
    summary: {
      additions: row.summary_additions ?? 0,
      deletions: row.summary_deletions ?? 0,
      files: row.summary_files ?? 0,
    },
  };
  if (typeof row.parent_id === 'string') json.parentID = row.parent_id;
  return json;
}

function loadSqliteBundle(
  db: SqliteDb,
  dbPath: string,
  sessionRow: SqliteRow,
  warnings: RunWarning[],
): SessionBundle {
  const sessionId = sessionRow.id;
  const messages: OcRecord[] = [];
  const partsByMessage = new Map<string, OcRecord[]>();
  for (const m of db
    .prepare('SELECT * FROM message WHERE session_id = ? ORDER BY id')
    .all(sessionId)) {
    const json = rowToJson(m, { sessionID: sessionId });
    if (json === undefined) {
      warnings.push({
        message: `unparseable message row ${m.id}`,
        file: dbPath,
      });
      continue;
    }
    messages.push({ json, provenance: { file: dbPath, recordId: m.id } });
    const parts: OcRecord[] = [];
    for (const p of db
      .prepare('SELECT * FROM part WHERE message_id = ? ORDER BY id')
      .all(m.id)) {
      const pJson = rowToJson(p, { messageID: m.id, sessionID: sessionId });
      if (pJson === undefined) {
        warnings.push({
          message: `unparseable part row ${p.id}`,
          file: dbPath,
        });
        continue;
      }
      parts.push({ json: pJson, provenance: { file: dbPath, recordId: p.id } });
    }
    partsByMessage.set(m.id, parts);
  }

  const children: SessionBundle[] = [];
  for (const c of db
    .prepare('SELECT * FROM session WHERE parent_id = ? ORDER BY id')
    .all(sessionId)) {
    children.push(loadSqliteBundle(db, dbPath, c, warnings));
  }

  return {
    session: {
      json: sessionRowToJson(sessionRow),
      provenance: { file: dbPath, recordId: sessionId },
    },
    messages,
    partsByMessage,
    children,
  };
}

// ---------------------------------------------------------------------------
// SessionBundle → RawSpan[] (one emitter for all eras)
// ---------------------------------------------------------------------------

interface EmitContext {
  spans: RawSpan[];
  warnings: RunWarning[];
  redact: boolean;
}

/** Redaction happens here in core: with redact, prompt-derived fields become null. */
function contentField(
  ctx: EmitContext,
  fields: Record<string, string | undefined>,
): RawSpan['content'] {
  const keys = Object.keys(fields);
  if (ctx.redact) {
    return Object.fromEntries(keys.map((k) => [k, null]));
  }
  const present = keys.filter((k) => fields[k] !== undefined);
  if (present.length === 0) return undefined;
  return Object.fromEntries(present.map((k) => [k, fields[k]]));
}

function firstTextPart(parts: OcRecord[] | undefined): string | undefined {
  for (const p of parts ?? []) {
    if (p.json.type === 'text') {
      const t = str(p.json.text);
      if (t !== undefined) return t;
    }
  }
  return undefined;
}

function toolStatus(state: Json | undefined): RawSpan['status'] {
  const s = str(state?.status);
  if (s === 'completed') return 'ok';
  if (s === 'error') return 'error';
  if (s === 'running' || s === 'pending') return 'in_progress';
  return 'unknown';
}

/** Code-change counts for OpenCode's file-modifying tools (lowercase names;
 * input keys observed: edit {oldString,newString}, write {content}). */
function codeChangeCounts(
  toolName: string,
  input: Json,
): { linesAdded?: number; linesRemoved?: number } {
  switch (toolName) {
    case 'edit':
      return {
        linesAdded: lineCount(input.newString),
        linesRemoved: lineCount(input.oldString),
      };
    case 'write':
      return { linesAdded: lineCount(input.content) };
    default:
      return {};
  }
}

function outputBytes(state: Json | undefined): number | undefined {
  const out = state?.output;
  if (typeof out === 'string') return Buffer.byteLength(out, 'utf8');
  return undefined;
}

/** A failed part's error text: a string in the storage format, an
 * `{ name, message }` object in some exports. */
function errorText(state: Json | undefined): string | undefined {
  const err = state?.error;
  return typeof err === 'string'
    ? err
    : isObj(err)
      ? (str(err.message) ?? str(err.name))
      : undefined;
}

function durationBetween(
  startedAt: string,
  endedAt: string | undefined,
): number | undefined {
  if (endedAt === undefined) return undefined;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

function emitBundle(
  bundle: SessionBundle,
  ownerSpanId: string | null,
  ctx: EmitContext,
): void {
  const ses = bundle.session.json;
  const sessionId = str(ses.id) ?? bundle.session.provenance.recordId;
  const t = timeOf(ses);
  const startedAt = iso(t.created) ?? EPOCH;
  const endedAt = iso(t.updated);
  const isChild = ownerSpanId !== null;

  // child sessions surface through their subagent span, not a nested session
  const containerId = isChild ? ownerSpanId : sessionId;
  if (!isChild) {
    ctx.spans.push({
      id: sessionId,
      parentId: null,
      kind: 'session',
      name: 'session',
      status: 'ok',
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      durationMs: durationBetween(startedAt, endedAt),
      agent: { sessionId },
      attributes: {},
      provenance: {
        file: bundle.session.provenance.file,
        recordId: bundle.session.provenance.recordId,
      },
    });
  }

  const childBySessionId = new Map<string, SessionBundle>();
  for (const c of bundle.children) {
    childBySessionId.set(str(c.session.json.id) ?? '', c);
  }
  const emittedChildren = new Set<string>();

  for (const msg of bundle.messages) {
    const m = msg.json;
    if (m.role !== 'assistant') continue; // user text surfaces as promptPreview
    const msgId = str(m.id) ?? msg.provenance.recordId;
    const mt = timeOf(m);
    const mStart = iso(mt.created) ?? startedAt;
    const mEnd = iso(mt.completed);
    const { model, provider } = modelOf(m);
    const tokens = isObj(m.tokens) ? m.tokens : {};
    const cache = isObj(tokens.cache) ? tokens.cache : {};
    const reasoning = int(tokens.reasoning);

    const parentMsgId = str(m.parentID);
    const promptPreview =
      parentMsgId === undefined
        ? undefined
        : firstTextPart(bundle.partsByMessage.get(parentMsgId))?.slice(
            0,
            PREVIEW_CHARS,
          );
    const outputPreview = firstTextPart(
      bundle.partsByMessage.get(msgId),
    )?.slice(0, PREVIEW_CHARS);

    ctx.spans.push({
      id: msgId,
      parentId: containerId,
      kind: 'llm_call',
      name: model ?? 'unknown',
      status: isObj(m.error) ? 'error' : 'ok',
      startedAt: mStart,
      ...(mEnd === undefined ? {} : { endedAt: mEnd }),
      durationMs: durationBetween(mStart, mEnd),
      llm: {
        provider: provider ?? 'unknown',
        model: model ?? 'unknown',
        tokens: {
          input: int(tokens.input),
          output: int(tokens.output),
          cacheRead: int(cache.read),
          cacheWrite: int(cache.write),
          ...(reasoning === 0 ? {} : { reasoning }),
        },
        // OpenCode stores cost: 0 — never trusted; the cost engine (task 2.5)
        // computes it and flips costSource to 'computed'
        costSource: 'unknown',
        ...(str(m.finish) === undefined ? {} : { stopReason: str(m.finish) }),
      },
      content: contentField(ctx, { promptPreview, outputPreview }),
      // NOTE: no tracepulse.cacheWrite1hTokens here — OpenCode storage
      // exposes only flat cache.read/cache.write with no TTL breakdown, so
      // 1h cache writes price at the 5m rate on this path and the same
      // Anthropic session reads cheaper than its claude-code JSONL parse
      // (same documented asymmetry as the OTLP adapter's passthrough).
      attributes: {},
      provenance: msg.provenance,
    });

    for (const part of bundle.partsByMessage.get(msgId) ?? []) {
      const p = part.json;
      if (p.type !== 'tool') continue;
      const partId = str(p.id) ?? part.provenance.recordId;
      const toolName = str(p.tool) ?? 'unknown';
      const state = isObj(p.state) ? p.state : undefined;
      const input = isObj(state?.input) ? state.input : {};
      const st = isObj(state?.time) ? state.time : {};
      const pStart = iso(num(st.start)) ?? mStart;
      const pEnd = iso(num(st.end));
      const failure = errorText(state);
      // a permission refusal is the person's decision, not the tool failing
      // (same contract as the claude-code adapter): `cancelled`, not `error`
      const rejected =
        toolStatus(state) === 'error' && isUserRejection(failure);
      const status = rejected ? 'cancelled' : toolStatus(state);
      const counts = status === 'ok' ? codeChangeCounts(toolName, input) : {};
      const bytes = outputBytes(state);
      const mcpServer = mcpServerOf(toolName);

      ctx.spans.push({
        id: partId,
        parentId: msgId,
        kind: mcpServer === undefined ? 'tool_call' : 'mcp_call',
        name: toolName,
        status,
        ...(rejected ? { statusReason: 'user-rejected' } : {}),
        startedAt: pStart,
        ...(pEnd === undefined ? {} : { endedAt: pEnd }),
        durationMs: durationBetween(pStart, pEnd),
        tool: {
          name: toolName,
          isError: status === 'error',
          ...(mcpServer === undefined ? {} : { mcpServer }),
          ...(bytes === undefined ? {} : { outputBytes: bytes }),
          ...counts,
        },
        // a failure's text is the one output worth previewing (same
        // content/redaction contract as the claude-code adapter); a declined
        // call keeps the harness message so the Inspector can say why
        ...(status === 'error' || rejected
          ? {
              content: contentField(ctx, {
                outputPreview: errorPreview(failure, PREVIEW_CHARS),
              }),
            }
          : {}),
        attributes: {
          ...toolTargetAttributes('opencode', toolName, input, ctx.redact),
          ...(mcpServer === undefined
            ? {}
            : { 'runray.mcpDetection': 'name-heuristic' }),
        },
        provenance: part.provenance,
      });

      if (toolName === 'task') {
        emitSubagent(part, childBySessionId, emittedChildren, ctx);
      }
    }
  }

  // children never referenced by a task tool part still belong to the run
  for (const child of bundle.children) {
    const childId = str(child.session.json.id) ?? '';
    if (emittedChildren.has(childId)) continue;
    ctx.warnings.push({
      message: `child session ${childId} not referenced by any task tool — attached to the session root`,
      file: child.session.provenance.file,
    });
    const ct = timeOf(child.session.json);
    const cStart = iso(ct.created) ?? startedAt;
    const cEnd = iso(ct.updated);
    ctx.spans.push({
      id: childId,
      parentId: containerId,
      kind: 'subagent',
      name: 'subagent:unknown',
      status: 'ok',
      startedAt: cStart,
      ...(cEnd === undefined ? {} : { endedAt: cEnd }),
      durationMs: durationBetween(cStart, cEnd),
      agent: { sessionId: childId },
      attributes: {},
      provenance: child.session.provenance,
    });
    emitBundle(child, childId, ctx);
  }
}

function emitSubagent(
  taskPart: OcRecord,
  childBySessionId: Map<string, SessionBundle>,
  emittedChildren: Set<string>,
  ctx: EmitContext,
): void {
  const p = taskPart.json;
  const partId = str(p.id) ?? taskPart.provenance.recordId;
  const state = isObj(p.state) ? p.state : undefined;
  const input = isObj(state?.input) ? state.input : {};
  const metadata = isObj(state?.metadata) ? state.metadata : {};
  const childSessionId = str(metadata.sessionId);
  const subagentType = str(input.subagent_type) ?? 'unknown';
  const st = isObj(state?.time) ? state.time : {};
  const startedAt = iso(num(st.start)) ?? EPOCH;
  const endedAt = iso(num(st.end));
  const spanId = childSessionId ?? `${partId}:agent`;

  ctx.spans.push({
    id: spanId,
    parentId: partId,
    kind: 'subagent',
    name: `subagent:${subagentType}`,
    status: toolStatus(state),
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    durationMs: durationBetween(startedAt, endedAt),
    agent: {
      name: subagentType,
      ...(childSessionId === undefined ? {} : { sessionId: childSessionId }),
    },
    content: contentField(ctx, { delegationReason: str(input.description) }),
    attributes: {},
    provenance: taskPart.provenance,
  });

  if (childSessionId === undefined) return;
  const child = childBySessionId.get(childSessionId);
  if (child === undefined) {
    ctx.warnings.push({
      message: `child session ${childSessionId} referenced by task tool not found`,
      file: taskPart.provenance.file,
    });
    return;
  }
  emittedChildren.add(childSessionId);
  emitBundle(child, spanId, ctx);
}

function bundleToRawRun(
  bundle: SessionBundle,
  format: Candidate['format'],
  files: string[],
  warnings: RunWarning[],
  redact: boolean,
): RawRun {
  const ctx: EmitContext = { spans: [], warnings, redact };
  emitBundle(bundle, null, ctx);

  const ses = bundle.session.json;
  const title = redact ? undefined : str(ses.title);
  const directory = str(ses.directory);
  return {
    source: { tool: 'opencode', format, files },
    ...(title === undefined ? {} : { title }),
    ...(directory === undefined
      ? {}
      : {
          // basename() is empty for a filesystem root — `D:\` on win32, `/`
          // anywhere — and an empty name collides with the UI's "all
          // projects" sentinel, so the run drops out of the project filter.
          project: { name: basename(directory) || directory, path: directory },
        }),
    spans: ctx.spans,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

const SES_FILE_RE = /^ses_[A-Za-z0-9]+\.json$/;
/** parse() needs the join key; runRef packs db path + session id. */
const DB_REF_SEP = '::';

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
      // unreadable file: still listed; parse() will warn
    }
  }
  return { mtimeMs, sizeBytes };
}

/** Bounded sniff (1 KiB): an `opencode export` document, possibly behind the
 * scrub-meta prefix. Not a parse — detect() stays cheap. All three markers
 * must appear (the session info object is small, so `"messages"` lands well
 * inside the first KiB) — one alone is too easy to hit in unrelated JSON. */
function looksLikeExport(file: string): boolean {
  try {
    const head = readFileSync(file, { encoding: 'utf8', flag: 'r' }).slice(
      0,
      1024,
    );
    return (
      head.includes('"info"') &&
      head.includes('"ses_') &&
      head.includes('"messages"')
    );
  } catch {
    return false;
  }
}

async function storageSessionFiles(storageDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const file of await listSessionFiles(storageDir)) {
    if (SES_FILE_RE.test(basename(file))) out.push(file);
  }
  return out;
}

/** All files of one storage-era session (for Candidate.files / mtime / size). */
async function storageSessionFileSet(
  storageDir: string,
  sessionFile: string,
): Promise<string[]> {
  const files = [sessionFile];
  const sessionId = basename(sessionFile, '.json');
  const msgDir = join(storageDir, 'message', sessionId);
  for (const m of await safeReaddir(msgDir)) {
    if (!m.isFile() || !m.name.endsWith('.json')) continue;
    files.push(join(msgDir, m.name));
    const partDir = join(storageDir, 'part', basename(m.name, '.json'));
    for (const p of await safeReaddir(partDir)) {
      if (p.isFile() && p.name.endsWith('.json'))
        files.push(join(partDir, p.name));
    }
  }
  return files;
}

/** Recursively find storage/ trees, opencode.db files, and export JSONs under
 * a root (raw/ trees and node_modules excluded; depth-bounded). */
async function scanRoot(
  root: string,
  found: { storageDirs: string[]; dbFiles: string[]; exportFiles: string[] },
  depth = 0,
): Promise<void> {
  if (depth > 6) return;
  const name = basename(root);
  if (name === 'raw' || name === 'node_modules') return;
  const entries = await safeReaddir(root);
  const hasSession = entries.some(
    (e) => e.isDirectory() && e.name === 'session',
  );
  if (name === 'storage' && hasSession) {
    found.storageDirs.push(root);
    return; // never descend into message/part trees
  }
  for (const e of entries) {
    const path = join(root, e.name);
    if (e.isDirectory()) {
      await scanRoot(path, found, depth + 1);
    } else if (e.name === 'opencode.db') {
      found.dbFiles.push(path);
    } else if (
      e.name.endsWith('.json') &&
      !SES_FILE_RE.test(e.name) &&
      looksLikeExport(path)
    ) {
      found.exportFiles.push(path);
    }
  }
}

function defaultRoots(): string[] {
  const env = process.env.OPENCODE_DATA_DIR;
  if (env !== undefined && env !== '') return env.split(',');
  return [join(homedir(), '.local', 'share', 'opencode')];
}

/**
 * OpenCode built-in tools (E4). The on-disk part JSON carries no MCP
 * marker; OpenCode registers MCP tools as `<server>_<tool>`, which
 * collides with built-in underscore names — hence allowlist first, then
 * the name heuristic. Grounded on captured fixtures; the human-gated MCP
 * fixture (task 8.1) is ground truth for corrections.
 */
const OPENCODE_BUILTIN_TOOLS = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'list',
  'patch',
  'apply_patch',
  'webfetch',
  'websearch',
  'task',
  'todowrite',
  'todoread',
  'skill',
  'question',
]);

/**
 * MCP server prefix per the underscore-join heuristic — a non-builtin name
 * containing `_` classifies as `mcp_call` with the segment before the
 * first `_` as the server. Every heuristic hit is flagged via
 * `runray.mcpDetection` so downstream consumers can show the
 * uncertainty. Built-ins and non-underscore names stay `tool_call`.
 */
function mcpServerOf(toolName: string): string | undefined {
  if (OPENCODE_BUILTIN_TOOLS.has(toolName)) return undefined;
  const idx = toolName.indexOf('_');
  if (idx <= 0) return undefined;
  return toolName.slice(0, idx);
}

export const opencodeAdapter: SourceAdapter = {
  id: 'opencode',

  defaultRoots,

  async detect(roots: string[]): Promise<Candidate[]> {
    const scanRoots = roots.length > 0 ? roots : defaultRoots();
    const candidates: Candidate[] = [];
    for (const root of scanRoots) {
      const found = { storageDirs: [], dbFiles: [], exportFiles: [] } as {
        storageDirs: string[];
        dbFiles: string[];
        exportFiles: string[];
      };
      await scanRoot(root, found);

      // db first: within one root the db wins over file storage for the same
      // session id (dual-write during OpenCode's storage migration)
      const dbSessionIds = new Set<string>();
      for (const dbFile of found.dbFiles.sort()) {
        const dbStat = await statInto([dbFile, `${dbFile}-wal`]);
        try {
          const db = await openDb(dbFile);
          try {
            const rows = db
              .prepare(
                'SELECT id FROM session WHERE parent_id IS NULL ORDER BY id',
              )
              .all();
            for (const row of rows) {
              dbSessionIds.add(row.id);
              candidates.push({
                runRef: `${dbFile}${DB_REF_SEP}${row.id}`,
                format: 'opencode-sqlite',
                files: [dbFile],
                ...dbStat,
              });
            }
            for (const row of db
              .prepare('SELECT id FROM session WHERE parent_id IS NOT NULL')
              .all()) {
              dbSessionIds.add(row.id); // children dedupe too
            }
          } finally {
            db.close();
          }
        } catch {
          // Unreadable db — or better-sqlite3 absent, since it is an optional
          // dependency (packages/core/src/sqlite.ts). Either way detect() must
          // not throw: one candidate per db keeps the source visible and lets
          // parse() surface the clear error through reportDiscoveryErrors,
          // while claude-code and otlp candidates are unaffected. Dropping the
          // candidate instead would report "No agent sessions found" and hide
          // the reason.
          candidates.push({
            runRef: dbFile,
            format: 'opencode-sqlite',
            files: [dbFile],
            ...dbStat,
          });
        }
      }

      for (const storageDir of found.storageDirs.sort()) {
        for (const sessionFile of await storageSessionFiles(storageDir)) {
          const sessionId = basename(sessionFile, '.json');
          if (dbSessionIds.has(sessionId)) continue;
          // root candidates only: children join their parent's run
          const json = await readJson(sessionFile, []);
          if (json === undefined || str(json.parentID) !== undefined) continue;
          const files = await storageSessionFileSet(storageDir, sessionFile);
          candidates.push({
            runRef: sessionFile,
            format: 'opencode-storage',
            files,
            ...(await statInto(files)),
          });
        }
      }

      for (const exportFile of found.exportFiles.sort()) {
        candidates.push({
          runRef: exportFile,
          format: 'opencode-export',
          files: [exportFile],
          ...(await statInto([exportFile])),
        });
      }
    }
    return candidates.sort((a, b) =>
      a.runRef < b.runRef ? -1 : a.runRef > b.runRef ? 1 : 0,
    );
  },

  async parse(candidate: Candidate, opts: ParseOptions): Promise<RawRun> {
    const warnings: RunWarning[] = [];

    if (candidate.format === 'opencode-export') {
      const file = candidate.runRef;
      const doc = await readJson(file, warnings);
      const bundle =
        doc === undefined ? undefined : loadExportBundle(file, doc);
      if (bundle === undefined) {
        throw new Error(`not an opencode export document: ${file}`);
      }
      return bundleToRawRun(
        bundle,
        'opencode-export',
        candidate.files,
        warnings,
        opts.redact,
      );
    }

    if (candidate.format === 'opencode-sqlite') {
      const sep = candidate.runRef.lastIndexOf(DB_REF_SEP);
      const dbFile =
        sep < 0 ? candidate.runRef : candidate.runRef.slice(0, sep);
      const sessionId =
        sep < 0 ? undefined : candidate.runRef.slice(sep + DB_REF_SEP.length);
      const db = await openDb(dbFile); // throws the clear, actionable error
      try {
        const rows = db
          .prepare(
            sessionId === undefined
              ? 'SELECT * FROM session WHERE parent_id IS NULL ORDER BY id LIMIT 1'
              : 'SELECT * FROM session WHERE id = ?',
          )
          .all(...(sessionId === undefined ? [] : [sessionId]));
        const row = rows[0];
        if (row === undefined) {
          throw new Error(
            `session not found in ${dbFile}: ${sessionId ?? '(any)'}`,
          );
        }
        const bundle = loadSqliteBundle(db, dbFile, row, warnings);
        return bundleToRawRun(
          bundle,
          'opencode-sqlite',
          candidate.files,
          warnings,
          opts.redact,
        );
      } finally {
        db.close();
      }
    }

    // opencode-storage
    const sessionFile = candidate.runRef;
    const storageDir = dirname(dirname(dirname(sessionFile))); // …/storage/session/<project>/ses.json
    const bundle = await loadStorageBundle(
      storageDir,
      sessionFile,
      warnings,
      new Set(),
    );
    if (bundle === undefined) {
      throw new Error(`unreadable opencode session file: ${sessionFile}`);
    }
    return bundleToRawRun(
      bundle,
      'opencode-storage',
      candidate.files,
      warnings,
      opts.redact,
    );
  },
};
