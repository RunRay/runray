import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isSqliteUnavailable, loadSqlite } from './sqlite.js';

/**
 * Transcript slice reader (add-profiler-depth D4): resolves the raw
 * source-log content behind one span's provenance, so the Inspector can
 * show the full text behind a 200-char preview. Privacy shape:
 *
 * - REDACTION IS ENFORCED HERE, IN CORE: with `redact: true` this function
 *   returns `{status:'redacted'}` BEFORE opening any file — the serving
 *   endpoint cannot leak even if its handler is buggy (AGENTS.md rule 2).
 * - Callers (the CLI server) resolve provenance from their own trusted
 *   TraceFile and never accept client-supplied paths.
 * - Responses are size-capped (1 MB) with a `truncated` flag; missing or
 *   rotated files, busy databases, and unsupported sources return
 *   structured statuses, never a crash.
 */

export interface TranscriptSegment {
  label: string;
  text: string;
}

export type TranscriptSlice =
  | { status: 'ok'; segments: TranscriptSegment[]; truncated: boolean }
  | { status: 'redacted' | 'unsupported' }
  | { status: 'unavailable'; reason: string };

export interface TranscriptProvenance {
  file: string;
  line?: number;
  recordId?: string;
}

export interface TranscriptOptions {
  redact: boolean;
}

const MAX_BYTES = 1024 * 1024;

function unavailable(reason: string): TranscriptSlice {
  return { status: 'unavailable', reason };
}

/** Cap total segment text at MAX_BYTES (UTF-16 length approximation). */
function capSegments(segments: TranscriptSegment[]): TranscriptSlice {
  let budget = MAX_BYTES;
  let truncated = false;
  const out: TranscriptSegment[] = [];
  for (const seg of segments) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    if (seg.text.length > budget) {
      out.push({ label: seg.label, text: seg.text.slice(0, budget) });
      truncated = true;
      budget = 0;
    } else {
      out.push(seg);
      budget -= seg.text.length;
    }
  }
  return { status: 'ok', segments: out, truncated };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

/** Role-labeled segments out of one claude-code JSONL record. */
function claudeRecordSegments(
  record: Record<string, unknown>,
): TranscriptSegment[] {
  const message = isObj(record.message) ? record.message : record;
  const role = typeof message.role === 'string' ? message.role : 'record';
  const content = message.content;
  if (typeof content === 'string') return [{ label: role, text: content }];
  if (!Array.isArray(content)) {
    return [{ label: role, text: JSON.stringify(record, null, 2) }];
  }
  const segments: TranscriptSegment[] = [];
  for (const block of content) {
    if (!isObj(block)) continue;
    switch (block.type) {
      case 'text':
      case 'thinking':
        segments.push({
          label: `${role} ${String(block.type)}`,
          text: asText(block.text ?? block.thinking ?? ''),
        });
        break;
      case 'tool_use':
        segments.push({
          label: `tool_use ${asText(block.name ?? '')}`,
          text: asText(block.input ?? {}),
        });
        break;
      case 'tool_result':
        segments.push({
          label: 'tool_result',
          text: asText(block.content ?? ''),
        });
        break;
      default:
        segments.push({
          label: asText(block.type ?? 'block'),
          text: JSON.stringify(block, null, 2),
        });
    }
  }
  return segments.length > 0
    ? segments
    : [{ label: role, text: JSON.stringify(record, null, 2) }];
}

async function readClaudeSlice(
  provenance: TranscriptProvenance,
): Promise<TranscriptSlice> {
  if (provenance.line === undefined) {
    return unavailable('provenance carries no line number');
  }
  let stream: ReturnType<typeof createReadStream>;
  try {
    statSync(provenance.file);
    stream = createReadStream(provenance.file, { encoding: 'utf8' });
  } catch (err) {
    return unavailable(
      `source log unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo !== provenance.line) continue;
      rl.close();
      try {
        const record: unknown = JSON.parse(line);
        if (!isObj(record)) return unavailable('record is not an object');
        return capSegments(claudeRecordSegments(record));
      } catch {
        return unavailable(`line ${provenance.line} is not valid JSON`);
      }
    }
  } finally {
    rl.close();
    stream.close();
  }
  return unavailable(`line ${provenance.line} is beyond the end of the file`);
}

/** Find a record by id inside an OpenCode export bundle / storage file. */
function findOpencodeRecord(
  doc: unknown,
  recordId: string | undefined,
): Record<string, unknown> | undefined {
  if (!isObj(doc)) return undefined;
  // whole-doc is only correct when no specific record was asked for
  if (recordId === undefined) return doc;
  if (doc.id === recordId) return doc;
  // export bundles carry the session id under `info`, not a top-level id
  if (isObj(doc.info) && doc.info.id === recordId) return doc.info;
  const messages = Array.isArray(doc.messages) ? doc.messages : [];
  for (const m of messages) {
    if (!isObj(m)) continue;
    const info = isObj(m.info) ? m.info : m;
    if (info.id === recordId) return info;
    const parts = Array.isArray(m.parts) ? m.parts : [];
    for (const p of parts) {
      if (isObj(p) && p.id === recordId) return p;
    }
  }
  // recordId given but nothing matched — never fall back to the whole doc
  // (that served up to the 1 MB cap of the entire session as one "record")
  return undefined;
}

function opencodeRecordSegments(
  record: Record<string, unknown>,
): TranscriptSegment[] {
  // storage/export records carry free text in a few known places; fall back
  // to the pretty-printed record so the slice is never empty
  const segments: TranscriptSegment[] = [];
  if (typeof record.text === 'string') {
    segments.push({ label: asText(record.type ?? 'text'), text: record.text });
  }
  const state = isObj(record.state) ? record.state : undefined;
  if (state !== undefined) {
    if (state.input !== undefined) {
      segments.push({ label: 'tool input', text: asText(state.input) });
    }
    if (typeof state.output === 'string') {
      segments.push({ label: 'tool output', text: state.output });
    }
  }
  if (segments.length === 0) {
    segments.push({
      label: asText(record.type ?? record.role ?? 'record'),
      text: JSON.stringify(record, null, 2),
    });
  }
  return segments;
}

async function readOpencodeSlice(
  provenance: TranscriptProvenance,
): Promise<TranscriptSlice> {
  if (provenance.file.endsWith('.db')) {
    return readOpencodeSqliteSlice(provenance);
  }
  let text: string;
  try {
    text = await readFile(provenance.file, 'utf8');
  } catch (err) {
    return unavailable(
      `source file unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const doc: unknown = JSON.parse(text);
    const record = findOpencodeRecord(doc, provenance.recordId);
    if (record === undefined) {
      return unavailable(`record ${provenance.recordId} not found`);
    }
    return capSegments(opencodeRecordSegments(record));
  } catch {
    return unavailable('source file is not valid JSON');
  }
}

async function readOpencodeSqliteSlice(
  provenance: TranscriptProvenance,
): Promise<TranscriptSlice> {
  if (provenance.recordId === undefined) {
    return unavailable('provenance carries no record id');
  }
  try {
    const Database = await loadSqlite<{ data?: string }>();
    // strictly read-only; the database is never created, modified, or locked
    const db = new Database(provenance.file, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      for (const table of ['message', 'part']) {
        const row = db
          .prepare(`SELECT data FROM ${table} WHERE id = ?`)
          .get(provenance.recordId);
        if (row?.data !== undefined) {
          const record: unknown = JSON.parse(row.data);
          if (isObj(record)) {
            return capSegments(opencodeRecordSegments(record));
          }
        }
      }
      return unavailable(`record ${provenance.recordId} not found`);
    } finally {
      db.close();
    }
  } catch (err) {
    // The optional native module is absent — its message already says how to
    // fix it, so it is passed through instead of being framed as a bad db.
    if (isSqliteUnavailable(err)) return unavailable(err.message);
    // SQLITE_BUSY, missing file, foreign schema — structured, never a crash
    return unavailable(
      `database unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve the raw source-log slice behind a span. `sourceTool` is the run's
 * `source.tool`; OTLP imports carry no readable transcript (unsupported).
 */
export async function readTranscriptSlice(
  provenance: TranscriptProvenance,
  sourceTool: string,
  options: TranscriptOptions,
): Promise<TranscriptSlice> {
  // redaction short-circuits BEFORE any file I/O — this is the guarantee
  // the endpoint relies on
  if (options.redact) return { status: 'redacted' };
  switch (sourceTool) {
    case 'claude-code':
      return readClaudeSlice(provenance);
    case 'opencode':
      return readOpencodeSlice(provenance);
    default:
      return { status: 'unsupported' };
  }
}
