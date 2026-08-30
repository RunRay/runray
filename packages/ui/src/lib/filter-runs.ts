import type { Run, SourceTool } from '@runray/schema';
import { localDay } from './overview';

/**
 * Global run filters (add-dashboard-extensions, D1/D2): pure, client-side
 * narrowing of the already-loaded runs. No re-fetch, no re-parse — identical
 * behavior in `view`, `demo`, and exported single files.
 */

export interface RunFilter {
  /** Project display key (see `projectKey`); null = no filter. */
  project: string | null;
  source: SourceTool | null;
  /** Bounded window in days; null = all time. */
  periodDays: number | null;
  /** A model name (a key of any run's byModel); drill-down from a rank row. */
  model: string | null;
  /** A specific local day `YYYY-MM-DD`; drill-down from a spend-by-day bar. */
  day: string | null;
  /** A tool/MCP name; drill-down from the dashboard By-tool card (E5). */
  tool: string | null;
}

export const EMPTY_FILTER: RunFilter = {
  project: null,
  source: null,
  periodDays: null,
  model: null,
  day: null,
  tool: null,
};

/** A run "uses" a tool when any tool/mcp span carries that name. */
export function runUsesTool(run: Run, tool: string): boolean {
  return run.spans.some(
    (s) =>
      (s.kind === 'tool_call' || s.kind === 'mcp_call') &&
      (s.tool?.name ?? s.name) === tool,
  );
}

/** A run "uses" a model when it spent on it (a key in the byModel rollup). */
export function runUsesModel(run: Run, model: string): boolean {
  return Object.hasOwn(run.totals.costUSD.byModel, model);
}

/**
 * The one project grouping key: runs without a project name group under the
 * same `—` placeholder the overview ranking renders — clicking that row must
 * filter to exactly the runs it counted.
 */
export function projectKey(run: Run): string {
  return run.project?.name ?? '—';
}

/**
 * Period anchor (D1): the local start day of the newest loaded run — never
 * wall-clock now, so an exported file renders the same slice on every open.
 * Anchored on ALL loaded runs, not the filtered subset: combining filters
 * must never shift the window.
 */
export function periodAnchorDay(runs: readonly Run[]): string | undefined {
  let anchor: string | undefined;
  for (const run of runs) {
    if (anchor === undefined || run.startedAt > anchor) anchor = run.startedAt;
  }
  return anchor === undefined ? undefined : localDay(anchor);
}

/** First local day inside a window of `periodDays` days ending at `anchorDay`. */
export function periodStartDay(anchorDay: string, periodDays: number): string {
  const cursor = new Date(`${anchorDay}T00:00:00`);
  cursor.setDate(cursor.getDate() - (periodDays - 1));
  return fmtDay(cursor);
}

function fmtDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local day immediately before `day` (YYYY-MM-DD), month/year safe. */
function dayBefore(day: string): string {
  const cursor = new Date(`${day}T00:00:00`);
  cursor.setDate(cursor.getDate() - 1);
  return fmtDay(cursor);
}

export interface SpendTrend {
  currentUSD: number;
  previousUSD: number;
  /** Signed fraction: +0.23 = the current period is up 23% on the previous. */
  deltaFraction: number;
}

/**
 * Spend in the visible period vs the equal-length period immediately before it
 * (add-dashboard-extensions D3). Meaningful only with a bounded period filter
 * AND a real baseline — returns null (suppressed) when periodDays is null, a
 * single-day drill-down is pinned (a point can't trend against a window), the
 * previous window holds fewer than 2 runs, or the previous window spent nothing
 * (no percentage to take). Project/source/model filters apply to both windows;
 * the period anchor is the newest of ALL runs (matching filterRuns), so
 * combining filters never shifts the comparison.
 */
export function spendTrend(
  allRuns: readonly Run[],
  filter: RunFilter,
): SpendTrend | null {
  const { periodDays } = filter;
  if (periodDays === null || filter.day !== null) return null;
  const anchorDay = periodAnchorDay(allRuns);
  if (anchorDay === undefined) return null;

  const curStart = periodStartDay(anchorDay, periodDays);
  const prevEnd = dayBefore(curStart);
  const prevStart = periodStartDay(prevEnd, periodDays);

  // Non-period dimensions (project/source/model) scope both windows; strip
  // the period so the two windows partition this set by day.
  const scoped = filterRuns(allRuns, { ...filter, periodDays: null });
  let currentUSD = 0;
  let previousUSD = 0;
  let previousRuns = 0;
  for (const run of scoped) {
    const day = localDay(run.startedAt);
    if (day >= curStart) {
      currentUSD += run.totals.costUSD.total;
    } else if (day >= prevStart && day <= prevEnd) {
      previousUSD += run.totals.costUSD.total;
      previousRuns += 1;
    }
  }
  if (previousRuns < 2 || previousUSD <= 0) return null;
  return {
    currentUSD,
    previousUSD,
    deltaFraction: (currentUSD - previousUSD) / previousUSD,
  };
}

/**
 * Drop filter dimensions whose value no longer exists among `runs`. Called
 * when fresh data lands (a `--watch` SSE refresh rebuilds the trace in place,
 * without a page reload), so a filter can't keep pointing at a project or
 * source (or drilled-down model/day) that rolled off — which would otherwise
 * leave an active brass chip pointing at nothing. Period is static (fixed
 * windows) and always valid. Returns the same reference when nothing changed,
 * so an unaffected refresh doesn't churn the store.
 */
export function reconcileFilter(
  filter: RunFilter,
  runs: readonly Run[],
): RunFilter {
  const project =
    filter.project === null ||
    runs.some((r) => projectKey(r) === filter.project)
      ? filter.project
      : null;
  const source =
    filter.source === null || runs.some((r) => r.source.tool === filter.source)
      ? filter.source
      : null;
  const model =
    filter.model === null ||
    runs.some((r) => runUsesModel(r, filter.model as string))
      ? filter.model
      : null;
  const day =
    filter.day === null ||
    runs.some((r) => localDay(r.startedAt) === filter.day)
      ? filter.day
      : null;
  const tool =
    filter.tool === null ||
    runs.some((r) => runUsesTool(r, filter.tool as string))
      ? filter.tool
      : null;
  if (
    project === filter.project &&
    source === filter.source &&
    model === filter.model &&
    day === filter.day &&
    tool === filter.tool
  ) {
    return filter;
  }
  return { ...filter, project, source, model, day, tool };
}

export function filterRuns(runs: readonly Run[], filter: RunFilter): Run[] {
  const anchorDay =
    filter.periodDays === null ? undefined : periodAnchorDay(runs);
  const startDay =
    anchorDay === undefined || filter.periodDays === null
      ? undefined
      : periodStartDay(anchorDay, filter.periodDays);
  return runs.filter((run) => {
    if (filter.project !== null && projectKey(run) !== filter.project) {
      return false;
    }
    if (filter.source !== null && run.source.tool !== filter.source) {
      return false;
    }
    if (filter.model !== null && !runUsesModel(run, filter.model)) {
      return false;
    }
    if (filter.day !== null && localDay(run.startedAt) !== filter.day) {
      return false;
    }
    if (filter.tool !== null && !runUsesTool(run, filter.tool)) {
      return false;
    }
    // Day strings are YYYY-MM-DD — lexicographic order IS date order.
    if (startDay !== undefined && localDay(run.startedAt) < startDay) {
      return false;
    }
    return true;
  });
}
