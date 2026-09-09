import { RULE_META } from '@runray/core/insights-meta';
import type { Run, Span } from '@runray/schema';
import { useMemo, useState } from 'react';
import type { RunFilter } from '../lib/filter-runs';
import { formatTokensCompact, formatUSD } from '../lib/format';
import {
  type RuleGroup,
  type SavingsSummary,
  savingsSummary,
  type WasteEntry,
} from '../lib/overview';
import { tourAttr } from '../lib/tour-attr';
import { useAppStore } from '../store';
import { CoverageBanner, CoverageCaveat } from './CoverageNotices';
import { PricingProvenance } from './PricingProvenance';
import { SeverityPill } from './SeverityPill';

/**
 * The dashboard's front door (D1): the answer before the counters. An
 * honest two-bucket headline — money already burned (waste-class, engine-
 * capped) vs efficiency opportunities (opportunity-class) — never one
 * undifferentiated "save $X"; the top three recommended changes with
 * humanized labels, per-change dollars, and evidence that expands IN
 * PLACE (the timeline deep link stays as a secondary action). When no
 * rule fired, the panel says so out loud instead of hiding.
 */
export function SavingsPanel({
  runs,
  filter,
}: {
  runs: Run[];
  filter: RunFilter;
}) {
  const summary: SavingsSummary = useMemo(() => savingsSummary(runs), [runs]);
  const period =
    filter.periodDays === null ? 'all time' : `last ${filter.periodDays} days`;
  const ruleCount = Object.keys(RULE_META).length;

  return (
    <section
      aria-label="Potential savings"
      className="rounded border border-border-slate bg-surface-container-low p-5 shadow-card motion-safe:animate-[rise_500ms_var(--ease-out)_both]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="micro-label text-text-faint">
          Potential savings · {period}
        </p>
        <PricingProvenance />
      </div>

      <div className="mt-2">
        <CoverageBanner runs={runs} />
      </div>

      {summary.findings === 0 ? (
        <p {...tourAttr('savings')} className="mt-3 text-body text-text-dim">
          All {ruleCount} rules found nothing to save in this period. No retry
          loops, cache breaks, or tier mismatches occurred in the visible
          sessions.
        </p>
      ) : (
        <>
          <div
            {...tourAttr('savings')}
            className="mt-3 flex flex-wrap items-end gap-x-10 gap-y-3"
          >
            <div>
              <p className="flex items-baseline gap-1.5 font-display text-[30px] font-semibold leading-[1.05] text-heat-2">
                <CoverageCaveat runs={runs} />
                {summary.burnedTokens > 0 ? (
                  <>
                    <span>{formatTokensCompact(summary.burnedTokens)}</span>
                    <span className="font-mono text-body font-normal text-text-dim">
                      ({formatUSD(summary.burnedUSD)})
                    </span>
                  </>
                ) : (
                  formatUSD(summary.burnedUSD)
                )}
              </p>
              <p className="mt-1 text-label text-text-dim">
                already burned from retries, cache breaks, and dead ends
              </p>
            </div>
            <div>
              <p className="flex items-baseline gap-1.5 font-display text-[30px] font-semibold leading-[1.05] text-cache-savings">
                <CoverageCaveat runs={runs} />
                {summary.opportunityTokens > 0 ? (
                  <>
                    <span>
                      {formatTokensCompact(summary.opportunityTokens)}
                    </span>
                    <span className="font-mono text-body font-normal text-text-dim">
                      ({formatUSD(summary.opportunityUSD)})
                    </span>
                  </>
                ) : (
                  formatUSD(summary.opportunityUSD)
                )}
              </p>
              <p className="mt-1 text-label text-text-dim">
                efficiency opportunities available from setup changes
              </p>
            </div>
          </div>

          {summary.topChanges.length > 0 && (
            <div className="mt-4 border-t border-border-slate">
              {summary.topChanges.map((group, i) => (
                <TopChangeRow
                  key={group.ruleId}
                  group={group}
                  runs={runs}
                  rank={i + 1}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Rule label + one-line explanation from the registry (open set). */
export function ruleLabel(ruleId: string): { label: string; explain: string } {
  const meta = RULE_META[ruleId];
  return meta === undefined
    ? { label: ruleId, explain: '' }
    : { label: meta.label, explain: meta.explain };
}

function TopChangeRow({
  group,
  runs,
  rank,
}: {
  group: RuleGroup;
  runs: Run[];
  rank: number;
}) {
  const [open, setOpen] = useState(rank === 1);
  // the rule's own explanation, never the top finding's suggestion: a group
  // spans many findings (for retry-loop, many tools), and each finding's
  // suggestion is read in the Inspector where it applies
  const { label, explain } = ruleLabel(group.ruleId);

  return (
    <div className="border-b border-border-slate last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="grid w-full grid-cols-[18px_minmax(0,1fr)_auto_auto] items-baseline gap-3 rounded px-1 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-surface-variant active:bg-bg-deep-gray"
      >
        <span className="font-display text-body font-semibold text-text-faint">
          {rank}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-body text-text">
            {label}
            <span className="ml-2 font-mono text-label text-text-faint">
              {group.ruleId} · {group.count}{' '}
              {group.count === 1 ? 'finding' : 'findings'}
            </span>
          </span>
          <span className="block truncate text-label text-text-dim">
            {explain}
          </span>
        </span>
        <SeverityPill severity={group.worstSeverity} />
        <span className="whitespace-nowrap font-mono text-body text-heat-2">
          {formatUSD(group.totalUSD)}
        </span>
      </button>
      {open && (
        <div className="pb-2.5 pl-[30px]">
          {group.entries.slice(0, 3).map((entry) => (
            <EvidenceInline
              key={`${entry.runId}:${entry.insight.id}`}
              entry={entry}
              runs={runs}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Evidence expanded in place (D2): span excerpts straight from the loaded
 * data — name, kind, cost, the existing ≤200-char preview (null renders
 * "redacted"); "Open in timeline" is the secondary action, not a teleport.
 */
export function EvidenceInline({
  entry,
  runs,
}: {
  entry: WasteEntry;
  runs: Run[];
}) {
  const stageInsight = useAppStore((s) => s.stageInsight);
  const spans = useMemo(() => {
    const run = runs.find((r) => r.id === entry.runId);
    if (run === undefined) return [];
    const byId = new Map(run.spans.map((s) => [s.id, s]));
    return entry.insight.spanIds
      .map((id) => byId.get(id))
      .filter((s): s is Span => s !== undefined)
      .slice(0, 3);
  }, [entry, runs]);
  const openInTimeline = () => {
    stageInsight(entry.insight);
    useAppStore.getState().navigateTo({ view: 'timeline', runId: entry.runId });
  };

  return (
    <div className="border-t border-dashed border-border-slate py-1.5 first:border-t-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-3">
        <span className="min-w-0 truncate text-body text-text">
          {entry.insight.title}
          <span className="ml-2 text-label text-text-dim">
            {entry.runTitle}
          </span>
        </span>
        <span className="whitespace-nowrap font-mono text-label text-heat-2">
          {formatUSD(entry.insight.estimatedWasteUSD ?? 0)}
        </span>
        <button
          type="button"
          onClick={openInTimeline}
          className="rounded border border-border-slate bg-surface px-2 py-0.5 text-label text-on-surface-variant transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-on-surface active:bg-bg-deep-gray"
        >
          Open in timeline
        </button>
      </div>
      {spans.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {spans.map((span) => (
            <li
              key={span.id}
              className="flex items-baseline gap-2 text-label text-text-dim"
            >
              <span className="micro-label shrink-0 text-text-faint">
                {span.kind}
              </span>
              <span className="shrink-0 font-mono text-text">{span.name}</span>
              <span className="min-w-0 truncate text-text-faint">
                {span.content?.promptPreview ??
                  span.content?.outputPreview ??
                  (span.content !== undefined ? 'redacted' : '')}
              </span>
              {span.llm?.costUSD !== undefined && (
                <span className="ml-auto shrink-0 font-mono">
                  {formatUSD(span.llm.costUSD)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
