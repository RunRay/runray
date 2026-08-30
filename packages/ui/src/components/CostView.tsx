import type { Insight, Run } from '@runray/schema';
import { type ReactNode, useMemo, useState } from 'react';
import {
  bucketCostByModel,
  type ToolCost,
  toolSpendLeaderboard,
} from '../lib/cost-breakdown';
import { formatClock, formatTokens, formatUSD } from '../lib/format';
import { assignModelColors } from '../lib/model-colors';
import { computeTimeRange } from '../lib/waterfall';
import { useAppStore } from '../store';
import { CacheDial } from './CacheDial';
import { CoverageBanner } from './CoverageNotices';
import { LimitSuffix } from './LimitMode';
import { NestedTreemap } from './NestedTreemap';
import { PricingProvenance, TranscriptCostNote } from './PricingProvenance';
import { SeverityPill } from './SeverityPill';
import { WhatIfPanel } from './WhatIfPanel';

/**
 * Cost Breakdown (03-design.md §4.3): hero totals · cost stacked by model
 * over time · treemap by agent subtree (heat = share of the biggest cell) ·
 * waste table naming failed work. Evidence links jump to the Timeline with
 * the span selected.
 */

export function CostView({ run }: { run: Run }) {
  const range = useMemo(() => computeTimeRange(run.spans), [run.spans]);
  const buckets = useMemo(
    () => bucketCostByModel(run.spans, range),
    [run.spans, range],
  );
  const models = useMemo(
    () =>
      Object.entries(run.totals.costUSD.byModel).sort((a, b) => b[1] - a[1]),
    [run.totals.costUSD.byModel],
  );
  const modelColor = useMemo(
    () => assignModelColors(models.map(([m]) => m)),
    [models],
  );
  const toolCosts = useMemo(() => toolSpendLeaderboard(run.spans), [run.spans]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
      {/* run-level unpriced-coverage banner (C7) — the money below is
          understated when this run has unpriced calls */}
      <CoverageBanner runs={[run]} />
      <Hero run={run} />

      <Panel title="Tool spend leaderboard">
        <ToolLeaderboard
          toolCosts={toolCosts}
          totalCost={run.totals.costUSD.total}
        />
      </Panel>

      <Panel title="Wasted spend">
        <WasteTable insights={run.insights} runId={run.id} />
      </Panel>

      <Panel title="What if — cheaper tier">
        <WhatIfPanel run={run} />
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Cost by model over time">
          <StackedBar
            buckets={buckets}
            modelColor={modelColor}
            durationMs={range.end - range.start}
          />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {models.map(([model, cost]) => (
              <span
                key={model}
                className="flex items-center gap-1.5 text-label text-text-dim"
              >
                <i
                  aria-hidden
                  className={`inline-block h-2 w-2 rounded-full ${modelColor.get(model) ?? 'bg-model-1'}`}
                />
                {model}
                <span className="font-mono text-text-faint">
                  {formatUSD(cost)}
                </span>
              </span>
            ))}
          </div>
        </Panel>

        <Panel title="Cost by agent subtree">
          <NestedTreemap run={run} />
        </Panel>
      </div>
    </div>
  );
}

interface ToolLeaderboardProps {
  toolCosts: ToolCost[];
  totalCost: number;
}

function ToolLeaderboard({ toolCosts, totalCost }: ToolLeaderboardProps) {
  if (toolCosts.length === 0) {
    return (
      <p className="py-6 text-center text-label text-text-faint">
        No tool calls or LLM usage recorded in this session.
      </p>
    );
  }

  const useCostBar = totalCost > 0;
  const maxVal = useCostBar
    ? Math.max(...toolCosts.map((t) => t.costUSD), 0.0001)
    : Math.max(...toolCosts.map((t) => t.tokens.total), 1);

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full text-body text-left">
          <thead>
            <tr className="border-b border-border-slate text-left text-label text-on-surface-variant">
              <th scope="col" className="py-1.5 pr-3 font-normal">
                tool
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                invocations
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                tokens (in / out)
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                cost (USD)
              </th>
              <th scope="col" className="py-1.5 pl-4 font-normal w-1/3">
                spend share
              </th>
            </tr>
          </thead>
          <tbody>
            {toolCosts.map((tc) => {
              const sharePercent =
                maxVal > 0
                  ? ((useCostBar ? tc.costUSD : tc.tokens.total) / maxVal) * 100
                  : 0;
              return (
                <tr
                  key={tc.name}
                  className="border-b border-border-slate/40 align-middle hover:bg-surface-variant/30"
                >
                  <td className="py-2.5 pr-3 font-medium text-text">
                    {tc.name}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono text-text-dim">
                    {tc.calls}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono text-text-dim">
                    <span
                      title={`${formatTokens(tc.tokens.input)} input / ${formatTokens(tc.tokens.output)} output`}
                    >
                      {formatTokens(tc.tokens.total)}
                      <span className="text-[10px] text-text-faint ml-1">
                        ({formatTokens(tc.tokens.input)}/
                        {formatTokens(tc.tokens.output)})
                      </span>
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono text-brand">
                    {formatUSD(tc.costUSD)}
                  </td>
                  <td className="py-2.5 pl-4 w-1/3">
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 rounded-full bg-surface-2 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-brand opacity-85 transition-all duration-500 ease-out"
                          style={{ width: `${sharePercent}%` }}
                        />
                      </div>
                      <span className="font-mono text-label text-text-faint w-8 text-right">
                        {sharePercent.toFixed(0)}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Hero({ run }: { run: Run }) {
  const { totals } = run;
  const wasted = totals.costUSD.wastedEstimate;
  return (
    <div className="rounded border border-border-slate bg-surface-container-low p-4 shadow-card">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <p className="micro-label text-text-faint">total cost</p>
          <p className="font-display text-hero font-semibold text-text">
            {formatUSD(totals.costUSD.total)}
          </p>
          <LimitSuffix valueUSD={totals.costUSD.total} />
        </div>
        <HeroStat label="tokens">
          <span className="font-mono">{formatTokens(totals.tokens.total)}</span>
        </HeroStat>
        <HeroStat label="cache hit-rate">
          <span className="flex items-center gap-1.5">
            <CacheDial rate={totals.cache.hitRate} />
            <span className="font-mono">
              {(totals.cache.hitRate * 100).toFixed(1)}%
            </span>
          </span>
        </HeroStat>
        <HeroStat label="wasted estimate">
          <span
            className={`font-mono ${wasted > 0 ? 'text-heat-2' : 'text-text-dim'}`}
          >
            {formatUSD(wasted)}
          </span>
        </HeroStat>
        {totals.codeChanges !== undefined && (
          <HeroStat label="code changes">
            <span className="font-mono">
              <span className="text-cache-savings">
                +{formatTokens(totals.codeChanges.linesAdded)}
              </span>{' '}
              <span className="text-span-error">
                −{formatTokens(totals.codeChanges.linesRemoved)}
              </span>
            </span>
          </HeroStat>
        )}
      </div>
      {/* provenance of the money shown above (C2/C9) — the third required
          placement alongside the what-if panel and the dashboard aggregate —
          plus the transcript lower-bound caveat */}
      <PricingProvenance className="mt-3 block" />
      <TranscriptCostNote run={run} className="mt-0.5 block" />
    </div>
  );
}

function HeroStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pb-1">
      <p className="micro-label text-text-faint">{label}</p>
      <p className="mt-0.5 text-detail text-text">{children}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="shrink-0 rounded border border-border-slate bg-surface-container-low p-4 shadow-card hover:bg-surface-container-highest transition-colors">
      <h3 className="mb-3 font-display text-title font-semibold text-text">
        {title}
      </h3>
      {children}
    </section>
  );
}

function StackedBar({
  buckets,
  modelColor,
  durationMs,
}: {
  buckets: ReturnType<typeof bucketCostByModel>;
  modelColor: Map<string, string>;
  durationMs: number;
}) {
  const [hover, setHover] = useState<{
    i: number;
    x: number;
    y: number;
  } | null>(null);
  const max = Math.max(...buckets.map((b) => b.total), 0);
  if (max === 0) {
    return (
      <p className="py-6 text-center text-label text-text-faint">
        No priced llm calls in this run.
      </p>
    );
  }
  const hovered = hover === null ? undefined : buckets[hover.i];
  return (
    <>
      <div
        role="img"
        aria-label="Bar chart: cost by model over the session timeline. Totals per model are listed in the legend below."
        className="flex h-28 items-end gap-px"
      >
        {buckets.map((bucket, i) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip; the same numbers live in the legend and waste table
          <div
            key={bucket.f0}
            onMouseMove={(e) => setHover({ i, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setHover(null)}
            className="flex h-full flex-1 flex-col-reverse"
          >
            {[...bucket.byModel.entries()].map(([model, cost]) => (
              <div
                key={model}
                className={modelColor.get(model) ?? 'bg-model-1'}
                style={{ height: `${(cost / max) * 100}%` }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-label text-text-faint">
        <span>00:00</span>
        <span>{formatClock(durationMs / 2)}</span>
        <span>{formatClock(durationMs)}</span>
      </div>
      {hovered !== undefined && hover !== null && hovered.total > 0 && (
        <div
          className="pointer-events-none fixed z-50 rounded-control border border-border bg-surface-2 px-2 py-1 font-mono text-label text-text shadow-popover"
          style={{ left: hover.x + 10, top: hover.y - 30 }}
        >
          {formatClock(hovered.f0 * durationMs)}–
          {formatClock(hovered.f1 * durationMs)} · {formatUSD(hovered.total)}
        </div>
      )}
    </>
  );
}

function WasteTable({
  insights,
  runId,
}: {
  insights: readonly Insight[];
  runId: string;
}) {
  const selectSpan = useAppStore((s) => s.selectSpan);
  if (insights.length === 0) {
    return (
      <p className="py-4 text-center text-label text-text-faint">
        No findings — nothing wasted that the rules can see.
      </p>
    );
  }
  const openEvidence = (insight: Insight) => {
    const first = insight.spanIds[0];
    if (first !== undefined) selectSpan(first);
    useAppStore.getState().navigateTo({ view: 'timeline', runId });
  };
  return (
    <table className="w-full text-body">
      <thead>
        <tr className="border-b border-border-slate text-left text-label text-on-surface-variant">
          <th scope="col" className="py-1.5 pr-3 font-normal">
            finding
          </th>
          <th scope="col" className="py-1.5 pr-3 text-right font-normal">
            est. waste
          </th>
          <th scope="col" className="py-1.5 pr-3 font-normal">
            suggestion
          </th>
          <th scope="col" className="py-1.5 font-normal">
            <span className="sr-only">evidence</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {insights.map((insight) => (
          <tr
            key={insight.id}
            className="border-b border-border-slate/40 align-top"
          >
            <td className="py-2 pr-3">
              <span className="mr-2">
                <SeverityPill severity={insight.severity} />
              </span>
              <span className="text-text">{insight.title}</span>
            </td>
            <td className="whitespace-nowrap py-2 pr-3 text-right font-mono text-heat-2">
              {insight.estimatedWasteUSD !== undefined
                ? formatUSD(insight.estimatedWasteUSD)
                : '—'}
            </td>
            <td className="py-2 pr-3 text-text-dim">
              {insight.suggestion ?? insight.detail}
            </td>
            <td className="whitespace-nowrap py-2 text-right">
              <button
                type="button"
                onClick={() => openEvidence(insight)}
                className="rounded border border-border-slate bg-surface px-2 py-0.5 text-label text-on-surface-variant transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-on-surface active:bg-bg-deep-gray"
              >
                View evidence
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
