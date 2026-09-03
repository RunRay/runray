/**
 * Waterfall layout (03-design.md §4.2), kept pure so it is testable and the
 * component stays a thin renderer. Input spans arrive normalizer-ordered
 * (deterministic); this module only derives visibility, concurrency lanes,
 * and the shared time scale — bar geometry is startedAt/durationMs, nothing
 * else.
 */

import type { Insight, Run, Span } from '@runray/schema';

/** Bracket segment marking consecutive siblings whose time ranges overlap. */
export type LaneMark = 'start' | 'mid' | 'end' | null;

export interface WaterfallRow {
  span: Span;
  hasChildren: boolean;
  /** This span's subtree is collapsed behind it. */
  collapsed: boolean;
  /** Number of spans hidden by the collapse (0 when expanded). */
  hiddenDescendants: number;
  lane: LaneMark;
}

export interface TimeRange {
  /** Epoch ms of the earliest span start. */
  start: number;
  /** Epoch ms of the latest span end; always > start. */
  end: number;
}

export function spanStartMs(span: Span): number {
  return Date.parse(span.startedAt);
}

export function spanEndMs(span: Span): number {
  return spanStartMs(span) + (span.durationMs ?? 0);
}

export function computeTimeRange(spans: readonly Span[]): TimeRange {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    start = Math.min(start, spanStartMs(span));
    end = Math.max(end, spanEndMs(span));
  }
  if (!Number.isFinite(start)) return { start: 0, end: 1 };
  // Degenerate zero-length runs still need a non-zero scale.
  return { start, end: end > start ? end : start + 1 };
}

/** Children keyed by parent id, preserving normalizer order. */
export function buildChildrenMap(
  spans: readonly Span[],
): Map<string | null, Span[]> {
  const map = new Map<string | null, Span[]>();
  for (const span of spans) {
    const list = map.get(span.parentId);
    if (list === undefined) map.set(span.parentId, [span]);
    else list.push(span);
  }
  return map;
}

/**
 * `/` filter: spans whose name matches the query, plus all their ancestors
 * so the tree stays readable. `null` = no filtering (empty query).
 */
export function matchingSpanIds(
  spans: readonly Span[],
  query: string,
): ReadonlySet<string> | null {
  const q = query.trim().toLowerCase();
  if (q === '') return null;
  const byId = new Map(spans.map((s) => [s.id, s]));
  const keep = new Set<string>();
  for (const span of spans) {
    if (!span.name.toLowerCase().includes(q)) continue;
    let cursor: Span | undefined = span;
    while (cursor !== undefined && !keep.has(cursor.id)) {
      keep.add(cursor.id);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
  }
  return keep;
}

/**
 * Depth-first flatten of the visible tree. Collapsed ids hide their whole
 * subtree behind the holder row; sibling groups whose time ranges overlap
 * get lane marks so the renderer can draw the concurrency bracket.
 * `visibleIds` (from the `/` filter) drops everything outside the set.
 */
export function flattenVisible(
  run: Pick<Run, 'spans'>,
  collapsedIds: ReadonlySet<string>,
  visibleIds?: ReadonlySet<string>,
): WaterfallRow[] {
  const childrenMap = buildChildrenMap(run.spans);
  const rows: WaterfallRow[] = [];

  const countSubtree = (id: string): number => {
    const children = childrenMap.get(id) ?? [];
    let n = children.length;
    for (const child of children) n += countSubtree(child.id);
    return n;
  };

  const visit = (siblings: readonly Span[]) => {
    const shown =
      visibleIds === undefined
        ? siblings
        : siblings.filter((s) => visibleIds.has(s.id));
    const lanes = laneMarks(shown);
    shown.forEach((span, i) => {
      const children = childrenMap.get(span.id) ?? [];
      const collapsed = collapsedIds.has(span.id) && children.length > 0;
      rows.push({
        span,
        hasChildren: children.length > 0,
        collapsed,
        hiddenDescendants: collapsed ? countSubtree(span.id) : 0,
        lane: lanes[i] ?? null,
      });
      if (!collapsed && children.length > 0) visit(children);
    });
  };

  visit(childrenMap.get(null) ?? []);
  return rows;
}

/**
 * Consecutive siblings form one concurrent group while each next span starts
 * before the group's running max end. Groups of one get no mark.
 */
export function laneMarks(siblings: readonly Span[]): LaneMark[] {
  const marks: LaneMark[] = new Array(siblings.length).fill(null);
  let groupStart = 0;
  let groupMaxEnd = Number.NEGATIVE_INFINITY;

  const closeGroup = (endExclusive: number) => {
    const size = endExclusive - groupStart;
    if (size >= 2) {
      marks[groupStart] = 'start';
      for (let j = groupStart + 1; j < endExclusive - 1; j++) marks[j] = 'mid';
      marks[endExclusive - 1] = 'end';
    }
  };

  siblings.forEach((span, i) => {
    const start = spanStartMs(span);
    if (i > 0 && start < groupMaxEnd) {
      groupMaxEnd = Math.max(groupMaxEnd, spanEndMs(span));
      return;
    }
    closeGroup(i);
    groupStart = i;
    groupMaxEnd = spanEndMs(span);
  });
  closeGroup(siblings.length);
  return marks;
}

/** Ids for the "collapse all subagents" quick action. */
export function subagentSpanIds(spans: readonly Span[]): string[] {
  return spans.filter((s) => s.kind === 'subagent').map((s) => s.id);
}

/**
 * Subtree economics rollup (D3): cost/tokens/llm-call count of every span's
 * subtree, one O(n) reverse pass — normalizer order guarantees parents
 * precede children, so a reverse walk folds each span into its parent after
 * its own subtree is complete. Cost counts priced spans only (the same
 * `costSource !== 'unknown'` convention as core rollups); excluded calls
 * surface as `unpricedCalls` so badges stay honest ("Σ $4.12 · +2
 * unpriced"). Waterfall container rows (subagent, session) render these —
 * a collapsed subagent is no longer economically opaque.
 */
export interface SubtreeRollup {
  costUSD: number;
  /** llm calls excluded from the dollar figure (costSource unknown). */
  unpricedCalls: number;
  /** Full token quad (incl. reasoning) across the subtree's llm calls. */
  tokens: number;
  llmCalls: number;
}

export function subtreeRollups(
  spans: readonly Span[],
): Map<string, SubtreeRollup> {
  const rollups = new Map<string, SubtreeRollup>();
  const indexById = new Map<string, number>();
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (span) indexById.set(span.id, i);
  }
  const get = (id: string): SubtreeRollup => {
    const existing = rollups.get(id);
    if (existing !== undefined) return existing;
    const fresh = { costUSD: 0, unpricedCalls: 0, tokens: 0, llmCalls: 0 };
    rollups.set(id, fresh);
    return fresh;
  };
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (!span) continue;
    const own = get(span.id);
    if (span.kind === 'llm_call' && span.llm !== undefined) {
      own.llmCalls += 1;
      const t = span.llm.tokens;
      own.tokens +=
        t.input + t.output + t.cacheRead + t.cacheWrite + (t.reasoning ?? 0);
      if (span.llm.costSource === 'unknown') own.unpricedCalls += 1;
      else own.costUSD += span.llm.costUSD ?? 0;
    }
    if (span.parentId !== null && indexById.has(span.parentId)) {
      const parent = get(span.parentId);
      parent.costUSD += own.costUSD;
      parent.unpricedCalls += own.unpricedCalls;
      parent.tokens += own.tokens;
      parent.llmCalls += own.llmCalls;
    }
  }
  // display rounding once, at the boundary
  for (const rollup of rollups.values()) {
    rollup.costUSD = Math.round(rollup.costUSD * 1e6) / 1e6;
  }
  return rollups;
}

/**
 * The collapsed ids that hide any of `targets` — their proper ancestors
 * present in `collapsed`. Expanding exactly these reveals the targets
 * (insight evidence, a deep-linked span) without touching unrelated
 * collapsed subtrees.
 */
export function collapsedAncestorsOf(
  spans: readonly Span[],
  targets: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  if (targets.size === 0 || collapsed.size === 0) return out;
  const byId = new Map(spans.map((s) => [s.id, s]));
  for (const id of targets) {
    let cursor = byId.get(id);
    while (cursor !== undefined && cursor.parentId !== null) {
      cursor = byId.get(cursor.parentId);
      if (cursor !== undefined && collapsed.has(cursor.id)) out.add(cursor.id);
    }
  }
  return out;
}
