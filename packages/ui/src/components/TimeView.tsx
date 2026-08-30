import type { Run } from '@runray/schema';
import { useMemo } from 'react';
import { formatDuration, formatUSD } from '../lib/format';
import {
  DEFAULT_IDLE_GAP_MS,
  type TimeCategory,
  timeBreakdown,
  toolDurationStats,
} from '../lib/time-breakdown';
import { useAppStore } from '../store';
import { ContextualHint } from './ContextualHint';

/**
 * The Time tab (E2): where the wall-clock went — model wait, tool
 * execution, coordination, idle — via the no-double-count interval sweep;
 * parallel compression reads as a separate ×N chip, never bar inflation.
 * Time answers a different question than money, so it is a sibling tab of
 * Cost and Timeline, not a buried section.
 */

const CATEGORY_LABEL: Record<TimeCategory, string> = {
  model: 'model wait',
  tool: 'tool execution',
  coordination: 'coordination',
  idle: 'idle',
};

const CATEGORY_BAR: Record<TimeCategory, string> = {
  model: 'bg-brass/70',
  tool: 'bg-surface-2',
  coordination: 'bg-border-slate',
  idle: 'bg-heat-1/40',
};

const CATEGORY_DOT: Record<TimeCategory, string> = {
  model: 'bg-brass/70',
  tool: 'bg-surface-2',
  coordination: 'bg-border-slate',
  idle: 'bg-heat-1/40',
};

const ORDER: TimeCategory[] = ['model', 'tool', 'coordination', 'idle'];

export function TimeView({ run }: { run: Run }) {
  const breakdown = useMemo(() => timeBreakdown(run), [run]);
  const tools = useMemo(() => toolDurationStats(run).slice(0, 8), [run]);
  const idleFindings = useMemo(
    () => run.insights.filter((i) => i.ruleId === 'idle-cache-expiry'),
    [run.insights],
  );
  const activateInsight = useAppStore((s) => s.activateInsight);
  const wall = breakdown.wallClockMs;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
      <ContextualHint hintKey="time-view" />
      <section className="rounded border border-border-slate bg-surface-container-low p-4 shadow-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="micro-label text-text-faint">
            wall-clock · {formatDuration(wall)}
          </p>
          {breakdown.parallelism > 1.05 && (
            <span
              className="rounded-control bg-surface-2 px-2 py-0.5 font-mono text-label text-text-dim"
              title="Σ active span time ÷ covered wall-clock — parallel work compresses into the same wall time"
            >
              ×{breakdown.parallelism.toFixed(1)} parallel
            </span>
          )}
        </div>

        {/* 100%-wall-clock stacked strip */}
        <div
          className="mt-2 flex h-6 w-full overflow-hidden rounded-control border border-border-slate"
          role="img"
          aria-label={ORDER.map(
            (c) =>
              `${CATEGORY_LABEL[c]} ${formatDuration(breakdown.totals[c])}`,
          ).join(', ')}
        >
          {breakdown.segments.map((seg) => (
            <div
              key={`${seg.start}`}
              className={CATEGORY_BAR[seg.category]}
              style={{ width: `${((seg.end - seg.start) / wall) * 100}%` }}
              title={`${CATEGORY_LABEL[seg.category]} · ${formatDuration(seg.end - seg.start)}`}
            />
          ))}
        </div>

        <table className="mt-3 w-max border-collapse text-label">
          <tbody>
            {ORDER.map((category) => (
              <tr key={category}>
                <td className="flex items-center gap-1.5 py-0.5 pr-4 text-text-dim">
                  <i
                    aria-hidden
                    className={`inline-block h-2 w-2 rounded-full ${CATEGORY_DOT[category]}`}
                  />
                  {CATEGORY_LABEL[category]}
                </td>
                <td className="py-0.5 pr-4 text-right font-mono text-text">
                  {formatDuration(breakdown.totals[category])}
                </td>
                <td className="py-0.5 text-right font-mono text-text-faint">
                  {wall > 0
                    ? `${Math.round((breakdown.totals[category] / wall) * 100)}%`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 micro-label text-text-faint">
          idle = gaps ≥ {DEFAULT_IDLE_GAP_MS / 1000}s (display threshold — the
          cache-expiry insight uses the provider TTL, a different constant)
        </p>
      </section>

      {idleFindings.length > 0 && (
        <section className="rounded border border-border-slate bg-surface-container-low p-4 shadow-card">
          <p className="micro-label text-text-faint">
            idle gaps that expired the cache
          </p>
          <ul className="mt-1">
            {idleFindings.map((insight) => (
              <li
                key={insight.id}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-3 border-t border-dashed border-border-slate py-1.5 text-body first:border-t-0"
              >
                <span className="min-w-0 truncate text-text">
                  {insight.title}
                </span>
                <span className="whitespace-nowrap font-mono text-label text-heat-2">
                  {formatUSD(insight.estimatedWasteUSD ?? 0)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    activateInsight(insight);
                    useAppStore
                      .getState()
                      .navigateTo({ view: 'timeline', runId: run.id });
                  }}
                  className="rounded border border-border-slate bg-surface px-2 py-0.5 text-label text-on-surface-variant transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-on-surface active:bg-bg-deep-gray"
                >
                  View evidence
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tools.length > 0 && (
        <section className="rounded border border-border-slate bg-surface-container-low p-4 shadow-card">
          <p className="micro-label text-text-faint">slowest tools · p95</p>
          <table className="mt-1 w-full border-collapse text-label">
            <thead>
              <tr className="micro-label text-text-faint">
                <th className="pb-1 text-left font-normal">tool</th>
                <th className="pb-1 text-right font-normal">calls</th>
                <th className="pb-1 text-right font-normal">p50</th>
                <th className="pb-1 text-right font-normal">p95</th>
                <th className="pb-1 text-right font-normal">max</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.name} className="border-t border-border-slate">
                  <td className="max-w-[240px] truncate py-1 pr-3 font-mono text-text">
                    {tool.name}
                  </td>
                  <td className="py-1 text-right font-mono text-text-dim">
                    {tool.calls}
                  </td>
                  <td className="py-1 text-right font-mono text-text-dim">
                    {formatDuration(tool.p50Ms)}
                  </td>
                  <td className="py-1 text-right font-mono text-text">
                    {formatDuration(tool.p95Ms)}
                  </td>
                  <td className="py-1 text-right font-mono text-text-faint">
                    {formatDuration(tool.maxMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
