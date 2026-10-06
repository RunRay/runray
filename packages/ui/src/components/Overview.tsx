import type { Run, SourceTool } from '@runray/schema';
import { type ReactNode, useMemo, useState } from 'react';
import {
  type RunFilter,
  type SpendTrend,
  spendTrend,
} from '../lib/filter-runs';
import { formatTokens, formatTokensCompact, formatUSD } from '../lib/format';
import {
  assignModelColors,
  assignModelColorVars,
  sourceColorVar,
} from '../lib/model-colors';
import {
  aggregateTotals,
  cacheAggregate,
  type DaySpend,
  errorRate,
  largestCallTokens,
  mostExpensiveCall,
  type RuleGroup,
  sessionCostStats,
  spendByDay,
  topModels,
  topProjects,
  topSources,
  wasteByRule,
  worstToolError,
} from '../lib/overview';
import { tourAttr } from '../lib/tour-attr';
import { AT_API_PRICES, type DisplayUnit, inUnit } from '../lib/unit';
import { useAppStore } from '../store';
import { CacheDial } from './CacheDial';
import { CoverageCaveat } from './CoverageNotices';
import { LimitStatementLine } from './LimitMode';
import { EvidenceInline, ruleLabel, SavingsPanel } from './SavingsPanel';
import { SeverityPill } from './SeverityPill';
import { ToolRankCard } from './ToolRankCard';

/**
 * Sessions overview (visualizer spec "Sessions overview aggregates"), composed
 * as an audit report (03-design.md §4.1, redesign mockup): statement → diagnosis
 * (KPIs) → rhythm (spend by day) → culprits (rankings, waste). Everything
 * derives from the loaded runs — no extra data.
 */

function periodLabel(filter: RunFilter): string {
  if (filter.day !== null) return filter.day;
  if (filter.periodDays === 7) return 'last 7 days';
  if (filter.periodDays === 30) return 'last 30 days';
  if (filter.periodDays !== null) return `last ${filter.periodDays} days`;
  return 'all time';
}

export function Overview({
  runs,
  allRuns,
  filter,
}: {
  /** The visible (filtered) runs — every aggregate below derives from these. */
  runs: Run[];
  /** All loaded runs + the active filter, for the trend's previous-period
   *  baseline (which lives outside the filtered set). */
  allRuns: Run[];
  filter: RunFilter;
}) {
  // the display unit (E6) picks the lead figure everywhere on this page;
  // estimates that only exist in dollars stay in dollars, "at API prices"
  const unit = useAppStore((s) => s.unit);
  const tokensLead = unit === 'tokens';
  const totals = useMemo(() => aggregateTotals(runs), [runs]);
  const days = useMemo(() => spendByDay(runs), [runs]);
  const projects = useMemo(() => topProjects(runs, 5, unit), [runs, unit]);
  const models = useMemo(() => topModels(runs, 5, unit), [runs, unit]);
  const chartModels = useMemo(() => topModels(runs, 8, unit), [runs, unit]);
  const sources = useMemo(() => topSources(runs, 5, unit), [runs, unit]);
  // One color assignment over ALL models so a model's rank dot and its stacked
  // chart segment always match (both index into the same sorted set).
  const allModelNames = useMemo(
    () => [
      ...new Set(runs.flatMap((r) => Object.keys(r.totals.costUSD.byModel))),
    ],
    [runs],
  );
  const modelClass = useMemo(
    () => assignModelColors(allModelNames),
    [allModelNames],
  );
  const modelVars = useMemo(
    () => assignModelColorVars(allModelNames),
    [allModelNames],
  );
  const cache = useMemo(() => cacheAggregate(runs), [runs]);
  const errors = useMemo(() => errorRate(runs), [runs]);
  const costStats = useMemo(() => sessionCostStats(runs), [runs]);
  const trend = useMemo(
    () => spendTrend(allRuns, filter, unit),
    [allRuns, filter, unit],
  );
  const waste = useMemo(() => wasteByRule(runs), [runs]);
  const worstErr = useMemo(() => worstToolError(runs), [runs]);
  const priciest = useMemo(() => mostExpensiveCall(runs), [runs]);
  const largestCall = useMemo(() => largestCallTokens(runs), [runs]);
  const setFilter = useAppStore((s) => s.setFilter);
  const avgTokens = Math.round(totals.tokens / (totals.sessions || 1));

  const wastedShare =
    totals.costUSD > 0 ? (totals.wastedUSD / totals.costUSD) * 100 : 0;
  const wasteFindings = waste.reduce((n, g) => n + g.count, 0);
  const wasteTotal = waste.reduce((s, g) => s + g.totalUSD, 0);
  const wasteDriver =
    waste[0] !== undefined
      ? `${ruleLabel(waste[0].ruleId).label} is the main driver`
      : 'nothing flagged as wasted';
  const errorNote =
    worstErr !== null
      ? `worst: ${worstErr.name} failed ${worstErr.count}×`
      : 'no tool errors';
  const sessionsNote = `${totals.sessions} ${totals.sessions === 1 ? 'session' : 'sessions'}`;
  const avgNote = tokensLead
    ? largestCall > 0
      ? `largest single call ${formatTokensCompact(largestCall)} tokens`
      : sessionsNote
    : priciest > 0
      ? `priciest single call ${formatUSD(priciest)}`
      : sessionsNote;
  const totalUSD =
    totals.costUSD > 0 ? formatUSD(totals.costUSD) : 'Local / $0.00';
  const parseWarnings = useMemo(
    () => runs.reduce((n, r) => n + (r.warnings?.length ?? 0), 0),
    [runs],
  );
  const viewConfig = useAppStore((s) => s.viewConfig);

  return (
    <div className="flex flex-col gap-6">
      {viewConfig?.isSample === true && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-brand/40 bg-brand/10 p-3.5 text-label text-text font-medium shadow-card">
          <span>
            This is a scrubbed sample session, not your data. Once you run an
            agent on this machine, view your sessions with:{' '}
            <code className="font-mono rounded border border-border-slate bg-surface px-1.5 py-0.5 text-text">
              runray view
            </code>
          </span>
        </div>
      )}
      {/* STREFA 1: EXECUTIVE BANNER (TOKEN-FIRST & IMPACT KPI) */}
      <section
        aria-label="Executive Overview"
        className="rounded border border-border-slate bg-surface-container-low p-5 shadow-card motion-safe:animate-[rise_500ms_var(--ease-out)_both]"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <p className="micro-label text-text-faint">
              Executive Overview · {periodLabel(filter)} · {totals.sessions}{' '}
              {totals.sessions === 1 ? 'session' : 'sessions'}
            </p>
            {/* keyed by unit: a flip settles the pair in again (unit-swap),
                so it reads as a change of unit, not of the numbers */}
            <div
              key={unit}
              className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 motion-safe:animate-[unit-swap_240ms_var(--ease-out)_both]"
            >
              {tokensLead ? (
                <>
                  <span className="font-display text-hero font-semibold text-text">
                    {formatTokensCompact(totals.tokens)}{' '}
                    <span className="text-body font-normal text-text-dim">
                      tokens
                    </span>
                  </span>
                  <span className="font-mono text-[24px] font-semibold text-brand-bright">
                    {totalUSD}
                    {totals.costUSD > 0 && (
                      // a real space, not just margin: the accessible name
                      // must not read "$484.06at API prices"
                      <span className="font-sans text-label font-normal text-text-dim">
                        {' '}
                        {AT_API_PRICES}
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <>
                  <span className="font-display text-hero font-semibold text-text">
                    {totalUSD}
                  </span>
                  <span className="font-mono text-[24px] font-semibold text-brand-bright">
                    {formatTokensCompact(totals.tokens)}{' '}
                    <span className="font-sans text-body font-normal text-text-dim">
                      tokens
                    </span>
                  </span>
                </>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-body text-text-dim">
              {trend !== null && (
                <TrendChip
                  trend={trend}
                  periodDays={filter.periodDays}
                  unit={unit}
                />
              )}
              <LimitStatementLine />
              {(totals.linesAdded > 0 || totals.linesRemoved > 0) && (
                <span className="font-mono text-cache-savings">
                  +{formatTokens(totals.linesAdded)} / −
                  {formatTokens(totals.linesRemoved)} lines
                </span>
              )}
            </div>
          </div>

          <BurnLine days={days} unit={unit} />
        </div>

        {/* KPI indicators bar */}
        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-border-slate/60 pt-4 lg:grid-cols-4">
          <KpiCard
            label={tokensLead ? 'Wasted share' : 'Wasted Spend'}
            delayMs={40}
          >
            {/* waste is a dollar estimate (no token count behind cache or
                model-choice findings): token mode leads with its share and
                names the dollars for what they are. Nothing priced means
                the waste is unknown, never a measured zero. */}
            <p className="flex flex-wrap items-baseline gap-x-2 font-display text-[24px] font-semibold leading-[1.1] text-heat-2">
              <CoverageCaveat runs={runs} />
              {totals.costUSD <= 0
                ? '—'
                : tokensLead || totals.wastedUSD <= 0
                  ? `${wastedShare.toFixed(1)}%`
                  : formatUSD(totals.wastedUSD)}
              <span className="font-sans text-label font-normal text-text-dim">
                {totals.costUSD <= 0
                  ? 'no priced calls'
                  : tokensLead
                    ? `${formatUSD(totals.wastedUSD)} ${AT_API_PRICES}`
                    : `(${wastedShare.toFixed(1)}%)`}
              </span>
            </p>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(wastedShare, 100)}%`,
                  background:
                    'linear-gradient(90deg, var(--color-heat-1), var(--color-heat-2))',
                }}
              />
            </div>
            <p
              className="mt-1 truncate text-label text-text-dim"
              title={wasteDriver}
            >
              {wasteDriver}
            </p>
          </KpiCard>

          <KpiCard label="Cache Hit-Rate" delayMs={90}>
            <p className="flex items-center gap-2 font-display text-[24px] font-semibold leading-[1.1] text-cache-savings">
              <CacheDial rate={cache.hitRate} size={20} />
              {(cache.hitRate * 100).toFixed(1)}%
            </p>
            <p className="mt-1 truncate text-label text-text-dim">
              {formatTokensCompact(cache.cacheReadTokens)} served from cache
            </p>
          </KpiCard>

          <KpiCard label="Tool Errors" delayMs={140}>
            <p className="flex items-baseline gap-2 font-display text-[24px] font-semibold leading-[1.1] text-text">
              {(errors.rate * 100).toFixed(1)}%
              <span className="font-mono text-label font-normal text-text-dim">
                {formatTokens(errors.errors)} / {formatTokens(errors.calls)}
              </span>
            </p>
            <p
              className="mt-1 truncate text-label text-text-dim"
              title={errorNote}
            >
              {errorNote}
            </p>
          </KpiCard>

          <KpiCard label="Avg Session" delayMs={190}>
            <p className="flex flex-wrap items-baseline gap-x-2 font-display text-[24px] font-semibold leading-[1.1] text-text">
              {tokensLead
                ? formatTokensCompact(avgTokens)
                : formatUSD(costStats.averageUSD)}
              <span className="font-mono text-label font-normal text-text-dim">
                {tokensLead
                  ? formatUSD(costStats.averageUSD)
                  : `${formatTokensCompact(avgTokens)} tokens`}
                {tokensLead && (
                  <span className="font-sans"> {AT_API_PRICES}</span>
                )}
              </span>
            </p>
            <p
              className="mt-1 truncate text-label text-text-dim"
              title={avgNote}
            >
              {avgNote}
            </p>
          </KpiCard>
        </div>
      </section>

      {/* STREFA 2: ACTION HUB (POTENTIAL SAVINGS & RECOMMENDATIONS) */}
      <section aria-label="Action Hub">
        <SavingsPanel runs={runs} filter={filter} />
      </section>

      {/* Resource breakdown: the rankings follow the display unit (E6) */}
      <section aria-label="Struktura zużycia zasobów">
        <div className="mb-3">
          <h2 className="font-display text-body font-semibold text-text">
            Resource Breakdown
          </h2>
          <p className="micro-label text-text-faint">
            {tokensLead ? 'Tokens' : 'Spend'} by project, model, and source ·
            click one to filter the sessions below
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <RankCard
            title="Top projects"
            hint="Click a project to filter the sessions below."
            delayMs={40}
          >
            <RankList
              unit={unit}
              entries={projects.map((p) => ({
                key: p.name,
                label: p.name,
                costUSD: p.costUSD,
                tokens: p.tokens,
              }))}
              maxCost={projects[0]?.costUSD ?? 0}
              maxTokens={Math.max(...projects.map((p) => p.tokens), 0)}
              onSelect={(project) => setFilter({ project })}
              activeKey={filter.project}
              filterNoun="project"
            />
          </RankCard>
          <RankCard
            title="Top models"
            hint="Share of total consumption by model."
            delayMs={90}
          >
            <RankList
              unit={unit}
              entries={models.map((m) => ({
                key: m.name,
                label: m.name,
                costUSD: m.costUSD,
                tokens: m.tokens,
                dotClass: modelClass.get(m.name) ?? 'bg-model-1',
              }))}
              maxCost={models[0]?.costUSD ?? 0}
              maxTokens={Math.max(...models.map((m) => m.tokens), 0)}
              onSelect={(model) => setFilter({ model })}
              activeKey={filter.model}
              filterNoun="model"
            />
          </RankCard>
          <RankCard
            title="By source"
            hint={`${sources.length} ${sources.length === 1 ? 'adapter' : 'adapters'} active · ${parseWarnings} parse ${parseWarnings === 1 ? 'warning' : 'warnings'}`}
            delayMs={140}
          >
            <RankList
              unit={unit}
              entries={sources.map((s) => ({
                key: s.name,
                label: s.name,
                costUSD: s.costUSD,
                tokens: s.tokens,
              }))}
              maxCost={sources[0]?.costUSD ?? 0}
              maxTokens={Math.max(...sources.map((s) => s.tokens), 0)}
              onSelect={(source) => setFilter({ source: source as SourceTool })}
              activeKey={filter.source}
              filterNoun="source"
            />
          </RankCard>
        </div>

        <div className="mt-4">
          <ToolRankCard runs={runs} activeTool={filter.tool} />
        </div>
      </section>

      {/* STREFA 4: TREND CZASOWY W SPEND BY DAY */}
      <SpendSection
        unit={unit}
        days={days}
        modelKeys={chartModels.map((m) => m.name)}
        modelVars={modelVars}
        sourceKeys={sources.map((s) => s.name)}
        activeDay={filter.day}
        onDay={(day) => setFilter({ day })}
      />

      {/* culprits */}
      {waste.length > 0 && (
        <section aria-label="Wasted spend">
          <SectionHead
            title="Wasted spend, by rule"
            aside={`${wasteFindings} ${wasteFindings === 1 ? 'finding' : 'findings'} · ${formatUSD(wasteTotal)} estimated${tokensLead ? ` ${AT_API_PRICES}` : ''}`}
          />
          <div className="mt-3 rounded border border-border-slate bg-surface-container-low px-4 py-1 shadow-card motion-safe:animate-[rise_500ms_var(--ease-out)_both]">
            <WasteBoard groups={waste} runs={runs} />
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Spend trend vs the previous equal-length period (D3). Up in spend is worth
 * flagging (ember, ▲); down is a saving (sage, ▼). Only rendered when
 * `spendTrend` returned a real baseline.
 */
function TrendChip({
  trend,
  periodDays,
  unit,
}: {
  trend: SpendTrend;
  periodDays: number | null;
  unit: DisplayUnit;
}) {
  const up = trend.deltaFraction >= 0;
  const pct = Math.abs(trend.deltaFraction * 100);
  const tokensLead = unit === 'tokens';
  const title = tokensLead
    ? `${formatTokensCompact(trend.currentTokens)} tokens this period vs ${formatTokensCompact(trend.previousTokens)} the previous ${periodDays ?? ''} days`
    : `${formatUSD(trend.currentUSD)} this period vs ${formatUSD(trend.previousUSD)} the previous ${periodDays ?? ''} days`;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-mono text-label ${
        up
          ? 'bg-heat-2/12 text-heat-2'
          : 'bg-cache-savings/12 text-cache-savings'
      }`}
      title={title}
    >
      {/* direction lives in the accessible name, not just the color+glyph
          (03-design.md §6: never color-alone) — mirrors SeverityPill */}
      <span className="sr-only">
        {tokensLead ? 'tokens' : 'spend'} {up ? 'up' : 'down'}{' '}
      </span>
      <span aria-hidden>{up ? '▲' : '▼'}</span>
      {pct.toFixed(0)}%
      <span className="text-text-faint">vs prev {periodDays ?? ''} days</span>
    </span>
  );
}

function KpiCard({
  label,
  delayMs = 0,
  children,
}: {
  label: string;
  delayMs?: number;
  children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-1.5 rounded border border-border-slate bg-surface-container-low px-4 py-3.5 shadow-card
        motion-safe:animate-[rise_500ms_var(--ease-out)_both]"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <p className="micro-label text-text-faint">{label}</p>
      {children}
    </section>
  );
}

/**
 * The burn line (03-design.md §1): cumulative spend across the plotted days.
 * Normalized by the sum of the days actually drawn (not the all-time total,
 * which can exceed them once `spendByDay` caps to 30 days) so the endpoint and
 * its label always agree. `pathLength=1` makes the draw-in animation unit-free.
 */
function BurnLine({ days, unit }: { days: DaySpend[]; unit: DisplayUnit }) {
  const tokensLead = unit === 'tokens';
  const plotted = useMemo(
    () => days.reduce((s, d) => s + inUnit(unit, d), 0),
    [days, unit],
  );
  const points = useMemo(() => {
    if (days.length < 2 || plotted <= 0) return null;
    let acc = 0;
    return days.map((d, i) => {
      acc += inUnit(unit, d);
      const x = (i / (days.length - 1)) * 400;
      const y = 76 - (acc / plotted) * 68;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
  }, [days, plotted, unit]);
  if (points === null) return <div aria-hidden />;
  const plottedLabel = tokensLead
    ? `${formatTokensCompact(plotted)} tokens`
    : formatUSD(plotted);

  const line = `M${points.join(' L')}`;
  const area = `${line} L400,80 L0,80 Z`;
  const [lastX = 400, lastY = 8] = (points[points.length - 1] ?? '')
    .split(',')
    .map(Number);

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between">
        <p className="micro-label text-text-faint">Burn line · cumulative</p>
        <p className="font-mono text-label text-brand">{plottedLabel}</p>
      </div>
      <svg
        role="img"
        aria-label={`Cumulative ${tokensLead ? 'tokens' : 'spend'} across ${days.length} days, ending at ${plottedLabel}.`}
        viewBox="0 0 400 80"
        preserveAspectRatio="none"
        className="mt-1 block h-16 w-full"
      >
        <path d={area} fill="var(--color-brand)" opacity={0.1} />
        <path
          d={line}
          fill="none"
          stroke="var(--color-brand-bright)"
          strokeWidth={1.8}
          pathLength={1}
          strokeDasharray={1}
          vectorEffect="non-scaling-stroke"
          className="motion-safe:animate-[draw_900ms_var(--ease-out)_both]"
        />
        <circle cx={lastX} cy={lastY} r={3} fill="var(--color-brand-bright)" />
      </svg>
    </div>
  );
}

/** A serif section title with an optional faint aside on the right. */
function SectionHead({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <h2 className="font-display text-header font-semibold text-text">
        {title}
      </h2>
      {children ??
        (aside !== undefined && (
          <span className="shrink-0 text-label text-text-faint">{aside}</span>
        ))}
    </div>
  );
}

/** A card with a mono-uppercase heading and an optional footnote hint. */
function RankCard({
  title,
  hint,
  delayMs = 0,
  children,
}: {
  title: string;
  hint?: string;
  delayMs?: number;
  children: ReactNode;
}) {
  return (
    <section
      className="min-w-0 rounded border border-border-slate bg-surface-container-low px-4 py-3.5 shadow-card
        motion-safe:animate-[rise_500ms_var(--ease-out)_both]"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <h3 className="micro-label mb-3 text-text-faint">{title}</h3>
      {children}
      {hint !== undefined && (
        <p className="mt-3 text-label text-text-faint">{hint}</p>
      )}
    </section>
  );
}

type ChartMode = 'total' | 'model' | 'source';

function isWeekend(day: string): boolean {
  const d = new Date(`${day}T00:00:00`).getDay();
  return d === 0 || d === 6;
}

/** Spend-by-day section: section head with the breakdown control, then chart. */
function SpendSection({
  unit,
  days,
  modelKeys,
  modelVars,
  sourceKeys,
  activeDay,
  onDay,
}: {
  unit: DisplayUnit;
  days: DaySpend[];
  modelKeys: string[];
  modelVars: Map<string, string>;
  sourceKeys: string[];
  activeDay: string | null;
  onDay: (day: string) => void;
}) {
  const [mode, setMode] = useState<ChartMode>('total');
  const options: { value: ChartMode; label: string }[] = [
    { value: 'total', label: 'Total' },
    { value: 'model', label: 'By model' },
    { value: 'source', label: 'By source' },
  ];
  const title = unit === 'tokens' ? 'Tokens by day' : 'Spend by day';
  return (
    <section {...tourAttr('overview-trend')} aria-label={title}>
      <SectionHead title={title}>
        <fieldset
          aria-label="Chart breakdown"
          className="m-0 inline-flex overflow-hidden rounded border border-border-slate bg-surface-container-low p-0"
        >
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={mode === o.value}
              onClick={() => setMode(o.value)}
              className={`px-3 py-1 text-label transition-colors duration-150 ease-out ${
                i > 0 ? 'border-border-slate border-l' : ''
              } ${
                mode === o.value
                  ? 'bg-surface font-medium text-text'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'
              }`}
            >
              {o.label}
            </button>
          ))}
        </fieldset>
      </SectionHead>
      <div className="mt-3 rounded border border-border-slate bg-surface-container-low px-4 py-3.5 shadow-card motion-safe:animate-[rise_500ms_var(--ease-out)_both]">
        <SpendChart
          unit={unit}
          days={days}
          mode={mode}
          modelKeys={modelKeys}
          modelVars={modelVars}
          sourceKeys={sourceKeys}
          activeDay={activeDay}
          onDay={onDay}
        />
      </div>
    </section>
  );
}

function SpendChart({
  unit,
  days,
  mode,
  modelKeys,
  modelVars,
  sourceKeys,
  activeDay,
  onDay,
}: {
  unit: DisplayUnit;
  days: DaySpend[];
  mode: ChartMode;
  modelKeys: string[];
  modelVars: Map<string, string>;
  sourceKeys: string[];
  activeDay: string | null;
  onDay: (day: string) => void;
}) {
  const [hover, setHover] = useState<{
    i: number;
    x: number;
    y: number;
  } | null>(null);
  const tokensLead = unit === 'tokens';
  // bar heights in the display unit; the waste strip stays a share of the
  // day's dollars (waste has no token count) and says so in token mode
  const heightOf = (d: DaySpend) => inUnit(unit, d);
  const stackOf = (d: DaySpend, key: string) =>
    (mode === 'model'
      ? (tokensLead ? d.byModelTokens : d.byModel)[key]
      : (tokensLead ? d.bySourceTokens : d.bySource)[key]) ?? 0;
  const figure = (d: DaySpend) =>
    tokensLead
      ? `${formatTokensCompact(d.tokens)} tokens`
      : formatUSD(d.costUSD);
  const wasteNote = (d: DaySpend) =>
    `${formatUSD(d.wastedUSD)} wasted${tokensLead ? ` ${AT_API_PRICES}` : ''}`;
  const max = Math.max(...days.map(heightOf), 0);
  if (max === 0) {
    return (
      <p className="py-8 text-center text-label text-text-faint">
        {tokensLead
          ? 'No sessions with token counts yet.'
          : 'No priced sessions yet.'}
      </p>
    );
  }

  const W = 1000;
  const H = 168;
  const PAD_T = 8;
  const PAD_B = 18;
  const plotH = H - PAD_T - PAD_B;
  const n = days.length;
  const slot = W / n;
  const barW = Math.min(slot * 0.62, 30);
  const total = days.reduce((s, d) => s + heightOf(d), 0);
  const stackKeys = mode === 'model' ? modelKeys : sourceKeys;
  const colorOf = (key: string) =>
    mode === 'model'
      ? (modelVars.get(key) ?? 'var(--color-model-1)')
      : sourceColorVar(key);

  let acc = 0;
  const burn = days.map((d, i) => {
    acc += heightOf(d);
    const x = (i + 0.5) * slot;
    const y = H - PAD_B - (total > 0 ? acc / total : 0) * plotH * 0.94;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const hovered = hover === null ? undefined : days[hover.i];
  const onEnter = (i: number) => (e: { clientX: number; clientY: number }) =>
    setHover({ i, x: e.clientX, y: e.clientY });

  return (
    <>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Daily ${tokensLead ? 'tokens' : 'spend'} across ${n} days. Bar height is ${tokensLead ? 'tokens' : 'cost'}; the strip under each bar warms with that day's share of wasted spend${tokensLead ? ` ${AT_API_PRICES}` : ''}; the light line is cumulative burn.`}
          className="block h-40 w-full"
        >
          {[1, 2, 3].map((g) => {
            const gy = PAD_T + (plotH * g) / 4;
            return (
              <line
                key={g}
                x1={0}
                y1={gy}
                x2={W}
                y2={gy}
                stroke="var(--color-border)"
                strokeWidth={1}
                strokeDasharray="2 6"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {days.map((day, i) => {
            const x = i * slot + (slot - barW) / 2;
            const active = activeDay === day.day;
            const share = day.costUSD > 0 ? day.wastedUSD / day.costUSD : 0;
            const stripColor =
              share === 0
                ? 'var(--color-border-strong)'
                : share < 0.1
                  ? 'var(--color-heat-1)'
                  : share < 0.18
                    ? 'var(--color-heat-2)'
                    : 'var(--color-heat-3)';
            const totalH = Math.max((heightOf(day) / max) * plotH, 3);
            return (
              <g key={day.day}>
                {isWeekend(day.day) && (
                  <rect
                    x={i * slot}
                    y={PAD_T}
                    width={slot}
                    height={plotH}
                    fill="var(--color-text)"
                    opacity={0.03}
                  />
                )}
                {active && (
                  <rect
                    x={i * slot}
                    y={PAD_T}
                    width={slot}
                    height={plotH}
                    fill="var(--color-brand)"
                    opacity={0.09}
                  />
                )}
                {heightOf(day) > 0 &&
                  (mode === 'total' ? (
                    <rect
                      x={x}
                      y={H - PAD_B - totalH}
                      width={barW}
                      height={totalH}
                      rx={1.5}
                      fill="var(--color-brand)"
                      opacity={0.82}
                    />
                  ) : (
                    (() => {
                      let accH = 0;
                      return stackKeys.map((key) => {
                        const val = stackOf(day, key);
                        if (val <= 0) return null;
                        const h = (val / max) * plotH;
                        const y = H - PAD_B - accH - h;
                        accH += h;
                        return (
                          <rect
                            key={key}
                            x={x}
                            y={y}
                            width={barW}
                            height={Math.max(h - 0.5, 0.5)}
                            rx={1}
                            fill={colorOf(key)}
                            opacity={0.88}
                          />
                        );
                      });
                    })()
                  ))}
                {heightOf(day) > 0 && (
                  <rect
                    x={x}
                    y={H - PAD_B + 4}
                    width={barW}
                    height={3}
                    rx={1.5}
                    fill={stripColor}
                    opacity={share === 0 ? 0.5 : 1}
                  />
                )}
              </g>
            );
          })}
          <line
            x1={(n - 0.5) * slot}
            y1={PAD_T}
            x2={(n - 0.5) * slot}
            y2={H - PAD_B}
            stroke="var(--color-brand-bright)"
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.55}
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={`M${burn.join(' L')}`}
            fill="none"
            stroke="var(--color-brand-bright)"
            strokeWidth={1.4}
            opacity={0.5}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* interaction overlay: one transparent hit-cell per day (real buttons
            for drillable days, so keyboard + hover both work over the SVG) */}
        <div className="absolute inset-0 flex">
          {days.map((day, i) =>
            onDay !== undefined && day.runs > 0 ? (
              <button
                key={day.day}
                type="button"
                onClick={() => onDay(day.day)}
                onMouseMove={onEnter(i)}
                onMouseLeave={() => setHover(null)}
                aria-pressed={activeDay === day.day}
                aria-label={`Filter to ${day.day}, ${figure(day)}, ${day.runs} ${day.runs === 1 ? 'run' : 'runs'}${day.wastedUSD > 0 ? `, ${wasteNote(day)}` : ''}`}
                className="flex-1 rounded-sm"
              />
            ) : (
              // biome-ignore lint/a11y/noStaticElementInteractions: empty/non-drillable day; hover-only tooltip, chart summary is on the svg aria-label
              <div
                key={day.day}
                onMouseMove={onEnter(i)}
                onMouseLeave={() => setHover(null)}
                className="flex-1"
              />
            ),
          )}
        </div>
        {hovered !== undefined && hover !== null && (
          <div
            className="pointer-events-none fixed z-50 rounded-control bg-surface-2 px-2 py-1 font-mono text-label text-text shadow-popover"
            style={{ left: hover.x + 10, top: hover.y - 30 }}
          >
            {hovered.day} ·{' '}
            <span className="text-brand">{figure(hovered)}</span>
            {hovered.wastedUSD > 0 && (
              <span className="text-heat-2"> · {wasteNote(hovered)}</span>
            )}
            {hovered.runs > 0
              ? ` · ${hovered.runs} ${hovered.runs === 1 ? 'run' : 'runs'}`
              : ' · idle'}
          </div>
        )}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-label text-text-faint">
        <span>{days[0]?.day}</span>
        <span>{days[days.length - 1]?.day}</span>
      </div>
      <ChartLegend
        unit={unit}
        mode={mode}
        modelKeys={modelKeys}
        modelVars={modelVars}
        sourceKeys={sourceKeys}
      />
    </>
  );
}

function ChartLegend({
  unit,
  mode,
  modelKeys,
  modelVars,
  sourceKeys,
}: {
  unit: DisplayUnit;
  mode: ChartMode;
  modelKeys: string[];
  modelVars: Map<string, string>;
  sourceKeys: string[];
}) {
  const tokensLead = unit === 'tokens';
  const wasteItem = {
    label: tokensLead
      ? `waste share ${AT_API_PRICES} (strip)`
      : 'waste share (strip)',
    color: 'var(--color-heat-2)',
  };
  const items =
    mode === 'total'
      ? [
          {
            label: tokensLead ? 'daily tokens' : 'daily cost',
            color: 'var(--color-brand)',
          },
          wasteItem,
          { label: 'cumulative burn', color: 'var(--color-brand-bright)' },
        ]
      : mode === 'model'
        ? modelKeys
            .map((k) => ({
              label: k,
              color: modelVars.get(k) ?? 'var(--color-model-1)',
            }))
            .concat(wasteItem)
        : sourceKeys
            .map((k) => ({ label: k, color: sourceColorVar(k) }))
            .concat(wasteItem);
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-label text-text-dim">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <i
            aria-hidden
            className="inline-block h-2 w-2 rounded-[2px]"
            style={{ background: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function RankList({
  entries,
  maxCost,
  maxTokens,
  unit,
  onSelect,
  activeKey,
  filterNoun,
}: {
  entries: {
    key: string;
    label: string;
    costUSD: number;
    tokens: number;
    dotClass?: string;
  }[];
  maxCost: number;
  maxTokens?: number;
  unit: DisplayUnit;
  /** When set, each row is a button that drills the sessions to that entry. */
  onSelect?: (key: string) => void;
  /** The entry currently filtered on (brass active state), if any. */
  activeKey?: string | null;
  /** Names the dimension for the button's accessible label ("project"). */
  filterNoun?: string;
}) {
  if (entries.length === 0) {
    return (
      <p className="py-6 text-center text-label text-text-faint">No data.</p>
    );
  }
  const isTokens = unit === 'tokens';
  const maxValue = isTokens ? (maxTokens ?? 1) : maxCost;

  return (
    <ul className="space-y-2">
      {entries.map((entry) => {
        const active = activeKey === entry.key;
        const value = isTokens ? entry.tokens : entry.costUSD;
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-2 text-label">
              <span className="flex min-w-0 items-center gap-1.5">
                {entry.dotClass !== undefined && (
                  <i
                    aria-hidden
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${entry.dotClass}`}
                  />
                )}
                <span
                  className={`truncate ${active ? 'text-brand' : 'text-text'}`}
                >
                  {entry.label}
                </span>
              </span>
              <span className="shrink-0 font-mono text-text-dim">
                {isTokens
                  ? formatTokensCompact(entry.tokens)
                  : formatUSD(entry.costUSD)}
              </span>
            </div>
            <div className="mt-1 h-[3px] w-full rounded-full bg-surface-2">
              {/* models keep their ramp color; projects/sources meter in brass */}
              <div
                className={`h-full rounded-full ${entry.dotClass ?? 'bg-brand'} ${entry.dotClass !== undefined ? '' : 'opacity-75'}`}
                style={{
                  width: `${maxValue > 0 ? (value / maxValue) * 100 : 0}%`,
                }}
              />
            </div>
          </>
        );
        return (
          <li key={entry.key}>
            {onSelect === undefined ? (
              body
            ) : (
              <button
                type="button"
                onClick={() => onSelect(entry.key)}
                aria-pressed={active}
                aria-label={`Filter to ${filterNoun ?? ''} ${entry.label}`}
                className={`-mx-1.5 block w-full rounded-control px-1.5 py-1 text-left transition-colors duration-150 ease-out hover:bg-surface-2 active:bg-bg ${
                  active ? 'bg-brand/10' : ''
                }`}
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Cross-run waste grouped by rule (D4): each rule is a collapsible group whose
 * summary carries the count, distinct sessions, worst severity, and summed
 * waste; expanding lists the individual findings, each linking to its evidence
 * in the run's timeline. The worst group opens by default so the biggest leak
 * is visible without a click.
 */
function WasteBoard({ groups, runs }: { groups: RuleGroup[]; runs: Run[] }) {
  const dayOf = useMemo(
    () => new Map(runs.map((r) => [r.id, r.startedAt.slice(0, 10)])),
    [runs],
  );
  // The worst group (first) starts open; the rest collapse.
  const [openRules, setOpenRules] = useState<ReadonlySet<string>>(
    () => new Set(groups[0] === undefined ? [] : [groups[0].ruleId]),
  );
  const toggle = (ruleId: string) =>
    setOpenRules((prev) => {
      const next = new Set(prev);
      if (!next.delete(ruleId)) next.add(ruleId);
      return next;
    });

  return (
    <div className="-mx-1">
      {groups.map((group) => {
        const isOpen = openRules.has(group.ruleId);
        return (
          <div
            key={group.ruleId}
            className="border-t border-border-slate first:border-t-0"
          >
            <button
              type="button"
              onClick={() => toggle(group.ruleId)}
              aria-expanded={isOpen}
              className="grid w-full grid-cols-[14px_minmax(0,1fr)_auto_auto] items-center gap-3 rounded px-1 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-surface-variant active:bg-bg-deep-gray"
            >
              <span
                aria-hidden
                className={`text-text-faint text-[10px] transition-transform duration-150 ease-out ${isOpen ? 'rotate-90' : ''}`}
              >
                ▶
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">
                  <span className="text-body text-text">
                    {ruleLabel(group.ruleId).label}
                  </span>
                  <span className="ml-2 font-mono text-label text-text-faint">
                    {group.ruleId}
                  </span>
                  <span className="text-label text-text-faint">
                    {' · '}
                    {group.count} {group.count === 1 ? 'finding' : 'findings'}
                    {group.sessionCount > 1 &&
                      ` in ${group.sessionCount} sessions`}
                  </span>
                </span>
                {/* one-line explanation (spec: header shows label + explain) */}
                <span className="truncate text-label text-text-faint">
                  {ruleLabel(group.ruleId).explain}
                </span>
              </span>
              <SeverityPill severity={group.worstSeverity} />
              <span className="whitespace-nowrap font-mono text-body text-heat-2">
                <CoverageCaveat runs={runs} />
                {formatUSD(group.totalUSD)}
              </span>
            </button>
            {isOpen && (
              <div className="pb-2 pl-[26px]">
                {group.entries.map((entry) => (
                  <EvidenceInline
                    key={`${entry.runId}:${entry.insight.id}`}
                    entry={{
                      ...entry,
                      runTitle: `${dayOf.get(entry.runId) ?? ''} ${entry.runTitle}`,
                    }}
                    runs={runs}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
