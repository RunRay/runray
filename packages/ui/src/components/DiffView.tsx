import { type DiffDelta, diffRuns } from '@runray/core/diff';
import type { Run } from '@runray/schema';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useMemo, useRef } from 'react';
import { buildDiffRows, type DiffRow } from '../lib/diff-view';
import {
  formatDateTime,
  formatDuration,
  formatTokensCompact,
  formatUSD,
} from '../lib/format';
import { KIND_BG } from '../lib/span-kind';
import { ContextualHint } from './ContextualHint';

/**
 * Diff view (run-diff 3.3, archived stylebook §4.6): two-column run headers
 * with delta chips, an aligned paired waterfall — added spans tinted brass
 * (heat-1), removed dimmed, cost-regressed pairs ember-underlined (heat-2)
 * — and a summary table mirroring the CLI figures. Everything renders the
 * SAME `RunDiff` the CLI prints, so the numbers cannot disagree.
 */

const ROW_PX = 28;
const INDENT_PX = 16;

/** `+$0.42` / `−$0.13` / `±0` — typographic minus, mono at call sites. */
function signed(n: number, fmt: (abs: number) => string): string {
  if (n === 0) return '±0';
  return `${n > 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
}

function pctSuffix(pct: number | null): string {
  if (pct === null) return '';
  const value = Math.round(pct * 100);
  return ` (${value >= 0 ? '+' : '−'}${Math.abs(value)}%)`;
}

/** Direction color for "more is worse" metrics; neutral for the rest. */
function deltaTone(delta: number, directional: boolean): string {
  if (delta === 0) return 'text-text-faint';
  if (!directional) return 'text-text-dim';
  return delta > 0 ? 'text-heat-2' : 'text-cache-savings';
}

export function DiffView({ runA, runB }: { runA: Run; runB: Run }) {
  const diff = useMemo(() => diffRuns(runA, runB), [runA, runB]);
  const rows = useMemo(
    () => buildDiffRows(runA, runB, diff),
    [runA, runB, diff],
  );
  const { header, alignment } = diff;

  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-4 p-5">
        <ContextualHint hintKey="diff" />
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-title font-semibold text-text">
            Run diff
          </h2>
          <p className="font-mono text-label text-text-faint">
            {alignment.matched.length} matched · {alignment.added.length} added
            · {alignment.removed.length} removed
          </p>
        </header>

        <div className="relative grid grid-cols-1 gap-4 md:grid-cols-2">
          <RunCard side="a" label="baseline" run={runA} />
          <RunCard side="b" label="comparison" run={runB} />
          <a
            href={`#/diff/${encodeURIComponent(runB.id)}/${encodeURIComponent(runA.id)}`}
            aria-label="Swap baseline and comparison"
            title="Swap A ↔ B"
            className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 rounded-full border border-border-strong bg-surface-container-high px-2.5 py-1 font-mono text-label text-text-dim shadow-card transition-colors duration-150 ease-out hover:text-text hover:border-outline focus-visible:text-text active:bg-surface-2 md:block"
          >
            ⇄
          </a>
        </div>

        <ul
          className="flex flex-wrap items-center gap-2"
          aria-label="Header deltas"
        >
          <DeltaChip
            label="cost"
            delta={header.costUSD.delta}
            directional
            text={`${signed(header.costUSD.delta, formatUSD)}${pctSuffix(header.costUSD.pct)}`}
          />
          <DeltaChip
            label="tokens"
            delta={header.tokens.total.delta}
            directional
            text={`${signed(header.tokens.total.delta, formatTokensCompact)} tokens${pctSuffix(header.tokens.total.pct)}`}
          />
          <DeltaChip
            label="tool errors"
            delta={header.toolErrors.delta}
            directional
            text={`${signed(header.toolErrors.delta, String)} tool error${Math.abs(header.toolErrors.delta) === 1 ? '' : 's'}`}
          />
          <DeltaChip
            label="llm calls"
            delta={header.llmCalls.delta}
            directional={false}
            text={`${signed(header.llmCalls.delta, String)} llm calls`}
          />
          <DeltaChip
            label="max depth"
            delta={header.maxDepth.delta}
            directional={false}
            text={`${signed(header.maxDepth.delta, String)} depth`}
          />
          <DeltaChip
            label="wall clock"
            delta={header.wallClockMs.delta}
            directional
            text={`${signed(header.wallClockMs.delta, formatDuration)} wall`}
          />
        </ul>

        <Panel title="Aligned spans">
          <PairedWaterfall rows={rows} />
        </Panel>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Summary — mirrors runray diff">
            <SummaryTable header={header} />
          </Panel>
          {alignment.subtrees.length > 0 && (
            <Panel title="Subagent subtrees">
              <SubtreeTable subtrees={alignment.subtrees} />
            </Panel>
          )}
        </div>
      </div>
    </main>
  );
}

function RunCard({
  side,
  label,
  run,
}: {
  side: 'a' | 'b';
  label: string;
  run: Run;
}) {
  return (
    <section className="rounded border border-border-slate bg-surface-container-low p-4 shadow-card">
      <p className="micro-label text-text-faint">
        run {side} · {label}
      </p>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <a
          href={`#/run/${encodeURIComponent(run.id)}`}
          className="truncate font-mono text-detail text-text underline-offset-4 transition-colors duration-150 ease-out hover:text-brand-bright hover:underline focus-visible:underline active:text-brand"
        >
          {run.id.slice(0, 16)}
        </a>
        <span className="font-display text-title font-semibold text-text">
          {formatUSD(run.totals.costUSD.total)}
        </span>
      </div>
      <p className="mt-1 truncate text-label text-text-dim">
        {run.title ?? run.source.tool}
      </p>
      <p className="mt-0.5 font-mono text-label text-text-faint">
        {run.source.tool} · {formatDateTime(run.startedAt)} ·{' '}
        {formatTokensCompact(run.totals.tokens.total)} tok ·{' '}
        {run.totals.counts.llmCalls} llm
      </p>
    </section>
  );
}

function DeltaChip({
  label,
  delta,
  directional,
  text,
}: {
  label: string;
  delta: number;
  directional: boolean;
  text: string;
}) {
  return (
    <li
      className={`rounded-full border border-border bg-surface-container-low px-2.5 py-0.5 font-mono text-label ${deltaTone(delta, directional)}`}
    >
      <span className="sr-only">{label} delta: </span>
      {text}
    </li>
  );
}

/**
 * The paired waterfall: matched | added | removed rows interleaved by
 * offset, virtualized like the Timeline. Added = brass tint, removed =
 * dimmed, cost-regressed = ember underline (§4.6).
 */
function PairedWaterfall({ rows }: { rows: DiffRow[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 20,
  });

  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-label text-text-faint">
        Nothing to align — both runs are empty.
      </p>
    );
  }

  return (
    <div>
      <p className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-label text-text-faint">
        <span>
          <i
            aria-hidden
            className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-heat-1/70"
          />
          added (run b only)
        </span>
        <span className="opacity-60">
          <i
            aria-hidden
            className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-span-hook"
          />
          removed (run a only)
        </span>
        <span>
          <i
            aria-hidden
            className="mr-1.5 inline-block h-2 w-0.5 rounded-sm bg-heat-2 align-middle"
          />
          cost-regressed pair
        </span>
      </p>
      <div
        ref={scrollRef}
        className="max-h-[480px] overflow-y-auto rounded border border-border bg-bg/40"
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            return (
              <PairedRow
                key={row.key}
                row={row}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_PX,
                  transform: `translateY(${item.start}px)`,
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PairedRow({
  row,
  style,
}: {
  row: DiffRow;
  style: React.CSSProperties;
}) {
  const rowTint =
    row.type === 'added'
      ? 'bg-heat-1/10'
      : row.type === 'removed'
        ? 'opacity-50'
        : '';
  const underline = row.costRegressed
    ? 'border-b-2 border-heat-2/80'
    : 'border-b border-border/40';

  return (
    <div
      style={style}
      className={`flex items-center gap-2 px-2 text-label ${rowTint} ${underline}`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-sm ${KIND_BG[row.kind]}`}
        style={{ marginLeft: row.depth * INDENT_PX }}
      />
      <span
        className={`truncate ${row.type === 'removed' ? 'text-text-faint line-through' : 'text-text-dim'}`}
      >
        {row.name}
      </span>
      {row.type === 'added' && (
        <span className="micro-label shrink-0 text-heat-1">+ added</span>
      )}
      {row.type === 'removed' && (
        <span className="micro-label shrink-0 text-text-faint">− removed</span>
      )}
      {row.statusChanged !== null && (
        <span className="micro-label shrink-0 text-span-error">
          {row.statusChanged.a}→{row.statusChanged.b}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-3 font-mono">
        {row.type === 'matched' ? (
          <>
            {row.costUSD !== null && row.costUSD.delta !== 0 && (
              <span className={deltaTone(row.costUSD.delta, true)}>
                {signed(row.costUSD.delta, formatUSD)}
              </span>
            )}
            {row.durationMs !== null && row.durationMs.delta !== 0 && (
              <span className="text-text-faint">
                {signed(row.durationMs.delta, formatDuration)}
              </span>
            )}
          </>
        ) : (
          <>
            {row.ownCostUSD > 0 && (
              <span className="text-text-dim">{formatUSD(row.ownCostUSD)}</span>
            )}
            {row.ownDurationMs > 0 && (
              <span className="text-text-faint">
                {formatDuration(row.ownDurationMs)}
              </span>
            )}
          </>
        )}
      </span>
    </div>
  );
}

/** The six CLI figures, verbatim — same RunDiff, same numbers. */
function SummaryTable({
  header,
}: {
  header: ReturnType<typeof diffRuns>['header'];
}) {
  const rows: Array<{
    metric: string;
    d: DiffDelta;
    directional: boolean;
    fmt: (n: number) => string;
  }> = [
    { metric: 'cost', d: header.costUSD, directional: true, fmt: formatUSD },
    {
      metric: 'tokens',
      d: header.tokens.total,
      directional: true,
      fmt: formatTokensCompact,
    },
    {
      metric: 'tool errors',
      d: header.toolErrors,
      directional: true,
      fmt: String,
    },
    {
      metric: 'llm calls',
      d: header.llmCalls,
      directional: false,
      fmt: String,
    },
    {
      metric: 'max depth',
      d: header.maxDepth,
      directional: false,
      fmt: String,
    },
    {
      metric: 'wall clock',
      d: header.wallClockMs,
      directional: true,
      fmt: formatDuration,
    },
  ];
  return (
    <table className="w-full text-body">
      <thead>
        <tr className="border-b border-border-slate text-left text-label text-on-surface-variant">
          <th scope="col" className="py-1.5 pr-3 font-normal">
            metric
          </th>
          <Th>run a</Th>
          <Th>run b</Th>
          <Th>Δ</Th>
          <Th>Δ%</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ metric, d, directional, fmt }) => (
          <tr key={metric} className="border-b border-border/40">
            <td className="py-1.5 pr-3 text-text-dim">{metric}</td>
            <Td>{fmt(d.a)}</Td>
            <Td>{fmt(d.b)}</Td>
            <td
              className={`whitespace-nowrap py-1.5 pr-3 text-right font-mono ${deltaTone(d.delta, directional)}`}
            >
              {signed(d.delta, fmt)}
            </td>
            <Td>
              {d.pct === null
                ? '—'
                : `${d.pct >= 0 ? '+' : '−'}${Math.abs(Math.round(d.pct * 100))}%`}
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SubtreeTable({
  subtrees,
}: {
  subtrees: ReturnType<typeof diffRuns>['alignment']['subtrees'];
}) {
  return (
    <table className="w-full text-body">
      <thead>
        <tr className="border-b border-border-slate text-left text-label text-on-surface-variant">
          <th scope="col" className="py-1.5 pr-3 font-normal">
            subagent
          </th>
          <Th>run a</Th>
          <Th>run b</Th>
          <Th>Δ subtree cost</Th>
        </tr>
      </thead>
      <tbody>
        {subtrees.map((s) => (
          <tr key={`${s.aId}:${s.bId}`} className="border-b border-border/40">
            <td className="truncate py-1.5 pr-3 text-text-dim">{s.name}</td>
            <Td>{formatUSD(s.costUSD.a)}</Td>
            <Td>{formatUSD(s.costUSD.b)}</Td>
            <td
              className={`whitespace-nowrap py-1.5 pr-3 text-right font-mono ${deltaTone(s.costUSD.delta, true)}`}
            >
              {signed(s.costUSD.delta, formatUSD)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th scope="col" className="py-1.5 pr-3 text-right font-normal">
      {children}
    </th>
  );
}

function Td({ children }: { children: ReactNode }) {
  return (
    <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-text">
      {children}
    </td>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="shrink-0 rounded border border-border-slate bg-surface-container-low p-4 shadow-card">
      <h3 className="mb-3 font-display text-title font-semibold text-text">
        {title}
      </h3>
      {children}
    </section>
  );
}
