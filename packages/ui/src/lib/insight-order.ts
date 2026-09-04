import type { Insight } from '@runray/schema';
import { SEVERITY_RANK } from './waterfall';

/**
 * Findings worst-first for the strip and the run tour: estimated waste
 * descending, then severity, then id. The engine's order is registration
 * order (rule by rule), which says nothing about size.
 */
export function rankInsights(insights: readonly Insight[]): Insight[] {
  return [...insights].sort(
    (a, b) =>
      (b.estimatedWasteUSD ?? 0) - (a.estimatedWasteUSD ?? 0) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.id < b.id ? -1 : 1),
  );
}
