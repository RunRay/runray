import { tourAttr } from '../lib/tour-attr';
import { useAppStore, useVisibleRuns } from '../store';
import { LimitModeToggle } from './LimitMode';

/** Local wall-clock stamp of the served snapshot (A8). */
function asOf(generatedAt: string): string {
  const d = new Date(generatedAt);
  if (Number.isNaN(d.getTime())) return generatedAt;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

import { FilterBar } from './FilterBar';

export function TopBar() {
  const data = useAppStore((s) => s.data);
  const streamConnected = useAppStore((s) => s.streamConnected);
  const visible = useVisibleRuns();
  const helpOpen = useAppStore((s) => s.ui.helpOpen);
  const toggleHelp = useAppStore((s) => s.toggleHelp);

  return (
    <header className="bg-surface text-text font-sans sticky top-0 w-full z-40 border-b border-border flex justify-between items-center h-16 px-6 py-4 transition-all duration-200">
      <div className="flex items-center gap-6">
        <FilterBar />
      </div>
      <div className="flex items-center gap-4 text-on-surface-variant">
        {data.status === 'ready' && (
          <p className="text-[12px] text-outline flex items-center gap-1.5 font-data-mono">
            {data.live ? (
              <>
                {/* pulse only when the event stream is actually connected
                    (i.e. --watch) — a plain view is a static snapshot */}
                {streamConnected && (
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full bg-success-emerald animate-pulse"
                    aria-hidden
                  />
                )}
                127.0.0.1 · local only
                {streamConnected && ' · live'}
              </>
            ) : (
              'exported file'
            )}
            <span className="mx-1 text-outline-variant" aria-hidden>
              │
            </span>
            {/* freshness (A8): snapshot time, re-rendered on SSE refetch */}
            <span title={data.traceFile.generatedAt}>
              as of {asOf(data.traceFile.generatedAt)}
            </span>
            <span className="mx-1 text-outline-variant" aria-hidden>
              │
            </span>
            <span>
              {visible.length === data.traceFile.runs.length
                ? `${data.traceFile.runs.length} runs`
                : `${visible.length} of ${data.traceFile.runs.length} runs`}
            </span>
          </p>
        )}
        <LimitModeToggle />
        {/* Bell button removed */}
        <button
          type="button"
          {...tourAttr('help-button')}
          onClick={() => toggleHelp()}
          aria-label="Keyboard shortcuts and help"
          aria-pressed={helpOpen}
          className="flex items-center justify-center rounded-control p-1 transition-colors duration-150 ease-out hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass active:text-text-faint"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </button>
      </div>
    </header>
  );
}
