/**
 * Usage-limit window math (E7): the window behind the since-reset period
 * and the budget meter. A user-configured window, never a provider quota.
 * Every computation anchors to the NEWEST RUN's start, never `Date.now()`,
 * so an exported file renders the same window forever (the determinism rule
 * the rolling periods follow). Reset boundaries are local wall-clock: a
 * user's "resets Thursday 14:00" is a local fact, and it stays 14:00 across
 * a daylight-saving change.
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

const DAY_INDEX: Record<NonNullable<LimitWindowConfig['resetDay']>, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `days` local calendar days after `ms`, keeping the local wall-clock time. */
function addLocalDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** The window containing `anchorIso` (the newest run's startedAt). */
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
  // step days-long windows forward from the reference to the one holding
  // the anchor (only windows under 7 days take a step). Calendar days, not
  // fixed 24 h, so a daylight-saving change can't shift the reset hour.
  let start = ref.getTime();
  let end = addLocalDays(start, days);
  while (end <= anchor) {
    start = end;
    end = addLocalDays(start, days);
  }
  return { start, end };
}

/** The window immediately before `bounds`, the same length in days. */
export function previousWindow(
  bounds: WindowBounds,
  cfg: LimitWindowConfig,
): WindowBounds {
  return {
    start: addLocalDays(bounds.start, -(cfg.days ?? 7)),
    end: bounds.start,
  };
}

/** "Mon 00:00": the local weekday and time a window starts. */
export function windowStartLabel(bounds: WindowBounds): string {
  const d = new Date(bounds.start);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The budget in `unit`, when one is configured (the meter's gate). */
export function budgetIn(
  cfg: LimitWindowConfig | undefined,
  unit: 'usd' | 'tokens',
): number | undefined {
  const budget = unit === 'usd' ? cfg?.budgetUSD : cfg?.budgetTokens;
  return budget !== undefined && budget > 0 ? budget : undefined;
}
