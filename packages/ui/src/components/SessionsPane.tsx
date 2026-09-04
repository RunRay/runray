import type { Run } from '@runray/schema';
import { useEffect, useRef } from 'react';
import { formatDateTime, formatUSD } from '../lib/format';
import { toHash } from '../lib/router';
import { errorPill } from '../lib/triage';
import { useAppStore } from '../store';

/**
 * 280px sessions rail (03-design.md §3). This is the shell's navigation
 * skeleton — the full sortable table with badges lands in task 3.2.
 */
export function SessionsPane({ runs }: { runs: Run[] }) {
  const route = useAppStore((s) => s.route);
  const activeRunId = 'runId' in route ? route.runId : null;

  // A deep link (dashboard evidence, palette, shared hash) can land on a
  // run far down the rail — keep the active row in view so the rail agrees
  // with the header about which session this is.
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (activeRunId === null) return;
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeRunId]);

  return (
    <nav
      aria-label="Sessions"
      className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface"
    >
      <p className="flex items-baseline justify-between border-b border-border px-3 py-2">
        <span className="micro-label text-text-faint">Sessions</span>
        <span className="font-mono text-label text-text-faint">
          {runs.length}
        </span>
      </p>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {runs.map((run) => {
          const active = run.id === activeRunId;
          // the count alone (the rail is narrow); the tone is the triage's —
          // red only when something is for the person or the session never
          // got past it — and the tooltip carries the owner breakdown
          const pill = errorPill(run);
          return (
            <li key={run.id} ref={active ? activeRef : undefined}>
              <a
                href={toHash({ view: 'cost', runId: run.id })}
                aria-current={active ? 'page' : undefined}
                className={`block border-l-2 px-3 py-2 transition-colors duration-150 ease-out ${
                  active
                    ? 'border-brand bg-surface-2'
                    : 'border-transparent hover:bg-surface-2 active:bg-bg'
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-body text-text">
                    {run.title ?? run.project?.name ?? run.source.tool}
                  </span>
                  <span className="shrink-0 font-mono text-label text-text-dim">
                    {formatUSD(run.totals.costUSD.total)}
                  </span>
                </span>
                <span className="mt-0.5 flex items-baseline justify-between gap-2 text-label text-text-faint">
                  <span className="font-mono">
                    {formatDateTime(run.startedAt)}
                  </span>
                  {pill !== null && (
                    <span
                      title={pill.title}
                      className={
                        pill.tone === 'alarm'
                          ? 'text-span-error'
                          : 'text-text-dim'
                      }
                    >
                      {pill.count}
                    </span>
                  )}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
