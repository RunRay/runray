import type { RawRun, RawSpan } from '../adapter.js';
import type { PricingTable } from './engine.js';
import { cacheWrite1hTokens, computeCostUSD, matchModel } from './engine.js';
import { BUNDLED_PRICING } from './snapshot.js';

/**
 * Cost engine (task 2.5, 05-ARCHITECTURE §2.3). Prices llm_call spans from a
 * bundled, offline snapshot. The pure math (matching, cost computation)
 * lives in `./engine.js` — the browser-safe `@runray/core/pricing`
 * subpath; this module adds the snapshot and the RawRun pricing pass, which
 * only the CLI pipeline consumes. No match ⇒ `costSource: 'unknown'` and
 * the span is excluded from cost rollups — we never guess silently.
 * Source-reported aggregate cost is never trusted for rollups
 * (docs/02-DATA-MODEL.md); a reported per-span cost survives only when we
 * cannot compute our own.
 */

export type {
  DowngradeSuggestion,
  PricingEntry,
  PricingTable,
  RepricedSpan,
  RepricedSubtree,
  RepriceResult,
  RepriceRiskThresholds,
  SubtreeRiskFlag,
  TierStage,
  TokenCounts,
  UnpricedCoverage,
} from './engine.js';
export {
  CACHE_WRITE_1H_ATTR,
  cacheWrite1hTokens,
  canonicalModelName,
  computeCostUSD,
  DEFAULT_REPRICE_RISK,
  downgradeMap,
  effectiveCacheWriteRate,
  looseModelKey,
  MODEL_TIERS,
  matchModel,
  repriceRun,
  repriceSpans,
  round6,
  suggestedDowngrade,
  unpricedCoverage,
} from './engine.js';

export function bundledPricing(): PricingTable {
  return BUNDLED_PRICING;
}

function priceSpan(span: RawSpan, table: PricingTable): RawSpan {
  if (span.kind !== 'llm_call' || span.llm === undefined) return span;
  const entry = matchModel(table, span.llm.model);
  if (entry === undefined) {
    // never guess silently: keep an adapter-reported figure as 'reported',
    // otherwise surface the gap as 'unknown' (excluded from rollups)
    if (span.llm.costUSD !== undefined && span.llm.costSource === 'reported')
      return span;
    const { costUSD: _dropped, ...llm } = span.llm;
    return { ...span, llm: { ...llm, costSource: 'unknown' } };
  }
  return {
    ...span,
    llm: {
      ...span.llm,
      costUSD: computeCostUSD(
        entry,
        span.llm.tokens,
        cacheWrite1hTokens(span.attributes, span.llm.tokens),
      ),
      costSource: 'computed',
    },
  };
}

/** Enrich a RawRun with computed costs. Pure — returns a new RawRun. Runs
 * between `parse()` and `normalize()` so derived totals include cost. */
export function priceRun(
  raw: RawRun,
  table: PricingTable = BUNDLED_PRICING,
): RawRun {
  return { ...raw, spans: raw.spans.map((s) => priceSpan(s, table)) };
}
