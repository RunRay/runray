import type { Run } from '@runray/schema';
import { useAppStore } from '../store';

/**
 * The one pricing-provenance line (C2/C9): rendered wherever repriced money
 * is shown — the what-if panel, the Cost view totals, the dashboard savings
 * aggregate — so every dollar figure names the table that produced it.
 * "refreshed" = the user's `pricing --refresh` override; "bundled" = the
 * shipped snapshot. Renders nothing when the page has no payload.
 */
export function PricingProvenance({ className = '' }: { className?: string }) {
  const pricing = useAppStore((s) => s.pricing);
  if (pricing === undefined) return null;
  const origin = pricing.origin === 'user' ? 'refreshed' : 'bundled';
  return (
    <span className={`micro-label text-text-faint ${className}`}>
      prices: LiteLLM snapshot {pricing.table.snapshotDate} ({origin})
    </span>
  );
}

/**
 * The lower-bound caveat for transcript-derived money: providers bill some
 * work that never reaches the local log (utility calls like titles and
 * summaries, retried requests, per-search web fees), so the provider's own
 * usage report can read higher than any figure computed here. A permanent
 * methodological note, not a warning — quiet body register (text-label,
 * sentence case; the sibling provenance line is a micro-label tag), never
 * ember-tinted (ember means "fixable incompleteness", see CoverageNotices).
 * Rendered only for transcript-parsed sources with a pricing payload:
 * OTLP-ingested runs are not "recorded transcripts" and may carry
 * provider-reported costs the claim would be wrong about, and without the
 * payload the note would float alone with no provenance line above it.
 */
export function TranscriptCostNote({
  run,
  className = '',
}: {
  run: Run;
  className?: string;
}) {
  const pricing = useAppStore((s) => s.pricing);
  if (pricing === undefined) return null;
  const tool = run.source.tool;
  if (tool !== 'claude-code' && tool !== 'opencode') return null;
  return (
    <span className={`text-label text-text-faint ${className}`}>
      Computed from the recorded transcript — a lower bound. Utility calls,
      unlogged retries, and web-search fees never reach the log, so provider
      billing can read higher.
    </span>
  );
}
