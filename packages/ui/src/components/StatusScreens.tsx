/** Full-pane states per 03-design.md §5: direct copy, next step, no apology. */

import type { ReactNode } from 'react';
import type { ViewConfigPayload } from '../lib/load';
import { useAppStore } from '../store';

export function LoadingScreen() {
  return (
    <CenteredPane>
      <p className="text-body text-text-dim" role="status">
        Reading traces…
      </p>
    </CenteredPane>
  );
}

export function ErrorScreen({ message }: { message: string }) {
  return (
    <CenteredPane>
      <div className="max-w-md">
        <h1 className="font-display text-title font-semibold">
          Couldn't load trace data.
        </h1>
        <p className="mt-2 rounded-control border border-border bg-surface px-3 py-2 font-mono text-label text-text-dim">
          {message}
        </p>
        <p className="mt-3 text-body text-text-dim">
          Start the viewer with <Command>runray view</Command> and reload this
          page.
        </p>
      </div>
    </CenteredPane>
  );
}

/**
 * §4.7: the roots discovery checked, with the CLI's verdict per root. Pure and
 * exported so the markup is assertable without a DOM — the field it renders
 * (`verdict`) is a cross-package contract with the CLI's `ScannedRoot`.
 * Rendered live-only; `rootsScanned` never enters an export payload.
 */
export function CheckedRoots({
  roots,
}: {
  roots: ViewConfigPayload['rootsScanned'];
}) {
  if (roots === undefined || roots.length === 0) return null;
  return (
    <div className="mt-4 border-t border-border-slate pt-3 text-label text-text-dim">
      <p className="micro-label text-text-faint font-sans">Looked in:</p>
      <div className="mt-1 space-y-1 font-mono">
        {roots.map((r) => (
          <div key={r.path} className="flex justify-between gap-4">
            <span className="truncate">{r.path}</span>
            <span className="text-text-faint">{r.verdict}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyScreen() {
  const data = useAppStore((s) => s.data);
  const rootsScanned = useAppStore((s) => s.viewConfig?.rootsScanned);
  const isLive = data.status === 'ready' && data.live;

  return (
    <CenteredPane>
      <div className="max-w-md">
        <h1 className="font-display text-header font-semibold">
          No agent sessions found.
        </h1>
        <p className="mt-2 text-body text-text-dim">
          Run a coding agent once, then open the viewer:
        </p>
        <ol className="mt-3 space-y-2 text-body text-text-dim">
          <li>
            <Command>claude "explain this repo"</Command>. Any Claude Code
            session writes a trace automatically.
          </li>
          <li>
            <Command>runray view</Command>. Discovers the trace and opens this
            dashboard.
          </li>
        </ol>
        <p className="mt-3 text-label text-text-faint">
          Logs somewhere else? Point at a folder:{' '}
          <Command>runray view &lt;path&gt;</Command>
        </p>
        {isLive && <CheckedRoots roots={rootsScanned} />}
      </div>
    </CenteredPane>
  );
}

/** Runs exist, filters hide them all — invite the obvious next action. */
export function NoMatchScreen({ onClear }: { onClear: () => void }) {
  return (
    <CenteredPane>
      <div className="max-w-md text-center">
        <h1 className="font-display text-title font-semibold">
          No sessions match the filters.
        </h1>
        <button
          type="button"
          onClick={onClear}
          className="mt-3 rounded-control border border-brand/50 bg-brand/10 px-3 py-1 text-label text-brand transition-colors duration-150 ease-out hover:bg-brand/20 active:bg-bg"
        >
          Clear filters
        </button>
      </div>
    </CenteredPane>
  );
}

function CenteredPane({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      {children}
    </div>
  );
}

function Command({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-control border border-border bg-surface px-1.5 py-0.5 font-mono text-label text-text">
      {children}
    </code>
  );
}
