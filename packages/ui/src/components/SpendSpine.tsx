import type { Run } from '@runray/schema';
import { useMemo, useRef, useState } from 'react';
import { formatClock, formatUSD } from '../lib/format';
import {
  buildCostSeries,
  buildSpineSegments,
  cumulativeCostAt,
} from '../lib/spine';
import { tourAttr } from '../lib/tour-attr';
import type { TimeRange } from '../lib/waterfall';

/**
 * Spend Spine (03-design.md §1): the signature element. A 24px vertical
 * gutter where y = session time and x = cumulative cost; steep (hot)
 * segments glow amber→red. Hover reads "at 02:14 — $1.83"; click scrolls
 * the waterfall to that moment. Quiet when idle — the heat IS the message.
 */

const HEAT_VAR = [
  'var(--color-heat-0)',
  'var(--color-heat-1)',
  'var(--color-heat-2)',
  'var(--color-heat-3)',
] as const;

/** Cost axis inset inside the 24px gutter: $0 → x=3, run total → x=21. */
const X_MIN = 3;
const X_MAX = 21;
const VIEW_H = 1000;

export interface ViewportFraction {
  f0: number;
  f1: number;
}

export function SpendSpine({
  run,
  range,
  positionFraction,
  viewportFraction,
  onNavigate,
}: {
  run: Run;
  range: TimeRange;
  /** Fraction of run time currently at the top of the waterfall viewport. */
  positionFraction: number;
  /** Visible time range fraction in the viewport. */
  viewportFraction?: ViewportFraction;
  onNavigate: (timeMs: number) => void;
}) {
  const series = useMemo(() => buildCostSeries(run.spans), [run.spans]);
  const segments = useMemo(
    () => buildSpineSegments(series, range),
    [series, range],
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ y: number; label: string } | null>(null);

  const x = (c: number) => X_MIN + c * (X_MAX - X_MIN);

  const fractionAt = (clientY: number): number => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.height === 0) return 0;
    return Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  };

  return (
    <div {...tourAttr('spend-spine')} className="relative flex shrink-0">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only affordance; keyboard access ships as the spine's data-table fallback (task 3.8) */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: same — keyboard equivalent is the 3.8 data-table fallback */}
      <div
        ref={wrapRef}
        className="w-6 cursor-pointer"
        onMouseMove={(e) => {
          const f = fractionAt(e.clientY);
          const t = range.start + f * (range.end - range.start);
          setHover({
            y: e.clientY,
            label: `at ${formatClock(t - range.start)} — ${formatUSD(cumulativeCostAt(series, t))}`,
          });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const f = fractionAt(e.clientY);
          onNavigate(range.start + f * (range.end - range.start));
        }}
      >
        <svg
          role="img"
          aria-label={`Spend Spine: cumulative cost over the session, total ${formatUSD(
            run.totals.costUSD.total,
          )}. Click to jump the timeline.`}
          viewBox={`0 0 24 ${VIEW_H}`}
          preserveAspectRatio="none"
          className="block h-full w-full"
        >
          {/* faint $0 axis */}
          <line
            x1={X_MIN}
            y1={0}
            x2={X_MIN}
            y2={VIEW_H}
            stroke="var(--color-border)"
            vectorEffect="non-scaling-stroke"
          />
          {segments.map((seg) => (
            <line
              key={seg.f0}
              x1={x(seg.c0)}
              y1={seg.f0 * VIEW_H}
              x2={x(seg.c1)}
              y2={seg.f1 * VIEW_H}
              stroke={HEAT_VAR[seg.heat]}
              strokeWidth={seg.heat > 0 ? 2 : 1.25}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* visible viewport range indicator */}
          {viewportFraction !== undefined && (
            <rect
              x={0}
              y={Math.min(viewportFraction.f0, viewportFraction.f1) * VIEW_H}
              width={24}
              height={Math.max(
                3,
                Math.abs(viewportFraction.f1 - viewportFraction.f0) * VIEW_H,
              )}
              fill="var(--color-brand)"
              fillOpacity={0.15}
            />
          )}
          {/* current waterfall position */}
          <line
            x1={0}
            y1={positionFraction * VIEW_H}
            x2={24}
            y2={positionFraction * VIEW_H}
            stroke="var(--color-brand)"
            strokeWidth={2}
            strokeOpacity={0.95}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      {hover !== null && (
        <div
          className="pointer-events-none fixed z-50 translate-y-1/2 whitespace-nowrap rounded-control border border-border bg-surface-2 px-2 py-1 font-mono text-label text-text shadow-popover"
          style={{
            left: (wrapRef.current?.getBoundingClientRect().right ?? 0) + 8,
            top: hover.y - 22,
          }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}
