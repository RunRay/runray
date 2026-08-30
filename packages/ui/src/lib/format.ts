/**
 * Display formatting per 03-design.md: numbers over adjectives, mono +
 * tabular-nums at the call sites. Kept UI-local — importing from the CLI
 * would cross the Track boundary (AGENTS.md).
 */

/** `$0.3959` under a dollar, `$12.41` above — enough precision to compare. */
export function formatUSD(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/** Space thousands grouping: `138 610` (plain space — copy-paste friendly). */
export function formatTokens(value: number): string {
  return new Intl.NumberFormat('en-US', { useGrouping: true })
    .format(value)
    .replace(/,/g, ' ');
}

/**
 * Compact token count for prominent, space-tight spots (hero sub-stat, KPI
 * notes, sessions column): `382.9M`, `9.8M`, `84k`, `512`. The full grouped
 * form (`formatTokens`) stays for places that need every digit.
 */
export function formatTokensCompact(value: number): string {
  // 999_500 not 1_000_000: values that round up to 1000k roll over to 1.0M.
  if (value >= 999_500) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/**
 * Relative time anchored to a reference instant (the trace file's
 * `generatedAt`, never wall-clock `now`) so an exported report reads the same
 * on every open — determinism over freshness, matching the period anchor.
 * `just now` · `5 m ago` · `3 h ago` · `yesterday` · `4 days ago` ·
 * `2026-05-30` past a fortnight.
 */
export function formatRelativeTime(iso: string, referenceIso: string): string {
  const then = new Date(iso).getTime();
  const ref = new Date(referenceIso).getTime();
  if (Number.isNaN(then) || Number.isNaN(ref)) return iso.slice(0, 10);
  const mins = Math.floor((ref - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return iso.slice(0, 10);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Clock offset into the run: `02:14`, or `1:02:14` past an hour. */
export function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** `2026-07-07 14:03` — sortable at a glance, no locale surprises. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}
