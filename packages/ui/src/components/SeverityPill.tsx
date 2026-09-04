import type { Insight } from '@runray/schema';

/**
 * The one severity pill (03-design.md §4.1): tinted background, mono
 * uppercase, always carries the word — severity is never color-alone.
 * Mapping per §2: warning = ember, critical = alarm, never brass. The
 * tooltip says what severity MEANS (a per-run size grade, not a rule
 * property); the tiers themselves are in the `?` help sheet and the docs,
 * so the numbers live in one place in the UI.
 */
export function SeverityPill({ severity }: { severity: Insight['severity'] }) {
  const tint =
    severity === 'critical'
      ? 'bg-heat-3/15 text-heat-3'
      : severity === 'warning'
        ? 'bg-heat-2/15 text-heat-2'
        : 'bg-surface-2 text-text-dim';
  return (
    <span
      title={`${severity} — graded from this finding's share of the run's cost, not from its rule. Press ? for the tiers.`}
      className={`micro-label rounded-control px-1.5 py-px ${tint}`}
    >
      {severity}
    </span>
  );
}
