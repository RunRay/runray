/**
 * "Inside a run — where the money went" teaser data (redesign mockup, cost axis
 * grouped by model): the priciest run's cost split per model. `byModel` is the
 * authoritative per-model cost, so the model rows sum to the run total; token /
 * call aggregates for the inspector come from the run's spans. No individual
 * calls, no double-counted subtrees — every dollar lands in exactly one model.
 */

import type { Insight, Run } from '@runray/schema';

export interface ModelRow {
  model: string;
  costUSD: number;
  /** costUSD / run total (0..1) — the bar width. */
  shareOfRun: number;
}

export interface ModelDetail {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
}

export interface RunTeaserData {
  run: Run;
  /** The denominator the bars are a share of (run total, or model sum). */
  totalUSD: number;
  /** Cost by model, descending — the breakdown bars. */
  rows: ModelRow[];
  /** Cost not attributed to any listed model (usually 0). */
  otherUSD: number;
  /** The biggest model — the inspector focus. */
  topModel: string;
  topCostUSD: number;
  topShare: number;
  topDetail: ModelDetail;
  topInsight: Insight | undefined;
}

/** The most actionable insight: biggest estimated waste, else the first. */
function pickInsight(insights: readonly Insight[]): Insight | undefined {
  let best: Insight | undefined;
  for (const insight of insights) {
    if (
      best === undefined ||
      (insight.estimatedWasteUSD ?? 0) > (best.estimatedWasteUSD ?? 0)
    ) {
      best = insight;
    }
  }
  return best;
}

export function buildRunTeaser(run: Run): RunTeaserData | null {
  const entries = Object.entries(run.totals.costUSD.byModel)
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const first = entries[0];
  if (first === undefined) return null;

  const sumModels = entries.reduce((sum, [, cost]) => sum + cost, 0);
  const total =
    run.totals.costUSD.total > 0 ? run.totals.costUSD.total : sumModels;
  const denom = total > 0 ? total : 1;
  const rows: ModelRow[] = entries.map(([model, cost]) => ({
    model,
    costUSD: cost,
    shareOfRun: cost / denom,
  }));
  const otherUSD = Math.max(denom - sumModels, 0);

  // Per-model token/call aggregates for the inspector, straight from the spans.
  const detail = new Map<string, ModelDetail>();
  for (const span of run.spans) {
    const llm = span.llm;
    if (llm === undefined) continue;
    const d = detail.get(llm.model) ?? {
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
    };
    d.calls += 1;
    d.tokensIn += llm.tokens.input;
    d.tokensOut += llm.tokens.output;
    d.cacheRead += llm.tokens.cacheRead;
    detail.set(llm.model, d);
  }

  const topModel = first[0];
  return {
    run,
    totalUSD: denom,
    rows,
    otherUSD,
    topModel,
    topCostUSD: first[1],
    topShare: first[1] / denom,
    topDetail: detail.get(topModel) ?? {
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
    },
    topInsight: pickInsight(run.insights),
  };
}

/** The most expensive priced run in a set (the teaser's subject). */
export function mostExpensiveRun(runs: readonly Run[]): Run | undefined {
  let best: Run | undefined;
  for (const run of runs) {
    if (
      run.totals.costUSD.total > 0 &&
      (best === undefined ||
        run.totals.costUSD.total > best.totals.costUSD.total)
    ) {
      best = run;
    }
  }
  return best;
}
