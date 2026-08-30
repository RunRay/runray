import type { RunDiff } from '@runray/core';
import { humanDuration, humanTokens } from './list.js';

/**
 * `runray diff` human summary (run-diff spec "Cost delta"): delta chips
 * as text — absolute + percent — worst regressions first. The UI's Diff
 * view summary table mirrors these figures because both render the same
 * `RunDiff` from `@runray/core/diff`; `--json` prints that shape
 * verbatim (the CI-gate input, additive-only).
 */

function signedCount(n: number): string {
  if (n === 0) return '±0';
  return n > 0 ? `+${n}` : `${n}`;
}

function signedMoney(n: number): string {
  if (n === 0) return '±$0.00';
  const abs = Math.abs(n);
  const digits = abs >= 0.01 ? 2 : 4;
  return `${n > 0 ? '+' : '-'}$${abs.toFixed(digits)}`;
}

function signedTokens(n: number): string {
  if (n === 0) return '±0';
  return `${n > 0 ? '+' : '-'}${humanTokens(Math.abs(n))}`;
}

function signedDuration(ms: number): string {
  if (ms === 0) return '±0s';
  return `${ms > 0 ? '+' : '-'}${humanDuration(Math.abs(ms))}`;
}

/** `(+34%)`; empty on a zero base (pct null — never Infinity). */
function pctChip(pct: number | null): string {
  if (pct === null) return '';
  const value = Math.round(pct * 100);
  return ` (${value >= 0 ? '+' : ''}${value}%)`;
}

/** Matched-pair cost regressions, worst first (already round6). */
export function worstRegressions(
  diff: RunDiff,
  limit = 5,
): Array<{ label: string; deltaUSD: number }> {
  return diff.alignment.matched
    .filter((pair) => pair.costUSD.delta > 0)
    .sort(
      (x, y) =>
        y.costUSD.delta - x.costUSD.delta ||
        (x.aId < y.aId ? -1 : x.aId > y.aId ? 1 : 0),
    )
    .slice(0, limit)
    .map((pair) => ({
      label: `${pair.kind}  ${pair.name}`,
      deltaUSD: pair.costUSD.delta,
    }));
}

export function formatDiffSummary(diff: RunDiff): string {
  const { header, alignment } = diff;
  const lines: string[] = [];

  lines.push(
    `a  ${diff.a.id}  (${diff.a.source}, ${diff.a.startedAt})`,
    `b  ${diff.b.id}  (${diff.b.source}, ${diff.b.startedAt})`,
    '',
  );

  const rows: Array<[string, string, string]> = [
    [
      'cost',
      `${signedMoney(header.costUSD.delta)}${pctChip(header.costUSD.pct)}`,
      `$${header.costUSD.a.toFixed(2)} → $${header.costUSD.b.toFixed(2)}`,
    ],
    [
      'tokens',
      `${signedTokens(header.tokens.total.delta)}${pctChip(header.tokens.total.pct)}`,
      `${humanTokens(header.tokens.total.a)} → ${humanTokens(header.tokens.total.b)}`,
    ],
    [
      'tool errors',
      `${signedCount(header.toolErrors.delta)}${pctChip(header.toolErrors.pct)}`,
      `${header.toolErrors.a} → ${header.toolErrors.b}`,
    ],
    [
      'llm calls',
      `${signedCount(header.llmCalls.delta)}${pctChip(header.llmCalls.pct)}`,
      `${header.llmCalls.a} → ${header.llmCalls.b}`,
    ],
    [
      'max depth',
      `${signedCount(header.maxDepth.delta)}${pctChip(header.maxDepth.pct)}`,
      `${header.maxDepth.a} → ${header.maxDepth.b}`,
    ],
    [
      'wall clock',
      `${signedDuration(header.wallClockMs.delta)}${pctChip(header.wallClockMs.pct)}`,
      `${humanDuration(header.wallClockMs.a)} → ${humanDuration(header.wallClockMs.b)}`,
    ],
  ];
  const w0 = Math.max(...rows.map((r) => r[0].length));
  const w1 = Math.max(...rows.map((r) => r[1].length));
  for (const [label, chip, range] of rows) {
    lines.push(`  ${label.padEnd(w0)}  ${chip.padEnd(w1)}  ${range}`);
  }

  const flips = alignment.matched.filter(
    (pair) => pair.statusChanged !== undefined,
  ).length;
  lines.push(
    '',
    `  spans: ${alignment.matched.length} matched · ${alignment.added.length} added · ${alignment.removed.length} removed${flips > 0 ? ` · ${flips} status change${flips === 1 ? '' : 's'}` : ''}`,
  );

  const regressions = worstRegressions(diff);
  if (regressions.length > 0) {
    lines.push('', '  worst regressions:');
    for (const item of regressions) {
      lines.push(
        `    ${signedMoney(item.deltaUSD).padStart(8)}  ${item.label}`,
      );
    }
  }

  const subtreeChanges = diff.alignment.subtrees.filter(
    (s) => s.costUSD.delta !== 0,
  );
  if (subtreeChanges.length > 0) {
    lines.push('', '  subagent subtrees:');
    for (const s of subtreeChanges) {
      lines.push(`    ${signedMoney(s.costUSD.delta).padStart(8)}  ${s.name}`);
    }
  }

  return lines.join('\n');
}
