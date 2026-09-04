import type { Insight, Run } from '@runray/schema';
import { formatUSD } from '../lib/format';
import { rankInsights } from '../lib/insight-order';
import { type RunViewName, toHash } from '../lib/router';
import { tourAttr } from '../lib/tour-attr';
import { useAppStore } from '../store';

/**
 * Insights strip (03-design.md §4.2): the five largest findings, ranked by
 * estimated waste — severity color, title, waste $ — and a way to the
 * rest on the Waste tab, where they are grouped instead of listed.
 * Activating a pill highlights the evidence spans in the waterfall and
 * opens the insight in the Inspector; from the Cost view it first jumps
 * to the Timeline.
 */

/** Pills shown before the strip hands over to the Waste tab: a session
 * with thirty findings is eighteen cache breaks and thirteen re-reads,
 * which the tab groups and the strip cannot. */
const STRIP_MAX = 5;

const SEVERITY_PILL: Record<Insight['severity'], string> = {
  info: 'border-border text-text-dim',
  warning: 'border-heat-2/50 text-heat-2',
  critical: 'border-heat-3/50 text-heat-3',
};

export function InsightsStrip({ run, view }: { run: Run; view: RunViewName }) {
  const activeId = useAppStore((s) => s.selection.insightId);
  const activateInsight = useAppStore((s) => s.activateInsight);
  if (run.insights.length === 0) return null;
  const ranked = rankInsights(run.insights);
  const shown = ranked.slice(0, STRIP_MAX);
  const hidden = ranked.length - shown.length;

  const onActivate = (insight: Insight) => {
    activateInsight(insight);
    if (view !== 'timeline') {
      useAppStore.getState().navigateTo({ view: 'timeline', runId: run.id });
    }
  };

  return (
    <div
      {...tourAttr('insights-strip')}
      role="toolbar"
      aria-label="Findings"
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-4 py-2"
    >
      {shown.map((insight) => {
        const active = insight.id === activeId;
        return (
          <button
            key={insight.id}
            type="button"
            onClick={() => onActivate(insight)}
            aria-pressed={active}
            className={`flex shrink-0 items-center gap-1.5 rounded-control border px-2.5 py-1 text-label transition-colors duration-150 ease-out hover:bg-surface-2 active:bg-bg ${
              SEVERITY_PILL[insight.severity]
            } ${active ? 'bg-surface-2' : 'bg-surface'}`}
          >
            <span aria-hidden>⚠</span>
            <span className="max-w-72 truncate text-text">{insight.title}</span>
            {insight.estimatedWasteUSD !== undefined && (
              <span className="font-mono">
                {formatUSD(insight.estimatedWasteUSD)}
              </span>
            )}
          </button>
        );
      })}
      {hidden > 0 && (
        <a
          href={toHash({ view: 'waste', runId: run.id })}
          aria-label={`${hidden} more ${hidden === 1 ? 'finding' : 'findings'}, grouped on the Waste tab`}
          className="flex shrink-0 items-center rounded-control border border-dashed border-border-slate bg-surface px-2.5 py-1 text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary active:bg-bg"
        >
          +{hidden} more in Waste
        </a>
      )}
    </div>
  );
}
