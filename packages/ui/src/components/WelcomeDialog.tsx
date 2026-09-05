import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';

/**
 * Welcome dialog (§4.1 / §4.1b): native <dialog> with focus trap,
 * Esc as secondary action, run count from traceFile, privacy line as its own
 * quieter block. Rendered only after the state fetch resolves.
 */
export function WelcomeDialog() {
  const data = useAppStore((s) => s.data);
  const viewConfig = useAppStore((s) => s.viewConfig);
  const dismissWelcome = useAppStore((s) => s.dismissWelcome);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const primaryBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    primaryBtnRef.current?.focus();
  }, []);

  const count = data.status === 'ready' ? data.traceFile.runs.length : 0;
  const isSample = viewConfig?.isSample === true;

  const title = isSample
    ? 'A sample session, scrubbed and bundled.'
    : count === 1
      ? 'One session was already on this machine.'
      : `${count} sessions were already on this machine.`;

  const body = isSample
    ? 'Real structure, no real prompts or paths. Everything below works the same on your own sessions when you run "runray view".'
    : 'RunRay found these in logs Claude Code and OpenCode already wrote. No collector or account required.';

  const privacy =
    'Everything stays local. No network calls or telemetry; this dashboard runs on 127.0.0.1 for this browser only.';

  // Secondary / Esc / backdrop = "I'll explore myself": the dashboard tour is
  // declined, not merely deferred (plan §7.2).
  const handleDismiss = () => {
    dismissWelcome(false);
  };

  const handleStart = () => {
    dismissWelcome(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDismiss();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-bg/70 backdrop-blur-xs"
        onClick={handleDismiss}
        aria-hidden="true"
      />
      <dialog
        ref={dialogRef}
        open
        aria-label="Welcome to RunRay"
        onKeyDown={handleKeyDown}
        className="relative m-0 max-h-full w-[480px] overflow-y-auto rounded-panel border border-border-slate bg-surface-container-low p-6 shadow-popover text-text backdrop:bg-bg/70"
      >
        <h2 className="font-display text-title font-semibold leading-snug text-text">
          {title}
        </h2>
        <p className="mt-3 text-body text-text-dim leading-normal">{body}</p>

        <div className="mt-4 rounded border border-border-slate bg-surface-2 p-3 text-label text-text-faint leading-normal">
          {privacy}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={handleDismiss}
            className="rounded-control border border-border-slate bg-surface px-4 py-2 text-label font-medium text-text-dim transition-colors duration-150 ease-out hover:bg-surface-variant hover:text-text active:bg-bg-deep-gray focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass"
          >
            I'll explore myself
          </button>
          <button
            ref={primaryBtnRef}
            type="button"
            onClick={handleStart}
            className="rounded-control bg-brand px-4 py-2 text-label font-medium text-white transition-colors duration-150 ease-out hover:bg-brand-secondary active:bg-brand-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass"
          >
            Show me around
          </button>
        </div>
      </dialog>
    </div>
  );
}
