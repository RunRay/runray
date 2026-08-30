import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatDateTime,
  formatDuration,
  formatRelativeTime,
  formatTokens,
  formatTokensCompact,
  formatUSD,
} from './format';

describe('formatUSD', () => {
  it('shows 4 decimals under a dollar, 2 above', () => {
    expect(formatUSD(0.3959)).toBe('$0.3959');
    expect(formatUSD(0)).toBe('$0.0000');
    expect(formatUSD(1)).toBe('$1.00');
    expect(formatUSD(12.408)).toBe('$12.41');
  });
});

describe('formatTokens', () => {
  it('groups thousands with thin spaces', () => {
    expect(formatTokens(138610)).toBe('138 610');
    expect(formatTokens(999)).toBe('999');
  });
});

describe('formatTokensCompact', () => {
  it('abbreviates to M / k with a floor of raw digits', () => {
    expect(formatTokensCompact(382_905_750)).toBe('382.9M');
    expect(formatTokensCompact(9_800_000)).toBe('9.8M');
    expect(formatTokensCompact(84_000)).toBe('84k');
    expect(formatTokensCompact(999_600)).toBe('1.0M'); // rolls over, not '1000k'
    expect(formatTokensCompact(999_400)).toBe('999k');
    expect(formatTokensCompact(512)).toBe('512');
    expect(formatTokensCompact(0)).toBe('0');
  });
});

describe('formatRelativeTime', () => {
  const ref = '2026-07-07T12:00:00';
  it('buckets against the reference instant, not wall-clock now', () => {
    expect(formatRelativeTime('2026-07-07T11:59:40', ref)).toBe('just now');
    expect(formatRelativeTime('2026-07-07T11:30:00', ref)).toBe('30 m ago');
    expect(formatRelativeTime('2026-07-07T09:00:00', ref)).toBe('3 h ago');
    expect(formatRelativeTime('2026-07-06T10:00:00', ref)).toBe('yesterday');
    expect(formatRelativeTime('2026-07-03T12:00:00', ref)).toBe('4 days ago');
  });
  it('falls back to the ISO date past a fortnight or on garbage', () => {
    expect(formatRelativeTime('2026-06-01T12:00:00', ref)).toBe('2026-06-01');
    expect(formatRelativeTime('nope', ref)).toBe('nope');
  });
});

describe('formatDuration', () => {
  it('scales units with duration', () => {
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(9500)).toBe('9.5s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(154_000)).toBe('2m 34s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });
});

describe('formatClock', () => {
  it('renders mm:ss offsets, adding hours past 60 minutes', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(134_000)).toBe('02:14');
    expect(formatClock(3_734_500)).toBe('1:02:14');
  });
});

describe('formatDateTime', () => {
  it('renders a sortable local timestamp and passes garbage through', () => {
    expect(formatDateTime('2026-07-07T00:00:00')).toBe('2026-07-07 00:00');
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});
