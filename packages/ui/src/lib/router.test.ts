import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER } from './filter-runs';
import {
  DASHBOARD_ROUTE,
  formatHash,
  parseFilterParams,
  parseHash,
  type Route,
  SESSIONS_ROUTE,
  toHash,
} from './router';

describe('parseHash', () => {
  it('maps the documented routes', () => {
    expect(parseHash('#/sessions')).toEqual({ view: 'sessions' });
    expect(parseHash('#/run/abc123')).toEqual({
      view: 'cost',
      runId: 'abc123',
    });
    expect(parseHash('#/run/abc123/timeline')).toEqual({
      view: 'timeline',
      runId: 'abc123',
    });
  });

  it('falls back to dashboard for empty or unknown hashes', () => {
    expect(parseHash('')).toEqual({ view: 'dashboard' });
    expect(parseHash('#')).toEqual({ view: 'dashboard' });
    expect(parseHash('#/')).toEqual({ view: 'dashboard' });
    expect(parseHash('#/nope/xyz')).toEqual({ view: 'dashboard' });
    expect(parseHash('#/run')).toEqual({ view: 'dashboard' });
    expect(parseHash('#/run/abc/unknown')).toEqual({
      view: 'cost',
      runId: 'abc',
    });
  });

  it('round-trips every route shape through toHash, including ids needing encoding', () => {
    const routes: Route[] = [
      { view: 'dashboard' },
      { view: 'sessions' },
      { view: 'timeline', runId: 'a1b2c3' },
      { view: 'cost', runId: 'a1b2c3' },
      { view: 'timeline', runId: 'odd/id with space' },
      { view: 'diff', runA: 'a1b2c3', runB: 'e5f6a7' },
      { view: 'diff', runA: 'odd/id', runB: 'with space' },
    ];
    for (const route of routes) {
      expect(parseHash(toHash(route))).toEqual(route);
    }
  });
});

describe('diff route (run-diff 3.1)', () => {
  it('parses and formats #/diff/:a/:b', () => {
    expect(parseHash('#/diff/run_a/run_b')).toEqual({
      view: 'diff',
      runA: 'run_a',
      runB: 'run_b',
    });
    expect(toHash({ view: 'diff', runA: 'run_a', runB: 'run_b' })).toBe(
      '#/diff/run_a/run_b',
    );
  });

  it('a diff hash missing either slot falls back to the dashboard', () => {
    expect(parseHash('#/diff')).toEqual({ view: 'dashboard' });
    expect(parseHash('#/diff/run_a')).toEqual({ view: 'dashboard' });
  });

  it('keeps filter params across the ? split', () => {
    const hash = formatHash(
      { view: 'diff', runA: 'run_a', runB: 'run_b' },
      { ...EMPTY_FILTER, source: 'claude-code' },
    );
    expect(hash).toBe('#/diff/run_a/run_b?source=claude-code');
    expect(parseHash(hash)).toEqual({
      view: 'diff',
      runA: 'run_a',
      runB: 'run_b',
    });
    expect(parseFilterParams(hash).source).toBe('claude-code');
  });
});

describe('time route + filter params (D6/E2)', () => {
  it('parses and formats #/run/:id/time', () => {
    expect(parseHash('#/run/run_a/time')).toEqual({
      view: 'time',
      runId: 'run_a',
    });
    expect(toHash({ view: 'time', runId: 'run_a' })).toBe('#/run/run_a/time');
  });

  it('old hashes without params parse exactly as before', () => {
    expect(parseHash('#/run/run_a/timeline')).toEqual({
      view: 'timeline',
      runId: 'run_a',
    });
    expect(parseFilterParams('#/run/run_a/timeline')).toEqual(EMPTY_FILTER);
  });

  it('full parse/format matrix round-trips every dimension in canonical order', () => {
    const filter = {
      project: 'shop web',
      source: 'claude-code' as const,
      periodDays: 7,
      model: 'claude-opus-4-8',
      day: '2026-07-07',
      tool: 'webfetch',
    };
    const hash = formatHash(DASHBOARD_ROUTE, filter);
    expect(hash).toBe(
      '#/dashboard?project=shop%20web&source=claude-code&period=7&model=claude-opus-4-8&day=2026-07-07&tool=webfetch',
    );
    expect(parseHash(hash)).toEqual(DASHBOARD_ROUTE);
    expect(parseFilterParams(hash)).toEqual(filter);
  });

  it('partial filters emit only their params; empty filter emits none', () => {
    expect(formatHash(SESSIONS_ROUTE, { ...EMPTY_FILTER, tool: 'Bash' })).toBe(
      '#/sessions?tool=Bash',
    );
    expect(formatHash(SESSIONS_ROUTE, EMPTY_FILTER)).toBe('#/sessions');
  });

  it('invalid period values degrade to null, never NaN', () => {
    expect(parseFilterParams('#/dashboard?period=abc').periodDays).toBeNull();
    expect(parseFilterParams('#/dashboard?period=-3').periodDays).toBeNull();
  });

  it('run routes keep filters across the ? split', () => {
    const hash = formatHash(
      { view: 'cost', runId: 'run_b' },
      { ...EMPTY_FILTER, source: 'opencode' },
    );
    expect(parseHash(hash)).toEqual({ view: 'cost', runId: 'run_b' });
    expect(parseFilterParams(hash).source).toBe('opencode');
  });
});
