import {
  DEFAULT_SEVERITY_THRESHOLDS,
  type LeakEvent,
  type RunWaste,
} from '@runray/core/waste';
import type { Insight, Run } from '@runray/schema';
import { useMemo } from 'react';
import { formatDuration, formatUSD } from '../lib/format';
import { formatOffset } from '../lib/triage';
import { tok } from '../lib/waste';
import { useAppStore } from '../store';

/**
 * The leak rail (visualizer "Waste tab" — leaks on the clock): the
 * session's time axis with the context each model call carried drawn as
 * an area, and a bar for every burned finding at the moment it happened,
 * sized by its amount. Idle gaps are shaded, compactions marked apart (a
 * new prefix written once is cheap, and a lever), and a guide sits at
 * ~200k tokens, where re-writes of a large history start. One hue for
 * money: burned is heat, the curve is brand, nothing here is severity.
 * A bar opens its finding on the timeline. Cents — folded groups, and
 * any burn under the warning floor — are left off the rail.
 */

const W = 1000;
const H = 120;
const TOP = 14;
const BASE = 96;
const BUCKETS = 160;
const GUIDE_TOKENS = 200_000;
/** A pause between two calls longer than this (and than 5% of the run)
 * breaks the curve: nothing was in the model's context meanwhile. */
const HOLE_MIN_MS = 5 * 60_000;

/** Tick step: about five labels, on a clock-friendly unit. */
function tickStepMs(durationMs: number): number {
  const steps = [
    60_000,
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
    3_600_000,
    2 * 3_600_000,
    5 * 3_600_000,
    10 * 3_600_000,
    24 * 3_600_000,
  ];
  for (const s of steps) if (durationMs / s <= 6) return s;
  return steps[steps.length - 1] as number;
}

export function LeakRail({ run, waste }: { run: Run; waste: RunWaste }) {
  const showInsight = useAppStore((s) => s.showInsight);
  const navigateTo = useAppStore((s) => s.navigateTo);
  const durationMs = Math.max(
    1,
    run.durationMs ??
      Math.max(
        ...waste.context.map((c) => c.offsetMs),
        ...waste.events.map((e) => e.endMs),
      ),
  );
  const folded = useMemo(
    () => new Set(waste.burned.filter((g) => g.folded).map((g) => g.ruleId)),
    [waste.burned],
  );
  const events = useMemo(
    () => waste.events.filter((e) => !folded.has(e.ruleId)),
    [waste.events, folded],
  );
  const bars = events.filter(
    (e) =>
      e.kind === 'burn' && e.usd >= DEFAULT_SEVERITY_THRESHOLDS.warningFloorUSD,
  );
  const idles = events.filter((e) => e.kind === 'idle');
  const compactions = events.filter((e) => e.kind === 'compaction');
  const maxUsd = Math.max(0.01, ...bars.map((b) => b.usd));
  const maxTokens = Math.max(
    GUIDE_TOKENS,
    ...waste.context.map((c) => c.tokens),
  );
  const x = (ms: number) =>
    (Math.min(durationMs, Math.max(0, ms)) / durationMs) * W;
  const y = (tokens: number) => BASE - (tokens / maxTokens) * (BASE - TOP);

  // the context curve: the largest call per bucket, split where a long
  // pause separates two calls (an idle gap draws as a hole, not a slope)
  const segments = useMemo(() => {
    const hole = Math.max(HOLE_MIN_MS, durationMs * 0.05);
    const out: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> = [];
    let curBucket = -1;
    let prevMs = Number.NEGATIVE_INFINITY;
    for (const c of waste.context) {
      if (c.offsetMs - prevMs > hole && cur.length > 0) {
        out.push(cur);
        cur = [];
        curBucket = -1;
      }
      prevMs = c.offsetMs;
      const b = Math.min(
        BUCKETS - 1,
        Math.floor((c.offsetMs / durationMs) * BUCKETS),
      );
      const last = cur[cur.length - 1];
      if (b === curBucket && last !== undefined) {
        last[1] = Math.max(last[1], c.tokens);
      } else {
        cur.push([((b + 0.5) / BUCKETS) * W, c.tokens]);
        curBucket = b;
      }
    }
    if (cur.length > 0) out.push(cur);
    return out;
  }, [waste.context, durationMs]);

  const byId = useMemo(
    () => new Map(run.insights.map((i) => [i.id, i])),
    [run.insights],
  );
  const open = (e: LeakEvent) => {
    const insight: Insight | undefined = byId.get(e.insightId);
    if (insight === undefined) return;
    showInsight(insight, e.spanId);
    navigateTo({ view: 'timeline', runId: run.id });
  };

  const step = tickStepMs(durationMs);
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs; t += step) ticks.push(t);

  const summary = `${bars.length} burned ${bars.length === 1 ? 'finding' : 'findings'} on the session's time axis${idles.length > 0 ? `, ${idles.length} idle ${idles.length === 1 ? 'gap' : 'gaps'}` : ''}${compactions.length > 0 ? `, ${compactions.length} ${compactions.length === 1 ? 'compaction' : 'compactions'}` : ''}, over the context size of ${waste.context.length} model calls`;

  return (
    <div>
      <p className="flex justify-between micro-label text-text-faint">
        <span>Where it leaked · {formatDuration(durationMs)}</span>
        <span>bar height = amount · click a bar to open the finding</span>
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1.5 block h-auto w-full"
        role="img"
        aria-label={summary}
      >
        <title>{summary}</title>
        {idles.map((e) => (
          <rect
            key={`idle-${e.insightId}`}
            x={x(e.startMs).toFixed(1)}
            y={TOP}
            width={Math.max(1, x(e.endMs) - x(e.startMs)).toFixed(1)}
            height={BASE - TOP}
            fill="var(--color-heat-1)"
            fillOpacity={0.12}
          >
            <title>
              {`idle ${formatDuration(e.endMs - e.startMs)} · ${formatOffset(e.startMs)}–${formatOffset(e.endMs)} · the cache expired`}
            </title>
          </rect>
        ))}
        {segments.map((seg) => {
          const first = seg[0] as [number, number];
          const last = seg[seg.length - 1] as [number, number];
          const line = seg
            .map(([px, v]) => `${px.toFixed(1)},${y(v).toFixed(1)}`)
            .join(' L');
          return (
            <g key={`seg-${first[0]}`}>
              <path
                d={`M${first[0].toFixed(1)},${BASE} L${line} L${last[0].toFixed(1)},${BASE} Z`}
                fill="var(--color-brand)"
                fillOpacity={0.16}
              />
              <path
                d={`M${line}`}
                fill="none"
                stroke="var(--color-brand-bright)"
                strokeOpacity={0.7}
                strokeWidth={1}
              />
            </g>
          );
        })}
        <line
          x1={0}
          x2={W}
          y1={y(GUIDE_TOKENS).toFixed(1)}
          y2={y(GUIDE_TOKENS).toFixed(1)}
          stroke="var(--color-text-faint)"
          strokeDasharray="3 4"
          strokeWidth={1}
        />
        <text
          x={W - 4}
          y={(y(GUIDE_TOKENS) - 4).toFixed(1)}
          textAnchor="end"
          className="fill-text-faint font-mono text-[9px]"
        >
          {tok(GUIDE_TOKENS)}
        </text>
        <text
          x={4}
          y={TOP + 8}
          className="fill-text-faint font-mono text-[9px]"
        >
          {tok(maxTokens)}
        </text>
        {compactions.map((e) => (
          <line
            key={`c-${e.insightId}`}
            x1={x(e.startMs).toFixed(1)}
            x2={x(e.startMs).toFixed(1)}
            y1={BASE - 10}
            y2={BASE + 2}
            stroke="var(--color-cache-savings)"
            strokeWidth={2}
          >
            <title>{`${formatOffset(e.startMs)} · compaction · ${formatUSD(e.usd)}`}</title>
          </line>
        ))}
        {bars.map((e) => {
          const h = Math.max(3, (e.usd / maxUsd) * (BASE - TOP - 6));
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG bar; the same finding is a button in the groups below
            <rect
              key={`b-${e.insightId}`}
              role="button"
              tabIndex={0}
              aria-label={`${formatOffset(e.startMs)} · ${e.label} · ${formatUSD(e.usd)}`}
              x={(x(e.startMs) - 2).toFixed(1)}
              y={(BASE - h).toFixed(1)}
              width={4}
              height={h.toFixed(1)}
              rx={1}
              fill="var(--color-heat-2)"
              className="cursor-pointer transition-opacity duration-150 ease-out hover:opacity-70 focus-visible:outline-none focus-visible:opacity-70"
              onClick={() => open(e)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  open(e);
                }
              }}
            >
              <title>{`${formatOffset(e.startMs)} · ${e.label} · ${formatUSD(e.usd)}`}</title>
            </rect>
          );
        })}
        <line
          x1={0}
          x2={W}
          y1={BASE}
          y2={BASE}
          stroke="var(--color-border-slate)"
          strokeWidth={1}
        />
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={x(t).toFixed(1)}
              x2={x(t).toFixed(1)}
              y1={BASE}
              y2={BASE + 4}
              stroke="var(--color-border-slate)"
            />
            <text
              x={x(t).toFixed(1)}
              y={BASE + 15}
              textAnchor={t === 0 ? 'start' : 'middle'}
              className="fill-text-faint font-mono text-[10px]"
            >
              {formatOffset(t)}
            </text>
          </g>
        ))}
        <text
          x={W}
          y={BASE + 15}
          textAnchor="end"
          className="fill-text-faint font-mono text-[10px]"
        >
          {formatOffset(durationMs)}
        </text>
      </svg>
      <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-label text-text-dim">
        <span className="inline-flex items-center gap-1.5">
          <i
            aria-hidden
            className="inline-block h-2.5 w-1 rounded-[1px] bg-heat-2"
          />
          burned · height is the amount
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i
            aria-hidden
            className="inline-block h-2.5 w-0.5 bg-cache-savings"
          />
          compaction · new prefix written once
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block h-2.5 w-2.5 bg-heat-1/25" />
          idle gap · cache expired
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="inline-block h-2.5 w-2.5 bg-brand/30" />
          context size per call
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i
            aria-hidden
            className="inline-block w-3 border-t border-dashed border-text-faint"
          />
          ~{tok(GUIDE_TOKENS)} · re-writes of a large history start above it
        </span>
      </p>
    </div>
  );
}
