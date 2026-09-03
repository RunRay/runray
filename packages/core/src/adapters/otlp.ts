import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
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

/**
 * OTLP adapter (task 2.8, best-effort by design — trace-ingestion spec).
 * Imports OTLP/JSON trace documents ({ resourceSpans: [...] } — an OTel
 * Collector file-exporter line or a `scripts/otlp-sink.mjs` capture), groups
 * spans into runs by `session.id`, and passes `gen_ai.*` attributes through
 * unchanged. There is NO zero-config location — OTLP is the explicit-path
 * power-user import (ADR-3), so detect() without roots finds nothing.
 *
 * Claude Code beta span names are pinned via the fixtures in
 * `fixtures/otlp/claude-traces-beta/` (CC 2.1.81, scope
 * com.anthropic.claude_code.tracing@1.0.0):
 *
 *   claude_code.interaction            → turn        (root, one per prompt)
 *   claude_code.llm_request            → llm_call    (tokens in BESPOKE attrs
 *     input_tokens/output_tokens/cache_read_tokens/cache_creation_tokens —
 *     gen_ai.usage.* is absent; the mapper prefers the standard keys and
 *     falls back to the pinned bespoke ones)
 *   claude_code.tool                   → tool_call/mcp_call (tool_name)
 *   claude_code.tool.blocked_on_user   → other       (permission-wait phase)
 *   claude_code.tool.execution         → other       (execution phase)
 *   claude_code.hook                   → hook
 *
 * Anything unrecognized degrades to `kind: other` with provenance — the
 * import never fails on shape. Subagent nesting needs no synthesis: the
 * parent links carry it (a subagent's spans nest under the spawning tool's
 * execution span), and dangling parentSpanIds fall to the normalizer's Flat
 * Trace Fallback. Privacy: only `gen_ai.*` enters `attributes`; identity
 * attrs (user.*, organization.id) are dropped and `user_prompt` maps to the
 * redactable `content.promptPreview`. Span events are skipped in v0.1 (they
 * can carry full tool I/O under OTEL_LOG_TOOL_CONTENT).
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

/** Decode an OTLP AnyValue to plain JSON (int64 arrives as string OR number). */
function anyValue(v: unknown): unknown {
  if (!isObj(v)) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : v.intValue;
  }
  if ('doubleValue' in v) return v.doubleValue;
  if ('arrayValue' in v && isObj(v.arrayValue)) {
    const values = v.arrayValue.values;
    return Array.isArray(values) ? values.map(anyValue) : [];
  }
  if ('kvlistValue' in v && isObj(v.kvlistValue)) {
    const values = v.kvlistValue.values;
    const out: Json = {};
    if (Array.isArray(values)) {
      for (const kv of values) {
        if (isObj(kv) && typeof kv.key === 'string')
          out[kv.key] = anyValue(kv.value);
      }
    }
    return out;
  }
  return undefined;
}

function attrsToMap(attrs: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!Array.isArray(attrs)) return map;
  for (const a of attrs) {
    if (isObj(a) && typeof a.key === 'string')
      map.set(a.key, anyValue(a.value));
  }
  return map;
}

function attrStr(attrs: Map<string, unknown>, key: string): string | undefined {
  return str(attrs.get(key));
}
function attrInt(attrs: Map<string, unknown>, key: string): number {
  const v = attrs.get(key);
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.max(0, Math.round(v))
    : 0;
}
function attrNum(attrs: Map<string, unknown>, key: string): number | undefined {
  const v = attrs.get(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** int64 nanos arrive as strings beyond 2^53 — convert via BigInt, not Number. */
function nanoToIso(nano: unknown): string | undefined {
  const s =
    typeof nano === 'string'
      ? nano
      : typeof nano === 'number'
        ? String(nano)
        : undefined;
  if (s === undefined || !/^\d+$/.test(s)) return undefined;
  return new Date(Number(BigInt(s) / 1_000_000n)).toISOString();
}

function durationBetween(
  startedAt: string,
  endedAt: string | undefined,
): number | undefined {
  if (endedAt === undefined) return undefined;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

interface OtlpSpan {
  json: Json;
  attrs: Map<string, unknown>;
  groupKey: string;
}

/** Flatten resourceSpans → spans with their attribute maps and group keys. */
function collectSpans(
  doc: Json,
  file: string,
  warnings: RunWarning[],
): OtlpSpan[] {
  const out: OtlpSpan[] = [];
  const resourceSpans = doc.resourceSpans;
  if (!Array.isArray(resourceSpans)) return out;
  for (const rs of resourceSpans) {
    if (!isObj(rs)) continue;
    const scopeSpans = rs.scopeSpans ?? rs.instrumentationLibrarySpans;
    if (!Array.isArray(scopeSpans)) continue;
    for (const ss of scopeSpans) {
      if (!isObj(ss) || !Array.isArray(ss.spans)) continue;
      for (const span of ss.spans) {
        if (!isObj(span) || typeof span.spanId !== 'string') {
          warnings.push({ message: 'span without spanId skipped', file });
          continue;
        }
        const attrs = attrsToMap(span.attributes);
        const sessionId = attrStr(attrs, 'session.id');
        const groupKey = sessionId ?? `trace:${str(span.traceId) ?? 'unknown'}`;
        out.push({ json: span, attrs, groupKey });
      }
    }
  }
  return out;
}

function collectMetricSessions(doc: Json): string[] {
  const sessions = new Set<string>();
  const resourceMetrics = doc.resourceMetrics;
  if (!Array.isArray(resourceMetrics)) return [];
  for (const rm of resourceMetrics) {
    if (!isObj(rm)) continue;
    const scopeMetrics = rm.scopeMetrics ?? rm.instrumentationLibraryMetrics;
    if (!Array.isArray(scopeMetrics)) continue;
    for (const sm of scopeMetrics) {
      if (!isObj(sm) || !Array.isArray(sm.metrics)) continue;
      for (const m of sm.metrics) {
        if (!isObj(m)) continue;
        const metric = m as Json;
        const sums = isObj(metric.sum)
          ? metric.sum.dataPoints
          : isObj(metric.histogram)
            ? metric.histogram.dataPoints
            : isObj(metric.gauge)
              ? metric.gauge.dataPoints
              : [];
        if (!Array.isArray(sums)) continue;
        for (const dp of sums) {
          if (!isObj(dp)) continue;
          const attrs = attrsToMap(dp.attributes);
          const sessionId = attrStr(attrs, 'session.id');
          if (sessionId) sessions.add(sessionId);
        }
      }
    }
  }
  return [...sessions];
}

/** Pinned Claude Code beta names → span kinds; everything else → other. */
function kindOf(name: string, toolName: string | undefined): RawSpan['kind'] {
  switch (name) {
    case 'claude_code.interaction':
    case 'opencode.session':
      return 'turn';
    case 'claude_code.llm_request':
    case 'opencode.llm':
      return 'llm_call';
    case 'claude_code.tool':
      return toolName?.startsWith('mcp__') === true ? 'mcp_call' : 'tool_call';
    case 'claude_code.hook':
      return 'hook';
    default:
      if (
        name.startsWith('claude_code.tool_') ||
        name.startsWith('opencode.tool.')
      )
        return 'tool_call';
      return 'other';
  }
}

function statusOf(span: Json, attrs: Map<string, unknown>): RawSpan['status'] {
  const code = isObj(span.status) ? span.status.code : undefined;
  if (code === 2) return 'error';
  if (attrs.get('success') === false) return 'error';
  return 'ok';
}

/** runray.* / tracepulse.* keys that are pure identity/metadata (safe under --redact);
 * `runray.target` / `tracepulse.target` is a display token and counts as content, so it is
 * dropped when redacting, exactly like an adapter's own target display. */
const REDACT_SAFE_RUNRAY = new Set([
  'runray.targetKey',
  'runray.targetKind',
  'runray.mcpDetection',
  'tracepulse.targetKey',
  'tracepulse.targetKind',
  'tracepulse.mcpDetection',
  // token count, never content. NOTE: passthrough only — this adapter never
  // DERIVES the 5m/1h split from plain cache-write counts, so an OTLP
  // capture whose emitter omits the split prices 1h writes at the 5m rate
  // and reads lower than the same session parsed from its JSONL transcript.
  CACHE_WRITE_1H_ATTR,
]);

/** gen_ai.* passthrough — keys and values unchanged (values decoded from the
 * OTLP AnyValue envelope; that encoding is transport, not data). Under
 * redaction, runray.* / tracepulse.* is filtered to the identity allowlist so an emitter's
 * `runray.target` display text never survives --redact (privacy is enforced
 * in core, not the UI). */
function genAiAttributes(attrs: Map<string, unknown>, redact: boolean): Json {
  const out: Json = {};
  for (const [key, value] of attrs) {
    if (value === undefined) continue;
    if (key.startsWith('gen_ai.')) {
      out[key] = value;
    } else if (key.startsWith('runray.') || key.startsWith('tracepulse.')) {
      // reserved prefix survives passthrough (X2), but redaction keeps only
      // identity keys — never the display token or any other content key
      if (!redact || REDACT_SAFE_RUNRAY.has(key)) out[key] = value;
    }
  }
  return out;
}

function toRawSpan(
  otlp: OtlpSpan,
  sessionRootId: string,
  file: string,
  redact: boolean,
): RawSpan {
  const span = otlp.json;
  const attrs = otlp.attrs;
  const name = str(span.name) ?? 'unknown';
  const toolName = attrStr(attrs, 'tool_name');
  const kind = kindOf(name, toolName);
  const spanId = String(span.spanId);
  const parentId = str(span.parentSpanId) ?? sessionRootId;
  const startedAt = nanoToIso(span.startTimeUnixNano) ?? EPOCH;
  const endedAt = nanoToIso(span.endTimeUnixNano);
  const status = statusOf(span, attrs);

  const base: RawSpan = {
    id: spanId,
    parentId,
    kind,
    name,
    status,
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    durationMs: durationBetween(startedAt, endedAt),
    attributes: genAiAttributes(attrs, redact),
    provenance: { file, recordId: spanId },
  };

  if (kind === 'llm_call') {
    const model =
      attrStr(attrs, 'gen_ai.request.model') ??
      attrStr(attrs, 'model') ??
      'unknown';
    const finishReasons = attrs.get('gen_ai.response.finish_reasons');
    const stopReason =
      attrStr(attrs, 'stop_reason') ??
      (Array.isArray(finishReasons) ? str(finishReasons[0]) : undefined);
    base.llm = {
      provider:
        attrStr(attrs, 'gen_ai.provider.name') ??
        attrStr(attrs, 'gen_ai.system') ??
        'unknown',
      model,
      tokens: {
        input:
          attrInt(attrs, 'gen_ai.usage.input_tokens') ||
          attrInt(attrs, 'input_tokens') ||
          attrInt(attrs, 'llm.token_count.prompt'),
        output:
          attrInt(attrs, 'gen_ai.usage.output_tokens') ||
          attrInt(attrs, 'output_tokens') ||
          attrInt(attrs, 'llm.token_count.completion'),
        cacheRead:
          attrInt(attrs, 'cache_read_tokens') ||
          attrInt(attrs, 'llm.token_count.prompt_details.cache_read'),
        cacheWrite:
          attrInt(attrs, 'cache_creation_tokens') ||
          attrInt(attrs, 'llm.token_count.prompt_details.cache_write'),
      },
      costSource:
        attrNum(attrs, 'gen_ai.usage.cost') !== undefined ||
        attrNum(attrs, 'llm.cost.total') !== undefined
          ? 'reported'
          : 'unknown',
      ...(stopReason === undefined ? {} : { stopReason }),
    };
    const costUSD =
      attrNum(attrs, 'gen_ai.usage.cost') ?? attrNum(attrs, 'llm.cost.total');
    if (costUSD !== undefined) {
      base.llm.costUSD = costUSD;
    }
  } else if (kind === 'tool_call' || kind === 'mcp_call') {
    const mcpServer =
      toolName?.startsWith('mcp__') === true
        ? toolName.split('__')[1]
        : undefined;
    base.tool = {
      name: toolName ?? 'unknown',
      isError: status === 'error',
      ...(mcpServer === undefined ? {} : { mcpServer }),
    };
    // a failed span's status message is the one result text OTLP carries —
    // same content/redaction contract as the transcript adapters
    if (status === 'error') {
      const message = isObj(span.status) ? str(span.status.message) : undefined;
      if (redact) base.content = { outputPreview: null };
      else if (message !== undefined && message.length > 0) {
        base.content = { outputPreview: message.slice(0, PREVIEW_CHARS) };
      }
    }
  } else if (kind === 'turn') {
    const prompt = attrStr(attrs, 'user_prompt');
    if (redact) {
      base.content = { promptPreview: null };
    } else if (prompt !== undefined) {
      base.content = { promptPreview: prompt.slice(0, PREVIEW_CHARS) };
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

/** parse() needs the group key; runRef packs file path + session id. */
const _REF_SEP = '::';

/** Bounded sniff (1 KiB): an OTLP/JSON trace document, possibly behind the
 * scrub-meta prefix. Not a parse — detect() stays cheap per file. */
function looksLikeOtlp(file: string): boolean {
  try {
    const chunk = readFileSync(file, { encoding: 'utf8', flag: 'r' }).slice(
      0,
      1024,
    );
    return (
      chunk.includes('"resourceSpans"') || chunk.includes('"resourceMetrics"')
    );
  } catch {
    return false;
  }
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function findOtlpFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const name = basename(root);
  if (name === 'raw' || name === 'node_modules') return [];
  const out: string[] = [];
  for (const e of await safeReaddir(root)) {
    const path = join(root, e.name);
    if (e.isDirectory()) out.push(...(await findOtlpFiles(path, depth + 1)));
    else if (
      (e.name.endsWith('.json') || e.name.endsWith('.jsonl')) &&
      looksLikeOtlp(path)
    )
      out.push(path);
  }
  return out.sort();
}

export const otlpAdapter: SourceAdapter = {
  id: 'otlp',

  // import-only source: no zero-config location, nothing to watch (ADR-3)
  defaultRoots: () => [],

  async detect(roots: string[]): Promise<Candidate[]> {
    // explicit-path import only — no zero-config default location (ADR-3)
    if (roots.length === 0) return [];
    const candidates: Candidate[] = [];
    for (const root of roots) {
      const traceSessions = new Map<
        string,
        { file: string; mtimeMs: number; sizeBytes: number; key: string }[]
      >();
      const metricFiles = new Map<
        string,
        Set<{ file: string; mtimeMs: number; sizeBytes: number }>
      >();

      for (const file of await findOtlpFiles(root)) {
        let fileStat: { mtimeMs: number; sizeBytes: number };
        try {
          const s = await stat(file);
          fileStat = { mtimeMs: s.mtimeMs, sizeBytes: s.size };
        } catch {
          fileStat = { mtimeMs: 0, sizeBytes: 0 };
        }
        // enumerating runs (session ids) requires reading the document once;
        // OTLP is the explicit-import path, so the cost is opted into
        try {
          const content = stripBom(await readFile(file, 'utf8'));
          let docs: Json[] = [];
          try {
            const doc = JSON.parse(content);
            if (isObj(doc)) docs = [doc];
          } catch (_err) {
            for (const line of content.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const doc = JSON.parse(trimmed);
              if (isObj(doc)) docs.push(doc);
            }
          }
          if (docs.length === 0) continue;
          const tKeys = new Set<string>();
          const mKeys = new Set<string>();
          for (const doc of docs) {
            for (const span of collectSpans(doc, file, [])) {
              tKeys.add(span.groupKey);
            }
            for (const sid of collectMetricSessions(doc)) {
              mKeys.add(sid);
            }
          }
          for (const key of tKeys) {
            let list = traceSessions.get(key);
            if (!list) {
              list = [];
              traceSessions.set(key, list);
            }
            list.push({ file, key, ...fileStat });
          }
          for (const key of mKeys) {
            let set = metricFiles.get(key);
            if (!set) {
              set = new Set();
              metricFiles.set(key, set);
            }
            set.add({ file, ...fileStat });
          }
        } catch {
          // unparseable file: skipped SILENTLY, and that is a known rough
          // edge rather than a design choice. The sniff matched, so the user
          // meant this file to be OTLP; dropping it without a word makes the
          // CLI report the directory as "empty". reportDiscoveryErrors cannot
          // carry it — that channel only relays failures from parse() on an
          // already-detected candidate — so surfacing this needs a
          // detect-time diagnostics channel.
        }
      }

      for (const [key, tFiles] of traceSessions.entries()) {
        for (const tFile of tFiles) {
          const files = [tFile.file];
          let mtimeMs = tFile.mtimeMs;
          let sizeBytes = tFile.sizeBytes;

          const mSet = metricFiles.get(key);
          if (mSet) {
            for (const mFile of mSet) {
              if (!files.includes(mFile.file)) {
                files.push(mFile.file);
                mtimeMs = Math.max(mtimeMs, mFile.mtimeMs);
                sizeBytes += mFile.sizeBytes;
              }
            }
          }

          candidates.push({
            runRef: `${tFile.file}${_REF_SEP}${key}`,
            format: 'otlp-json',
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
    const sep = candidate.runRef.lastIndexOf(_REF_SEP);
    const wantedKey =
      sep < 0 ? undefined : candidate.runRef.slice(sep + _REF_SEP.length);

    const warnings: RunWarning[] = [];
    const allSpans: OtlpSpan[] = [];

    const metricTokens = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    };
    let metricCost = 0;

    if (candidate.files.length === 0) throw new Error('no files in candidate');

    for (const file of candidate.files) {
      let docs: Json[] = [];
      try {
        const content = stripBom(await readFile(file, 'utf8'));
        try {
          const doc = JSON.parse(content);
          if (isObj(doc)) docs = [doc];
        } catch (_err) {
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const doc = JSON.parse(trimmed);
            if (isObj(doc)) docs.push(doc);
          }
        }
      } catch (err) {
        throw new Error(
          `cannot parse OTLP/JSON document: ${file} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (docs.length === 0)
        throw new Error(`not an OTLP/JSON document: ${file}`);

      for (const doc of docs) {
        allSpans.push(...collectSpans(doc, file, warnings));

        // Extract metrics if present
        const resourceMetrics = doc.resourceMetrics;
        if (Array.isArray(resourceMetrics)) {
          for (const rm of resourceMetrics) {
            if (!isObj(rm)) continue;
            const scopeMetrics =
              rm.scopeMetrics ?? rm.instrumentationLibraryMetrics;
            if (!Array.isArray(scopeMetrics)) continue;
            for (const sm of scopeMetrics) {
              if (!isObj(sm) || !Array.isArray(sm.metrics)) continue;
              for (const m of sm.metrics) {
                if (!isObj(m)) continue;
                const metric = m as Json;
                const sums = isObj(metric.sum) ? metric.sum.dataPoints : [];
                if (!Array.isArray(sums)) continue;
                for (const dp of sums) {
                  if (!isObj(dp)) continue;
                  const attrs = attrsToMap(dp.attributes);
                  const sessionId = attrStr(attrs, 'session.id');
                  if (sessionId !== wantedKey) continue;

                  const val =
                    typeof dp.asDouble === 'number'
                      ? dp.asDouble
                      : typeof dp.intValue === 'number'
                        ? dp.intValue
                        : typeof dp.asDouble === 'string'
                          ? Number(dp.asDouble)
                          : typeof dp.intValue === 'string'
                            ? Number(dp.intValue)
                            : 0;

                  if (metric.name === 'opencode.token.usage') {
                    const type = attrStr(attrs, 'type');
                    if (type === 'input') metricTokens.input += val;
                    else if (type === 'output') metricTokens.output += val;
                    else if (type === 'cacheRead')
                      metricTokens.cacheRead += val;
                    else if (type === 'cacheCreation')
                      metricTokens.cacheWrite += val;
                    else if (type === 'reasoning')
                      metricTokens.reasoning += val;
                  } else if (metric.name === 'opencode.cost.usage') {
                    metricCost += val;
                  }
                }
              }
            }
          }
        }
      }
    }

    const spans = allSpans.filter((s) => s.groupKey === wantedKey);
    const groupKey = wantedKey ?? spans[0]?.groupKey ?? 'unknown';

    // synthetic session root: "spans sharing a session id form one run" —
    // trace roots parent here, and it gives the run a stable identity
    let minStart: string | undefined;
    let maxEnd: string | undefined;
    for (const s of spans) {
      const start = nanoToIso(s.json.startTimeUnixNano);
      const end = nanoToIso(s.json.endTimeUnixNano);
      if (start !== undefined && (minStart === undefined || start < minStart))
        minStart = start;
      if (end !== undefined && (maxEnd === undefined || end > maxEnd))
        maxEnd = end;
    }
    const sessionSpan: RawSpan = {
      id: groupKey,
      parentId: null,
      kind: 'session',
      name: 'session',
      status: 'ok',
      startedAt: minStart ?? EPOCH,
      ...(maxEnd === undefined ? {} : { endedAt: maxEnd }),
      durationMs: durationBetween(minStart ?? EPOCH, maxEnd),
      agent: { sessionId: groupKey },
      attributes: {},
      provenance: { file: candidate.files[0] ?? 'unknown', recordId: groupKey },
    };

    const rawSpans = spans.map((s) =>
      toRawSpan(
        s,
        groupKey,
        (candidate.files.find((f) => f.includes('traces')) ||
          candidate.files[0]) ??
          'unknown',
        opts.redact,
      ),
    );

    // Inject extracted metrics into the first llm_call span so normalizer counts them
    const hasMetricTokens =
      metricTokens.input > 0 ||
      metricTokens.output > 0 ||
      metricTokens.cacheRead > 0 ||
      metricTokens.cacheWrite > 0 ||
      metricTokens.reasoning > 0;
    if (hasMetricTokens || metricCost > 0) {
      const firstLlm = rawSpans.find((s) => s.kind === 'llm_call');
      if (firstLlm?.llm) {
        if (
          hasMetricTokens &&
          firstLlm.llm.tokens.input === 0 &&
          firstLlm.llm.tokens.output === 0
        ) {
          firstLlm.llm.tokens.input += metricTokens.input;
          firstLlm.llm.tokens.output += metricTokens.output;
          firstLlm.llm.tokens.cacheRead += metricTokens.cacheRead;
          firstLlm.llm.tokens.cacheWrite += metricTokens.cacheWrite;
          if (metricTokens.reasoning > 0)
            firstLlm.llm.tokens.reasoning =
              (firstLlm.llm.tokens.reasoning ?? 0) + metricTokens.reasoning;
        }
        if (
          metricCost > 0 &&
          (firstLlm.llm.costUSD === undefined || firstLlm.llm.costUSD === 0)
        ) {
          firstLlm.llm.costUSD = metricCost;
          firstLlm.llm.costSource = 'reported';
        }
      }
    }

    return {
      source: { tool: 'otlp', format: 'otlp-json', files: candidate.files },
      spans: [sessionSpan, ...rawSpans],
      warnings,
    };
  },
};
