import type { Insight } from '@runray/schema';

/**
 * The one severity pill (03-design.md §4.1): tinted background, mono
 * uppercase, always carries the word — severity is never color-alone.
 * Mapping per §2: warning = ember, critical = alarm, never brass.
 */
export function SeverityPill({ severity }: { severity: Insight['severity'] }) {
  const tint =
    severity === 'critical'
      ? 'bg-heat-3/15 text-heat-3'
      : severity === 'warning'
        ? 'bg-heat-2/15 text-heat-2'
        : 'bg-surface-2 text-text-dim';
  return (
    <span className={`micro-label rounded-control px-1.5 py-px ${tint}`}>
      {severity}
    </span>
  );
}
