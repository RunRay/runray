import { unpricedCoverage } from '@runray/core';
import type { Run, TraceFile } from '@runray/schema';

/**
 * `runray list` output (cli spec "Scripting output"): a machine-readable
 * per-run summary — id, source, timing, tokens, cost — plus a human table.
 * The shape is additive-only; `unpricedLlmCalls`/`unpricedTokens` surface
 * cost-coverage honesty for scripting (C7).
 */

export interface RunSummary {
  id: string;
  source: string;
  title?: string;
  project?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  tokens: Run['totals']['tokens'];
  costUSD: number;
  wastedUSD: number;
  insights: number;
  toolErrors: number;
  unpricedLlmCalls: number;
  unpricedTokens: number;
}

export function summarizeRuns(traceFile: TraceFile): RunSummary[] {
  return traceFile.runs.map((run) => {
    const coverage = unpricedCoverage(run);
    return {
      id: run.id,
      source: run.source.tool,
      ...(run.title === undefined ? {} : { title: run.title }),
      ...(run.project?.name === undefined ? {} : { project: run.project.name }),
      startedAt: run.startedAt,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
      tokens: run.totals.tokens,
      costUSD: run.totals.costUSD.total,
      wastedUSD: run.totals.costUSD.wastedEstimate,
      insights: run.insights.length,
      toolErrors: run.totals.counts.toolErrors,
      unpricedLlmCalls: coverage.unpricedLlmCalls,
      unpricedTokens: coverage.unpricedTokens,
    };
  });
}

export function humanDuration(ms: number | undefined): string {
  if (ms === undefined) return '-';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

export function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

export function formatRunTable(summaries: RunSummary[]): string {
  const header = [
    'DATE',
    'SOURCE',
    'PROJECT',
    'TITLE',
    'DUR',
    'TOKENS',
    'COST',
    'FLAGS',
  ];
  const rows = summaries.map((s) => [
    s.startedAt.slice(0, 16).replace('T', ' '),
    s.source,
    s.project ?? '-',
    (s.title ?? '-').slice(0, 40),
    humanDuration(s.durationMs),
    humanTokens(s.tokens.total),
    `$${s.costUSD.toFixed(2)}`,
    [
      s.insights > 0
        ? `${s.insights} insight${s.insights === 1 ? '' : 's'}`
        : '',
      s.toolErrors > 0 ? `${s.toolErrors} err` : '',
    ]
      .filter(Boolean)
      .join(', ') || '-',
  ]);
  const table = [header, ...rows];
  const widths = header.map((_, col) =>
    Math.max(...table.map((row) => (row[col] ?? '').length)),
  );
  return table
    .map((row) =>
      row
        .map((cell, col) => (cell ?? '').padEnd(widths[col] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
