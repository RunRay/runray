/**
 * Diff view display adapter (run-diff 3.2): turns the core `RunDiff` into
 * interleaved rows for the paired waterfall — matched | added | removed —
 * plus regression flags per the archived stylebook §4.6 (added = brass
 * tint, removed = dimmed, cost-regressed = ember underline). Pure module;
 * all figures come from `@runray/core/diff`, so the view can never
 * disagree with the CLI.
 */

import type { DiffDelta, RunDiff } from '@runray/core/diff';
import type { Run, Span } from '@runray/schema';

export interface DiffRow {
  type: 'matched' | 'added' | 'removed';
  /** Stable render key. */
  key: string;
  kind: Span['kind'];
  name: string;
  depth: number;
  aId: string | null;
  bId: string | null;
  /** Pair deltas — matched rows only. */
  costUSD: DiffDelta | null;
  tokens: DiffDelta | null;
  durationMs: DiffDelta | null;
  /** The lone side's own figures — added/removed rows only. */
  ownCostUSD: number;
  ownDurationMs: number;
  statusChanged: { a: Span['status']; b: Span['status'] } | null;
  /** Matched pair whose cost went up (ember underline). */
  costRegressed: boolean;
  /** Anchor: start offset from its own run's start — the interleave key. */
  offsetMs: number;
}

/** Priced-only own cost — the same convention as core rollups. */
function spanOwnCostUSD(span: Span): number {
  if (span.kind !== 'llm_call' || span.llm === undefined) return 0;
  return span.llm.costSource === 'unknown' ? 0 : (span.llm.costUSD ?? 0);
}

const TYPE_ORDER = { matched: 0, removed: 1, added: 2 } as const;

/**
 * Interleave matched pairs (anchored on the a-side), removed spans (a-side)
 * and added spans (b-side) by their start offset from each run's own start,
 * so structurally similar positions line up even when the runs happened on
 * different days. Deterministic tie-break: offset, type, key.
 */
export function buildDiffRows(a: Run, b: Run, diff: RunDiff): DiffRow[] {
  const aById = new Map(a.spans.map((s) => [s.id, s]));
  const bById = new Map(b.spans.map((s) => [s.id, s]));
  const aStart = Date.parse(a.startedAt);
  const bStart = Date.parse(b.startedAt);
  const rows: DiffRow[] = [];

  for (const pair of diff.alignment.matched) {
    const spanA = aById.get(pair.aId);
    if (spanA === undefined) continue;
    rows.push({
      type: 'matched',
      key: `m:${pair.aId}:${pair.bId}`,
      kind: pair.kind,
      name: pair.name,
      depth: spanA.depth,
      aId: pair.aId,
      bId: pair.bId,
      costUSD: pair.costUSD,
      tokens: pair.tokens,
      durationMs: pair.durationMs,
      ownCostUSD: 0,
      ownDurationMs: 0,
      statusChanged: pair.statusChanged ?? null,
      costRegressed: pair.costUSD.delta > 0,
      offsetMs: Date.parse(spanA.startedAt) - aStart,
    });
  }

  const loneRow = (
    type: 'added' | 'removed',
    span: Span,
    runStart: number,
  ): DiffRow => ({
    type,
    key: `${type === 'added' ? 'a' : 'r'}:${span.id}`,
    kind: span.kind,
    name: span.name,
    depth: span.depth,
    aId: type === 'removed' ? span.id : null,
    bId: type === 'added' ? span.id : null,
    costUSD: null,
    tokens: null,
    durationMs: null,
    ownCostUSD: spanOwnCostUSD(span),
    ownDurationMs: span.durationMs ?? 0,
    statusChanged: null,
    costRegressed: false,
    offsetMs: Date.parse(span.startedAt) - runStart,
  });

  for (const id of diff.alignment.removed) {
    const span = aById.get(id);
    if (span !== undefined) rows.push(loneRow('removed', span, aStart));
  }
  for (const id of diff.alignment.added) {
    const span = bById.get(id);
    if (span !== undefined) rows.push(loneRow('added', span, bStart));
  }

  rows.sort(
    (x, y) =>
      x.offsetMs - y.offsetMs ||
      TYPE_ORDER[x.type] - TYPE_ORDER[y.type] ||
      (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );
  return rows;
}
