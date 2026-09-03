import type { Insight, Run } from '@runray/schema';
import { formatUSD } from '../lib/format';
import { rankInsights } from '../lib/insight-order';
import type { RunViewName } from '../lib/router';
import { tourAttr } from '../lib/tour-attr';
import { useAppStore } from '../store';

/**
 * Insights strip (03-design.md §4.2): one pill per finding, ranked by
 * estimated waste — severity color, title, waste $. Activating highlights the evidence spans in the
 * waterfall and opens the insight in the Inspector; from the Cost view it
 * first jumps to the Timeline.
 */

const SEVERITY_PILL: Record<Insight['severity'], string> = {
  info: 'border-border text-text-dim',
  warning: 'border-heat-2/50 text-heat-2',
  critical: 'border-heat-3/50 text-heat-3',
};

export function InsightsStrip({ run, view }: { run: Run; view: RunViewName }) {
  const activeId = useAppStore((s) => s.selection.insightId);
  const activateInsight = useAppStore((s) => s.activateInsight);
  if (run.insights.length === 0) return null;

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
      className="flex items-center gap-1.5 overflow-x-auto border-b border-border px-4 py-2"
    >
      {rankInsights(run.insights).map((insight) => {
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
    </div>
  );
}
