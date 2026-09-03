/**
 * Hash routing (05-ARCHITECTURE §4): the hash is the single source of truth
 * for "which run, which view" so deep links survive the single-file export
 * and `file://` (no history API, no server rewrites).
 *
 * Routes: `#/dashboard` (default) · `#/sessions` · `#/run/:id` (cost is the
 * run default) · `#/run/:id/timeline` · `#/run/:id/time` ·
 * `#/run/:id/errors` · `#/diff/:a/:b`
 * (add-run-diff). Filter state rides a query-style suffix in the
 * canonical order `project, source, period, model, day, tool` (D6 —
 * supersedes add-dashboard-extensions D2), so a copied link restores the
 * same filtered view; hashes without params parse exactly as before.
 */

import { EMPTY_FILTER, type RunFilter } from './filter-runs';

export type Route =
  | { view: 'dashboard' }
  | { view: 'sessions' }
  | { view: 'timeline'; runId: string }
  | { view: 'cost'; runId: string }
  | { view: 'time'; runId: string }
  | { view: 'errors'; runId: string }
  | { view: 'diff'; runA: string; runB: string };

/** The run-scoped views, as `RunView` switches between them. */
export type RunViewName = 'timeline' | 'cost' | 'time' | 'errors';

export const DASHBOARD_ROUTE: Route = { view: 'dashboard' };
export const SESSIONS_ROUTE: Route = { view: 'sessions' };

/** Canonical filter-param order — links must be byte-stable. */
const FILTER_PARAMS = [
  'project',
  'source',
  'period',
  'model',
  'day',
  'tool',
] as const;

/** Unknown or empty hashes fall back to the dashboard — never a 404. */
export function parseHash(hash: string): Route {
  const path = hash.split('?')[0] ?? '';
  const segments = path.replace(/^#/, '').split('/').filter(Boolean);
  if (segments[0] === 'run' && segments[1] !== undefined) {
    const runId = decodeURIComponent(segments[1]);
    if (segments[2] === 'timeline') return { view: 'timeline', runId };
    if (segments[2] === 'time') return { view: 'time', runId };
    if (segments[2] === 'errors') return { view: 'errors', runId };
    return { view: 'cost', runId };
  }
  if (
    segments[0] === 'diff' &&
    segments[1] !== undefined &&
    segments[2] !== undefined
  ) {
    return {
      view: 'diff',
      runA: decodeURIComponent(segments[1]),
      runB: decodeURIComponent(segments[2]),
    };
  }
  if (segments[0] === 'sessions') {
    return SESSIONS_ROUTE;
  }
  if (segments[0] === 'dashboard') {
    return DASHBOARD_ROUTE;
  }
  return DASHBOARD_ROUTE;
}

/** Filter dims encoded in the hash; absent params stay null (old links). */
export function parseFilterParams(hash: string): RunFilter {
  const query = hash.split('?')[1];
  if (query === undefined || query === '') return EMPTY_FILTER;
  const params = new URLSearchParams(query);
  const period = Number(params.get('period') ?? '');
  return {
    project: params.get('project'),
    source: params.get('source') as RunFilter['source'],
    periodDays: Number.isInteger(period) && period > 0 ? period : null,
    model: params.get('model'),
    day: params.get('day'),
    tool: params.get('tool'),
  };
}

export function toHash(route: Route): string {
  switch (route.view) {
    case 'dashboard':
      return '#/dashboard';
    case 'sessions':
      return '#/sessions';
    case 'timeline':
      return `#/run/${encodeURIComponent(route.runId)}/timeline`;
    case 'time':
      return `#/run/${encodeURIComponent(route.runId)}/time`;
    case 'errors':
      return `#/run/${encodeURIComponent(route.runId)}/errors`;
    case 'cost':
      return `#/run/${encodeURIComponent(route.runId)}`;
    case 'diff':
      return `#/diff/${encodeURIComponent(route.runA)}/${encodeURIComponent(route.runB)}`;
  }
}

/** Route + filter → one shareable hash (canonical param order). */
export function formatHash(route: Route, filter?: RunFilter): string {
  const base = toHash(route);
  if (filter === undefined) return base;
  const parts: string[] = [];
  for (const key of FILTER_PARAMS) {
    const value =
      key === 'period'
        ? filter.periodDays === null
          ? null
          : String(filter.periodDays)
        : filter[key];
    if (value === null || value === undefined) continue;
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? base : `${base}?${parts.join('&')}`;
}

export function routesEqual(a: Route, b: Route): boolean {
  return toHash(a) === toHash(b);
}
