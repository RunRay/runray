import type { Run } from '@runray/schema';
import {
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { projectKey, type RunFilter } from '../lib/filter-runs';
import { formatUSD } from '../lib/format';
import { fuzzyScore } from '../lib/fuzzy';
import { DASHBOARD_ROUTE, type Route, SESSIONS_ROUTE } from '../lib/router';
import type { Theme } from '../lib/theme';
import { useAppStore } from '../store';

/**
 * Command palette (add-dashboard-extensions 3.1, D7): ⌘K / Ctrl-K — internal,
 * no dependency. Fuzzy run search (title · project · source), view switching,
 * theme toggle, and filter actions, all over the existing store. Keyboard-first
 * via the WAI-ARIA combobox + listbox pattern: focus stays in the input and
 * `aria-activedescendant` tracks the highlight, so arrows / Enter / Esc drive
 * everything without moving DOM focus around the list.
 */

const NO_RUNS: Run[] = [];

type Group = 'Go to' | 'Switch view' | 'Runs' | 'Compare' | 'Filter' | 'Theme';

interface Command {
  /** Stable across renders (React key + activedescendant map). */
  id: string;
  group: Group;
  label: string;
  /** Right-aligned mono context (project · source · cost, or a keybinding). */
  hint?: string;
  /** Extra searchable text never shown (ids, synonyms). */
  keywords?: string;
  perform(): void;
}

const PERIODS: { days: number | null; label: string }[] = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: null, label: 'All time' },
];

/**
 * The whole command set, in group order (Go to · Switch view · Runs · Filter ·
 * Theme). Derived from the loaded runs + current route/filter — no new data.
 */
function buildCommands(
  runs: readonly Run[],
  activeRunId: string | null,
  filter: RunFilter,
  setFilter: (patch: Partial<RunFilter>) => void,
  clearFilter: () => void,
  theme: Theme,
  toggleTheme: () => void,
  isLive?: boolean,
  onClose?: () => void,
): Command[] {
  const cmds: Command[] = [];
  const nav = (route: Route) => () => {
    useAppStore.getState().navigateTo(route);
  };

  cmds.push({
    id: 'go:dashboard',
    group: 'Go to',
    label: 'Dashboard',
    keywords: 'home dashboard savings overview start',
    perform: nav(DASHBOARD_ROUTE),
  });
  cmds.push({
    id: 'go:sessions',
    group: 'Go to',
    label: 'Sessions list',
    keywords: 'sessions list all runs',
    perform: nav(SESSIONS_ROUTE),
  });

  if (isLive) {
    cmds.push({
      id: 'action:export',
      group: 'Go to',
      label: 'Export report…',
      keywords: 'export report share anonymize sanitize singlefile',
      perform: () => {
        onClose?.();
        useAppStore.getState().toggleExport(true);
      },
    });
  }

  if (activeRunId !== null) {
    cmds.push({
      id: 'view:timeline',
      group: 'Switch view',
      label: 'Timeline view',
      hint: 'g t',
      keywords: 'timeline waterfall spans current run',
      perform: nav({ view: 'timeline', runId: activeRunId }),
    });
    cmds.push({
      id: 'view:cost',
      group: 'Switch view',
      label: 'Cost view',
      hint: 'g c',
      keywords: 'cost spend money treemap current run',
      perform: nav({ view: 'cost', runId: activeRunId }),
    });
    cmds.push({
      id: 'view:time',
      group: 'Switch view',
      label: 'Time view',
      keywords: 'time wall clock idle model wait breakdown current run',
      perform: nav({ view: 'time', runId: activeRunId }),
    });
  }

  for (const run of runs) {
    const project = projectKey(run);
    const hint = [
      project === '—' ? null : project,
      run.source.tool,
      formatUSD(run.totals.costUSD.total),
    ]
      .filter(Boolean)
      .join(' · ');
    cmds.push({
      id: `run:${run.id}`,
      group: 'Runs',
      label: run.title ?? `${run.source.tool} session`,
      hint,
      keywords: `${run.id} ${project} ${run.source.tool}`,
      perform: nav({ view: 'cost', runId: run.id }),
    });
  }

  // Compare (run-diff 3.4): with an active run, pick the second directly;
  // otherwise anchor the pick and finish in the sessions table.
  for (const run of runs) {
    const label = run.title ?? `${run.source.tool} session`;
    if (activeRunId !== null) {
      if (run.id === activeRunId) continue;
      cmds.push({
        id: `compare:${run.id}`,
        group: 'Compare',
        label: `Compare active run with: ${label}`,
        hint: formatUSD(run.totals.costUSD.total),
        keywords: `diff compare versus vs ${run.id}`,
        perform: nav({ view: 'diff', runA: activeRunId, runB: run.id }),
      });
    } else {
      cmds.push({
        id: `compare:${run.id}`,
        group: 'Compare',
        label: `Compare from: ${label}`,
        hint: formatUSD(run.totals.costUSD.total),
        keywords: `diff compare versus vs ${run.id}`,
        perform: () => {
          useAppStore.getState().setDiffAnchor(run.id);
          useAppStore.getState().navigateTo(SESSIONS_ROUTE);
        },
      });
    }
  }

  if (runs.length > 0) {
    const anyActive =
      filter.project !== null ||
      filter.source !== null ||
      filter.periodDays !== null ||
      filter.model !== null ||
      filter.day !== null ||
      filter.tool !== null;
    if (anyActive) {
      cmds.push({
        id: 'filter:clear',
        group: 'Filter',
        label: 'Clear all filters',
        keywords: 'reset clear remove filters',
        perform: clearFilter,
      });
    }
    for (const project of [...new Set(runs.map(projectKey))].sort()) {
      if (filter.project === project) continue;
      cmds.push({
        id: `filter:project:${project}`,
        group: 'Filter',
        label: `Project: ${project}`,
        keywords: `filter project ${project}`,
        perform: () => setFilter({ project }),
      });
    }
    for (const source of [...new Set(runs.map((r) => r.source.tool))].sort()) {
      if (filter.source === source) continue;
      cmds.push({
        id: `filter:source:${source}`,
        group: 'Filter',
        label: `Source: ${source}`,
        keywords: `filter source tool ${source}`,
        perform: () => setFilter({ source }),
      });
    }
    for (const period of PERIODS) {
      if (filter.periodDays === period.days) continue;
      cmds.push({
        id: `filter:period:${period.days ?? 'all'}`,
        group: 'Filter',
        label: `Period: ${period.label}`,
        keywords: `filter period time ${period.label}`,
        perform: () => setFilter({ periodDays: period.days }),
      });
    }
  }

  const target = theme === 'ink' ? 'paper' : 'ink';
  cmds.push({
    id: 'theme:toggle',
    group: 'Theme',
    label: `Switch to ${target} theme`,
    keywords: `theme appearance ${target} ink paper dark light`,
    perform: toggleTheme,
  });

  return cmds;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const data = useAppStore((s) => s.data);
  const route = useAppStore((s) => s.route);
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);
  const clearFilter = useAppStore((s) => s.clearFilter);
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const runs = data.status === 'ready' ? data.traceFile.runs : NO_RUNS;
  const activeRunId = 'runId' in route ? route.runId : null;

  const commands = useMemo(
    () =>
      buildCommands(
        runs,
        activeRunId,
        filter,
        setFilter,
        clearFilter,
        theme,
        toggleTheme,
        data.status === 'ready' && data.live,
        onClose,
      ),
    [
      runs,
      activeRunId,
      filter,
      setFilter,
      clearFilter,
      theme,
      toggleTheme,
      data,
      onClose,
    ],
  );

  // Empty query → the full set in group order; a query → a flat, best-first
  // fuzzy ranking (ties break by build order, so it never reshuffles).
  const grouped = query.trim() === '';
  const results = useMemo(() => {
    if (grouped) return commands;
    const q = query.trim();
    return commands
      .map((c, i) => ({
        c,
        i,
        score: fuzzyScore(q, `${c.label} ${c.hint ?? ''} ${c.keywords ?? ''}`),
      }))
      .filter((x): x is { c: Command; i: number; score: number } => {
        return x.score !== null;
      })
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.c);
  }, [commands, query, grouped]);

  // Clamp both ends: never below 0 (so a stale index can't dangle
  // aria-activedescendant at palette-option--1) and never past the last row.
  const activeIndex =
    results.length === 0
      ? 0
      : Math.max(0, Math.min(active, results.length - 1));
  const activeId =
    results.length > 0 ? `palette-option-${activeIndex}` : undefined;

  // Reset the highlight to the top whenever the query changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on query text, not the derived results identity
  useEffect(() => setActive(0), [query]);

  // Auto-focus the input on open; restore focus to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Keep the highlighted row in view as arrows walk past the fold.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll follows the active index and the list (query) it indexes into
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, query]);

  const move = (delta: 1 | -1) =>
    setActive((i) => {
      const n = results.length;
      if (n === 0) return 0;
      return (Math.min(i, n - 1) + delta + n) % n;
    });

  const run = (cmd: Command | undefined) => {
    if (cmd === undefined) return;
    onClose();
    cmd.perform();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      // Tab is trapped and repurposed to navigate — focus never leaves the
      // input, so the modal is a self-contained focus context.
      case 'ArrowDown':
      case 'Tab':
        if (e.key === 'Tab' && e.shiftKey) {
          e.preventDefault();
          move(-1);
        } else {
          e.preventDefault();
          move(1);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      // Home/End are deliberately NOT trapped: focus lives in a real text
      // field, so they stay caret-to-start / caret-to-end for editing the
      // query (the editable-combobox convention). List jumps live on arrows.
      case 'Enter':
        e.preventDefault();
        run(results[activeIndex]);
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[14vh]">
      {/* backdrop is a real button: click closes; keyboard close is Esc */}
      <button
        type="button"
        aria-label="Close command palette"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-bg/70"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-[560px] max-w-full overflow-hidden rounded-panel border border-border bg-surface-2 shadow-popover [animation:rise_140ms_cubic-bezier(0,0,0.2,1)]"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls="palette-listbox"
            aria-autocomplete="list"
            aria-label="Search commands and runs"
            aria-activedescendant={activeId}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search runs, views, filters…"
            className="h-12 flex-1 bg-transparent text-detail text-text placeholder:text-text-faint focus:outline-none"
          />
          <kbd className="micro-label shrink-0 rounded-[4px] border border-border px-1.5 py-0.5 text-text-faint">
            esc
          </kbd>
        </div>

        {/* Announce live filtering to screen readers — the visible "N results"
            count and the empty state are otherwise silent (APG completion). */}
        <div role="status" aria-live="polite" className="sr-only">
          {results.length === 0
            ? `No commands match ${query.trim()}`
            : `${results.length} ${results.length === 1 ? 'command' : 'commands'} available`}
        </div>

        <div
          ref={listRef}
          role="listbox"
          id="palette-listbox"
          aria-label="Commands"
          className="max-h-[46vh] overflow-y-auto py-1"
        >
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-label text-text-dim">
              No commands match{' '}
              <span className="font-mono text-text">“{query.trim()}”</span>.
            </p>
          ) : (
            results.map((cmd, index) => {
              const isActive = index === activeIndex;
              const header =
                grouped &&
                (index === 0 || results[index - 1]?.group !== cmd.group);
              return (
                <Fragment key={cmd.id}>
                  {header && (
                    <div
                      aria-hidden
                      className="micro-label px-4 pt-2.5 pb-1 text-text-faint"
                    >
                      {cmd.group}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    id={`palette-option-${index}`}
                    tabIndex={-1}
                    aria-selected={isActive}
                    data-active={isActive}
                    onMouseMove={() => setActive(index)}
                    onClick={() => run(cmd)}
                    className={`flex w-full items-center justify-between gap-3 border-l-2 py-2 pr-4 pl-3.5 text-left text-body transition-colors duration-150 ease-out ${
                      isActive
                        ? 'border-brand bg-brand/10 text-text'
                        : 'border-transparent text-text-dim hover:bg-surface hover:text-text'
                    }`}
                  >
                    <span className="truncate">{cmd.label}</span>
                    {cmd.hint !== undefined && cmd.hint !== '' && (
                      <span className="shrink-0 font-mono text-label text-text-faint">
                        {cmd.hint}
                      </span>
                    )}
                  </button>
                </Fragment>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-text-faint">
          <Hint keys="↑ ↓" label="navigate" />
          <Hint keys="↵" label="open" />
          <Hint keys="esc" label="close" />
          <span className="ml-auto font-mono text-label">
            {results.length} {results.length === 1 ? 'result' : 'results'}
          </span>
        </div>
      </div>
    </div>
  );
}

function Hint({ keys, label }: { keys: string; label: string }): ReactNode {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="micro-label rounded-[4px] border border-border px-1.5 py-0.5 text-text-dim">
        {keys}
      </kbd>
      <span className="text-label">{label}</span>
    </span>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden
      className="shrink-0 text-text-faint"
    >
      <title>Search</title>
      <circle
        cx="7"
        cy="7"
        r="4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <line
        x1="10.5"
        y1="10.5"
        x2="14"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
