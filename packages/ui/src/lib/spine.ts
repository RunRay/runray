/**
 * Spend Spine data (03-design.md §1, §4.2): cost accretes at each priced
 * llm span's END (you pay when the call completes), sampled into uniform
 * time segments. Heat = segment spend rate relative to the hottest segment
 * of the run — the spine answers "where did it burn", not absolute $/s.
 */

import type { Span } from '@runray/schema';
import type { TimeRange } from './waterfall';
import { spanEndMs } from './waterfall';

export interface CostPoint {
  /** Epoch ms when the cumulative total reached `cumulative`. */
  t: number;
  cumulative: number;
}

export type HeatLevel = 0 | 1 | 2 | 3;

export interface SpineSegment {
  /** Time fractions of the run (0 = start, 1 = end). */
  f0: number;
  f1: number;
  /** Cumulative-cost fractions of the run total (0..1; 0 when total is 0). */
  c0: number;
  c1: number;
  heat: HeatLevel;
}

/** Priced llm spans → cumulative step series, sorted by completion time. */
export function buildCostSeries(spans: readonly Span[]): CostPoint[] {
  const events: { t: number; cost: number }[] = [];
  for (const span of spans) {
    const cost = span.llm?.costUSD;
    if (cost === undefined || span.llm?.costSource === 'unknown') continue;
    events.push({ t: spanEndMs(span), cost });
  }
  events.sort((a, b) => a.t - b.t);
  let cumulative = 0;
  return events.map((e) => {
    cumulative += e.cost;
    return { t: e.t, cumulative };
  });
}

/** Cumulative cost at time `t` (step function; 0 before the first event). */
export function cumulativeCostAt(
  series: readonly CostPoint[],
  t: number,
): number {
  let lo = 0;
  let hi = series.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = series[mid];
    if (point === undefined) break;
    if (point.t <= t) {
      result = point.cumulative;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * Uniform time sampling into `sampleCount` segments. Heat buckets are
 * relative to the steepest segment: 0 = no spend, then thirds of max.
 */
export function buildSpineSegments(
  series: readonly CostPoint[],
  range: TimeRange,
  sampleCount = 160,
): SpineSegment[] {
  const total =
    series.length > 0 ? (series[series.length - 1]?.cumulative ?? 0) : 0;
  const duration = range.end - range.start;
  const costs: number[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    costs.push(
      cumulativeCostAt(series, range.start + (duration * i) / sampleCount),
    );
  }

  let maxDelta = 0;
  for (let i = 0; i < sampleCount; i++) {
    maxDelta = Math.max(maxDelta, (costs[i + 1] ?? 0) - (costs[i] ?? 0));
  }

  const segments: SpineSegment[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const a = costs[i] ?? 0;
    const b = costs[i + 1] ?? 0;
    const delta = b - a;
    let heat: HeatLevel = 0;
    if (delta > 0 && maxDelta > 0) {
      const rel = delta / maxDelta;
      heat = rel > 2 / 3 ? 3 : rel > 1 / 3 ? 2 : 1;
    }
    segments.push({
      f0: i / sampleCount,
      f1: (i + 1) / sampleCount,
      c0: total > 0 ? a / total : 0,
      c1: total > 0 ? b / total : 0,
      heat,
    });
  }
  return segments;
}
