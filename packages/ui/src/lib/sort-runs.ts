/**
 * Sessions-table sorting (03-design.md §4.1: "sort by any column; default
 * recency"). Pure and deterministic: missing values sink to the bottom in
 * either direction, ties break newest-first then by id.
 */

import type { Run } from '@runray/schema';

export type SortKey =
  | 'date'
  | 'project'
  | 'title'
  | 'models'
  | 'duration'
  | 'tokens'
  | 'cost';
export type SortDir = 'asc' | 'desc';

export const DEFAULT_SORT: { key: SortKey; dir: SortDir } = {
  key: 'date',
  dir: 'desc',
};

const getters: Record<SortKey, (run: Run) => string | number | undefined> = {
  date: (r) => Date.parse(r.startedAt),
  project: (r) => r.project?.name?.toLowerCase(),
  title: (r) => r.title?.toLowerCase(),
  models: (r) => Object.keys(r.totals.costUSD.byModel).length,
  duration: (r) => r.durationMs,
  tokens: (r) => r.totals.tokens.total,
  cost: (r) => r.totals.costUSD.total,
};

export function sortRuns(
  runs: readonly Run[],
  key: SortKey,
  dir: SortDir,
): Run[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...runs].sort((a, b) => {
    const va = getters[key](a);
    const vb = getters[key](b);
    if (va === undefined && vb === undefined) return tieBreak(a, b);
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    if (va < vb) return -sign;
    if (va > vb) return sign;
    return tieBreak(a, b);
  });
}

function tieBreak(a: Run, b: Run): number {
  const d = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
