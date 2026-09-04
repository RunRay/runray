import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { formatClock, formatUSD } from '../lib/format';
import { buildCostSeries, cumulativeCostAt } from '../lib/spine';
import { computeTimeRange } from '../lib/waterfall';
import { selectActiveRun, useAppStore } from '../store';
import { SeverityPill } from './SeverityPill';

/**
 * `?` help sheet (03-design.md §3, §6): the keyboard map, the findings
 * legend (class + severity tiers — the one place in the UI that states the
 * default thresholds), plus the Spend Spine's accessible fallback —
 * cumulative cost as a plain data table.
 */

/** Severity tiers as shipped (DEFAULT_THRESHOLDS.severity in core). */
const SEVERITY_LEGEND: [
  severity: 'critical' | 'warning' | 'info',
  meaning: string,
][] = [
  ['critical', 'at least 10% of this run’s cost and at least $1'],
  ['warning', 'at least 2% of this run’s cost and at least $0.05'],
  ['info', 'smaller than that, or no dollar estimate'],
];

const KEYMAP: [keys: string, action: string][] = [
  ['⌘K / Ctrl K', 'open the command palette'],
  ['j / k', 'next / previous span row'],
  ['Enter', 'inspect the focused row'],
  ['← / →', 'collapse / expand the selected subtree'],
  ['g t / g c', 'switch to Timeline / Cost view'],
  ['/', 'filter spans by name'],
  ['?', 'toggle this help sheet'],
  ['[', 'collapse / expand the navigation rail'],
  ['Esc', 'close / clear'],
];

export function HelpSheet({ onClose }: { onClose: () => void }) {
  const run = useAppStore(selectActiveRun);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);

  const spineTable = useMemo(() => {
    if (run === undefined) return null;
    const range = computeTimeRange(run.spans);
    const series = buildCostSeries(run.spans);
    if (series.length === 0) return null;
    const steps = 8;
    return Array.from({ length: steps + 1 }, (_, i) => {
      const t = range.start + ((range.end - range.start) * i) / steps;
      return {
        offset: formatClock(t - range.start),
        cost: cumulativeCostAt(series, t),
      };
    });
  }, [run]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      {/* backdrop is a real button: click AND keyboard closable */}
      <button
        type="button"
        aria-label="Close help"
        onClick={onClose}
        className="absolute inset-0 bg-bg/70"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts, findings legend and chart data"
        className="relative max-h-full w-[480px] overflow-y-auto rounded-panel border border-border bg-surface-2 p-4 shadow-popover"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-title font-semibold text-text">
            Help
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close help"
            className="flex h-6 w-6 items-center justify-center rounded-control text-text-faint transition-colors duration-150 ease-out hover:bg-surface hover:text-text active:bg-bg"
          >
            ✕
          </button>
        </div>

        <h3 className="micro-label mt-3 mb-2 text-text-faint">Keyboard</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {KEYMAP.map(([keys, action]) => (
            <div key={keys} className="contents">
              <dt>
                <Kbd>{keys}</Kbd>
              </dt>
              <dd className="self-center text-label text-text-dim">{action}</dd>
            </div>
          ))}
        </dl>

        <h3 className="micro-label mt-4 mb-2 text-text-faint">Findings</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-label">
          <dt className="self-center text-text">burned</dt>
          <dd className="text-text-dim">
            spend that bought nothing — retries, cache re-writes, duplicate
            reads, dead ends. Adds up to the run’s wasted figure.
          </dd>
          <dt className="self-center text-text">opportunity</dt>
          <dd className="text-text-dim">
            spend that could have been cheaper — heavy fixed context, wrong
            model tier, cold cache. Never counted as wasted.
          </dd>
          {SEVERITY_LEGEND.map(([severity, meaning]) => (
            <div key={severity} className="contents">
              <dt className="self-center">
                <SeverityPill severity={severity} />
              </dt>
              <dd className="self-center text-text-dim">{meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-label leading-[1.45] text-text-faint">
          Severity is graded per run, not per rule: the same $0.60 retry loop is
          a warning in a $0.65 session and info in a $600 one. Defaults shown;
          tune them under{' '}
          <span className="font-mono">insights.thresholds.severity</span> in
          runray.config.json.
        </p>

        {spineTable !== null && (
          <>
            <h3 className="micro-label mt-4 mb-2 text-text-faint">
              Burn line as data
            </h3>
            <table className="w-full text-label">
              <thead>
                <tr className="border-b border-border text-left text-text-faint">
                  <th scope="col" className="py-1 font-normal">
                    time into session
                  </th>
                  <th scope="col" className="py-1 text-right font-normal">
                    cumulative cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {spineTable.map((row) => (
                  <tr key={row.offset} className="border-b border-border/40">
                    <td className="py-1 font-mono text-text-dim">
                      {row.offset}
                    </td>
                    <td className="py-1 text-right font-mono text-text">
                      {formatUSD(row.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-control border border-border bg-surface px-1.5 py-0.5 font-mono text-label text-text">
      {children}
    </kbd>
  );
}
