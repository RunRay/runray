import { unpricedCoverage } from '@runray/core/pricing';
import type { Run } from '@runray/schema';

/**
 * Unpriced-cost coverage over the visible runs (C7). Per-run numbers come
 * straight from core's browser-safe `unpricedCoverage` — one
 * implementation, zero drift — and aggregate here for dashboard-level
 * banners and caveat markers on waste/savings figures.
 */
export interface CoverageAggregate {
  llmCalls: number;
  unpricedLlmCalls: number;
  unpricedTokens: number;
  /** Offending model names across runs, sorted ascending. */
  models: string[];
  runsAffected: number;
  complete: boolean;
}

export function coverageOf(runs: readonly Run[]): CoverageAggregate {
  let llmCalls = 0;
  let unpricedLlmCalls = 0;
  let unpricedTokens = 0;
  let runsAffected = 0;
  const models = new Set<string>();
  for (const run of runs) {
    const c = unpricedCoverage(run);
    llmCalls += c.llmCalls;
    if (c.complete) continue;
    runsAffected += 1;
    unpricedLlmCalls += c.unpricedLlmCalls;
    unpricedTokens += c.unpricedTokens;
    for (const m of c.models) models.add(m);
  }
  return {
    llmCalls,
    unpricedLlmCalls,
    unpricedTokens,
    models: [...models].sort(),
    runsAffected,
    complete: unpricedLlmCalls === 0,
  };
}
