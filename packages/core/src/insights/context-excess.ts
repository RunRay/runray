import type { Run, Span } from '@runray/schema';
import {
  cacheWrite1hTokens,
  effectiveCacheWriteRate,
  matchModel,
  type PricingEntry,
  type PricingTable,
} from '../pricing/engine.js';
import { contextTokens } from './cache-shape.js';
import { buildScopeIndex, chronologicalLlmCalls } from './helpers.js';

/**
 * The context-excess formula behind the `context-bloat` finding, shared
 * with the Waste tab (cost-engine "Context ceiling estimates"): the rule
 * prices every token a call carried above the session's opening context;
 * the tab re-runs the same formula with a ceiling in place of the
 * baseline to say what keeping the context under 100k, 200k or 400k
 * tokens would have saved. One module, one formula, so the two can never
 * disagree. Browser-safe: only the pricing engine and pure helpers.
 */

/** The model that carried the most input-class tokens. */
export function dominantModel(spans: readonly Span[]): string | undefined {
  const byModel = new Map<string, number>();
  for (const s of spans) {
    if (s.kind !== 'llm_call' || !s.llm) continue;
    byModel.set(
      s.llm.model,
      (byModel.get(s.llm.model) ?? 0) +
        s.llm.tokens.input +
        s.llm.tokens.cacheRead,
    );
  }
  return [...byModel.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  )[0]?.[0];
}

export function dominantModelEntry(
  run: Run,
  pricing: PricingTable,
): PricingEntry | undefined {
  const dominant = dominantModel(run.spans);
  return dominant === undefined ? undefined : matchModel(pricing, dominant);
}

export function median3(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[1] ?? 0;
}

/** Effective cache-write rate of one span's write at this entry's rates:
 * the 5m/1h blend from the adapter-recorded TTL split — the SAME math the
 * cost engine billed, so waste dollars reconcile with span costUSD. */
export function spanCacheWriteRate(entry: PricingEntry, s: Span): number {
  const t = s.llm?.tokens;
  if (t === undefined) return entry.cacheWritePerMTok;
  return effectiveCacheWriteRate(entry, t, cacheWrite1hTokens(s.attributes, t));
}

/** What one input-class token of this call cost on average: its input,
 * cache-read and effective cache-write legs over its context. A grown
 * context served from cache is priced as cache reads, not as fresh input
 * — measuring `input` alone never saw a cached session grow, and the
 * input rate would overstate one by an order of magnitude. */
export function contextRatePerMTok(
  s: Span,
  pricing: PricingTable,
  fallback: PricingEntry | undefined,
): number | undefined {
  const t = s.llm?.tokens;
  if (t === undefined) return undefined;
  const entry =
    (s.llm === undefined ? undefined : matchModel(pricing, s.llm.model)) ??
    fallback;
  if (entry === undefined) return undefined;
  const context = t.input + t.cacheRead + t.cacheWrite;
  if (context <= 0) return undefined;
  return (
    (t.input * entry.inputPerMTok +
      t.cacheRead * entry.cacheReadPerMTok +
      t.cacheWrite * spanCacheWriteRate(entry, s)) /
    context
  );
}

/** The main session's model calls, chronological: a subagent runs its own
 * context, and its small calls would drag the session's medians. */
export function mainScopeLlmCalls(run: Run): Span[] {
  const scope = buildScopeIndex(run);
  const scopeKind = new Map(run.spans.map((s) => [s.id, s.kind]));
  return chronologicalLlmCalls(run).filter(
    (l) =>
      l.llm !== undefined &&
      scopeKind.get(scope.get(l.id) ?? '') !== 'subagent',
  );
}

export interface ContextExcess {
  /** Calls from the fourth on that carried more than the floor. */
  above: number;
  /** Cumulative input-class tokens above the floor. */
  tokens: number;
  /** Those tokens at the rate each call actually paid; undefined once any
   * call above the floor is unpriced (never a guess). */
  usd: number | undefined;
}

/**
 * Cumulative excess over a floor, from the fourth call on (the first three
 * set the baseline), each call's share priced at what that call actually
 * paid per input-class token. The rule passes the opening baseline; the
 * Waste tab passes a ceiling.
 */
export function contextExcess(
  llms: readonly Span[],
  floor: number,
  pricing: PricingTable | undefined,
  fallback: PricingEntry | undefined,
): ContextExcess {
  let above = 0;
  let tokens = 0;
  let usd: number | undefined = pricing === undefined ? undefined : 0;
  for (let i = 3; i < llms.length; i++) {
    const span = llms[i] as Span;
    const excess = Math.max(0, contextTokens(span) - floor);
    if (excess === 0) continue;
    above += 1;
    tokens += excess;
    if (pricing === undefined) continue;
    const rate = contextRatePerMTok(span, pricing, fallback);
    if (rate === undefined) usd = undefined;
    else if (usd !== undefined) usd += (excess * rate) / 1e6;
  }
  return { above, tokens, usd };
}

export const DEFAULT_CONTEXT_CAPS: readonly number[] = [
  100_000, 200_000, 400_000,
];

export interface ContextCapEstimate extends ContextExcess {
  cap: number;
}

export interface ContextCapEstimates {
  /** Median context of the first three main-scope calls — the rule's floor. */
  baseline: number;
  /** Median context of the last three. */
  last: number;
  /** Calls from the fourth on — the ones the formula counts. */
  counted: number;
  /** The rule's own figure: excess over the baseline. */
  excess: ContextExcess;
  /** Blended $ per million excess tokens, when priced. */
  ratePerMTok: number | undefined;
  /** The same formula with a ceiling in place of the baseline. */
  caps: ContextCapEstimate[];
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * What the `context-bloat` estimate is made of, and what a ceiling would
 * have changed. Undefined when the run has fewer than six main-scope calls
 * (the rule never fires there). Without a pricing table the token figures
 * stand and the amounts are undefined.
 */
export function contextCapEstimates(
  run: Run,
  pricing?: PricingTable,
  caps: readonly number[] = DEFAULT_CONTEXT_CAPS,
): ContextCapEstimates | undefined {
  const llms = mainScopeLlmCalls(run);
  if (llms.length < 6) return undefined;
  const contexts = llms.map(contextTokens);
  const baseline = median3(contexts.slice(0, 3));
  const last = median3(contexts.slice(-3));
  const fallback =
    pricing === undefined ? undefined : dominantModelEntry(run, pricing);
  const finish = (e: ContextExcess): ContextExcess => ({
    ...e,
    usd: e.usd === undefined ? undefined : round6(e.usd),
  });
  const excess = finish(contextExcess(llms, baseline, pricing, fallback));
  return {
    baseline,
    last,
    counted: llms.length - 3,
    excess,
    ratePerMTok:
      excess.usd === undefined || excess.tokens === 0
        ? undefined
        : (excess.usd / excess.tokens) * 1e6,
    caps: caps.map((cap) => ({
      cap,
      ...finish(contextExcess(llms, cap, pricing, fallback)),
    })),
  };
}
