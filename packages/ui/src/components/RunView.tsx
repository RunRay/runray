import type { Run } from '@runray/schema';
import {
  formatDateTime,
  formatDuration,
  formatTokens,
  formatUSD,
} from '../lib/format';
import { type Route, toHash } from '../lib/router';
import { useAppStore } from '../store';
import { CostView } from './CostView';
import { InsightsStrip } from './InsightsStrip';
import { TimeView } from './TimeView';
import { Waterfall } from './Waterfall';

/**
 * Center pane: run header + Timeline|Cost tab switch (hash-driven). The
 * actual views are placeholders until tasks 3.3–3.7 fill them in.
 */
export function RunView({
  run,
  view,
}: {
  run: Run;
  view: 'timeline' | 'cost' | 'time';
}) {
  const toggleInspector = useAppStore((s) => s.toggleInspector);
  const inspectorOpen = useAppStore((s) => s.ui.inspectorOpen);
  const wasted = run.totals.costUSD.wastedEstimate;

  return (
    <div className="flex h-full min-w-0 flex-col min-h-0">
      <div className="shrink-0 border-b border-outline-variant/30 bg-surface-dim px-4 py-3">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="truncate font-display text-header font-semibold">
            {run.title ?? run.project?.name ?? `${run.source.tool} session`}
          </h1>
          <button
            type="button"
            onClick={toggleInspector}
            aria-pressed={inspectorOpen}
            className="shrink-0 rounded border border-border-slate bg-surface px-2.5 py-1 text-label text-on-surface-variant transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-on-surface active:bg-bg-deep-gray"
          >
            Inspector
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-on-surface-variant">
          <span className="font-mono">{formatDateTime(run.startedAt)}</span>
          {run.durationMs !== undefined && (
            <> · {formatDuration(run.durationMs)}</>
          )}
          ·{' '}
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-text-dim font-mono">
            {run.source.tool}
          </span>
        </div>

        {/* Session KPI Summary Bar */}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 rounded border border-border-slate bg-surface-container-low p-2.5">
          <div>
            <p className="micro-label text-text-faint">Total Tokens</p>
            <p className="font-mono text-body font-semibold text-text">
              {formatTokens(run.totals.tokens.total)}
            </p>
          </div>
          <div>
            <p className="micro-label text-text-faint">Cost (USD)</p>
            <p className="font-mono text-body font-semibold text-on-surface">
              {run.totals.costUSD.total > 0
                ? formatUSD(run.totals.costUSD.total)
                : 'Local / $0.00'}
            </p>
          </div>
          <div>
            <p className="micro-label text-text-faint">Cache Read</p>
            <p className="font-mono text-body font-semibold text-cache-savings">
              {formatTokens(run.totals.tokens.cacheRead)}
            </p>
          </div>
          <div>
            <p className="micro-label text-text-faint">Status / Waste</p>
            <p
              className={`font-mono text-body font-semibold ${wasted > 0 ? 'text-heat-2' : 'text-text-dim'}`}
            >
              {wasted > 0 ? `${formatUSD(wasted)} wasted` : 'Clean run'}
            </p>
          </div>
        </div>

        <div className="mt-3">
          <ViewTabs runId={run.id} view={view} />
        </div>
      </div>

      <InsightsStrip run={run} view={view} />

      <div className="min-h-0 flex-1 p-4 flex flex-col overflow-hidden">
        {view === 'timeline' ? (
          <Waterfall run={run} />
        ) : view === 'time' ? (
          <TimeView run={run} />
        ) : (
          <CostView run={run} />
        )}
      </div>
    </div>
  );
}

function ViewTabs({
  runId,
  view,
}: {
  runId: string;
  view: 'timeline' | 'cost' | 'time';
}) {
  const tabs: { label: string; route: Route; active: boolean }[] = [
    {
      label: 'Overview',
      route: { view: 'cost', runId },
      active: view === 'cost',
    },
    {
      label: 'Timeline Explorer',
      route: { view: 'timeline', runId },
      active: view === 'timeline',
    },
    {
      label: 'Time',
      route: { view: 'time', runId },
      active: view === 'time',
    },
  ];
  return (
    <nav
      aria-label="Run views"
      className="flex overflow-hidden rounded border border-border-slate"
    >
      {tabs.map(({ label, route, active }) => (
        <a
          key={label}
          href={toHash(route)}
          aria-current={active ? 'page' : undefined}
          className={`px-3 py-1 text-label transition-colors duration-150 ease-out ${
            active
              ? 'bg-surface-variant text-on-surface font-semibold'
              : 'bg-surface text-on-surface-variant hover:bg-surface-variant/40 hover:text-on-surface active:bg-bg-deep-gray'
          }`}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
