import { identityContext, toolIdentity } from '@runray/core/tools';
import type { Run, Span } from '@runray/schema';
import { computeTimeRange, spanEndMs, spanStartMs } from './waterfall';

/**
 * Wall-clock decomposition for the Time view (E2): an interval sweep over
 * the run's span boundaries in which concurrent spans can never
 * double-count an instant — parallel work compresses into the same wall
 * time and is reported separately as a parallelism factor. Categories, in
 * precedence order per elementary interval: any llm active → model wait
 * (the model is what you are billed to wait for), else any tool active →
 * tool execution, else a call that waits on the person active → waiting,
 * else a gap — at or above the idle threshold → idle, below →
 * coordination. A tool that runs while a question is pending is execution:
 * the person waiting is not what the session was doing.
 */

/**
 * Display segmentation default. DELIBERATELY distinct from core's
 * `idleCacheExpiry.minIdleMinutes` (5 min): that one is a provider
 * cache-TTL economics constant for the insight rule; this one merely
 * separates "thinking/typing" gaps from genuinely idle stretches on a
 * descriptive chart (design E3 — sharing a value would corrupt one
 * semantic or the other).
 */
export const DEFAULT_IDLE_GAP_MS = 60_000;

export type TimeCategory =
  | 'model'
  | 'tool'
  | 'waiting'
  | 'coordination'
  | 'idle';

/** Display order: what the session did, then what nobody did. */
export const TIME_CATEGORIES: readonly TimeCategory[] = [
  'model',
  'tool',
  'waiting',
  'coordination',
  'idle',
];

export interface TimeSegment {
  category: TimeCategory;
  start: number;
  end: number;
}

export interface TimeBreakdown {
  segments: TimeSegment[];
  totals: Record<TimeCategory, number>;
  wallClockMs: number;
  /**
   * Σ active-interval durations ÷ their covered wall-clock — "×1.8
   * parallel". 1 when nothing overlaps or nothing ran. Model and tool work
   * only: waiting on the person is nobody working.
   */
  parallelism: number;
}

const TOOL_KINDS = new Set<Span['kind']>(['tool_call', 'mcp_call', 'hook']);

type Active = 'llm' | 'tool' | 'wait';

interface Interval {
  start: number;
  end: number;
  kind: Active;
}

/**
 * Closed intervals only — in-progress spans contribute zero length. A tool
 * call whose resolved activity is "human" (a question to the person, a
 * plan awaiting approval) is waiting, not execution.
 */
function activeIntervals(run: Run): Interval[] {
  const context = identityContext(run.spans);
  const out: Interval[] = [];
  for (const span of run.spans) {
    const isLlm = span.kind === 'llm_call';
    if (!isLlm && !TOOL_KINDS.has(span.kind)) continue;
    const start = spanStartMs(span);
    const end = spanEndMs(span);
    if (end <= start) continue;
    const kind: Active = isLlm
      ? 'llm'
      : toolIdentity(span, context)?.activity === 'human'
        ? 'wait'
        : 'tool';
    out.push({ start, end, kind });
  }
  return out;
}

export function timeBreakdown(
  run: Run,
  idleGapMs = DEFAULT_IDLE_GAP_MS,
): TimeBreakdown {
  const range = computeTimeRange(run.spans);
  const intervals = activeIntervals(run);

  // Event sweep: instead of rescanning every interval per elementary segment
  // (O(segments·intervals) — a main-thread stall at the 10k-span scale), emit
  // +1/-1 events per kind at each interval's clamped bounds and walk the
  // boundaries maintaining active counts. O(n log n), identical segmentation.
  const boundaries = new Set<number>([range.start, range.end]);
  const events = new Map<number, Record<Active, number>>();
  const bump = (t: number, kind: Active, delta: number) => {
    const e = events.get(t) ?? { llm: 0, tool: 0, wait: 0 };
    e[kind] += delta;
    events.set(t, e);
  };
  for (const i of intervals) {
    const s = Math.max(range.start, i.start);
    const e = Math.min(range.end, i.end);
    boundaries.add(s);
    boundaries.add(e);
    if (e <= s) continue;
    bump(s, i.kind, 1);
    bump(e, i.kind, -1);
  }
  const points = [...boundaries].sort((a, b) => a - b);

  const raw: TimeSegment[] = [];
  const active: Record<Active, number> = { llm: 0, tool: 0, wait: 0 };
  for (let p = 1; p < points.length; p++) {
    const start = points[p - 1] as number;
    const end = points[p] as number;
    // apply events at the segment's start before classifying it
    const ev = events.get(start);
    if (ev !== undefined) {
      active.llm += ev.llm;
      active.tool += ev.tool;
      active.wait += ev.wait;
    }
    if (end <= start) continue;
    const category: TimeCategory =
      active.llm > 0
        ? 'model'
        : active.tool > 0
          ? 'tool'
          : active.wait > 0
            ? 'waiting'
            : end - start >= idleGapMs
              ? 'idle'
              : 'coordination';
    const prev = raw[raw.length - 1];
    if (
      prev !== undefined &&
      prev.category === category &&
      prev.end === start
    ) {
      prev.end = end;
    } else {
      raw.push({ category, start, end });
    }
  }

  const totals: Record<TimeCategory, number> = {
    model: 0,
    tool: 0,
    waiting: 0,
    coordination: 0,
    idle: 0,
  };
  for (const seg of raw) totals[seg.category] += seg.end - seg.start;

  const activeSum = intervals.reduce(
    (acc, i) => (i.kind === 'wait' ? acc : acc + (i.end - i.start)),
    0,
  );
  const covered = totals.model + totals.tool;
  return {
    segments: raw,
    totals,
    wallClockMs: range.end - range.start,
    parallelism: covered > 0 ? activeSum / covered : 1,
  };
}

export interface ToolDurationStat {
  name: string;
  calls: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Nearest-rank percentile over a sorted-ascending array (deterministic). */
function nearestRank(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(1, Math.ceil((percentile / 100) * sorted.length)) - 1;
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

function statsFromDurations(byName: Map<string, number[]>): ToolDurationStat[] {
  const out: ToolDurationStat[] = [];
  for (const [name, durations] of byName) {
    const sorted = [...durations].sort((a, b) => a - b);
    out.push({
      name,
      calls: sorted.length,
      p50Ms: nearestRank(sorted, 50),
      p95Ms: nearestRank(sorted, 95),
      maxMs: sorted[sorted.length - 1] ?? 0,
    });
  }
  out.sort((a, b) => b.p95Ms - a.p95Ms || (a.name < b.name ? -1 : 1));
  return out;
}

function collectDurations(run: Run, byName: Map<string, number[]>): void {
  for (const span of run.spans) {
    if (!TOOL_KINDS.has(span.kind)) continue;
    const duration = span.durationMs ?? spanEndMs(span) - spanStartMs(span);
    if (duration <= 0) continue;
    const list = byName.get(span.name) ?? [];
    list.push(duration);
    byName.set(span.name, list);
  }
}

/**
 * Cross-run merge for the dashboard By-tool card's duration column, keyed
 * by harness tool name, p95-first (stable ties by name). The per-run view
 * no longer keys by harness name: the Time tab lists tools by resolved
 * identity through `@runray/core/tools`. This one stays until the card
 * moves to tool ids in its own change.
 */
export function toolDurationStatsAcrossRuns(
  runs: readonly Run[],
): ToolDurationStat[] {
  const byName = new Map<string, number[]>();
  for (const run of runs) collectDurations(run, byName);
  return statsFromDurations(byName);
}
