import { type Run, RunSchema, type RunTotals, type Span } from '@runray/schema';
import type { RawRun, RawSpan, RunWarning } from './adapter.js';

/**
 * Normalizer pipeline (task 2.4, 05-ARCHITECTURE §2.2): pure functions
 * `RawRun → buildTree (Flat Trace Fallback) → deriveDepth → stable sort →
 * totals rollup → Run`. Deterministic by contract — the same RawRun always
 * yields byte-identical output (golden tests, run diff in v0.2).
 *
 * Cost is NOT computed here: llm spans keep whatever `costUSD`/`costSource`
 * the adapter emitted; the cost engine (task 2.5) enriches them before totals
 * are consumed for money. Totals derived here still sum any present costUSD.
 */

export interface NormalizeOptions {
  /**
   * Strip this directory prefix from `provenance.file` and `source.files`
   * and emit POSIX separators — goldens must not embed machine paths.
   */
  baseDir?: string;
  /** Validate the result against the frozen schema (default true). */
  validate?: boolean;
}

const EPOCH = '1970-01-01T00:00:00Z';

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable run identity: hash of the source session id(s) (docs/02-DATA-MODEL). */
function deriveRunId(roots: RawSpan[]): string {
  const key = roots.map((r) => r.agent?.sessionId ?? r.id).join('\n');
  const h1 = fnv1a(key).toString(16).padStart(8, '0');
  const h2 = fnv1a(key + h1)
    .toString(16)
    .padStart(8, '0');
  return `run_${h1}${h2}`;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

function relativize(path: string, baseDir: string | undefined): string {
  const posix = toPosix(path);
  if (baseDir === undefined) return posix;
  const base = toPosix(baseDir).replace(/\/+$/, '');
  if (posix === base) return '.';
  if (posix.startsWith(`${base}/`)) return posix.slice(base.length + 1);
  return posix;
}

function parseMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** Chronological, deterministic order: (timestamp, raw string, id). */
function compareSpans(a: RawSpan, b: RawSpan): number {
  const diff = parseMs(a.startedAt) - parseMs(b.startedAt);
  if (diff !== 0) return diff;
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Flat Trace Fallback (trace-ingestion spec): spans whose `parentId` dangles
 * (missing target or a parent cycle) re-attach to the run root; the run gets
 * a warning naming the affected spans. Returns fixed copies.
 */
function buildTree(spans: RawSpan[], warnings: RunWarning[]): RawSpan[] {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const roots = spans.filter((s) => s.parentId === null).sort(compareSpans);
  const fallbackParent = roots[0]?.id ?? null;

  // Only spans that themselves hold a broken link are re-parented: a dangling
  // reference or membership in a parent cycle. Their descendants stay attached
  // — they become valid once the holder is re-attached to the root.
  // state: 0 = unvisited, 1 = on the current chain, 2 = settled
  const state = new Map<string, number>();
  const broken = new Set<string>();
  function resolve(span: RawSpan): void {
    const chain: RawSpan[] = [];
    let current: RawSpan = span;
    for (;;) {
      const s = state.get(current.id);
      if (s === 2) break;
      if (s === 1) {
        // cycle: members are the chain suffix from the revisited span
        const start = chain.indexOf(current);
        for (const member of chain.slice(start)) broken.add(member.id);
        break;
      }
      state.set(current.id, 1);
      chain.push(current);
      if (current.parentId === null) break;
      if (broken.has(current.parentId)) break; // parent gets re-attached; chain is fine
      const parent = byId.get(current.parentId);
      if (parent === undefined) {
        broken.add(current.id);
        break;
      }
      current = parent;
    }
    for (const c of chain) state.set(c.id, 2);
  }
  for (const span of spans) resolve(span);

  if (broken.size === 0) return spans;
  const ids = [...broken].sort();
  const shown = ids.slice(0, 10).join(', ');
  warnings.push({
    message: `Flat Trace Fallback: ${ids.length} span(s) with broken parent links re-attached to the run root (${shown}${ids.length > 10 ? ', …' : ''})`,
  });
  return spans.map((s) =>
    broken.has(s.id) && s.id !== fallbackParent
      ? { ...s, parentId: fallbackParent }
      : s,
  );
}

function deriveDepths(spans: RawSpan[]): Map<string, number> {
  const depths = new Map<string, number>();
  const children = new Map<string | null, RawSpan[]>();
  for (const s of spans) {
    const list = children.get(s.parentId) ?? [];
    list.push(s);
    children.set(s.parentId, list);
  }
  const queue: Array<{ id: string | null; depth: number }> = [
    { id: null, depth: 0 },
  ];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    for (const child of children.get(item.id) ?? []) {
      depths.set(child.id, item.depth);
      queue.push({ id: child.id, depth: item.depth + 1 });
    }
  }
  return depths;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/** Cost sums are rounded to micro-dollars — IEEE float artifacts must not leak into goldens. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function deriveTotals(spans: Span[]): RunTotals {
  const tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
  };
  const byModel = new Map<string, number>();
  let costTotal = 0;
  let llmCalls = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let subagents = 0;
  let maxDepth = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let hasCodeChanges = false;

  for (const s of spans) {
    maxDepth = Math.max(maxDepth, s.depth);
    if (s.kind === 'subagent') subagents++;
    if (s.kind === 'tool_call' || s.kind === 'mcp_call') {
      toolCalls++;
      if (s.status === 'error') toolErrors++;
      if (
        s.tool?.linesAdded !== undefined ||
        s.tool?.linesRemoved !== undefined
      ) {
        hasCodeChanges = true;
        linesAdded += s.tool.linesAdded ?? 0;
        linesRemoved += s.tool.linesRemoved ?? 0;
      }
    }
    if (s.kind === 'llm_call' && s.llm) {
      llmCalls++;
      tokens.input += s.llm.tokens.input;
      tokens.output += s.llm.tokens.output;
      tokens.cacheRead += s.llm.tokens.cacheRead;
      tokens.cacheWrite += s.llm.tokens.cacheWrite;
      tokens.reasoning += s.llm.tokens.reasoning ?? 0;
      if (s.llm.costUSD !== undefined) {
        costTotal += s.llm.costUSD;
        byModel.set(
          s.llm.model,
          (byModel.get(s.llm.model) ?? 0) + s.llm.costUSD,
        );
      }
    }
  }
  tokens.total =
    tokens.input +
    tokens.output +
    tokens.cacheRead +
    tokens.cacheWrite +
    tokens.reasoning;
  const cacheDenominator = tokens.cacheRead + tokens.input;

  return {
    tokens,
    costUSD: {
      total: round6(costTotal),
      // wasted spend sums waste-class insight findings — filled by the
      // insight engine (task 4.x), zero until then
      wastedEstimate: 0,
      byModel: Object.fromEntries(
        [...byModel.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([model, usd]) => [model, round6(usd)]),
      ),
    },
    counts: { llmCalls, toolCalls, toolErrors, subagents, maxDepth },
    cache: {
      hitRate:
        cacheDenominator === 0
          ? 0
          : round4(tokens.cacheRead / cacheDenominator),
    },
    ...(hasCodeChanges ? { codeChanges: { linesAdded, linesRemoved } } : {}),
  };
}

/** Rebuild each span in schema field order — key order is part of golden stability. */
function finalizeSpan(
  raw: RawSpan,
  depth: number,
  baseDir: string | undefined,
): Span {
  return {
    id: raw.id,
    parentId: raw.parentId,
    kind: raw.kind,
    name: raw.name,
    status: raw.status,
    ...(raw.statusReason === undefined
      ? {}
      : { statusReason: raw.statusReason }),
    startedAt: raw.startedAt,
    ...(raw.endedAt === undefined ? {} : { endedAt: raw.endedAt }),
    ...(raw.durationMs === undefined ? {} : { durationMs: raw.durationMs }),
    depth,
    ...(raw.llm === undefined ? {} : { llm: raw.llm }),
    ...(raw.tool === undefined ? {} : { tool: raw.tool }),
    ...(raw.agent === undefined ? {} : { agent: raw.agent }),
    ...(raw.content === undefined ? {} : { content: raw.content }),
    attributes: raw.attributes,
    provenance: {
      file: relativize(raw.provenance.file, baseDir),
      ...(raw.provenance.line === undefined
        ? {}
        : { line: raw.provenance.line }),
      ...(raw.provenance.recordId === undefined
        ? {}
        : { recordId: raw.provenance.recordId }),
    },
  };
}

export function normalize(raw: RawRun, options: NormalizeOptions = {}): Run {
  // warnings carry file references too — relativize them like provenance
  const warnings: RunWarning[] = raw.warnings.map((w) =>
    w.file === undefined
      ? w
      : { ...w, file: relativize(w.file, options.baseDir) },
  );
  if (raw.spans.length === 0) {
    warnings.push({ message: 'run contains no spans' });
  }

  const fixed = buildTree(raw.spans, warnings);
  const depths = deriveDepths(fixed);
  const sorted = [...fixed].sort(compareSpans);
  const spans = sorted.map((s) =>
    finalizeSpan(s, depths.get(s.id) ?? 0, options.baseDir),
  );

  const roots = fixed.filter((s) => s.parentId === null).sort(compareSpans);
  const startedAt = spans[0]?.startedAt ?? EPOCH;
  let endMs = parseMs(startedAt);
  let endIso = startedAt;
  for (const s of spans) {
    const candidate = s.endedAt ?? s.startedAt;
    const ms = parseMs(candidate);
    if (ms > endMs) {
      endMs = ms;
      endIso = candidate;
    }
  }

  const run: Run = {
    id: deriveRunId(roots),
    source: {
      tool: raw.source.tool,
      format: raw.source.format,
      files: raw.source.files.map((f) => relativize(f, options.baseDir)),
    },
    ...(raw.title === undefined ? {} : { title: raw.title }),
    ...(raw.project === undefined ? {} : { project: raw.project }),
    startedAt,
    endedAt: endIso,
    durationMs: Math.max(0, endMs - parseMs(startedAt)),
    ...(warnings.length === 0 ? {} : { warnings }),
    spans,
    totals: deriveTotals(spans),
    insights: [],
  };

  if (options.validate !== false) RunSchema.parse(run);
  return run;
}
