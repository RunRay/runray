import type { Run } from '@runray/schema';
import { useMemo, useRef, useState } from 'react';
import { formatTokensCompact, formatUSD } from '../lib/format';
import {
  type LimitWindowConfig,
  limitShare,
  type WindowSpend,
  windowBounds,
  windowSpend,
} from '../lib/limit-window';
import { useAppStore } from '../store';
import { ContextualHint } from './ContextualHint';

/**
 * Limit display mode (E1): opt-in % framing for subscription users whose
 * currency is a reference window, not dollars. Every % carries "est." —
 * this is a user-configured window, never a provider quota; percentages
 * appear in exactly three slots (overview statement, Wasted KPI, run Cost
 * hero) so the framing never doubles every number's visual weight. Window
 * math anchors to the newest run — exports render identical forever.
 */

export interface LimitView {
  cfg: LimitWindowConfig;
  spend: WindowSpend;
}

/** Active limit view over the LOADED runs; null when off/unconfigured/empty. */
export function useLimitView(): LimitView | null {
  const limit = useAppStore((s) => s.limit);
  const data = useAppStore((s) => s.data);
  return useMemo(() => {
    if (!limit.enabled || limit.config === undefined) return null;
    if (data.status !== 'ready' || data.traceFile.runs.length === 0) {
      return null;
    }
    // runs are newest-first; the anchor is the newest run's end (or start)
    const newest = data.traceFile.runs[0] as Run;
    const bounds = windowBounds(
      newest.endedAt ?? newest.startedAt,
      limit.config,
    );
    const spend = windowSpend(data.traceFile.runs, bounds);
    if (spend.runs === 0) return null; // suppressed: window has no runs
    return { cfg: limit.config, spend };
  }, [limit, data]);
}

/** Secondary statement line (slot 1): budget-aware copy, never X-of-itself. */
export function LimitStatementLine() {
  const view = useLimitView();
  if (view === null) return null;
  const { cfg, spend } = view;

  let textContent: React.ReactNode = null;
  if ((cfg.budgetUSD ?? 0) > 0) {
    const share = limitShare(spend.costUSD, spend, cfg, 'usd');
    textContent = (
      <span className="text-label text-text-dim">
        this window:{' '}
        <span className="font-mono">{formatUSD(spend.costUSD)}</span>
        {' of '}
        <span className="font-mono">{formatUSD(cfg.budgetUSD ?? 0)}</span>
        {share !== undefined && <> (≈{Math.round(share * 100)}% used, est.)</>}
      </span>
    );
  } else if ((cfg.budgetTokens ?? 0) > 0) {
    const share = limitShare(spend.tokens, spend, cfg, 'tokens');
    textContent = (
      <span className="text-label text-text-dim">
        this window:{' '}
        <span className="font-mono">{formatTokensCompact(spend.tokens)}</span>
        {' of '}
        <span className="font-mono">
          {formatTokensCompact(cfg.budgetTokens ?? 0)}
        </span>
        {' tokens'}
        {share !== undefined && <> (≈{Math.round(share * 100)}% used, est.)</>}
      </span>
    );
  } else {
    textContent = (
      <span className="text-label text-text-dim">
        this window:{' '}
        <span className="font-mono">{formatTokensCompact(spend.tokens)}</span>
        {' tokens'}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ContextualHint hintKey="limit-mode" />
      {textContent}
    </div>
  );
}

/** Suffix for one dollar figure (slots 2–3): "≈N% of window, est." */
export function LimitSuffix({ valueUSD }: { valueUSD: number }) {
  const view = useLimitView();
  if (view === null) return null;
  const share = limitShare(valueUSD, view.spend, view.cfg);
  if (share === undefined) return null;
  return (
    <span className="font-sans text-label font-normal text-text-dim">
      ≈{share < 0.01 ? '<1' : Math.round(share * 100)}% of window, est.
    </span>
  );
}

const DAYS: NonNullable<LimitWindowConfig['resetDay']>[] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
];

/** TopBar toggle + settings popover — the double opt-in lives here. */
export function LimitModeToggle() {
  const limit = useAppStore((s) => s.limit);
  const setLimitEnabled = useAppStore((s) => s.setLimitEnabled);
  const setLimitOverride = useAppStore((s) => s.setLimitOverride);
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const configured = limit.config !== undefined;

  const draft = limit.config ?? { days: 7, resetDay: 'mon', resetHour: 0 };
  const patch = (p: Partial<LimitWindowConfig>) =>
    setLimitOverride({ ...draft, ...p });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Limit window display mode"
        aria-pressed={configured && limit.enabled}
        title="Show costs as % of a reference window (est.)"
        className={`rounded-control border px-2 py-0.5 font-mono text-label transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass active:bg-bg-deep-gray ${
          configured && limit.enabled
            ? 'border-brass/60 bg-brass/15 text-text'
            : 'border-border-slate bg-surface text-text-dim hover:bg-surface-variant hover:text-text'
        }`}
      >
        %win
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Limit window settings"
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded border border-border-slate bg-surface-container-low p-3 shadow-card"
        >
          <label className="flex items-center justify-between gap-2 text-label text-text">
            show % of window
            <input
              type="checkbox"
              checked={limit.enabled}
              disabled={!configured}
              onChange={(e) => setLimitEnabled(e.target.checked)}
              className="accent-[var(--color-brass)]"
            />
          </label>
          <p className="mt-1 text-label text-text-faint">
            A user-configured reference window. This is an estimate, not an
            official provider quota.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-label text-text-dim">
            <label className="flex flex-col gap-0.5">
              days
              <input
                type="number"
                min={1}
                max={90}
                value={draft.days ?? 7}
                onChange={(e) => patch({ days: Number(e.target.value) || 7 })}
                className="rounded-control border border-border-slate bg-surface px-1.5 py-0.5 font-mono text-text"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              reset day
              <select
                value={draft.resetDay ?? 'mon'}
                onChange={(e) =>
                  patch({
                    resetDay: e.target.value as LimitWindowConfig['resetDay'],
                  })
                }
                className="rounded-control border border-border-slate bg-surface px-1.5 py-1 font-mono text-text"
              >
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              reset hour
              <input
                type="number"
                min={0}
                max={23}
                value={draft.resetHour ?? 0}
                onChange={(e) =>
                  patch({ resetHour: Number(e.target.value) || 0 })
                }
                className="rounded-control border border-border-slate bg-surface px-1.5 py-0.5 font-mono text-text"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              budget $ (opt.)
              <input
                type="number"
                min={0}
                value={draft.budgetUSD ?? ''}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  patch({ budgetUSD: v > 0 ? v : undefined });
                }}
                className="rounded-control border border-border-slate bg-surface px-1.5 py-0.5 font-mono text-text"
              />
            </label>
          </div>
          <div className="mt-2 flex justify-between">
            <button
              type="button"
              onClick={() => {
                setLimitOverride(null);
                setLimitEnabled(false);
              }}
              className="rounded-control border border-border-slate bg-surface px-2 py-0.5 text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-text active:bg-bg-deep-gray"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-control border border-border-slate bg-surface px-2 py-0.5 text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-text active:bg-bg-deep-gray"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
