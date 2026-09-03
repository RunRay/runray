import type { Insight, Run } from '@runray/schema';
import type { PricingTable } from '../pricing/engine.js';
import { bundledPricing } from '../pricing/index.js';
import { ruleClass } from './meta.js';
import { V0_RULES } from './rules.js';

/**
 * Insight rule engine (tasks 4.1/4.2, 05-ARCHITECTURE §2.4). Rules are pure
 * functions over a normalized Run plus thresholds; the CLI feeds overrides
 * from `runray.config.json` (`insights.thresholds`).
 *
 * Waste semantics (docs/02-DATA-MODEL.md): `totals.costUSD.wastedEstimate`
 * sums only WASTE-CLASS findings — money already burned (retry-loop,
 * dead-end-run). Efficiency-opportunity findings (low-cache-hit, …) carry
 * their own `estimatedWasteUSD` but never inflate the run's wasted total.
 *
 * Severity semantics: rules do NOT grade themselves. The engine assigns
 * `severity` after evaluation from the finding's estimate as a share of the
 * run's cost (`gradeSeverity`, `thresholds.severity`), so severity answers
 * "how big is this in THIS run" while the class answers "is it already
 * burned" — two independent axes.
 */

export interface Thresholds {
  retryLoop: { minFailures: number; maxGapToolCalls: number };
  lowCacheHit: {
    maxHitRate: number;
    minCostUSD: number;
    minLlmCalls: number;
    /** Achievable hit-rate with a stable prefix — the savings target. */
    targetHitRate: number;
  };
  contextBloat: {
    multiplier: number;
    minMedianInputTokens: number;
    topCulprits: number;
  };
  expensiveSubagent: { minShareOfRunCost: number; minCostUSD: number };
  modelMismatch: {
    minSavingsUSD: number;
    riskToolCalls: number;
    riskContextTokens: number;
  };
  cachePrefixBreak: {
    minPrefixTokens: number;
    collapseRatio: number;
    rewriteFloorTokens: number;
  };
  idleCacheExpiry: { minIdleMinutes: number; rewriteFloorTokens: number };
  fixedContextOverhead: { floorTokens: number; minLlmCalls: number };
  duplicateRead: { minRepeats: number };
  scatteredToolFailures: { minFailures: number; minErrorShare: number };
  oversizedOutput: { minOutputBytes: number; topOffenders: number };
  /** Severity grading — see `gradeSeverity`. */
  severity: SeverityThresholds;
}

/**
 * Severity tiers as a share of the run's `costUSD.total`, each with an
 * absolute floor so cents in a tiny run never read as critical.
 */
export interface SeverityThresholds {
  warningShare: number;
  warningFloorUSD: number;
  criticalShare: number;
  criticalFloorUSD: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  retryLoop: { minFailures: 3, maxGapToolCalls: 3 },
  lowCacheHit: {
    maxHitRate: 0.4,
    minCostUSD: 0.1,
    minLlmCalls: 5,
    targetHitRate: 0.6,
  },
  contextBloat: { multiplier: 2, minMedianInputTokens: 50_000, topCulprits: 3 },
  expensiveSubagent: { minShareOfRunCost: 0.5, minCostUSD: 0.25 },
  modelMismatch: {
    minSavingsUSD: 0.5,
    riskToolCalls: 25,
    riskContextTokens: 150_000,
  },
  cachePrefixBreak: {
    minPrefixTokens: 20_000,
    collapseRatio: 0.2,
    rewriteFloorTokens: 10_000,
  },
  idleCacheExpiry: { minIdleMinutes: 5, rewriteFloorTokens: 10_000 },
  fixedContextOverhead: { floorTokens: 20_000, minLlmCalls: 5 },
  duplicateRead: { minRepeats: 3 },
  scatteredToolFailures: { minFailures: 5, minErrorShare: 0.2 },
  oversizedOutput: { minOutputBytes: 100_000, topOffenders: 5 },
  severity: {
    warningShare: 0.02,
    warningFloorUSD: 0.05,
    criticalShare: 0.1,
    criticalFloorUSD: 1,
  },
};

export type ThresholdOverrides = {
  [K in keyof Thresholds]?: Partial<Thresholds[K]>;
} & {
  /** Deprecated alias: `retryLoop.minConsecutiveFailures` → `minFailures`. */
  retryLoop?: Partial<Thresholds['retryLoop']> & {
    minConsecutiveFailures?: number;
  };
};

export function resolveThresholds(
  overrides: ThresholdOverrides = {},
): Thresholds {
  // deprecated config alias (pre-windowed-clustering name); an explicit
  // minFailures always wins
  const retryOverride: Partial<Thresholds['retryLoop']> = {
    ...(overrides.retryLoop?.minConsecutiveFailures !== undefined
      ? { minFailures: overrides.retryLoop.minConsecutiveFailures }
      : {}),
    ...overrides.retryLoop,
  };
  delete (retryOverride as Record<string, unknown>).minConsecutiveFailures;
  const resolved: Thresholds = {
    retryLoop: { ...DEFAULT_THRESHOLDS.retryLoop, ...retryOverride },
    lowCacheHit: {
      ...DEFAULT_THRESHOLDS.lowCacheHit,
      ...overrides.lowCacheHit,
    },
    contextBloat: {
      ...DEFAULT_THRESHOLDS.contextBloat,
      ...overrides.contextBloat,
    },
    expensiveSubagent: {
      ...DEFAULT_THRESHOLDS.expensiveSubagent,
      ...overrides.expensiveSubagent,
    },
    modelMismatch: {
      ...DEFAULT_THRESHOLDS.modelMismatch,
      ...overrides.modelMismatch,
    },
    cachePrefixBreak: {
      ...DEFAULT_THRESHOLDS.cachePrefixBreak,
      ...overrides.cachePrefixBreak,
    },
    idleCacheExpiry: {
      ...DEFAULT_THRESHOLDS.idleCacheExpiry,
      ...overrides.idleCacheExpiry,
    },
    fixedContextOverhead: {
      ...DEFAULT_THRESHOLDS.fixedContextOverhead,
      ...overrides.fixedContextOverhead,
    },
    duplicateRead: {
      ...DEFAULT_THRESHOLDS.duplicateRead,
      ...overrides.duplicateRead,
    },
    scatteredToolFailures: {
      ...DEFAULT_THRESHOLDS.scatteredToolFailures,
      ...overrides.scatteredToolFailures,
    },
    oversizedOutput: {
      ...DEFAULT_THRESHOLDS.oversizedOutput,
      ...overrides.oversizedOutput,
    },
    severity: { ...DEFAULT_THRESHOLDS.severity, ...overrides.severity },
  };
  // a raised firing gate must never produce a negative-savings absurdity
  resolved.lowCacheHit.targetHitRate = Math.max(
    resolved.lowCacheHit.targetHitRate,
    resolved.lowCacheHit.maxHitRate,
  );
  return resolved;
}

/**
 * A finding as a rule emits it: no per-run id yet, and no severity — the
 * engine grades that from the estimate's share of the run (`gradeSeverity`).
 */
export type Finding = Omit<Insight, 'id' | 'severity'>;

/**
 * Severity from magnitude alone: the estimate's share of the run's priced
 * cost, gated by an absolute floor per tier. No estimate, or a run with no
 * priced cost, cannot be sized and grades `info` — never a guess.
 */
export function gradeSeverity(
  estimatedWasteUSD: number | undefined,
  runCostUSD: number,
  t: SeverityThresholds = DEFAULT_THRESHOLDS.severity,
): Insight['severity'] {
  if (estimatedWasteUSD === undefined || !(runCostUSD > 0)) return 'info';
  const share = estimatedWasteUSD / runCostUSD;
  if (share >= t.criticalShare && estimatedWasteUSD >= t.criticalFloorUSD) {
    return 'critical';
  }
  if (share >= t.warningShare && estimatedWasteUSD >= t.warningFloorUSD) {
    return 'warning';
  }
  return 'info';
}

/**
 * Everything a rule may consult (C3). `pricing` is the same effective table
 * the run's spans were priced with — rules must never reach for the bundled
 * snapshot on their own, or insight dollars diverge from span dollars the
 * moment the user refreshes pricing.
 */
export interface RuleContext {
  thresholds: Thresholds;
  pricing: PricingTable;
}

export interface InsightRule {
  id: string;
  evaluate(run: Run, ctx: RuleContext): Finding[];
}

/** Waste-class membership derives from the rule-metadata registry (B1). */
function isWasteClass(ruleId: string): boolean {
  return ruleClass(ruleId) === 'waste';
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Evaluate rules over a normalized Run. Pure — returns a new Run with
 * `insights` filled (severity graded per finding) and
 * `totals.costUSD.wastedEstimate` recomputed. Rule order is fixed
 * (registration order) so insight ids are deterministic.
 */
export function applyInsights(
  run: Run,
  overrides: ThresholdOverrides = {},
  rules: readonly InsightRule[] = V0_RULES,
  pricing: PricingTable = bundledPricing(),
): Run {
  const ctx: RuleContext = {
    thresholds: resolveThresholds(overrides),
    pricing,
  };
  const insights: Insight[] = [];
  for (const rule of rules) {
    for (const { ruleId, ...rest } of rule.evaluate(run, ctx)) {
      // key order is part of the byte-stable contract (goldens, exports):
      // id · ruleId · severity · the rule's own fields, as it always was
      insights.push({
        id: `i${insights.length + 1}`,
        ruleId,
        severity: gradeSeverity(
          rest.estimatedWasteUSD,
          run.totals.costUSD.total,
          ctx.thresholds.severity,
        ),
        ...rest,
      });
    }
  }
  // cap (B2): waste-class overlap is only partially deduped across rules, so
  // the flagship number can never exceed what the run actually spent
  const wastedEstimate = Math.min(
    round6(
      insights
        .filter((i) => isWasteClass(i.ruleId))
        .reduce((acc, i) => acc + (i.estimatedWasteUSD ?? 0), 0),
    ),
    run.totals.costUSD.total,
  );
  return {
    ...run,
    totals: {
      ...run.totals,
      costUSD: { ...run.totals.costUSD, wastedEstimate },
    },
    insights,
  };
}

export type { Playbook, PlaybookSource, RuleClass, RuleMeta } from './meta.js';
export {
  PLAYBOOK_SOURCE_LABEL,
  PLAYBOOK_SOURCES,
  playbookActions,
  RULE_META,
  ruleClass,
} from './meta.js';
export {
  extractPlaybooksBlock,
  PLAYBOOKS_END,
  PLAYBOOKS_START,
  renderPlaybooksMarkdown,
  replacePlaybooksBlock,
} from './playbook-markdown.js';
export { V0_RULES } from './rules.js';
