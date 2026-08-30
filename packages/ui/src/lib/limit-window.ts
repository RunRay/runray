import type { Run } from '@runray/schema';

/**
 * Limit-window math (E1): an OPT-IN display layer for subscription users —
 * "% of my reference window", never a provider quota. Every computation
 * anchors to the NEWEST RUN's timestamp, never `Date.now()`, so an
 * exported file renders the same percentages forever (the same
 * determinism rule the period filter follows). Reset boundaries are local
 * wall-clock: a user's "resets Thursday 14:00" is a local fact.
 */

export interface LimitWindowConfig {
  /** Window length in days (default 7). */
  days?: number;
  resetDay?: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  /** Local hour 0–23 the window resets at (default 0). */
  resetHour?: number;
  budgetUSD?: number;
  budgetTokens?: number;
}

export interface WindowBounds {
  /** Epoch ms, inclusive. */
  start: number;
  /** Epoch ms, exclusive. */
  end: number;
}

const DAY_MS = 86_400_000;
const DAY_INDEX: Record<NonNullable<LimitWindowConfig['resetDay']>, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** The window containing `anchorIso` (newest run's endedAt ?? startedAt). */
export function windowBounds(
  anchorIso: string,
  cfg: LimitWindowConfig,
): WindowBounds {
  const anchor = Date.parse(anchorIso);
  const days = cfg.days ?? 7;
  const resetHour = cfg.resetHour ?? 0;
  const targetDow = DAY_INDEX[cfg.resetDay ?? 'mon'];

  // most recent resetDay@resetHour at or before the anchor (local time)
  const ref = new Date(anchor);
  ref.setHours(resetHour, 0, 0, 0);
  while (ref.getDay() !== targetDow || ref.getTime() > anchor) {
    ref.setDate(ref.getDate() - 1);
  }
  // step days-length windows forward from the reference to the one
  // containing the anchor (covers days < 7; for days >= 7 steps = 0)
  const steps = Math.floor((anchor - ref.getTime()) / (days * DAY_MS));
  const start = ref.getTime() + steps * days * DAY_MS;
  return { start, end: start + days * DAY_MS };
}

export interface WindowSpend {
  costUSD: number;
  tokens: number;
  runs: number;
}

/** Runs bucketed into the window by startedAt (same convention as spendByDay). */
export function windowSpend(
  runs: readonly Run[],
  bounds: WindowBounds,
): WindowSpend {
  let costUSD = 0;
  let tokens = 0;
  let count = 0;
  for (const run of runs) {
    const t = Date.parse(run.startedAt);
    if (t < bounds.start || t >= bounds.end) continue;
    costUSD += run.totals.costUSD.total;
    tokens += run.totals.tokens.total;
    count += 1;
  }
  return { costUSD, tokens, runs: count };
}

/**
 * Share of the window's reference denominator: the configured budget when
 * present, else spend-to-date (and then a TOTAL figure must not be framed
 * against itself — callers phrase that slot as "$X spent this window").
 * Undefined when no meaningful denominator exists.
 */
export function limitShare(
  value: number,
  spend: WindowSpend,
  cfg: LimitWindowConfig,
  unit: 'usd' | 'tokens' = 'usd',
): number | undefined {
  const denominator =
    unit === 'usd'
      ? (cfg.budgetUSD ?? spend.costUSD)
      : (cfg.budgetTokens ?? spend.tokens);
  if (denominator <= 0) return undefined;
  return value / denominator;
}

/** True when the config carries an explicit budget (denominator ≠ self). */
export function hasBudget(cfg: LimitWindowConfig): boolean {
  return (cfg.budgetUSD ?? 0) > 0 || (cfg.budgetTokens ?? 0) > 0;
}
