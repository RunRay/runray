import { createReadStream, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  Candidate,
  ParseOptions,
  RawRun,
  RawSpan,
  RunWarning,
  SourceAdapter,
} from '../adapter.js';
import { CACHE_WRITE_1H_ATTR } from '../pricing/engine.js';
import { stripBom } from '../text.js';
import { errorPreview, exitCodeOf, isUserRejection } from './error-preview.js';
import { toolTargetAttributes } from './target.js';

/**
 * Claude Code adapter (task 2.2). Storage layout (verified 2026-07 on CC
 * 2.1.138–2.1.197, see docs/02-DATA-MODEL.md Open Q1):
 *
 *   <project-dir>/<session-uuid>.jsonl                           main transcript
 *   <project-dir>/<session-uuid>/subagents/agent-<agentId>.jsonl subagent transcripts
 *   <project-dir>/<session-uuid>/subagents/agent-<agentId>.meta.json sidecar (CC ≥2.2)
 *   <project-dir>/<session-uuid>/subagents/workflows/wf_<id>/    workflow agents (v0.1: skipped)
 *
 * Parent-child joins, in precedence order (verified 2026-08 on CC 2.2.x):
 * 1. `toolUseResult.agentId` on a tool-result record — synchronous `Agent`
 *    calls AND forked skills (`status: 'forked'` on e.g. a `Skill` result).
 * 2. The `agent-<id>.meta.json` sidecar — background agents leave NO
 *    agentId on any tool result; the sidecar carries `toolUseId` (the
 *    spawning tool_use) and `parentAgentId` (enclosing agent for nested
 *    spawns), plus `name`/`agentType`/`description` for labeling.
 * Legacy sessions (`Task` tool / `isSidechain: true`) parse flat with a
 * run warning.
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
function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.max(0, Math.round(v))
    : 0;
}
function lineCount(v: unknown): number {
  const s = str(v);
  return s ? s.split('\n').length : 0;
}
/** First human-readable text of a content value (string or block array). */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (isObj(block) && block.type === 'text') {
      const t = str(block.text);
      if (t !== undefined) return t;
    }
  }
  return undefined;
}
function byteLength(content: unknown): number | undefined {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (!Array.isArray(content)) return undefined;
  let total = 0;
  for (const block of content) {
    if (isObj(block) && typeof block.text === 'string') {
      total += Buffer.byteLength(block.text, 'utf8');
    }
  }
  return total;
}
function durationBetween(
  startedAt: string,
  endedAt: string | undefined,
): number | undefined {
  if (endedAt === undefined) return undefined;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/**
 * Code-change counts for file-modifying tools, derived from tool_use input
 * strings (newline positions survive fixture scrubbing, unlike diff markers).
 * Approximation by design: `replace_all` multi-occurrence edits count once,
 * and overwriting Write reports only added lines (the old size is unknown).
 */
function codeChangeCounts(
  toolName: string,
  input: Json,
): { linesAdded?: number; linesRemoved?: number } {
  switch (toolName) {
    case 'Edit':
      return {
        linesAdded: lineCount(input.new_string),
        linesRemoved: lineCount(input.old_string),
      };
    case 'MultiEdit': {
      let added = 0;
      let removed = 0;
      if (Array.isArray(input.edits)) {
        for (const e of input.edits) {
          if (!isObj(e)) continue;
          added += lineCount(e.new_string);
          removed += lineCount(e.old_string);
        }
      }
      return { linesAdded: added, linesRemoved: removed };
    }
    case 'Write':
      return { linesAdded: lineCount(input.content) };
    case 'NotebookEdit':
      return { linesAdded: lineCount(input.new_source) };
    default:
      return {};
  }
}

interface ToolUseRef {
  id: string;
  name: string;
  input: Json;
  line: number;
  timestamp: string;
}
interface ToolResultRef {
  timestamp: string;
  line: number;
  isError: boolean;
  outputBytes: number | undefined;
  /** PREVIEW_CHARS of an error result's text starting where the failure is
   * named (error-preview.ts) — the one thing a retry-loop or dead-end
   * finding can quote; prompt-derived, so it goes through the
   * content/redaction contract like every preview. */
  errorPreview: string | undefined;
  /** `Exit code N` parsed from a shell tool's failure text. */
  exitCode: number | undefined;
  /** The "failure" is the harness reporting that the person declined the
   * call — a decision, not an error (spec: "User-rejected tool calls"). */
  rejected: boolean;
  toolUseResult: Json | undefined;
}
/** One llm_call — assistant JSONL records sharing a message.id (Claude Code
 * writes one record per content block, each repeating the same usage; naive
 * per-record counting would double tokens). */
interface LlmGroup {
  key: string;
  parentUuid: string | null;
  line: number;
  startedAt: string;
  endedAt: string;
  model: string | undefined;
  stopReason: string | undefined;
  usage: Json | undefined;
  isApiError: boolean;
  outputPreview: string | undefined;
  toolUses: ToolUseRef[];
}
interface Transcript {
  groups: LlmGroup[];
  results: Map<string, ToolResultRef>;
  userText: Map<string, string>;
  sessionId: string | undefined;
  cwd: string | undefined;
  gitBranch: string | undefined;
  aiTitle: string | undefined;
  customTitle: string | undefined;
  legacy: boolean;
  firstTs: string | undefined;
}

async function collectTranscript(
  file: string,
  warnings: RunWarning[],
): Promise<Transcript> {
  const t: Transcript = {
    groups: [],
    results: new Map(),
    userText: new Map(),
    sessionId: undefined,
    cwd: undefined,
    gitBranch: undefined,
    aiTitle: undefined,
    customTitle: undefined,
    legacy: false,
    firstTs: undefined,
  };
  const byKey = new Map<string, LlmGroup>();
  const rl = createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  });
  let line = 0;
  for await (const raw of rl) {
    line++;
    if (raw.trim() === '') continue;
    let rec: unknown;
    try {
      // Only the first line can carry a byte-order mark, and JSON.parse
      // rejects it — a transcript re-saved by an editor or a shell redirect
      // would otherwise lose its first record.
      rec = JSON.parse(line === 1 ? stripBom(raw) : raw);
    } catch {
      warnings.push({ message: 'unparseable JSONL line', file, line });
      continue;
    }
    if (!isObj(rec)) continue;
    const type = str(rec.type);
    if (
      type === 'x-runray-scrub' ||
      type === 'x-tracepulse-scrub' ||
      type === 'x-tracellm-scrub'
    )
      continue; // fixture marker
    const ts = str(rec.timestamp);
    if (ts !== undefined && t.firstTs === undefined) t.firstTs = ts;
    if (rec.isSidechain === true) t.legacy = true;
    if (t.sessionId === undefined) t.sessionId = str(rec.sessionId);
    if (t.cwd === undefined) t.cwd = str(rec.cwd);
    if (t.gitBranch === undefined) t.gitBranch = str(rec.gitBranch);

    if (type === 'assistant') {
      const msg = isObj(rec.message) ? rec.message : undefined;
      if (!msg) continue;
      const uuid = str(rec.uuid) ?? `rec-${line}`;
      const key = str(msg.id) ?? uuid;
      let g = byKey.get(key);
      if (!g) {
        g = {
          key,
          parentUuid: str(rec.parentUuid) ?? null,
          line,
          startedAt: ts ?? EPOCH,
          endedAt: ts ?? EPOCH,
          model: undefined,
          stopReason: undefined,
          usage: undefined,
          isApiError: false,
          outputPreview: undefined,
          toolUses: [],
        };
        byKey.set(key, g);
        t.groups.push(g);
      }
      if (ts !== undefined) g.endedAt = ts;
      g.model ??= str(msg.model);
      g.stopReason = str(msg.stop_reason) ?? g.stopReason;
      if (isObj(msg.usage)) g.usage = msg.usage;
      if (rec.isApiErrorMessage === true) g.isApiError = true;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!isObj(block)) continue;
          if (block.type === 'text' && g.outputPreview === undefined) {
            g.outputPreview = str(block.text)?.slice(0, PREVIEW_CHARS);
          } else if (block.type === 'tool_use') {
            const id = str(block.id);
            if (id === undefined) continue;
            g.toolUses.push({
              id,
              name: str(block.name) ?? 'unknown',
              input: isObj(block.input) ? block.input : {},
              line,
              timestamp: ts ?? g.startedAt,
            });
          }
        }
      }
    } else if (type === 'user') {
      const uuid = str(rec.uuid);
      const msg = isObj(rec.message) ? rec.message : undefined;
      const content = msg?.content;
      const text = textOf(content);
      if (uuid !== undefined && text !== undefined) t.userText.set(uuid, text);
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isObj(block) || block.type !== 'tool_result') continue;
          const toolUseId = str(block.tool_use_id);
          if (toolUseId === undefined) continue;
          const failureText =
            block.is_error === true ? textOf(block.content) : undefined;
          t.results.set(toolUseId, {
            timestamp: ts ?? EPOCH,
            line,
            isError: block.is_error === true,
            outputBytes: byteLength(block.content),
            errorPreview: errorPreview(failureText, PREVIEW_CHARS),
            exitCode: exitCodeOf(failureText),
            rejected: isUserRejection(failureText),
            toolUseResult: isObj(rec.toolUseResult)
              ? rec.toolUseResult
              : undefined,
          });
        }
      }
    } else if (type === 'ai-title') {
      t.aiTitle = str(rec.aiTitle) ?? t.aiTitle;
    } else if (type === 'custom-title') {
      t.customTitle = str(rec.customTitle) ?? t.customTitle;
    }
    // other record types (system, attachment, mode, queue-operation, …) carry
    // no span-relevant data in v0.1 and are skipped silently
  }
  return t;
}

function mapAgentStatus(result: ToolResultRef | undefined): RawSpan['status'] {
  if (!result) return 'in_progress';
  if (result.rejected) return 'cancelled';
  if (result.isError) return 'error';
  const s = str(result.toolUseResult?.status)?.toLowerCase();
  if (s === undefined) return 'ok';
  if (s.includes('error') || s.includes('fail')) return 'error';
  if (s.includes('cancel')) return 'cancelled';
  if (
    s.includes('running') ||
    s.includes('progress') ||
    s.includes('pending')
  ) {
    return 'in_progress';
  }
  return 'ok';
}

/** Outcome derivable from a transcript alone — the only signal a
 * background/forked agent leaves: its spawn ack (or sidecar) records no
 * result, but the transcript knows when the last call ended and whether
 * any API call errored. */
function transcriptOutcome(t: Transcript): {
  endedAt?: string;
  error: boolean;
} {
  let endedAt: string | undefined;
  let error = false;
  for (const g of t.groups) {
    if (endedAt === undefined || g.endedAt > endedAt) endedAt = g.endedAt;
    if (g.isApiError) error = true;
  }
  return { ...(endedAt === undefined ? {} : { endedAt }), error };
}

interface ParseContext {
  spans: RawSpan[];
  warnings: RunWarning[];
  fileByAgentId: Map<string, string>;
  visited: Set<string>;
  /** Agent ids that already own a subagent span — a later tool result
   * echoing a known agentId (status update, batched results sharing one
   * record-level toolUseResult) must never emit a second span. */
  agentIds: Set<string>;
  /** The session's main transcript: isSidechain records mark the LEGACY
   * era only here — modern agent transcripts carry isSidechain on every
   * record and must not trip the legacy warning. */
  mainFile: string;
  redact: boolean;
  legacy: boolean;
}

function usageTokens(usage: Json | undefined): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const cc = usage?.cache_creation;
  const byTtl = isObj(cc)
    ? int(cc.ephemeral_5m_input_tokens) + int(cc.ephemeral_1h_input_tokens)
    : 0;
  return {
    input: int(usage?.input_tokens),
    output: int(usage?.output_tokens),
    cacheRead: int(usage?.cache_read_input_tokens),
    // the flat total is authoritative, but a record can carry only the TTL
    // breakdown — a present breakdown must never price as a zero write
    cacheWrite: Math.max(int(usage?.cache_creation_input_tokens), byTtl),
  };
}

/** 1-hour-TTL share of the cache write, from `usage.cache_creation`. The
 * schema's token quad is frozen, so the split rides in span attributes
 * (CACHE_WRITE_1H_ATTR) for the cost engine — writes with a 1h TTL bill at
 * a higher rate than the default 5m. Capped at the reported total. */
function cacheWrite1hAttr(
  usage: Json | undefined,
  cacheWrite: number,
): Record<string, number> {
  const cc = usage?.cache_creation;
  const oneHour = Math.min(
    isObj(cc) ? int(cc.ephemeral_1h_input_tokens) : 0,
    cacheWrite,
  );
  return oneHour > 0 ? { [CACHE_WRITE_1H_ATTR]: oneHour } : {};
}

/** Redaction happens here in core: with redact, prompt-derived fields become null. */
function contentField(
  ctx: ParseContext,
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

async function emitFromTranscript(
  t: Transcript,
  file: string,
  ownerSpanId: string,
  ctx: ParseContext,
): Promise<void> {
  // isSidechain marks the LEGACY era only in the MAIN transcript — modern
  // (CC ≥2.2) agent transcripts carry isSidechain: true on every record,
  // and a correctly nested run must not be branded "parsed flat"
  if (t.legacy && file === ctx.mainFile) ctx.legacy = true;

  for (const g of t.groups) {
    const promptPreview =
      g.parentUuid !== null
        ? t.userText.get(g.parentUuid)?.slice(0, PREVIEW_CHARS)
        : undefined;
    const tokens = usageTokens(g.usage);
    ctx.spans.push({
      id: g.key,
      parentId: ownerSpanId,
      kind: 'llm_call',
      name: g.model ?? 'unknown',
      status: g.isApiError ? 'error' : 'ok',
      startedAt: g.startedAt,
      endedAt: g.endedAt,
      durationMs: durationBetween(g.startedAt, g.endedAt),
      llm: {
        provider: 'anthropic',
        model: g.model ?? 'unknown',
        tokens,
        // cost is never taken from the source — the cost engine (task 2.5)
        // computes it and flips costSource to 'computed'
        costSource: 'unknown',
        ...(g.stopReason === undefined ? {} : { stopReason: g.stopReason }),
      },
      content: contentField(ctx, {
        promptPreview,
        outputPreview: g.outputPreview,
      }),
      attributes: cacheWrite1hAttr(g.usage, tokens.cacheWrite),
      provenance: { file, line: g.line },
    });

    for (const tu of g.toolUses) {
      if (tu.name === 'Task') ctx.legacy = true;
      const result = t.results.get(tu.id);
      const mcpServer = tu.name.startsWith('mcp__')
        ? tu.name.split('__')[1]
        : undefined;
      const succeeded = result !== undefined && !result.isError;
      const counts = succeeded ? codeChangeCounts(tu.name, tu.input) : {};
      const endedAt = result?.timestamp;
      ctx.spans.push({
        id: tu.id,
        parentId: g.key,
        kind: mcpServer === undefined ? 'tool_call' : 'mcp_call',
        name: tu.name,
        // a declined call is the person's decision, not the tool failing:
        // `cancelled` keeps it out of toolErrors and every failure rule
        status:
          result === undefined
            ? 'in_progress'
            : result.rejected
              ? 'cancelled'
              : result.isError
                ? 'error'
                : 'ok',
        ...(result?.rejected ? { statusReason: 'user-rejected' } : {}),
        startedAt: tu.timestamp,
        ...(endedAt === undefined ? {} : { endedAt }),
        durationMs: durationBetween(tu.timestamp, endedAt),
        tool: {
          name: tu.name,
          isError: result?.isError === true && !result.rejected,
          ...(mcpServer === undefined ? {} : { mcpServer }),
          ...(result?.exitCode === undefined
            ? {}
            : { exitCode: result.exitCode }),
          ...(result?.outputBytes === undefined
            ? {}
            : { outputBytes: result.outputBytes }),
          ...counts,
        },
        // only a failure's text is kept: successful outputs are sized, not
        // previewed (a file's first 200 chars would be noise in every span)
        ...(result?.isError
          ? {
              content: contentField(ctx, {
                outputPreview: result.errorPreview,
              }),
            }
          : {}),
        attributes: toolTargetAttributes(
          'claude-code',
          tu.name,
          tu.input,
          ctx.redact,
        ),
        provenance: { file, line: tu.line },
      });

      // Agent calls always delegate; any OTHER tool whose result carries an
      // agentId forked an agent too (e.g. Skill → status:'forked') — the
      // old name gate silently dropped those subtrees and their cost
      if (
        tu.name === 'Agent' ||
        str(result?.toolUseResult?.agentId) !== undefined
      ) {
        await emitSubagent(tu, result, file, ctx);
      }
    }
  }
}

async function emitSubagent(
  tu: ToolUseRef,
  result: ToolResultRef | undefined,
  file: string,
  ctx: ParseContext,
): Promise<void> {
  const agentId = str(result?.toolUseResult?.agentId);
  if (agentId !== undefined) {
    // a later result echoing a known agentId (status update, or several
    // batched tool_result blocks sharing one record-level toolUseResult)
    // must not emit a second span with the same id
    if (ctx.agentIds.has(agentId)) return;
    ctx.agentIds.add(agentId);
  }
  const subagentType =
    str(tu.input.subagent_type) ??
    str(result?.toolUseResult?.commandName) ??
    'unknown';
  const spanId = agentId ?? `${tu.id}:agent`;
  const childPath =
    agentId === undefined ? undefined : ctx.fileByAgentId.get(agentId);
  const child =
    childPath !== undefined && !ctx.visited.has(childPath)
      ? await collectTranscript(childPath, ctx.warnings)
      : undefined;
  // a fork's tool result is just the spawn ack — the transcript is the
  // only witness of when the agent ended and whether it errored
  const isFork = str(result?.toolUseResult?.status)?.toLowerCase() === 'forked';
  const outcome =
    isFork && child !== undefined ? transcriptOutcome(child) : undefined;
  const endedAt = outcome?.endedAt ?? result?.timestamp;
  ctx.spans.push({
    id: spanId,
    parentId: tu.id,
    kind: 'subagent',
    name: `subagent:${subagentType}`,
    status: outcome?.error === true ? 'error' : mapAgentStatus(result),
    startedAt: tu.timestamp,
    ...(endedAt === undefined ? {} : { endedAt }),
    durationMs: durationBetween(tu.timestamp, endedAt),
    agent: {
      name: subagentType,
      ...(agentId === undefined ? {} : { sessionId: agentId }),
    },
    content: contentField(ctx, { delegationReason: str(tu.input.description) }),
    attributes: {},
    provenance: { file, line: tu.line },
  });

  if (agentId === undefined) return;
  if (childPath === undefined) {
    ctx.warnings.push({
      message: `subagent transcript not found for agentId ${agentId}`,
      file,
      line: tu.line,
    });
    return;
  }
  if (child === undefined) return; // transcript already visited elsewhere
  ctx.visited.add(childPath);
  await emitFromTranscript(child, childPath, spanId, ctx);
}

interface AgentMeta {
  name?: string;
  agentType?: string;
  description?: string;
  toolUseId?: string;
  parentAgentId?: string;
}

async function readAgentMeta(
  transcript: string,
): Promise<AgentMeta | undefined> {
  const metaPath = transcript.replace(/\.jsonl$/, '.meta.json');
  try {
    const raw: unknown = JSON.parse(await readFile(metaPath, 'utf8'));
    if (!isObj(raw)) return undefined;
    return {
      name: str(raw.name),
      agentType: str(raw.agentType),
      description: str(raw.description),
      toolUseId: str(raw.toolUseId),
      parentAgentId: str(raw.parentAgentId),
    };
  } catch {
    return undefined; // no sidecar (older CC) or unreadable — not an error
  }
}

/**
 * Adopt transcripts whose parent-child join lives in a `.meta.json`
 * sidecar: background agents leave no `toolUseResult.agentId` anywhere in
 * the spawning transcript. Anchor precedence: `toolUseId` (the spawning
 * tool_use span) then `parentAgentId` (the enclosing agent's span for
 * nested spawns). Adoption iterates to a fixpoint in sorted agent-id order
 * so children adopt after their parents, deterministically; entries whose
 * file gets visited mid-loop (a tool result inside an adopted transcript
 * linked them first) are pruned, never adopted twice. Transcripts with no
 * sidecar or no resolvable anchor stay unlinked (run warning).
 */
async function adoptMetaLinkedAgents(ctx: ParseContext): Promise<void> {
  const unvisited = [...ctx.fileByAgentId]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .filter(([, file]) => !ctx.visited.has(file));
  const metas = await Promise.all(
    unvisited.map(([, file]) => readAgentMeta(file)),
  );
  const pending = new Map<string, { file: string; meta: AgentMeta }>();
  unvisited.forEach(([agentId, file], i) => {
    const meta = metas[i];
    if (meta !== undefined) pending.set(agentId, { file, meta });
  });

  // spans are append-only, so the anchor index grows with a cursor instead
  // of being rebuilt per adoption (that was O(agents × spans))
  const byId = new Map<string, RawSpan>();
  let indexed = 0;
  const reindex = () => {
    for (; indexed < ctx.spans.length; indexed++) {
      const s = ctx.spans[indexed] as RawSpan;
      byId.set(s.id, s);
    }
  };

  while (pending.size > 0) {
    reindex();
    let adopted: string | undefined;
    for (const [agentId, { file, meta }] of [...pending].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      // linked mid-loop by a tool result inside an adopted transcript —
      // the record join won; adopting again would duplicate the subtree
      if (ctx.visited.has(file) || ctx.agentIds.has(agentId)) {
        pending.delete(agentId);
        continue;
      }
      const anchor =
        (meta.toolUseId === undefined ? undefined : byId.get(meta.toolUseId)) ??
        (meta.parentAgentId === undefined
          ? undefined
          : byId.get(meta.parentAgentId));
      if (anchor === undefined) continue;
      const t = await collectTranscript(file, ctx.warnings);
      const agentName = meta.name ?? meta.agentType ?? 'unknown';
      const outcome = transcriptOutcome(t);
      const startedAt = t.firstTs ?? anchor.startedAt;
      const span: RawSpan = {
        id: agentId,
        parentId: anchor.id,
        kind: 'subagent',
        name: `subagent:${agentName}`,
        // the sidecar records no outcome — the transcript is the witness:
        // an API-error group marks the container failed, otherwise ok
        status: outcome.error ? 'error' : 'ok',
        startedAt,
        ...(outcome.endedAt === undefined ? {} : { endedAt: outcome.endedAt }),
        durationMs: durationBetween(startedAt, outcome.endedAt),
        agent: { name: agentName, sessionId: agentId },
        content: contentField(ctx, { delegationReason: meta.description }),
        attributes: {},
        provenance: { file, line: 1 },
      };
      // claim the placeholder emitSubagent left for a resultless Agent
      // call — this adoption IS that delegation, not a sibling of it
      const phantomIdx =
        meta.toolUseId === undefined
          ? -1
          : ctx.spans.findIndex(
              (s) =>
                s.id === `${meta.toolUseId}:agent` && s.kind === 'subagent',
            );
      if (phantomIdx !== -1) {
        ctx.spans[phantomIdx] = span;
        byId.set(agentId, span); // the cursor already passed that slot
      } else {
        ctx.spans.push(span);
      }
      ctx.agentIds.add(agentId);
      ctx.visited.add(file);
      await emitFromTranscript(t, file, agentId, ctx);
      adopted = agentId;
      break; // re-scan with the extended index — nested agents may anchor now
    }
    if (adopted === undefined) return; // fixpoint: nothing left resolvable
    pending.delete(adopted);
  }
}

/** Containers must cover their children (async agents outlive their tool result). */
function extendContainerEnds(spans: RawSpan[]): void {
  const byId = new Map(spans.map((s) => [s.id, s]));
  for (const span of spans) {
    const end = span.endedAt ?? span.startedAt;
    let parentId = span.parentId;
    while (parentId !== null) {
      const parent = byId.get(parentId);
      if (!parent) break;
      if (
        (parent.kind === 'subagent' || parent.kind === 'session') &&
        (parent.endedAt ?? parent.startedAt) < end
      ) {
        parent.endedAt = end;
        parent.durationMs = durationBetween(parent.startedAt, end);
      }
      parentId = parent.parentId;
    }
  }
}

const AGENT_FILE_RE = /^agent-([A-Za-z0-9]+)\.jsonl$/;
const AGENT_META_RE = /^agent-[A-Za-z0-9]+\.meta\.json$/;

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function findAgentTranscripts(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await safeReaddir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findAgentTranscripts(path)));
    // .meta.json sidecars are provenance too: parse() reads them and they
    // decide whether whole subtrees exist, so they must count toward the
    // candidate's file set, size, and freshness
    else if (AGENT_FILE_RE.test(entry.name) || AGENT_META_RE.test(entry.name))
      out.push(path);
    // journal.jsonl (workflow metadata) is deliberately skipped — task 1.4 decision
  }
  return out.sort();
}

function defaultRoots(): string[] {
  return [join(homedir(), '.claude', 'projects')];
}

function looksLikeOtlp(file: string): boolean {
  try {
    return readFileSync(file, { encoding: 'utf8', flag: 'r' })
      .slice(0, 1024)
      .includes('"resourceSpans"');
  } catch {
    return false;
  }
}

export const claudeCodeAdapter: SourceAdapter = {
  id: 'claude-code',

  defaultRoots,

  async detect(roots: string[]): Promise<Candidate[]> {
    const scanRoots = roots.length > 0 ? roots : defaultRoots();
    const candidates: Candidate[] = [];
    for (const root of scanRoots) {
      const dirs = [root];
      for (const entry of await safeReaddir(root)) {
        if (entry.isDirectory()) dirs.push(join(root, entry.name));
      }
      for (const dir of dirs) {
        for (const entry of await safeReaddir(dir)) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          if (AGENT_FILE_RE.test(entry.name) || entry.name === 'journal.jsonl')
            continue;
          const sessionFile = join(dir, entry.name);
          if (looksLikeOtlp(sessionFile)) continue;

          const sessionDir = join(dir, entry.name.slice(0, -'.jsonl'.length));
          const files = [
            sessionFile,
            ...(await findAgentTranscripts(join(sessionDir, 'subagents'))),
          ];
          let mtimeMs = 0;
          let sizeBytes = 0;
          for (const f of files) {
            try {
              const s = await stat(f);
              mtimeMs = Math.max(mtimeMs, s.mtimeMs);
              sizeBytes += s.size;
            } catch {
              // unreadable child transcript: still listed; parse() will warn
            }
          }
          candidates.push({
            runRef: sessionFile,
            format: 'claude-jsonl',
            files,
            mtimeMs,
            sizeBytes,
          });
        }
      }
    }
    return candidates.sort((a, b) =>
      a.runRef < b.runRef ? -1 : a.runRef > b.runRef ? 1 : 0,
    );
  },

  async parse(candidate: Candidate, opts: ParseOptions): Promise<RawRun> {
    const warnings: RunWarning[] = [];
    const fileByAgentId = new Map<string, string>();
    for (const f of candidate.files) {
      const m = AGENT_FILE_RE.exec(basename(f));
      if (m?.[1] !== undefined) fileByAgentId.set(m[1], f);
    }
    const mainFile = candidate.runRef;
    const ctx: ParseContext = {
      spans: [],
      warnings,
      fileByAgentId,
      visited: new Set([mainFile]),
      agentIds: new Set(),
      mainFile,
      redact: opts.redact,
      legacy: false,
    };

    const main = await collectTranscript(mainFile, warnings);
    const sessionId = main.sessionId ?? basename(mainFile, '.jsonl');
    const sessionSpan: RawSpan = {
      id: sessionId,
      parentId: null,
      kind: 'session',
      name: 'session',
      status: 'ok',
      startedAt: main.firstTs ?? EPOCH,
      agent: { sessionId },
      attributes: {},
      provenance: { file: mainFile, line: 1 },
    };
    ctx.spans.push(sessionSpan);
    await emitFromTranscript(main, mainFile, sessionSpan.id, ctx);

    if (ctx.legacy) {
      warnings.unshift({
        message:
          'legacy subagent format detected (Task tool / isSidechain records) — spans parsed flat, nesting unsupported in v0.1',
        file: mainFile,
      });
    }
    await adoptMetaLinkedAgents(ctx);

    const unlinked = [...fileByAgentId.values()].filter(
      (f) => !ctx.visited.has(f),
    );
    if (unlinked.length > 0) {
      warnings.push({
        message: `${unlinked.length} subagent transcript(s) not linked by any tool result or .meta.json sidecar (workflow agents; skipped in v0.1)`,
        file: mainFile,
      });
    }
    extendContainerEnds(ctx.spans);

    const title = ctx.redact ? undefined : (main.customTitle ?? main.aiTitle);
    return {
      source: {
        tool: 'claude-code',
        format: 'claude-jsonl',
        files: candidate.files,
      },
      ...(title === undefined ? {} : { title }),
      ...(main.cwd === undefined
        ? {}
        : {
            project: {
              // A drive-root cwd has no basename on win32, and an empty
              // name collides with the UI 'all projects' sentinel, so the
              // run would disappear from the project filter.
              name: basename(main.cwd) || main.cwd,
              path: main.cwd,
              ...(main.gitBranch === undefined
                ? {}
                : { gitBranch: main.gitBranch }),
            },
          }),
      spans: ctx.spans,
      warnings,
    };
  },
};
