import type { Run, Span } from '@runray/schema';
import { round6 } from '../pricing/engine.js';

/**
 * Run diff (add-run-diff, E-D2): a pure, dependency-free comparison of two
 * normalized runs, exposed as the browser-safe `@runray/core/diff`
 * subpath so the CLI's `--json`, the CI gate, and the visualizer's Diff
 * view all print THE SAME implementation — "summary table mirrors CI
 * output" holds by construction, never by duplicated logic.
 *
 * Alignment (spec "Alignment robustness"): recursive per-sibling-group
 * matching keyed by the `(kind, name)` multiset — within one parent's
 * children, spans with the same key pair off in chronological order of
 * occurrence, so reordering independent siblings never produces spurious
 * added/removed pairs. Unpaired spans classify as added (b-only) or
 * removed (a-only), whole subtrees included. Deterministic throughout:
 * chronological (startedAt, then id) ordering, round6 money, and pct null
 * on a zero base.
 */

export interface DiffDelta {
  a: number;
  b: number;
  /** b − a. */
  delta: number;
  /** (b − a) / a; null when the base is zero (never Infinity/NaN). */
  pct: number | null;
}

function delta(a: number, b: number): DiffDelta {
  return {
    a: round6(a),
    b: round6(b),
    delta: round6(b - a),
    pct: a === 0 ? null : round6((b - a) / a),
  };
}

export interface RunRef {
  id: string;
  title?: string;
  startedAt: string;
  source: string;
}

export interface RunDiffHeader {
  costUSD: DiffDelta;
  tokens: {
    input: DiffDelta;
    output: DiffDelta;
    cacheRead: DiffDelta;
    cacheWrite: DiffDelta;
    /** Reasoning tokens (OpenCode emits these); folded into `total`. */
    reasoning: DiffDelta;
    total: DiffDelta;
  };
  toolErrors: DiffDelta;
  llmCalls: DiffDelta;
  maxDepth: DiffDelta;
  wallClockMs: DiffDelta;
}

export interface AlignedPair {
  aId: string;
  bId: string;
  kind: Span['kind'];
  name: string;
  /** Priced llm cost of the two spans (0 for non-llm spans). */
  costUSD: DiffDelta;
  /** Full token quad (incl. reasoning) of the two spans. */
  tokens: DiffDelta;
  durationMs: DiffDelta;
  /** Present only when the status flipped (e.g. ok → error). */
  statusChanged?: { a: Span['status']; b: Span['status'] };
}

export interface SubtreePairDelta {
  aId: string;
  bId: string;
  name: string;
  /** Whole-subtree priced cost (root included). */
  costUSD: DiffDelta;
}

export interface SpanAlignment {
  /** Paired spans, chronological by the a-side. */
  matched: AlignedPair[];
  /** Span ids present only in run b, chronological. */
  added: string[];
  /** Span ids present only in run a, chronological. */
  removed: string[];
  /** Matched subagent pairs with whole-subtree cost deltas. */
  subtrees: SubtreePairDelta[];
}

export interface RunDiff {
  a: RunRef;
  b: RunRef;
  header: RunDiffHeader;
  alignment: SpanAlignment;
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Priced-only span cost — the same convention as every rollup. */
function spanCost(span: Span): number {
  if (span.kind !== 'llm_call' || span.llm === undefined) return 0;
  return span.llm.costSource === 'unknown' ? 0 : (span.llm.costUSD ?? 0);
}

function spanTokens(span: Span): number {
  if (span.kind !== 'llm_call' || span.llm === undefined) return 0;
  const t = span.llm.tokens;
  return t.input + t.output + t.cacheRead + t.cacheWrite + (t.reasoning ?? 0);
}

function chronological(spans: readonly Span[]): Span[] {
  return [...spans].sort(
    (x, y) =>
      ms(x.startedAt) - ms(y.startedAt) ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
}

function childrenMap(run: Run): Map<string | null, Span[]> {
  const map = new Map<string | null, Span[]>();
  for (const span of run.spans) {
    const list = map.get(span.parentId) ?? [];
    list.push(span);
    map.set(span.parentId, list);
  }
  for (const [key, list] of map) map.set(key, chronological(list));
  return map;
}

function wallClockMs(run: Run): number {
  if (run.durationMs !== undefined) return run.durationMs;
  if (run.endedAt !== undefined) return ms(run.endedAt) - ms(run.startedAt);
  return 0;
}

function runRef(run: Run): RunRef {
  return {
    id: run.id,
    ...(run.title === undefined ? {} : { title: run.title }),
    startedAt: run.startedAt,
    source: run.source.tool,
  };
}

/** All spans of a subtree (root included), chronological. */
function collectSubtree(
  root: Span,
  children: Map<string | null, Span[]>,
): Span[] {
  const out: Span[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const span = stack.pop();
    if (span === undefined) break;
    out.push(span);
    for (const child of children.get(span.id) ?? []) stack.push(child);
  }
  return chronological(out);
}

export function diffRuns(a: Run, b: Run): RunDiff {
  const header: RunDiffHeader = {
    costUSD: delta(a.totals.costUSD.total, b.totals.costUSD.total),
    tokens: {
      input: delta(a.totals.tokens.input, b.totals.tokens.input),
      output: delta(a.totals.tokens.output, b.totals.tokens.output),
      cacheRead: delta(a.totals.tokens.cacheRead, b.totals.tokens.cacheRead),
      cacheWrite: delta(a.totals.tokens.cacheWrite, b.totals.tokens.cacheWrite),
      reasoning: delta(
        a.totals.tokens.reasoning ?? 0,
        b.totals.tokens.reasoning ?? 0,
      ),
      total: delta(a.totals.tokens.total, b.totals.tokens.total),
    },
    toolErrors: delta(a.totals.counts.toolErrors, b.totals.counts.toolErrors),
    llmCalls: delta(a.totals.counts.llmCalls, b.totals.counts.llmCalls),
    maxDepth: delta(a.totals.counts.maxDepth, b.totals.counts.maxDepth),
    wallClockMs: delta(wallClockMs(a), wallClockMs(b)),
  };

  const childrenA = childrenMap(a);
  const childrenB = childrenMap(b);
  const matched: AlignedPair[] = [];
  const subtrees: SubtreePairDelta[] = [];
  const added: Span[] = [];
  const removed: Span[] = [];

  const alignGroup = (
    aSiblings: readonly Span[],
    bSiblings: readonly Span[],
  ): void => {
    // multiset key = (kind, name); occurrences pair off chronologically
    const keyOf = (s: Span) => `${s.kind}\u0000${s.name}`;
    const byKeyA = new Map<string, Span[]>();
    const byKeyB = new Map<string, Span[]>();
    for (const s of aSiblings) {
      const list = byKeyA.get(keyOf(s)) ?? [];
      list.push(s);
      byKeyA.set(keyOf(s), list);
    }
    for (const s of bSiblings) {
      const list = byKeyB.get(keyOf(s)) ?? [];
      list.push(s);
      byKeyB.set(keyOf(s), list);
    }
    const keys = [...new Set([...byKeyA.keys(), ...byKeyB.keys()])].sort();
    for (const key of keys) {
      const listA = byKeyA.get(key) ?? [];
      const listB = byKeyB.get(key) ?? [];
      const pairs = Math.min(listA.length, listB.length);
      for (let i = 0; i < pairs; i++) {
        const spanA = listA[i] as Span;
        const spanB = listB[i] as Span;
        matched.push({
          aId: spanA.id,
          bId: spanB.id,
          kind: spanA.kind,
          name: spanA.name,
          costUSD: delta(spanCost(spanA), spanCost(spanB)),
          tokens: delta(spanTokens(spanA), spanTokens(spanB)),
          durationMs: delta(spanA.durationMs ?? 0, spanB.durationMs ?? 0),
          ...(spanA.status === spanB.status
            ? {}
            : { statusChanged: { a: spanA.status, b: spanB.status } }),
        });
        if (spanA.kind === 'subagent') {
          const costA = collectSubtree(spanA, childrenA).reduce(
            (acc, s) => acc + spanCost(s),
            0,
          );
          const costB = collectSubtree(spanB, childrenB).reduce(
            (acc, s) => acc + spanCost(s),
            0,
          );
          subtrees.push({
            aId: spanA.id,
            bId: spanB.id,
            name: spanA.agent?.name ?? spanA.name,
            costUSD: delta(costA, costB),
          });
        }
        alignGroup(
          childrenA.get(spanA.id) ?? [],
          childrenB.get(spanB.id) ?? [],
        );
      }
      // unpaired occurrences classify whole subtrees
      for (const extra of listA.slice(pairs)) {
        removed.push(...collectSubtree(extra, childrenA));
      }
      for (const extra of listB.slice(pairs)) {
        added.push(...collectSubtree(extra, childrenB));
      }
    }
  };

  alignGroup(childrenA.get(null) ?? [], childrenB.get(null) ?? []);

  // one id→start lookup, built once — the comparator used a.spans.find per
  // comparison, making the sort O(P·logP·N) and diffRuns quadratic at the
  // 10k-span scale the tool targets (measured 6.4s → 0.1s with this Map).
  // Output is byte-identical; only the lookup changes.
  const startById = new Map(a.spans.map((s) => [s.id, ms(s.startedAt)]));
  matched.sort(
    (x, y) =>
      (startById.get(x.aId) ?? 0) - (startById.get(y.aId) ?? 0) ||
      (x.aId < y.aId ? -1 : x.aId > y.aId ? 1 : 0),
  );
  subtrees.sort(
    (x, y) =>
      Math.abs(y.costUSD.delta) - Math.abs(x.costUSD.delta) ||
      (x.aId < y.aId ? -1 : 1),
  );

  return {
    a: runRef(a),
    b: runRef(b),
    header,
    alignment: {
      matched,
      added: chronological(added).map((s) => s.id),
      removed: chronological(removed).map((s) => s.id),
      subtrees,
    },
  };
}
