import type { Run, Span } from '@runray/schema';

/**
 * Shared pure helpers for insight rules (add-profiler-depth B2/B6/B-D13).
 * Every cross-rule interaction (retry-cluster subtraction in dead-end-run,
 * cluster exclusion in scattered-tool-failures, pair scans in the cache
 * rules) goes through these functions so the outcome is a pure function of
 * `(run, options)` with no evaluation-order dependence. Helpers take
 * explicit option params — never the `Thresholds` registry — so they stay
 * decoupled from config-key shape.
 */

const SCOPE_KINDS = new Set(['subagent', 'session']);

/**
 * Nearest enclosing scope (subagent or session) for every span. A scope
 * span is its own scope; other spans walk their parent chain. Orphans map
 * to their root-most resolvable ancestor (the normalizer's Flat Trace
 * Fallback guarantees parent ids resolve).
 */
export function buildScopeIndex(run: Run): Map<string, string> {
  const byId = new Map(run.spans.map((s) => [s.id, s]));
  const scope = new Map<string, string>();
  const resolve = (span: Span): string => {
    const cached = scope.get(span.id);
    if (cached !== undefined) return cached;
    let result = span.id;
    if (!SCOPE_KINDS.has(span.kind)) {
      const parent =
        span.parentId === null ? undefined : byId.get(span.parentId);
      result = parent === undefined ? span.id : resolve(parent);
    }
    scope.set(span.id, result);
    return result;
  };
  for (const span of run.spans) resolve(span);
  return scope;
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

// Span timestamps are re-parsed in several O(n·m) rule scans (retry claims,
// duplicate-read windows, scattered reactions); Date.parse dominated those
// hot loops. Memoize per span object — the same objects are shared across
// rules within one applyInsights call and GC'd with the run afterwards.
const startMsCache = new WeakMap<Span, number>();
const endMsCache = new WeakMap<Span, number>();

/** Cached epoch-ms of a span's start (Date.parse called at most once). */
export function startMs(span: Span): number {
  const cached = startMsCache.get(span);
  if (cached !== undefined) return cached;
  const v = ms(span.startedAt);
  startMsCache.set(span, v);
  return v;
}

/** Cached epoch-ms of a span's end (falls back to start when absent). */
export function endMs(span: Span): number {
  const cached = endMsCache.get(span);
  if (cached !== undefined) return cached;
  const v = span.endedAt === undefined ? startMs(span) : ms(span.endedAt);
  endMsCache.set(span, v);
  return v;
}

/** Chronological (startedAt, then id) — the canonical rule-scan order. */
export function chronological(spans: readonly Span[]): Span[] {
  return [...spans].sort(
    (a, b) =>
      ms(a.startedAt) - ms(b.startedAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** All llm_call spans carrying llm data, in chronological order. */
export function chronologicalLlmCalls(run: Run): Span[] {
  return chronological(
    run.spans.filter((s) => s.kind === 'llm_call' && s.llm !== undefined),
  );
}

/**
 * Adjacent same-model pairs in the chronological llm sequence — the input
 * shape for cache-lifecycle scans (prefix break, idle expiry).
 */
export function consecutiveSameModelPairs(
  llms: readonly Span[],
): Array<[Span, Span]> {
  const pairs: Array<[Span, Span]> = [];
  for (let i = 1; i < llms.length; i++) {
    const a = llms[i - 1];
    const b = llms[i];
    if (a && b && a.llm?.model === b.llm?.model) pairs.push([a, b]);
  }
  return pairs;
}

/**
 * Cache-lifecycle pairs keyed by (scope, model): consecutive same-model
 * calls WITHIN one scope's own subsequence. A prompt cache belongs to one
 * context window (scope) and one model, so pairing must never straddle a
 * subagent boundary — a subagent's first call writes its OWN fresh prefix
 * and must not be read as the main session's cache "breaking" — and must
 * survive interleaved calls of other scopes/models that would otherwise
 * break global adjacency. Returned in first-element chronological order so
 * findings stay in first-evidence order.
 */
export function scopedSameModelPairs(run: Run): Array<[Span, Span]> {
  const scope = buildScopeIndex(run);
  const groups = new Map<string, Span[]>();
  for (const s of chronologicalLlmCalls(run)) {
    const key = `${scope.get(s.id) ?? s.id}\u0000${s.llm?.model ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const pairs: Array<[Span, Span]> = [];
  for (const list of groups.values()) {
    // chronologicalLlmCalls already ordered each group chronologically
    for (let i = 1; i < list.length; i++) {
      pairs.push([list[i - 1] as Span, list[i] as Span]);
    }
  }
  return pairs.sort(
    (x, y) =>
      ms(x[0].startedAt) - ms(y[0].startedAt) ||
      (x[0].id < y[0].id ? -1 : x[0].id > y[0].id ? 1 : 0),
  );
}

export interface RetryClusterOptions {
  /** Minimum failures for a cluster to qualify. */
  minFailures: number;
  /** Max other same-scope tool calls tolerated between consecutive members. */
  maxGapToolCalls: number;
}

export interface RetryCluster {
  /** Failure identity: tool name + captured target key ('' when absent). */
  name: string;
  targetKey: string;
  /** Scope (nearest subagent/session) the cluster lives in — never spans scopes. */
  scopeId: string;
  /** Qualifying failed tool spans, chronological. */
  failures: Span[];
}

function targetKeyOf(span: Span): string {
  const v =
    (span.attributes as Record<string, unknown>)['runray.targetKey'] ??
    (span.attributes as Record<string, unknown>)['tracepulse.targetKey'];
  return typeof v === 'string' ? v : '';
}

/**
 * Windowed retry clustering (B6): failures share a cluster when they have
 * the same identity `(name, targetKey)`, live in the same scope, and are
 * separated by at most `maxGapToolCalls` other tool calls of that scope.
 * A success of the same identity ends its cluster (the retry saga
 * resolved). Clusters are returned in first-evidence chronological order.
 */
export function detectRetryClusters(
  run: Run,
  opts: RetryClusterOptions,
): RetryCluster[] {
  const scopeIndex = buildScopeIndex(run);
  const tools = chronological(
    run.spans.filter((s) => s.kind === 'tool_call' || s.kind === 'mcp_call'),
  );

  interface Open {
    cluster: RetryCluster;
    gap: number;
  }
  const done: RetryCluster[] = [];
  /** scopeId → identityKey → open cluster */
  const open = new Map<string, Map<string, Open>>();

  const close = (scopeOpen: Map<string, Open>, key: string) => {
    const o = scopeOpen.get(key);
    if (o !== undefined && o.cluster.failures.length >= opts.minFailures) {
      done.push(o.cluster);
    }
    scopeOpen.delete(key);
  };

  for (const t of tools) {
    const scopeId = scopeIndex.get(t.id) ?? t.id;
    const scopeOpen = open.get(scopeId) ?? new Map<string, Open>();
    open.set(scopeId, scopeOpen);
    const key = `${t.name}\u0000${targetKeyOf(t)}`;

    // every tool call widens the gap of the scope's other open clusters
    for (const [k, o] of scopeOpen) {
      if (k === key) continue;
      o.gap += 1;
      if (o.gap > opts.maxGapToolCalls) close(scopeOpen, k);
    }

    if (t.status === 'error') {
      const existing = scopeOpen.get(key);
      if (existing !== undefined) {
        existing.cluster.failures.push(t);
        existing.gap = 0;
      } else {
        scopeOpen.set(key, {
          cluster: {
            name: t.name,
            targetKey: targetKeyOf(t),
            scopeId,
            failures: [t],
          },
          gap: 0,
        });
      }
    } else {
      // a success of the same identity resolves the saga
      close(scopeOpen, key);
    }
  }
  for (const scopeOpen of open.values()) {
    for (const key of [...scopeOpen.keys()]) close(scopeOpen, key);
  }

  return chronologicalClusters(done);
}

function chronologicalClusters(clusters: RetryCluster[]): RetryCluster[] {
  return clusters.sort((a, b) => {
    const fa = a.failures[0];
    const fb = b.failures[0];
    if (!fa || !fb) return 0;
    return (
      ms(fa.startedAt) - ms(fb.startedAt) ||
      (fa.id < fb.id ? -1 : fa.id > fb.id ? 1 : 0)
    );
  });
}
