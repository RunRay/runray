import {
  ACTIVITY_LABELS,
  OTHER_COMMAND_KEY,
  TOOL_FLAGS,
  type ToolFamily,
  type ToolFlag,
  type ToolRow,
  type UsageStats,
} from '@runray/core/tools';

/**
 * The Time view's tool table as display rows (visualizer "Tool usage
 * table", "Shell utilities are grouped"). The figures are core's; this file
 * folds the short-lived shell tools into one group row, applies the family
 * filter and the sort, and words what a sub-row is called. Pure functions,
 * so the arrangement is testable without a DOM.
 */

/** What each family is called on a row's tag and in the filter. */
export const FAMILY_LABELS: Readonly<Record<ToolFamily, string>> = {
  shell: 'shell',
  harness: 'built-in',
  mcp: 'mcp',
  skill: 'skill',
  agent: 'agent',
  hook: 'hook',
};

export type ToolSort = 'total' | 'p95' | 'calls';
export type FamilyFilter = ToolFamily | 'all';

/** Sub-rows shown before the rest hide behind "show more". */
export const CHILD_PAGE = 8;

export const UTILITIES_ROW = 'group/utilities';

export interface TableChild {
  id: string;
  label: string;
  /** Said after the label where siblings differ: the kind of work. */
  note?: string;
  stats: UsageStats;
}

export interface TableRow {
  id: string;
  label: string;
  family: ToolFamily;
  /** Set on the folded group of short-lived shell tools. */
  group?: 'utilities';
  stats: UsageStats;
  /**
   * False for a group of several tools: a percentile over tools that
   * differ is not a figure core computed, so it is shown as unavailable.
   */
  percentiles: boolean;
  /** Time in commands led by another tool; beside the total, not in it. */
  alsoRanMs: number;
  alsoRanCalls: number;
  /** Share of summed tool time, 0–1. */
  share: number;
  /** False for shell calls of a trace recorded before classification. */
  classified: boolean;
  children: TableChild[];
}

function childLabel(row: ToolRow, label: string): string {
  if (label.length > 0) return label;
  return row.key === OTHER_COMMAND_KEY && !row.registry
    ? 'unnamed'
    : 'no subcommand';
}

function toRow(row: ToolRow, summedMs: number): TableRow {
  const activities = new Set(row.subs.map((s) => s.activity));
  return {
    id: row.id,
    label: row.label,
    family: row.family,
    stats: row,
    percentiles: true,
    alsoRanMs: row.alsoRanMs,
    alsoRanCalls: row.alsoRanCalls,
    share: summedMs > 0 ? row.totalMs / summedMs : 0,
    classified: row.classified,
    children: row.subs.map((sub) => ({
      id: `${row.id}/${sub.id}`,
      label: childLabel(row, sub.label),
      ...(activities.size > 1 ? { note: ACTIVITY_LABELS[sub.activity] } : {}),
      stats: sub,
    })),
  };
}

function sortKey(sort: ToolSort): (stats: UsageStats) => number {
  if (sort === 'p95') return (s) => s.p95Ms;
  if (sort === 'calls') return (s) => s.calls;
  return (s) => s.totalMs;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function emptyFlags(): Record<ToolFlag, number> {
  return Object.fromEntries(TOOL_FLAGS.map((f) => [f, 0])) as Record<
    ToolFlag,
    number
  >;
}

/** One row for several utilities: sums, the largest maximum, no percentiles. */
function utilitiesRow(
  members: readonly ToolRow[],
  summedMs: number,
  sort: ToolSort,
): TableRow {
  const key = sortKey(sort);
  const stats: UsageStats = {
    calls: 0,
    errors: 0,
    open: 0,
    totalMs: 0,
    sharedMs: 0,
    p50Ms: 0,
    // the largest member p95 places the group when the table sorts by p95
    p95Ms: 0,
    maxMs: 0,
    flags: emptyFlags(),
  };
  for (const m of members) {
    stats.calls += m.calls;
    stats.errors += m.errors;
    stats.open += m.open;
    stats.totalMs += m.totalMs;
    stats.sharedMs += m.sharedMs;
    stats.p95Ms = Math.max(stats.p95Ms, m.p95Ms);
    stats.maxMs = Math.max(stats.maxMs, m.maxMs);
    for (const flag of TOOL_FLAGS) stats.flags[flag] += m.flags[flag];
  }
  const ordered = [...members].sort(
    (a, b) => key(b) - key(a) || byText(a.key, b.key),
  );
  return {
    id: UTILITIES_ROW,
    label: 'shell utilities',
    family: 'shell',
    group: 'utilities',
    stats,
    percentiles: false,
    alsoRanMs: 0,
    alsoRanCalls: 0,
    share: summedMs > 0 ? stats.totalMs / summedMs : 0,
    classified: true,
    children: ordered.map((m) => ({
      id: m.id,
      label: m.label,
      stats: m,
    })),
  };
}

/** How many tools each family has among the rows, families in fixed order. */
export function familyCounts(
  rows: readonly ToolRow[],
): Array<{ family: ToolFamily; count: number }> {
  const counts = new Map<ToolFamily, number>();
  for (const row of rows) {
    counts.set(row.family, (counts.get(row.family) ?? 0) + 1);
  }
  return (Object.keys(FAMILY_LABELS) as ToolFamily[])
    .filter((family) => counts.has(family))
    .map((family) => ({ family, count: counts.get(family) ?? 0 }));
}

/**
 * The ranked rows as shown: filtered by family, utilities folded into one
 * group row when there are at least two of them, sorted by the chosen
 * figure (largest first, ties by label).
 */
export function tableRows(
  rows: readonly ToolRow[],
  summedMs: number,
  options: { family: FamilyFilter; sort: ToolSort },
): TableRow[] {
  const visible =
    options.family === 'all'
      ? rows
      : rows.filter((row) => row.family === options.family);
  const utilities = visible.filter((row) => row.utility);
  const fold = utilities.length >= 2;
  const out = visible
    .filter((row) => !(fold && row.utility))
    .map((row) => toRow(row, summedMs));
  if (fold) out.push(utilitiesRow(utilities, summedMs, options.sort));
  const key = sortKey(options.sort);
  return out.sort(
    (a, b) =>
      key(b.stats) - key(a.stats) ||
      byText(a.label, b.label) ||
      byText(a.id, b.id),
  );
}

/** Rows kept out of summed tool time: shown as they are, never folded. */
export function sideRows(rows: readonly ToolRow[]): TableRow[] {
  return rows.map((row) => toRow(row, 0));
}
