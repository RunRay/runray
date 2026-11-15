import {
  canonicalModelName,
  hasNoPublishedPrice,
  MODELS_WITHOUT_PUBLISHED_PRICE,
  unpricedCoverage,
} from '@runray/core/pricing';
import type { Run } from '@runray/schema';
import { formatUSD } from './format';

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

/**
 * The cost a header leads with. Zero dollars has two meanings, and they are
 * not the same figure: every call was priced and cost nothing (a model run
 * on the machine), or no call had a price at all (a Codex reviewer thread
 * read on its own runs on a model nobody publishes a price for). The second
 * is not "$0.00": the cost is not known, and the header says so.
 */
export function costHeadline(costUSD: number, runs: readonly Run[]): string {
  if (costUSD > 0) return formatUSD(costUSD);
  return coverageOf(runs).complete ? 'Local / $0.00' : 'Unpriced';
}

/** What the unpriced banner tells the person to do about the gap. */
export interface UnpricedAdvice {
  /** The offending models, one marked when no price list will ever hold it. */
  listed: string;
  /**
   * `refresh`: a newer price list may price them all. `refresh-others`: it
   * may price some; the marked ones stay unpriced. `none`: no provider
   * publishes a price for any of them, so a refresh changes nothing.
   */
  refresh: 'refresh' | 'refresh-others' | 'none';
  /** With `none` and one model (under any spelling): what that model is,
   * in core's words. */
  what?: string;
}

/**
 * The advice for the unpriced models of an aggregate, the way the CLI
 * warning words it (`reportUnpricedCoverage`): `runray pricing --refresh`
 * helps only with a model a newer list could hold. Advising it for the
 * model of the Codex approval reviewer would send the person in a circle:
 * refresh, same banner, refresh.
 */
export function unpricedAdvice(models: readonly string[]): UnpricedAdvice {
  const never = models.filter(hasNoPublishedPrice);
  if (never.length === 0) {
    return { listed: models.join(', '), refresh: 'refresh' };
  }
  if (never.length < models.length) {
    return {
      // `; ` between models: a marked one carries a comma of its own
      listed: models
        .map((m) => (hasNoPublishedPrice(m) ? `${m}, no published price` : m))
        .join('; '),
      refresh: 'refresh-others',
    };
  }
  // one model may be recorded under two spellings (with and without its
  // provider prefix): it is still one model, and still explained
  const ids = new Set(never.map(canonicalModelName));
  const [only] = ids.size === 1 ? ids : [];
  const what =
    only === undefined ? undefined : MODELS_WITHOUT_PUBLISHED_PRICE[only];
  return {
    listed: models.join(', '),
    refresh: 'none',
    ...(what === undefined ? {} : { what }),
  };
}
