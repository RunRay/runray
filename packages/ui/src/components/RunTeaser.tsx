import type { Run } from '@runray/schema';
import { useMemo } from 'react';
import { formatDuration, formatTokensCompact, formatUSD } from '../lib/format';
import { assignModelColorVars } from '../lib/model-colors';
import { buildRunTeaser, teaserRun } from '../lib/run-teaser';
import { AT_API_PRICES, formatFigure } from '../lib/unit';
import { useAppStore } from '../store';
import { ruleLabel } from './SavingsPanel';

/**
 * "Inside a run — where the money went" (redesign mockup, cost axis by model):
 * the priciest visible run's cost split per model — each model on its own row,
 * offset along the x-axis so it starts where the previous one ended, so the
 * bars march across and tile up to the whole run total. The inspector
 * spotlights the top model; the card links into the full run. In token mode
 * (E6) it is the heaviest run, split by tokens, with the top model's dollars
 * "at API prices".
 */

/** A tidy percentage: one decimal under 10%, whole above. */
function pct(share: number): string {
  const p = share * 100;
  return `${p.toFixed(p < 10 ? 1 : 0)}%`;
}

export function RunTeaser({ runs }: { runs: Run[] }) {
  const unit = useAppStore((s) => s.unit);
  const teaser = useMemo(() => {
    const run = teaserRun(runs, unit);
    return run === undefined ? null : buildRunTeaser(run, unit);
  }, [runs, unit]);
  // Model → color assigned over ALL visible runs, so a model keeps the same
  // hue here as in the overview's "Top models".
  const modelColor = useMemo(
    () =>
      assignModelColorVars(
        runs.flatMap((r) => Object.keys(r.totals.costUSD.byModel)),
      ),
    [runs],
  );
  if (teaser === null) return null;

  const { run, total, rows, other, topModel, topShare, topDetail, topInsight } =
    teaser;
  const tokensLead = unit === 'tokens';
  const top = rows[0];
  // a bar's figure in the unit: rows carry both, totals only the unit's
  const inLead = (value: number) =>
    formatFigure(unit, { costUSD: value, tokens: value });
  const open = () => {
    useAppStore.getState().navigateTo({ view: 'cost', runId: run.id });
  };

  // Cascade offsets: each model starts where the previous one ended.
  let acc = 0;
  const cascade = rows.map((row) => {
    const leftFrac = acc;
    acc += row.shareOfRun;
    return { row, leftFrac };
  });
  const otherLeftFrac = acc;
  const otherShare = total > 0 ? other / total : 0;
  const cacheHit =
    topDetail.cacheRead + topDetail.tokensIn > 0
      ? (topDetail.cacheRead / (topDetail.cacheRead + topDetail.tokensIn)) * 100
      : null;

  return (
    <section
      aria-label={
        tokensLead ? 'Token breakdown preview' : 'Cost breakdown preview'
      }
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-header font-semibold text-text">
          {tokensLead
            ? 'Where the tokens went in this run'
            : 'Where the money went in this run'}
        </h2>
        <span className="hidden shrink-0 text-label text-text-faint sm:inline">
          by model · {tokensLead ? 'heaviest' : 'priciest'} of {runs.length}{' '}
          {runs.length === 1 ? 'session' : 'sessions'}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-1 overflow-hidden rounded-panel border border-border bg-surface shadow-card md:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <button
              type="button"
              onClick={open}
              className="min-w-0 truncate text-left font-display text-title font-semibold text-text transition-colors duration-150 ease-out hover:text-brand"
            >
              {run.title ?? `${run.source.tool} session`}{' '}
              <span className="font-mono text-label text-brand">
                {formatFigure(
                  unit,
                  {
                    costUSD: run.totals.costUSD.total,
                    tokens: run.totals.tokens.total,
                  },
                  { named: true },
                )}
              </span>
              {run.durationMs !== undefined && (
                <span className="font-mono text-label text-text-faint">
                  {' '}
                  · {formatDuration(run.durationMs)}
                </span>
              )}
            </button>
            <span className="shrink-0 font-mono text-label text-text-faint">
              {rows.length} {rows.length === 1 ? 'model' : 'models'}
            </span>
          </div>
          <ul className="mt-3 flex flex-col gap-1">
            {/* baseline: the whole run at 100% — the ruler the cascade fills */}
            <CostBar
              label="whole run"
              cost={inLead(total)}
              leftFrac={0}
              frac={1}
              color="var(--color-span-hook)"
              index={0}
            />
            {cascade.map(({ row, leftFrac }, i) => (
              <CostBar
                key={row.model}
                label={row.model}
                cost={formatFigure(unit, row)}
                leftFrac={leftFrac}
                frac={row.shareOfRun}
                color={modelColor.get(row.model) ?? 'var(--color-model-1)'}
                index={i + 1}
              />
            ))}
            {other > (tokensLead ? 0 : 0.005) && (
              <CostBar
                label="other"
                cost={inLead(other)}
                leftFrac={otherLeftFrac}
                frac={otherShare}
                color="var(--color-border-strong)"
                index={rows.length + 1}
                muted
              />
            )}
          </ul>
        </div>
        <aside className="border-border border-t bg-surface-2 p-4 md:border-t-0 md:border-l">
          <p className="micro-label text-text-faint">Top model</p>
          <dl className="mt-2.5 flex flex-col gap-2">
            <Kv k="model" v={topModel} />
            {tokensLead ? (
              <>
                <Kv
                  k="tokens"
                  v={`${formatTokensCompact(top?.tokens ?? 0)} · ${pct(topShare)}`}
                  tone="money"
                />
                <Kv
                  k="cost"
                  v={`${formatUSD(top?.costUSD ?? 0)} ${AT_API_PRICES}`}
                />
              </>
            ) : (
              <Kv
                k="cost"
                v={`${formatUSD(top?.costUSD ?? 0)} · ${pct(topShare)}`}
                tone="money"
              />
            )}
            <Kv k="calls" v={`${formatTokensCompact(topDetail.calls)}`} />
            <Kv
              k={tokensLead ? 'in / out' : 'tokens'}
              v={`${formatTokensCompact(topDetail.tokensIn)} in · ${formatTokensCompact(topDetail.tokensOut)} out`}
            />
            {cacheHit !== null && (
              <Kv k="cache" v={`${cacheHit.toFixed(0)}% hit`} tone="sage" />
            )}
          </dl>
          {topInsight !== undefined && (
            <p className="mt-3 border-border border-t border-dashed pt-3 text-label text-text-faint">
              <span className="text-heat-2" title={topInsight.ruleId}>
                ⚠ {ruleLabel(topInsight.ruleId).label}
              </span>
              : {topInsight.suggestion ?? topInsight.title}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}

/**
 * One cascade row: a ramp dot + name in a readable label column, then a bar
 * offset to `leftFrac` (where the previous model ended) and sized by `frac`
 * (its share of the run) so the bars tile across to the whole-run width, then
 * the cost. Keeping labels on the surface (not on the ramp-colored bars) sides
 * with legibility — the ramp spans light-to-dark shades no single ink survives.
 */
function CostBar({
  label,
  cost,
  leftFrac,
  frac,
  color,
  index,
  muted,
}: {
  label: string;
  cost: string;
  leftFrac: number;
  frac: number;
  color: string;
  index: number;
  muted?: boolean;
}) {
  return (
    <li
      className="flex items-center gap-3"
      title={`${label} · ${cost} · ${pct(frac)}`}
    >
      <span className="flex w-36 shrink-0 items-center gap-1.5 overflow-hidden">
        <i
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
          style={{ background: color }}
        />
        <span
          className={`truncate text-label ${muted ? 'text-text-dim' : 'text-text'}`}
        >
          {label}
        </span>
      </span>
      <div className="relative h-[14px] flex-1">
        {/* the full-width track = the run's 100% ruler */}
        <div className="absolute inset-0 rounded-[3px] bg-surface-2" />
        <div
          className="absolute inset-y-0 rounded-[3px] origin-left motion-safe:animate-[bar-in_320ms_var(--ease-out)_both]"
          style={{
            left: `${(leftFrac * 100).toFixed(2)}%`,
            width: `max(${(frac * 100).toFixed(2)}%, 3px)`,
            background: color,
            transformOrigin: 'left center',
            animationDelay: `${Math.min(index * 60, 320)}ms`,
          }}
        />
      </div>
      <span className="w-16 shrink-0 text-right font-mono text-label text-text-dim">
        {cost}
      </span>
    </li>
  );
}

function Kv({ k, v, tone }: { k: string; v: string; tone?: 'money' | 'sage' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-label">
      <dt className="shrink-0 text-text-faint">{k}</dt>
      <dd
        className={`min-w-0 truncate font-mono ${
          tone === 'money'
            ? 'text-brand'
            : tone === 'sage'
              ? 'text-cache-savings'
              : 'text-text-dim'
        }`}
        title={v}
      >
        {v}
      </dd>
    </div>
  );
}
