import { toolUsage } from '@runray/core/tools';
import type { Run } from '@runray/schema';
import { useMemo, useState } from 'react';
import { formatDuration, formatUSD } from '../lib/format';
import {
  DEFAULT_IDLE_GAP_MS,
  TIME_CATEGORIES,
  type TimeCategory,
  timeBreakdown,
} from '../lib/time-breakdown';
import { activityParts, runToolUsage } from '../lib/tool-usage';
import { useAppStore } from '../store';
import { ActivityBar } from './ActivityBar';
import { ContextualHint } from './ContextualHint';
import { ToolTable } from './ToolTable';

/**
 * The Time tab (E2): where the wall-clock went — model wait, tool
 * execution, waiting on the person, coordination, idle — via the
 * no-double-count interval sweep;
 * parallel compression reads as a separate ×N chip, never bar inflation.
 * Time answers a different question than money, so it is a sibling tab of
 * Cost and Timeline, not a buried section.
 */

const CATEGORY_LABEL: Record<TimeCategory, string> = {
  model: 'model wait',
  tool: 'tool execution',
  waiting: 'waiting on you',
  coordination: 'coordination',
  idle: 'idle',
};

/** One fill per segment, shared by the strip and its legend swatch. */
const CATEGORY_FILL: Record<TimeCategory, string> = {
  model: 'bg-brass/70',
  tool: 'bg-surface-2',
  waiting: 'hatch-waiting',
  coordination: 'bg-border-slate',
  idle: 'bg-heat-1/40',
};

const CATEGORY_NOTE: Partial<Record<TimeCategory, string>> = {
  waiting:
    'A question or a plan was waiting for your answer and nothing else was running.',
};

const ORDER = TIME_CATEGORIES;

export function TimeView({
  run,
  manifest: propManifest,
}: {
  run: Run;
  manifest?: import('../lib/load').SanitizationManifest;
}) {
  const storeManifest = useAppStore((s) => s.viewConfig?.manifest);
  const manifest = propManifest ?? storeManifest;
  const breakdown = useMemo(() => timeBreakdown(run), [run]);
  const usage = useMemo(() => runToolUsage(run), [run]);
  const parts = useMemo(() => activityParts(usage), [usage]);
  // the selection belongs to one run: another run starts unfiltered
  const [selection, setSelection] = useState<{ run: Run; part: string } | null>(
    null,
  );
  const selectedPart =
    selection?.run === run && parts.some((p) => p.id === selection.part)
      ? selection.part
      : null;
  const current = parts.find((p) => p.id === selectedPart);
  const hasToolSpans =
    usage.calls + usage.agents.calls + usage.hooks.calls + usage.waiting.calls >
    0;
  const pruned =
    manifest?.profile === 'metadata-only' || manifest?.spansPruned === true;
  // a selected part narrows the rows; shares keep the run-wide denominator
  const shownRows = useMemo(
    () =>
      current === undefined
        ? usage.rows
        : toolUsage(run.spans, { activities: current.activities }).rows,
    [run, usage, current],
  );
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
              title="Total active span time divided by wall-clock duration. Parallel work compresses into the same elapsed time."
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
              className={CATEGORY_FILL[seg.category]}
              style={{ width: `${((seg.end - seg.start) / wall) * 100}%` }}
              title={`${CATEGORY_LABEL[seg.category]} · ${formatDuration(seg.end - seg.start)}`}
            />
          ))}
        </div>

        <table
          className="mt-3 w-max border-collapse text-label"
          data-testid="wall-clock-legend"
        >
          <tbody>
            {ORDER.map((category) => (
              <tr key={category} title={CATEGORY_NOTE[category]}>
                <td className="flex items-center gap-1.5 py-0.5 pr-4 text-text-dim">
                  <i
                    aria-hidden
                    className={`inline-block h-2.5 w-2.5 rounded-[2px] ${CATEGORY_FILL[category]}`}
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
          idle = gaps ≥ {DEFAULT_IDLE_GAP_MS / 1000}s (display threshold; the
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

      {parts.length > 0 && (
        <ActivityBar
          usage={usage}
          parts={parts}
          selected={selectedPart}
          onSelect={(part) =>
            setSelection(part === null ? null : { run, part })
          }
        />
      )}

      {hasToolSpans ? (
        <ToolTable
          usage={usage}
          rows={shownRows}
          source={run.source.tool}
          {...(current === undefined ? {} : { activityLabel: current.label })}
        />
      ) : (
        <section
          className="rounded border border-border-slate bg-surface-container-low p-4 shadow-card"
          data-testid="tools-empty"
        >
          {pruned ? (
            <p className="max-w-[80ch] text-label text-text-dim">
              Tool time by activity and the tool table are left out of this
              report. It was exported with the{' '}
              <code className="font-mono text-text">metadata-only</code>{' '}
              profile, which keeps session totals and drops individual calls.
            </p>
          ) : (
            <p className="text-label text-text-dim">
              This session made no tool calls, so there is no tool time to break
              down.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
