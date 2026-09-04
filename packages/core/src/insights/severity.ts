import type { Insight } from '@runray/schema';

/**
 * Severity grading (cost-engine "Severity grading"): a grade is the
 * estimate's share of the run's priced cost, gated by an absolute floor per
 * tier, so cents in a tiny run never read as critical. Rules never grade
 * themselves; the engine grades each finding here, and the browser-safe
 * waste module grades a GROUP of findings by the same function — one rule,
 * one place. Import-free so both stay bundleable by the visualizer.
 */
export interface SeverityThresholds {
  warningShare: number;
  warningFloorUSD: number;
  criticalShare: number;
  criticalFloorUSD: number;
}

export const DEFAULT_SEVERITY_THRESHOLDS: SeverityThresholds = {
  warningShare: 0.02,
  warningFloorUSD: 0.05,
  criticalShare: 0.1,
  criticalFloorUSD: 1,
};

/**
 * Severity from magnitude alone: the estimate's share of the run's priced
 * cost, gated by an absolute floor per tier. No estimate, or a run with no
 * priced cost, cannot be sized and grades `info` — never a guess.
 */
export function gradeSeverity(
  estimatedWasteUSD: number | undefined,
  runCostUSD: number,
  t: SeverityThresholds = DEFAULT_SEVERITY_THRESHOLDS,
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
