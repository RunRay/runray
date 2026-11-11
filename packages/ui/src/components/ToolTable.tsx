import type { ToolRow, ToolUsage, UsageStats } from '@runray/core/tools';
import { Fragment, useMemo, useState } from 'react';
import { formatDuration } from '../lib/format';
import {
  CHILD_PAGE,
  FAMILY_LABELS,
  type FamilyFilter,
  familyCounts,
  hookNote,
  sideRows,
  type TableChild,
  type TableRow,
  type ToolSort,
  tableRows,
  untimedNote,
} from '../lib/tool-table';
import { formatShare } from '../lib/tool-usage';

/**
 * The tool table of the Time view (visualizer "Tool usage table"): tools by
 * resolved identity instead of by harness tool name, so `docker` and
 * `vitest` are rows and `Bash` is not. Ranked by total time, re-sortable by
 * p95 and by calls, filterable by family; a row with subcommands expands to
 * them. What is kept out of summed tool time (delegations, hooks, questions
 * to the person) is listed apart, each kind under a line that says what its
 * rows are. For hooks from a Claude Code transcript that line is a limit:
 * only failed and cancelled runs are recorded.
 */

const SORTS: ReadonlyArray<{ id: ToolSort; label: string }> = [
  { id: 'calls', label: 'calls' },
  { id: 'total', label: 'total' },
  { id: 'p95', label: 'p95' },
];
const SORT_NAME: Record<ToolSort, string> = {
  total: 'total time',
  p95: 'p95',
  calls: 'calls',
};

const TAG =
  'ml-2 rounded-[4px] border border-border-slate px-1 font-mono text-micro uppercase tracking-[0.05em] text-text-faint';
const FLAG =
  'ml-1.5 rounded-[4px] border px-1 font-mono text-micro uppercase tracking-[0.05em]';
const NUM = 'py-1.5 pl-3 text-right font-mono whitespace-nowrap';

function Flags({ stats }: { stats: UsageStats }) {
  const count = (n: number) => (n > 1 ? `${n} ` : '');
  return (
    <>
      {stats.flags.background > 0 && (
        <span
          className={`${FLAG} border-heat-1/60 text-heat-1`}
          title="Sent to the background: the time shown is the launch, not the run."
        >
          {count(stats.flags.background)}bg
        </span>
      )}
      {stats.flags.timeout > 0 && (
        <span
          className={`${FLAG} border-heat-2/60 text-heat-2`}
          title="Stopped by the harness timeout."
        >
          {count(stats.flags.timeout)}timed out
        </span>
      )}
      {stats.flags.interrupted > 0 && (
        <span
          className={`${FLAG} border-heat-2/60 text-heat-2`}
          title="Interrupted before it finished."
        >
          {count(stats.flags.interrupted)}interrupted
        </span>
      )}
      {stats.cancelled > 0 && (
        <span
          className={`${FLAG} border-heat-2/60 text-heat-2`}
          title="Cancelled before it finished: a hook stopped by its timeout, or a call you declined. Not counted as an error."
        >
          {count(stats.cancelled)}cancelled
        </span>
      )}
      {stats.open > 0 && (
        <span
          className={`${FLAG} border-border-slate text-text-faint`}
          title="No result was recorded: the call was still running when the trace was written, or it was cut off. Counted as a call, no time added."
        >
          {count(stats.open)}no result
        </span>
      )}
    </>
  );
}

/** Calls the source reports without a duration, said beside the label. */
function Untimed({ stats }: { stats: UsageStats }) {
  const note = untimedNote(stats);
  if (note === undefined) return null;
  return (
    <span
      className="ml-2 font-sans text-text-faint"
      title="A turn's Stop hooks are reported together, as a count. The transcript records no duration for them."
    >
      {note}
    </span>
  );
}

/** The seven figure cells every row and sub-row shares. */
function Figures({
  stats,
  share,
  percentiles = true,
  alsoRanMs = 0,
  alsoRanCalls = 0,
}: {
  stats: UsageStats;
  /** Absent for sub-rows and for rows outside summed tool time. */
  share?: number;
  percentiles?: boolean;
  alsoRanMs?: number;
  alsoRanCalls?: number;
}) {
  // a figure the source cannot provide is unavailable, never zero: a call
  // without a result has no time yet, a stop-hook summary records none
  const timed = stats.calls > stats.open + stats.untimed;
  const time = (ms: number) => (timed ? formatDuration(ms) : '—');
  const unavailable = (
    <span title="Not computed across different tools. Expand the group for each tool's own figures.">
      —
    </span>
  );
  return (
    <>
      <td className={`${NUM} text-text-dim`}>{stats.calls}</td>
      <td className={`${NUM} text-text`}>
        {time(stats.totalMs)}
        {stats.sharedMs > 0 && (
          <span
            className="ml-1.5 text-text-faint"
            title="This much of the total was spent in commands that also ran other tools. One command has one duration, so it cannot be divided between them."
          >
            incl. {formatDuration(stats.sharedMs)} shared
          </span>
        )}
        {alsoRanMs > 0 && (
          <span
            className="ml-1.5 text-text-faint"
            title={`Ran in ${alsoRanCalls} ${alsoRanCalls === 1 ? 'command' : 'commands'} led by another tool. That time is counted on the other tool's row, not in this total.`}
          >
            +{formatDuration(alsoRanMs)} shared
          </span>
        )}
      </td>
      <td className={`${NUM} text-text-faint`}>
        {share !== undefined && (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-surface-2"
            >
              <span
                className="block h-full origin-left bg-brass/70"
                style={{ transform: `scaleX(${Math.min(1, share)})` }}
              />
            </span>
            <span className="inline-block w-8">{formatShare(share)}</span>
          </span>
        )}
      </td>
      <td className={`${NUM} text-text-dim`}>
        {percentiles ? time(stats.p50Ms) : unavailable}
      </td>
      <td className={`${NUM} text-text`}>
        {percentiles ? time(stats.p95Ms) : unavailable}
      </td>
      <td className={`${NUM} text-text-faint`}>{time(stats.maxMs)}</td>
      <td
        className={`${NUM} ${stats.errors > 0 ? 'text-span-error' : 'text-text-faint'}`}
      >
        {stats.errors}
      </td>
    </>
  );
}

function ChildRows({ row, tag }: { row: TableRow; tag: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? row.children : row.children.slice(0, CHILD_PAGE);
  const hidden = row.children.length - shown.length;
  return (
    <>
      {shown.map((child: TableChild) => (
        <tr
          key={child.id}
          className="border-t border-dashed border-border-slate"
        >
          <th
            scope="row"
            className="max-w-[320px] truncate py-1.5 pl-6 text-left font-mono font-normal text-text-dim"
          >
            {child.label}
            {child.note !== undefined && (
              <span className="font-sans text-text-faint"> · {child.note}</span>
            )}
            <Flags stats={child.stats} />
            <Untimed stats={child.stats} />
          </th>
          <Figures stats={child.stats} />
        </tr>
      ))}
      {hidden > 0 && (
        <tr className="border-t border-dashed border-border-slate">
          <td colSpan={8} className="py-1.5 pl-6">
            <button
              type="button"
              onClick={() => setAll(true)}
              className="rounded border border-border-slate bg-surface px-2 py-0.5 text-label text-on-surface-variant transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-on-surface active:bg-bg-deep-gray"
            >
              Show {hidden} more of {tag}
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

function Row({
  row,
  tag,
  share,
  expanded,
  onToggle,
}: {
  row: TableRow;
  /** Family tag text; side groups word their own. */
  tag: string;
  share?: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const expandable = row.children.length > 0;
  return (
    <>
      <tr className="border-t border-border-slate" title={row.hint}>
        <th
          scope="row"
          className="py-1.5 text-left font-mono font-normal whitespace-nowrap text-text"
        >
          {expandable ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={onToggle}
              className="-ml-1 inline-flex items-center gap-1.5 rounded-control px-1 text-left transition-colors duration-150 ease-out hover:bg-surface-variant/40 active:bg-surface-variant"
            >
              <span
                aria-hidden
                className={`inline-block w-2.5 text-text-faint transition-transform duration-150 ease-out ${expanded ? 'rotate-90' : ''}`}
              >
                ▸
              </span>
              {row.label}
            </button>
          ) : (
            <span className="pl-4">{row.label}</span>
          )}
          {row.hint !== undefined && (
            <span className="sr-only">. {row.hint}</span>
          )}
          <span className={TAG}>{tag}</span>
          {row.group === 'utilities' && (
            <span className="ml-2 font-sans text-text-faint">
              {row.children.length} tools
            </span>
          )}
          <Flags stats={row.stats} />
          <Untimed stats={row.stats} />
        </th>
        <Figures
          stats={row.stats}
          share={share}
          percentiles={row.percentiles}
          alsoRanMs={row.alsoRanMs}
          alsoRanCalls={row.alsoRanCalls}
        />
      </tr>
      {expandable && expanded && <ChildRows row={row} tag={row.label} />}
    </>
  );
}

export function ToolTable({
  usage,
  rows,
  activityLabel,
  source,
}: {
  /** The run-wide aggregation: the denominator and the side groups. */
  usage: ToolUsage;
  /** The ranked rows to show: `usage.rows`, or rows narrowed to an activity. */
  rows: readonly ToolRow[];
  /** Label of the activity the rows are narrowed to, when they are. */
  activityLabel?: string;
  /** The run's source tool: words the notice for calls without a program. */
  source: string;
}) {
  const [family, setFamily] = useState<FamilyFilter>('all');
  const [sort, setSort] = useState<ToolSort>('total');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const families = useMemo(() => familyCounts(rows), [rows]);
  // a family that the current rows no longer hold falls back to all
  const activeFamily =
    family !== 'all' && families.some((f) => f.family === family)
      ? family
      : 'all';
  const shown = useMemo(
    () => tableRows(rows, usage.summedMs, { family: activeFamily, sort }),
    [rows, usage.summedMs, activeFamily, sort],
  );
  const apart = useMemo(
    () =>
      [
        {
          id: 'agents',
          tag: 'agent',
          note: "A delegation contains its agent's own calls, which are counted above.",
          rows: sideRows(usage.agents.rows),
        },
        {
          id: 'hooks',
          tag: 'hook',
          note: hookNote(source),
          rows: sideRows(usage.hooks.rows),
        },
        {
          id: 'waiting',
          tag: 'waits on you',
          note: 'A question or a plan that waited for your answer.',
          rows: sideRows(usage.waiting.rows),
        },
      ].filter((group) => group.rows.length > 0),
    [usage, source],
  );
  const showApart =
    apart.length > 0 && activeFamily === 'all' && activityLabel === undefined;

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const filterButton = (id: FamilyFilter, label: string, count: number) => (
    <button
      key={id}
      type="button"
      aria-pressed={activeFamily === id}
      onClick={() => setFamily(id)}
      className="rounded-control border border-border-slate px-2 py-0.5 font-mono text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-variant/40 hover:text-text active:bg-surface-variant aria-pressed:border-brass aria-pressed:bg-brass/10 aria-pressed:text-text"
    >
      {label} {count}
    </button>
  );

  return (
    <section
      className="rounded border border-border-slate bg-surface-container-low p-4 shadow-card"
      aria-label="Tools"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="micro-label text-text-faint">
          tools · by {SORT_NAME[sort]}
          {activityLabel !== undefined && ` · ${activityLabel} only`}
        </p>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add a border and legend the filter row has no room for */}
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Filter tools by family"
        >
          {filterButton('all', 'all', rows.length)}
          {families.length > 1 &&
            families.map((f) =>
              filterButton(f.family, FAMILY_LABELS[f.family], f.count),
            )}
        </div>
      </div>

      {usage.unclassifiedShellCalls > 0 && (
        <p
          className="mt-2 max-w-[80ch] text-label text-text-dim"
          data-testid="tools-unclassified"
        >
          {source === 'otlp'
            ? 'This source records the name of the shell tool and no command, so shell calls are listed under that tool, not by the program they ran.'
            : 'This trace was recorded before tool identification, so shell calls are listed under the shell tool, not by the program they ran. Export the session again to see the programs.'}
        </p>
      )}

      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-label">
          <caption className="sr-only">
            Tools by resolved identity, with calls, total time, share of summed
            tool time, p50, p95, maximum and errors
          </caption>
          <thead>
            <tr className="micro-label text-text-faint">
              <th scope="col" className="w-full pb-1 text-left font-normal">
                tool
              </th>
              {SORTS.slice(0, 2).map((s) => (
                <SortHeader
                  key={s.id}
                  sort={s}
                  current={sort}
                  onSort={setSort}
                />
              ))}
              <th scope="col" className="pb-1 pl-3 text-right font-normal">
                share
              </th>
              <th scope="col" className="pb-1 pl-3 text-right font-normal">
                p50
              </th>
              <SortHeader
                sort={SORTS[2] as (typeof SORTS)[number]}
                current={sort}
                onSort={setSort}
              />
              <th scope="col" className="pb-1 pl-3 text-right font-normal">
                max
              </th>
              <th scope="col" className="pb-1 pl-3 text-right font-normal">
                errors
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <Row
                key={row.id}
                row={row}
                tag={FAMILY_LABELS[row.family]}
                share={row.share}
                expanded={expanded.has(row.id)}
                onToggle={() => toggle(row.id)}
              />
            ))}
            {shown.length === 0 && (
              <tr className="border-t border-border-slate">
                <td colSpan={8} className="py-3 text-text-faint">
                  No tool calls match this filter.
                </td>
              </tr>
            )}
          </tbody>
          {showApart && (
            <tbody data-testid="tools-apart">
              <tr className="border-t border-border-slate">
                <td colSpan={8} className="pt-4 text-label text-text-dim">
                  Not part of summed tool time
                </td>
              </tr>
              {apart.map((group, index) => (
                <Fragment key={group.id}>
                  <tr>
                    <td
                      colSpan={8}
                      className={`${index === 0 ? 'pt-1.5' : 'pt-3.5'} pb-1.5 text-label text-text-faint`}
                      data-testid={`tools-apart-${group.id}`}
                    >
                      {/* the table can be wider than its scroll box: keep
                          the sentence inside what is visible without
                          scrolling */}
                      <div className="max-w-[68ch]">{group.note}</div>
                    </td>
                  </tr>
                  {group.rows.map((row) => (
                    <Row
                      key={row.id}
                      row={row}
                      tag={group.tag}
                      expanded={expanded.has(row.id)}
                      onToggle={() => toggle(row.id)}
                    />
                  ))}
                </Fragment>
              ))}
            </tbody>
          )}
        </table>
      </div>

      <p
        className="mt-3 max-w-[80ch] text-label text-text-faint"
        data-testid="tools-limits"
      >
        A call is timed from the request to its result, so its time includes any
        wait for your permission: the source does not record that wait on its
        own. A command that ran several tools has one duration, which cannot be
        divided between them. It counts for the tool that usually takes longest
        and is shown as shared on the others.
      </p>
    </section>
  );
}

function SortHeader({
  sort,
  current,
  onSort,
}: {
  sort: { id: ToolSort; label: string };
  current: ToolSort;
  onSort: (sort: ToolSort) => void;
}) {
  const active = current === sort.id;
  return (
    <th
      scope="col"
      aria-sort={active ? 'descending' : 'none'}
      className="pb-1 pl-3 text-right font-normal"
    >
      <button
        type="button"
        onClick={() => onSort(sort.id)}
        title={`Sort by ${SORT_NAME[sort.id]}, largest first`}
        className={`micro-label rounded-control px-1 whitespace-nowrap transition-colors duration-150 ease-out hover:bg-surface-variant/40 hover:text-text active:bg-surface-variant ${active ? 'text-text' : 'text-text-faint'}`}
      >
        {sort.label}
        <span aria-hidden className={active ? '' : 'opacity-0'}>
          {' '}
          ↓
        </span>
      </button>
    </th>
  );
}
