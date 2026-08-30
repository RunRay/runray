import type { SourceTool } from '@runray/schema';
import { useEffect, useMemo, useRef, useState } from 'react';
import { projectKey } from '../lib/filter-runs';
import { useAppStore } from '../store';

/**
 * Global filter dropdowns (add-dashboard-extensions 1.2, 03-design.md §3):
 * project · source · period, narrowing the visible runs client-side. An
 * active filter is its own chip — brass state on the trigger plus a
 * dedicated ✕ — and "Reset" clears everything. Options derive from ALL
 * loaded runs, never the filtered subset (a filter must not hide its own
 * alternatives).
 */

const PERIODS: { key: number | null; label: string }[] = [
  { key: null, label: 'All time' },
  { key: 30, label: 'Last 30 days' },
  { key: 7, label: 'Last 7 days' },
];

export function FilterBar() {
  const data = useAppStore((s) => s.data);
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);
  const clearFilter = useAppStore((s) => s.clearFilter);

  const runs = data.status === 'ready' ? data.traceFile.runs : [];
  const projects = useMemo(
    () => [...new Set(runs.map(projectKey))].sort(),
    [runs],
  );
  const sources = useMemo(
    () => [...new Set(runs.map((r) => r.source.tool))].sort(),
    [runs],
  );

  if (data.status !== 'ready' || runs.length === 0) return null;
  const anyActive =
    filter.project !== null ||
    filter.source !== null ||
    filter.periodDays !== null ||
    filter.model !== null ||
    filter.day !== null ||
    filter.tool !== null;

  return (
    <fieldset
      className="flex min-w-0 items-center gap-1.5"
      aria-label="Run filters"
    >
      <Dropdown
        label="Project"
        options={[
          { key: '', label: 'All' },
          ...projects.map((p) => ({ key: p, label: p })),
        ]}
        activeKey={filter.project ?? ''}
        defaultKey=""
        onSelect={(key) => setFilter({ project: key === '' ? null : key })}
      />
      <Dropdown
        label="Source"
        options={[
          { key: '', label: 'All' },
          ...sources.map((s) => ({ key: s, label: s })),
        ]}
        activeKey={filter.source ?? ''}
        defaultKey=""
        onSelect={(key) =>
          setFilter({ source: key === '' ? null : (key as SourceTool) })
        }
      />
      <Dropdown
        label="Period"
        options={PERIODS.map((p) => ({
          key: p.key === null ? '' : String(p.key),
          label: p.label,
        }))}
        activeKey={filter.periodDays === null ? '' : String(filter.periodDays)}
        defaultKey=""
        onSelect={(key) =>
          setFilter({ periodDays: key === '' ? null : Number(key) })
        }
      />
      {/* Drill-down dimensions have no dropdown — they surface as chips. */}
      {filter.model !== null && (
        <FilterChip
          label="Model"
          value={filter.model}
          onClear={() => setFilter({ model: null })}
        />
      )}
      {filter.day !== null && (
        <FilterChip
          label="Day"
          value={filter.day}
          onClear={() => setFilter({ day: null })}
        />
      )}
      {filter.tool !== null && (
        <FilterChip
          label="Tool"
          value={filter.tool}
          onClear={() => setFilter({ tool: null })}
        />
      )}
      {anyActive && (
        <button
          type="button"
          onClick={clearFilter}
          className="rounded-control px-2 py-1 text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text active:bg-bg"
        >
          Reset
        </button>
      )}
    </fieldset>
  );
}

/**
 * A standalone active-filter chip for a drill-down dimension (model, day)
 * that has no dropdown. Brass active state + a dedicated ✕, matching the
 * active-dropdown chip look so all active filters read as one family.
 */
function FilterChip({
  label,
  value,
  onClear,
}: {
  label: string;
  value: string;
  onClear: () => void;
}) {
  return (
    <span className="flex items-stretch">
      <span className="flex items-center gap-1.5 rounded-l-[6px] border border-brand/50 bg-brand/10 py-1 pr-1.5 pl-2.5 text-label text-brand">
        {label}
        <span className="font-medium">{value}</span>
      </span>
      <button
        type="button"
        aria-label={`Clear ${label.toLowerCase()} filter`}
        onClick={onClear}
        className="rounded-r-[6px] border border-l-0 border-brand/50 bg-brand/10 px-1.5 text-label text-brand transition-colors duration-150 ease-out hover:bg-brand/20 active:bg-bg"
      >
        ✕
      </button>
    </span>
  );
}

interface Option {
  key: string;
  label: string;
}

function Dropdown({
  label,
  options,
  activeKey,
  defaultKey,
  onSelect,
}: {
  label: string;
  options: Option[];
  activeKey: string;
  defaultKey: string;
  onSelect: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const active = activeKey !== defaultKey;
  const current = options.find((o) => o.key === activeKey) ?? options[0];

  // Click outside closes; the listener exists only while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || wrapRef.current?.contains(e.target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Opening moves focus to the selected option (roving tabindex pattern).
  useEffect(() => {
    if (!open) return;
    const selected = listRef.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    );
    (
      selected ?? listRef.current?.querySelector<HTMLElement>('[role="option"]')
    )?.focus();
  }, [open]);

  const focusSibling = (from: HTMLElement, delta: 1 | -1) => {
    const items = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ??
        []),
    ];
    const at = items.indexOf(from);
    items[Math.min(Math.max(at + delta, 0), items.length - 1)]?.focus();
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  return (
    <div ref={wrapRef} className="relative flex items-stretch">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex items-center gap-1.5 border py-1 pl-2.5 text-label transition-colors duration-150 ease-out active:bg-bg ${
          active
            ? 'rounded-l-[6px] border-brand/50 bg-brand/10 pr-1.5 text-brand hover:bg-brand/15'
            : 'rounded-control border-border bg-surface pr-2 text-text-dim hover:border-border-strong hover:bg-surface-2 hover:text-text'
        }`}
      >
        {label}
        <span className={`font-medium ${active ? '' : 'text-text'}`}>
          {current?.label}
        </span>
        <span aria-hidden className="text-[9px] text-text-faint">
          ▾
        </span>
      </button>
      {active && (
        <button
          type="button"
          aria-label={`Clear ${label.toLowerCase()} filter`}
          onClick={() => onSelect(defaultKey)}
          className="rounded-r-[6px] border border-l-0 border-brand/50 bg-brand/10 px-1.5 text-label text-brand transition-colors duration-150 ease-out hover:bg-brand/20 active:bg-bg"
        >
          ✕
        </button>
      )}
      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          className="absolute top-full left-0 z-50 mt-1 max-h-72 min-w-full overflow-y-auto rounded-control bg-surface-2 py-1 whitespace-nowrap shadow-popover"
        >
          {options.map((option) => {
            const selected = option.key === activeKey;
            return (
              <button
                key={option.key === '' ? '·all' : option.key}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                onClick={() => {
                  onSelect(option.key);
                  close(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    focusSibling(
                      e.currentTarget,
                      e.key === 'ArrowDown' ? 1 : -1,
                    );
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    close(true);
                  } else if (e.key === 'Tab') {
                    // Hand focus back to the trigger before closing so native
                    // Tab moves from a mounted element. Closing alone would
                    // unmount this focused option (React 18 flushes the
                    // discrete update before Tab's default), orphaning focus
                    // on <body> and restarting navigation at the page top.
                    // No preventDefault: native Tab then flows to the adjacent
                    // control (forward and Shift+Tab backward both correct).
                    close(true);
                  }
                }}
                className={`flex w-full items-center justify-between gap-3 px-2.5 py-1 text-left text-label transition-colors duration-150 ease-out hover:bg-surface active:bg-bg ${
                  selected ? 'text-brand' : 'text-text'
                }`}
              >
                {option.label}
                {selected && (
                  <span aria-hidden className="font-mono">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
