import type { Run } from '@runray/schema';
import { localDay } from './overview';

/**
 * Client-side CSV builders (D5): pure functions over the VISIBLE (filtered)
 * runs with canonical bytes — fixed column order, rows sorted (startedAt,
 * then id) regardless of the on-screen sort, `String(n)` numbers
 * (locale-free), RFC 4180 quoting, CRLF line ends, and a UTF-8 BOM for
 * Excel. The same filtered data always produces byte-identical files,
 * offline included (Blob download, no server).
 */

const BOM = '﻿';
const CRLF = '\r\n';

function field(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = typeof value === 'number' ? String(value) : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rows(lines: string[][]): string {
  return BOM + lines.map((cells) => cells.join(',')).join(CRLF) + CRLF;
}

function canonical(runs: readonly Run[]): Run[] {
  return [...runs].sort(
    (a, b) =>
      Date.parse(a.startedAt) - Date.parse(b.startedAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export const SESSIONS_CSV_COLUMNS = [
  'runId',
  'startedAt',
  'endedAt',
  'project',
  'source',
  'title',
  'models',
  'durationMs',
  'tokensInput',
  'tokensOutput',
  'tokensCacheRead',
  'tokensCacheWrite',
  'tokensTotal',
  'costUSD',
  'wastedUSD',
  'llmCalls',
  'toolCalls',
  'toolErrors',
  'subagents',
  'insightCount',
] as const;

export function sessionsCsv(runs: readonly Run[]): string {
  const lines: string[][] = [[...SESSIONS_CSV_COLUMNS]];
  for (const run of canonical(runs)) {
    const t = run.totals;
    lines.push(
      [
        run.id,
        run.startedAt,
        run.endedAt ?? '',
        run.project?.name ?? '',
        run.source.tool,
        run.title ?? '',
        Object.keys(t.costUSD.byModel).sort().join(';'),
        run.durationMs ?? '',
        t.tokens.input,
        t.tokens.output,
        t.tokens.cacheRead,
        t.tokens.cacheWrite,
        t.tokens.total,
        t.costUSD.total,
        t.costUSD.wastedEstimate,
        t.counts.llmCalls,
        t.counts.toolCalls,
        t.counts.toolErrors,
        t.counts.subagents,
        run.insights.length,
      ].map(field),
    );
  }
  return rows(lines);
}

/** Per-day aggregates over ALL visible runs (no 30-day chart cap), plus one
 * column per model in stable sorted order. */
export function dayAggregatesCsv(runs: readonly Run[]): string {
  interface DayAcc {
    costUSD: number;
    wastedUSD: number;
    runs: number;
    byModel: Map<string, number>;
  }
  const days = new Map<string, DayAcc>();
  const models = new Set<string>();
  for (const run of canonical(runs)) {
    const day = localDay(run.startedAt);
    const acc = days.get(day) ?? {
      costUSD: 0,
      wastedUSD: 0,
      runs: 0,
      byModel: new Map<string, number>(),
    };
    acc.costUSD += run.totals.costUSD.total;
    acc.wastedUSD += run.totals.costUSD.wastedEstimate;
    acc.runs += 1;
    for (const [model, cost] of Object.entries(run.totals.costUSD.byModel)) {
      models.add(model);
      acc.byModel.set(model, (acc.byModel.get(model) ?? 0) + cost);
    }
    days.set(day, acc);
  }
  const modelColumns = [...models].sort();
  const lines: string[][] = [
    ['day', 'costUSD', 'wastedUSD', 'runs', ...modelColumns],
  ];
  for (const day of [...days.keys()].sort()) {
    const acc = days.get(day);
    if (acc === undefined) continue;
    lines.push(
      [
        day,
        acc.costUSD,
        acc.wastedUSD,
        acc.runs,
        ...modelColumns.map((m) => acc.byModel.get(m) ?? 0),
      ].map(field),
    );
  }
  return rows(lines);
}

/** Trigger a browser download of one CSV (Blob — works from file://). */
export function downloadCsv(filename: string, content: string): void {
  const url = URL.createObjectURL(
    new Blob([content], { type: 'text/csv;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
