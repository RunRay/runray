import type { Run } from '@runray/schema';
import { type ReactNode, useMemo, useState } from 'react';
import { dayAggregatesCsv, downloadCsv, sessionsCsv } from '../lib/csv';
import {
  formatDateTime,
  formatDuration,
  formatRelativeTime,
  formatTokensCompact,
  formatUSD,
} from '../lib/format';
import { assignModelColors } from '../lib/model-colors';
import { DEFAULT_SORT, type SortKey, sortRuns } from '../lib/sort-runs';
import { tourAttr } from '../lib/tour-attr';
import { errorPill } from '../lib/triage';
import { useAppStore } from '../store';

/**
 * Sessions list table (03-design.md §4.1, redesign mockup): When · Project ·
 * Title · Models · Duration · Tokens · Cost · badges. Sort by any column,
 * default recency; row activation opens the run's timeline. 28px rows — density
 * is a feature. "When" is relative to the file's `generatedAt`, not wall-clock
 * now, so an exported report reads the same on every open.
 */

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'date', label: 'When' },
  { key: 'project', label: 'Project' },
  { key: 'title', label: 'Title' },
  { key: 'models', label: 'Models' },
  { key: 'duration', label: 'Duration', numeric: true },
  { key: 'tokens', label: 'Tokens', numeric: true },
  { key: 'cost', label: 'Cost', numeric: true },
];

const COLUMN_LABEL: Record<SortKey, string> = {
  date: 'recency',
  project: 'project',
  title: 'title',
  models: 'model',
  duration: 'duration',
  tokens: 'tokens',
  cost: 'cost',
};

export function SessionsTable({
  runs,
  generatedAt,
  limit,
}: {
  runs: Run[];
  /** The file's generation instant — the relative-time anchor. */
  generatedAt: string;
  limit?: number;
}) {
  const diffAnchor = useAppStore((s) => s.diffAnchor);
  const anchorRun = useMemo(
    () => runs.find((r) => r.id === diffAnchor),
    [runs, diffAnchor],
  );
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 25;

  const sorted = useMemo(
    () => sortRuns(runs, sort.key, sort.dir),
    [runs, sort],
  );

  const totalPages = Math.ceil(runs.length / pageSize) || 1;

  const displayRuns = useMemo(() => {
    if (limit !== undefined) {
      return sorted.slice(0, limit);
    }
    const safePage = Math.min(currentPage, totalPages);
    const startIndex = (safePage - 1) * pageSize;
    return sorted.slice(startIndex, startIndex + pageSize);
  }, [sorted, limit, currentPage, totalPages]);

  const modelColor = useMemo(
    () =>
      assignModelColors(
        runs.flatMap((run) => Object.keys(run.totals.costUSD.byModel)),
      ),
    [runs],
  );

  const toggleSort = (key: SortKey) =>
    setSort((prev) => ({
      key,
      // Numbers open big-first; text opens A→Z. Re-click flips.
      dir:
        prev.key === key
          ? prev.dir === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'project' || key === 'title'
            ? 'asc'
            : 'desc',
    }));

  const sortDescriptor =
    sort.key === 'date' && sort.dir === 'desc'
      ? 'recency'
      : `${COLUMN_LABEL[sort.key]} ${sort.dir === 'asc' ? '↑' : '↓'}`;

  return (
    <section {...tourAttr('sessions-table')} aria-label="Sessions">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="font-display text-header font-semibold text-text">
          Sessions
        </h2>
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-label text-text-faint">
            {runs.length} {runs.length === 1 ? 'run' : 'runs'} · sorted by{' '}
            {sortDescriptor}
          </span>
          {runs.length > 0 && (
            <span className="flex items-center gap-1.5">
              <CsvButton
                label="Sessions CSV"
                onClick={() =>
                  downloadCsv('runray-sessions.csv', sessionsCsv(runs))
                }
              />
              <CsvButton
                label="Daily CSV"
                onClick={() =>
                  downloadCsv('runray-daily.csv', dayAggregatesCsv(runs))
                }
              />
            </span>
          )}
        </div>
      </div>
      {diffAnchor !== null && (
        <p
          role="status"
          className="mt-3 flex flex-wrap items-center gap-2 rounded border border-brand/40 bg-brand/8 px-3 py-2 text-label text-text-dim"
        >
          <span aria-hidden className="font-mono text-brand-bright">
            ⇄
          </span>
          Comparing from{' '}
          <span className="font-mono text-text">
            {anchorRun?.title ?? diffAnchor.slice(0, 16)}
          </span>
          . Pick the second run.
          <button
            type="button"
            onClick={() => useAppStore.getState().setDiffAnchor(null)}
            className="ml-auto rounded-control border border-border bg-surface px-2 py-0.5 text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text focus-visible:text-text active:bg-bg"
          >
            Cancel
          </button>
        </p>
      )}
      <div className="mt-3 overflow-hidden rounded border border-border-slate bg-surface-container-low shadow-card">
        <table className="w-full border-collapse text-body">
          <thead className="sticky top-0 z-10 bg-surface-container-highest">
            <tr className="border-b border-border-slate">
              {COLUMNS.map(({ key, label, numeric }) => {
                const active = sort.key === key;
                return (
                  <th
                    key={key}
                    scope="col"
                    aria-sort={
                      active
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                    className="p-0"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(key)}
                      className={`micro-label flex h-row w-full items-center gap-1 px-3 transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-on-surface active:bg-bg-deep-gray ${
                        numeric ? 'justify-end' : ''
                      } ${active ? 'text-text' : 'text-text-faint'}`}
                    >
                      {label}
                      <span
                        aria-hidden
                        className={active ? 'text-brand' : 'invisible'}
                      >
                        {active && sort.dir === 'asc' ? '▲' : '▼'}
                      </span>
                    </button>
                  </th>
                );
              })}
              <th
                scope="col"
                className="px-3 text-left text-label font-normal text-text-dim"
              >
                <span className="sr-only">Badges</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {displayRuns.map((run) => (
              <SessionRow
                key={run.id}
                run={run}
                modelColor={modelColor}
                generatedAt={generatedAt}
                diffAnchor={diffAnchor}
              />
            ))}
          </tbody>
        </table>
      </div>

      {limit !== undefined && runs.length > limit && (
        <div className="mt-3 flex justify-end">
          <a
            href="#/sessions"
            className="inline-flex items-center gap-1 text-label text-brand hover:underline font-semibold"
          >
            <span>View all sessions</span>
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </a>
        </div>
      )}

      {limit === undefined && runs.length > pageSize && (
        <div className="mt-4 flex items-center justify-between border-t border-border-slate/30 pt-4 text-body text-text-dim">
          <div className="text-label text-text-faint">
            Page {Math.min(currentPage, totalPages)} of {totalPages}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
              className="flex items-center justify-center gap-1 rounded border border-border-slate bg-surface px-3 py-1.5 text-label font-semibold text-on-surface transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-on-surface disabled:opacity-40 disabled:cursor-not-allowed active:bg-bg-deep-gray"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
              <span>Previous</span>
            </button>
            <button
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
              className="flex items-center justify-center gap-1 rounded border border-border-slate bg-surface px-3 py-1.5 text-label font-semibold text-on-surface transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-on-surface disabled:opacity-40 disabled:cursor-not-allowed active:bg-bg-deep-gray"
            >
              <span>Next</span>
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function SessionRow({
  run,
  modelColor,
  generatedAt,
  diffAnchor,
}: {
  run: Run;
  modelColor: Map<string, string>;
  generatedAt: string;
  diffAnchor: string | null;
}) {
  const models = Object.keys(run.totals.costUSD.byModel).sort();
  const open = () => {
    useAppStore.getState().navigateTo({ view: 'cost', runId: run.id });
  };
  const isAnchor = diffAnchor === run.id;
  // Two-step compare (run-diff 3.4): first click anchors, second navigates.
  const compare = () => {
    const store = useAppStore.getState();
    if (diffAnchor === null) {
      store.setDiffAnchor(run.id);
    } else if (isAnchor) {
      store.setDiffAnchor(null);
    } else {
      store.setDiffAnchor(null);
      store.navigateTo({ view: 'diff', runA: diffAnchor, runB: run.id });
    }
  };

  return (
    <tr
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      aria-label={`Open run ${run.title ?? run.id}`}
      className="h-row cursor-pointer border-b border-border-slate/50 transition-colors duration-150 ease-out hover:bg-surface-variant active:bg-primary/10"
    >
      <td
        className="whitespace-nowrap px-3 font-mono text-label text-text-dim"
        title={formatDateTime(run.startedAt)}
      >
        {formatRelativeTime(run.startedAt, generatedAt)}
      </td>
      <td className="max-w-32 truncate px-3 text-text-dim">
        {run.project?.name ?? '—'}
      </td>
      <td className="max-w-72 truncate px-3 text-text">
        {run.title ?? `${run.source.tool} session`}
      </td>
      <td className="whitespace-nowrap px-3">
        <span className="flex items-center gap-1">
          {models.slice(0, 4).map((model) => (
            <i
              key={model}
              title={model}
              className={`inline-block h-2 w-2 rounded-full ${modelColor.get(model) ?? 'bg-model-1'}`}
            />
          ))}
          {models.length > 4 && (
            <span className="text-label text-text-faint">
              +{models.length - 4}
            </span>
          )}
          {models.length === 0 && (
            <span className="text-label text-text-faint">—</span>
          )}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 text-right font-mono text-label text-text-dim">
        {run.durationMs !== undefined ? formatDuration(run.durationMs) : '—'}
      </td>
      <td className="whitespace-nowrap px-3 text-right font-mono text-label text-text-dim">
        {formatTokensCompact(run.totals.tokens.total)}
      </td>
      <td className="whitespace-nowrap px-3 text-right font-mono font-medium text-text">
        {formatUSD(run.totals.costUSD.total)}
      </td>
      <td className="whitespace-nowrap px-3">
        <span className="flex items-center justify-between gap-1.5">
          <span className="flex items-center gap-1.5">
            {(() => {
              // the count stays; the tone is the triage's — red only when
              // something is for the person or the session never got past it
              const pill = errorPill(run);
              return (
                pill !== null && (
                  <span title={pill.title}>
                    <Badge
                      className={
                        pill.tone === 'alarm'
                          ? 'bg-span-error/12 text-span-error'
                          : 'bg-surface-2 text-text-dim'
                      }
                    >
                      {pill.label}
                    </Badge>
                  </span>
                )
              );
            })()}
            {run.totals.counts.subagents > 0 && (
              <Badge className="bg-span-subagent/12 text-span-subagent">
                subagents:{run.totals.counts.subagents}
              </Badge>
            )}
            {run.insights.length > 0 && (
              <Badge className="bg-heat-2/12 text-heat-2">
                ⚠ {run.insights.length}
              </Badge>
            )}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              compare();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label={
              diffAnchor === null
                ? `Compare ${run.title ?? run.id} with…`
                : isAnchor
                  ? 'Cancel compare'
                  : `Compare with ${run.title ?? run.id}`
            }
            title={
              diffAnchor === null
                ? 'Compare with…'
                : isAnchor
                  ? 'Cancel compare'
                  : 'Compare with this run'
            }
            className={`rounded-control border px-1.5 py-px font-mono text-label transition-colors duration-150 ease-out focus-visible:text-text active:bg-bg ${
              isAnchor
                ? 'border-brand/60 bg-brand/15 text-brand-bright hover:text-text'
                : diffAnchor !== null
                  ? 'border-brand/40 text-brand-bright hover:bg-brand/10 hover:text-text'
                  : 'border-border text-text-faint hover:bg-surface-variant hover:text-text'
            }`}
          >
            {isAnchor ? '✕' : diffAnchor !== null ? 'vs' : '⇄'}
          </button>
        </span>
      </td>
    </tr>
  );
}

/** Download control for the client-side CSV export (D5) — works offline. */
function CsvButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-control border border-border-slate bg-surface px-2 py-0.5 font-mono text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass active:bg-bg-deep-gray"
    >
      <svg
        className="h-3 w-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
      </svg>
      {label}
    </button>
  );
}

function Badge({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-px font-mono text-label ${className}`}
    >
      {children}
    </span>
  );
}
