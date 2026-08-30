import type { Run, Span } from '@runray/schema';
import { computeTimeRange, spanEndMs, spanStartMs } from './waterfall';

/**
 * Wall-clock decomposition for the Time view (E2): an interval sweep over
 * the run's span boundaries in which concurrent spans can never
 * double-count an instant — parallel work compresses into the same wall
 * time and is reported separately as a parallelism factor. Categories, in
 * precedence order per elementary interval: any llm active → model wait
 * (the model is what you are billed to wait for), else any tool active →
 * tool execution, else a gap — at or above the idle threshold → idle,
 * below → coordination.
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

export type TimeCategory = 'model' | 'tool' | 'coordination' | 'idle';

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
   * parallel". 1 when nothing overlaps or nothing ran.
   */
  parallelism: number;
}

const TOOL_KINDS = new Set<Span['kind']>(['tool_call', 'mcp_call', 'hook']);

interface Interval {
  start: number;
  end: number;
  llm: boolean;
}

/** Closed intervals only — in-progress spans contribute zero length. */
function activeIntervals(run: Run): Interval[] {
  const out: Interval[] = [];
  for (const span of run.spans) {
    const isLlm = span.kind === 'llm_call';
    if (!isLlm && !TOOL_KINDS.has(span.kind)) continue;
    const start = spanStartMs(span);
    const end = spanEndMs(span);
    if (end <= start) continue;
    out.push({ start, end, llm: isLlm });
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
  // +1/-1 llm/tool events at each interval's clamped bounds and walk the
  // boundaries maintaining active counts. O(n log n), identical segmentation.
  const boundaries = new Set<number>([range.start, range.end]);
  const events = new Map<number, { llm: number; tool: number }>();
  const bump = (t: number, llm: number, tool: number) => {
    const e = events.get(t) ?? { llm: 0, tool: 0 };
    e.llm += llm;
    e.tool += tool;
    events.set(t, e);
  };
  for (const i of intervals) {
    const s = Math.max(range.start, i.start);
    const e = Math.min(range.end, i.end);
    boundaries.add(s);
    boundaries.add(e);
    if (e <= s) continue;
    bump(s, i.llm ? 1 : 0, i.llm ? 0 : 1);
    bump(e, i.llm ? -1 : 0, i.llm ? 0 : -1);
  }
  const points = [...boundaries].sort((a, b) => a - b);

  const raw: TimeSegment[] = [];
  let llmCount = 0;
  let toolCount = 0;
  for (let p = 1; p < points.length; p++) {
    const start = points[p - 1] as number;
    const end = points[p] as number;
    // apply events at the segment's start before classifying it
    const ev = events.get(start);
    if (ev !== undefined) {
      llmCount += ev.llm;
      toolCount += ev.tool;
    }
    if (end <= start) continue;
    const category: TimeCategory =
      llmCount > 0
        ? 'model'
        : toolCount > 0
          ? 'tool'
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
    coordination: 0,
    idle: 0,
  };
  for (const seg of raw) totals[seg.category] += seg.end - seg.start;

  const activeSum = intervals.reduce((acc, i) => acc + (i.end - i.start), 0);
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

/** Slowest tools of one run, p95-first (stable ties by name). */
export function toolDurationStats(run: Run): ToolDurationStat[] {
  const byName = new Map<string, number[]>();
  collectDurations(run, byName);
  return statsFromDurations(byName);
}

/** Cross-run merge for the dashboard By-tool card's duration column. */
export function toolDurationStatsAcrossRuns(
  runs: readonly Run[],
): ToolDurationStat[] {
  const byName = new Map<string, number[]>();
  for (const run of runs) collectDurations(run, byName);
  return statsFromDurations(byName);
}
