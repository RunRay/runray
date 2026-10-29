import { describe, expect, it } from 'vitest';
import {
  budgetIn,
  previousWindow,
  windowBounds,
  windowStartLabel,
} from './limit-window';

// TZ-proof assertions: relative properties (containment, local day-of-week,
// local hour, exact length) instead of absolute epoch values.

const DAY_MS = 86_400_000;

describe('windowBounds (E7)', () => {
  const anchor = '2026-07-18T09:30:00'; // a Saturday, local time

  it('is deterministic and anchored — never Date.now()', () => {
    const a = windowBounds(anchor, { days: 7, resetDay: 'thu' });
    const b = windowBounds(anchor, { days: 7, resetDay: 'thu' });
    expect(a).toEqual(b);
    expect(a.end - a.start).toBe(7 * DAY_MS);
    const t = Date.parse(anchor);
    expect(t).toBeGreaterThanOrEqual(a.start);
    expect(t).toBeLessThan(a.end);
  });

  it('starts on the configured local reset day and hour', () => {
    const bounds = windowBounds(anchor, {
      days: 7,
      resetDay: 'thu',
      resetHour: 14,
    });
    const start = new Date(bounds.start);
    expect(start.getDay()).toBe(4); // thursday
    expect(start.getHours()).toBe(14);
  });

  it('an anchor before the reset hour lands in the PREVIOUS window', () => {
    const before = windowBounds('2026-07-16T10:00:00', {
      days: 7,
      resetDay: 'thu',
      resetHour: 14,
    });
    const after = windowBounds('2026-07-16T15:00:00', {
      days: 7,
      resetDay: 'thu',
      resetHour: 14,
    });
    expect(after.start - before.start).toBe(7 * DAY_MS);
  });

  it('days < 7 steps sub-week windows from the reset reference', () => {
    const bounds = windowBounds(anchor, { days: 1, resetDay: 'mon' });
    expect(bounds.end - bounds.start).toBe(DAY_MS);
    const t = Date.parse(anchor);
    expect(t).toBeGreaterThanOrEqual(bounds.start);
    expect(t).toBeLessThan(bounds.end);
  });
});

/** Run `fn` in another time zone; Node re-reads TZ when it is assigned. */
function inZone<T>(zone: string, fn: () => T): T {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

describe('windowBounds across a daylight-saving change', () => {
  it('keeps the reset hour in the week the clocks go back', () => {
    // Europe/Warsaw left summer time on Sun 2026-10-25 at 03:00; the week
    // from Mon 19 Oct 00:00 to Mon 26 Oct 00:00 is 7 days and 1 hour long
    const bounds = inZone('Europe/Warsaw', () => {
      const b = windowBounds('2026-10-25T23:30:00+01:00', { resetDay: 'mon' });
      return {
        b,
        start: [new Date(b.start).getDay(), new Date(b.start).getHours()],
        end: [new Date(b.end).getDay(), new Date(b.end).getHours()],
      };
    });
    expect(bounds.start).toEqual([1, 0]);
    expect(bounds.end).toEqual([1, 0]);
    expect(bounds.b.end - bounds.b.start).toBe(7 * DAY_MS + 3_600_000);
  });

  it('starts on the reset day and hour for every hour of a year', () => {
    inZone('America/New_York', () => {
      const cfg = { days: 7, resetDay: 'thu' as const, resetHour: 14 };
      const from = Date.parse('2026-01-01T00:00:00Z');
      for (let t = from; t < from + 365 * DAY_MS; t += 3 * 3_600_000) {
        const b = windowBounds(new Date(t).toISOString(), cfg);
        const start = new Date(b.start);
        expect([start.getDay(), start.getHours()]).toEqual([4, 14]);
        expect(t).toBeGreaterThanOrEqual(b.start);
        expect(t).toBeLessThan(b.end);
      }
    });
  });
});

describe('previousWindow', () => {
  it('is the window of the same length in days right before', () => {
    const cfg = { days: 7, resetDay: 'mon' as const };
    const bounds = windowBounds('2026-07-18T09:30:00', cfg);
    const prev = previousWindow(bounds, cfg);
    expect(prev.end).toBe(bounds.start);
    expect(prev).toEqual(
      windowBounds(new Date(bounds.start - 1).toISOString(), cfg),
    );
  });
});

describe('windowStartLabel', () => {
  it('names the local weekday and time a window starts', () => {
    const bounds = windowBounds('2026-07-18T09:30:00', {
      resetDay: 'thu',
      resetHour: 14,
    });
    expect(windowStartLabel(bounds)).toBe('Thu 14:00');
    expect(windowStartLabel(windowBounds('2026-07-18T09:30:00', {}))).toBe(
      'Mon 00:00',
    );
  });
});

describe('budgetIn', () => {
  it('returns the budget in the asked unit, never the other one', () => {
    const cfg = { budgetUSD: 300, budgetTokens: 500_000_000 };
    expect(budgetIn(cfg, 'usd')).toBe(300);
    expect(budgetIn(cfg, 'tokens')).toBe(500_000_000);
    expect(budgetIn({ budgetTokens: 5 }, 'usd')).toBeUndefined();
    expect(budgetIn({ budgetUSD: 0 }, 'usd')).toBeUndefined();
    expect(budgetIn(undefined, 'tokens')).toBeUndefined();
  });
});
