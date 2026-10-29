import { formatTokensCompact, formatUSD } from '../lib/format';
import { budgetIn } from '../lib/limit-window';
import type { DisplayUnit } from '../lib/unit';
import { useAppStore, useLimitWindow } from '../store';

/**
 * The since-reset period's budget meter (E7): the window's spend or tokens
 * against the budget set in `limitWindow`, in the display unit. The caller
 * renders it only while the since-reset period is active and no single day
 * is pinned, so the figure it measures is the headline right above it. No
 * budget in the unit means no percentage; the live viewer names the config
 * key instead (an export's reader can't set one).
 *
 * The track spans the larger of the budget and the use: under budget the
 * fill stops short of the end; over it, a tick marks the budget and the
 * overrun runs past it in the overspend colour.
 */
export function BudgetMeter({
  unit,
  costUSD,
  tokens,
}: {
  unit: DisplayUnit;
  /** The visible runs' totals: the headline figures. */
  costUSD: number;
  tokens: number;
}) {
  const limitWindow = useLimitWindow();
  const live = useAppStore((s) => s.data.status === 'ready' && s.data.live);
  const budget = budgetIn(limitWindow, unit);

  if (budget === undefined) {
    if (!live) return null;
    const key = unit === 'tokens' ? 'budgetTokens' : 'budgetUSD';
    return (
      <p className="text-label text-text-faint">
        Set <code className="font-mono">limitWindow.{key}</code> in{' '}
        <code className="font-mono">runray.config.json</code> to see this window
        against a budget.
      </p>
    );
  }

  const used = unit === 'tokens' ? tokens : costUSD;
  const share = used / budget;
  const over = share > 1;
  const span = Math.max(share, 1);
  const fill = Math.min(share, 1) / span;
  const pct =
    share > 0 && share < 0.01 ? '<1' : String(Math.round(share * 100));
  const figure = (n: number) =>
    unit === 'tokens' ? formatTokensCompact(n) : formatUSD(n);

  return (
    <div key={unit} className="w-full max-w-sm">
      <p className="flex flex-wrap items-baseline gap-x-2 text-label">
        <span className="font-mono text-text">
          {figure(used)} of {figure(budget)}
          {unit === 'tokens' ? ' tokens' : ''}
        </span>
        <span className={over ? 'text-heat-2' : 'text-text-dim'}>
          ≈{pct}% used (est.){over ? ', over budget' : ''}
        </span>
      </p>
      <div
        aria-hidden
        className="relative mt-1.5 h-1 w-full overflow-hidden rounded-[2px] bg-border-slate/70"
      >
        <div
          className="absolute inset-y-0 left-0 w-full origin-left rounded-[2px] bg-brand motion-safe:animate-[bar-in_480ms_var(--ease-out)_both]"
          style={{ transform: `scaleX(${fill})` }}
        />
        {over && (
          <>
            <div
              className="absolute inset-y-0 left-0 w-full origin-left bg-heat-2"
              style={{
                transform: `translateX(${fill * 100}%) scaleX(${1 - fill})`,
              }}
            />
            {/* the budget line the overrun runs past */}
            <div
              className="absolute inset-y-0 w-px bg-text"
              style={{ left: `${fill * 100}%` }}
            />
          </>
        )}
      </div>
    </div>
  );
}
