/**
 * "Inside a run — where the money went" teaser data (redesign mockup, cost axis
 * grouped by model): the biggest run's split per model, in the display unit
 * (E6). Dollars come from `byModel`, the authoritative per-model cost, so the
 * rows sum to the run total; tokens come from the run's spans the same way
 * the run totals count them. Call aggregates for the inspector come from the
 * spans too. No individual calls, no double-counted subtrees — every dollar or
 * token lands in exactly one model.
 */

import type { Insight, Run } from '@runray/schema';
import { runTokensByModel } from './overview';
import { type DisplayUnit, inUnit } from './unit';

export interface ModelRow {
  model: string;
  costUSD: number;
  tokens: number;
  /** The model's share of the run in the teaser's unit (0..1) — the bar. */
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
  /** The unit the rows are ranked and sized in. */
  unit: DisplayUnit;
  /** The denominator the bars are a share of, in the unit (run total, or
   * model sum). */
  total: number;
  /** Models, descending in the unit — the breakdown bars. */
  rows: ModelRow[];
  /** The part of the total no listed model carries (usually 0). */
  other: number;
  /** The biggest model — the inspector focus (`rows[0]`). */
  topModel: string;
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

export function buildRunTeaser(
  run: Run,
  by: DisplayUnit = 'usd',
): RunTeaserData | null {
  const costByModel = run.totals.costUSD.byModel;
  const tokensByModel = runTokensByModel(run);
  const entries = Object.entries(by === 'tokens' ? tokensByModel : costByModel)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const first = entries[0];
  if (first === undefined) return null;

  const sumModels = entries.reduce((sum, [, value]) => sum + value, 0);
  const runTotal = inUnit(by, {
    costUSD: run.totals.costUSD.total,
    tokens: run.totals.tokens.total,
  });
  const total = runTotal > 0 ? runTotal : sumModels;
  const denom = total > 0 ? total : 1;
  const rows: ModelRow[] = entries.map(([model, value]) => ({
    model,
    costUSD: costByModel[model] ?? 0,
    tokens: tokensByModel[model] ?? 0,
    shareOfRun: value / denom,
  }));
  const other = Math.max(denom - sumModels, 0);

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
    unit: by,
    total: denom,
    rows,
    other,
    topModel,
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

/** The teaser's subject: the priciest run, or in token mode the heaviest;
 * undefined when no run has anything in that unit. */
export function teaserRun(
  runs: readonly Run[],
  by: DisplayUnit = 'usd',
): Run | undefined {
  const size = (run: Run) =>
    inUnit(by, {
      costUSD: run.totals.costUSD.total,
      tokens: run.totals.tokens.total,
    });
  let best: Run | undefined;
  for (const run of runs) {
    if (size(run) > 0 && (best === undefined || size(run) > size(best))) {
      best = run;
    }
  }
  return best;
}
