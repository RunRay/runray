import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { exportCommand, type SanitizeProfile } from '../lib/export-command';
import type { RunFilter } from '../lib/filter-runs';
import type { Route } from '../lib/router';
import { useAppStore, useVisibleRuns } from '../store';

const PROFILES: Array<{
  id: SanitizeProfile;
  label: string;
  badge?: string;
  description: string;
  caution?: string;
}> = [
  {
    id: 'sanitized',
    label: 'Sanitized',
    badge: 'Recommended',
    description:
      'Redacts prompt and output text, and scrubs project paths, branch names, and transcript filenames into pseudonyms.',
  },
  {
    id: 'metadata-only',
    label: 'Metadata only',
    description:
      'Redacts text, scrubs paths, and prunes leaf spans (llm/tool calls). Preserves session containers, run totals, and insight findings.',
  },
  {
    id: 'full',
    label: 'Full trace',
    description: 'Full fidelity trace with prompt text and real paths.',
    caution:
      'Caution: Contains unredacted prompt text and local filesystem paths.',
  },
];

export interface ExportDialogProps {
  onClose: () => void;
  route?: Route;
  filter?: RunFilter;
  allRuns?: readonly import('@runray/schema').Run[];
  visibleRuns?: readonly import('@runray/schema').Run[];
}

export function ExportDialog({
  onClose,
  route: propRoute,
  filter: propFilter,
  allRuns: propAllRuns,
  visibleRuns: propVisibleRuns,
}: ExportDialogProps) {
  const [profile, setProfile] = useState<SanitizeProfile>('sanitized');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const storeRoute = useAppStore((s) => s.route);
  const storeFilter = useAppStore((s) => s.filter);
  const data = useAppStore((s) => s.data);
  const storeAllRuns = data.status === 'ready' ? data.traceFile.runs : [];
  const storeVisibleRuns = useVisibleRuns();

  const route = propRoute ?? storeRoute;
  const filter = propFilter ?? storeFilter;
  const allRuns = propAllRuns ?? storeAllRuns;
  const visibleRuns = propVisibleRuns ?? storeVisibleRuns;

  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Capture triggering active element on mount so focus can be returned on close
  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      triggerRef.current?.focus();
    };
  }, []);

  // Trap focus inside dialog & handle Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const commandInfo = useMemo(() => {
    return exportCommand(
      {
        route,
        filter,
        allRuns,
        visibleRuns,
      },
      profile,
    );
  }, [route, filter, allRuns, visibleRuns, profile]);

  const handleCopy = async () => {
    setCopyError(false);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(commandInfo.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      data-testid="export-dialog-backdrop"
    >
      <button
        type="button"
        aria-label="Close export dialog"
        onClick={onClose}
        className="absolute inset-0 bg-bg/70 backdrop-blur-xs"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="export-dialog"
        className="relative max-h-[90vh] w-full max-w-[580px] overflow-y-auto rounded-panel border border-border bg-surface-2 p-5 shadow-popover text-text font-sans"
      >
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div>
            <h2
              id={titleId}
              className="font-display text-title font-semibold text-text"
            >
              Export report
            </h2>
            <p className="mt-0.5 text-label text-text-dim">
              Single-file offline HTML reports generated locally via the CLI.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close export dialog"
            className="flex h-7 w-7 items-center justify-center rounded-control text-text-faint transition-colors duration-150 ease-out hover:bg-surface hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass active:bg-bg"
          >
            ✕
          </button>
        </div>

        {/* Profile choice */}
        <div className="mt-4 flex flex-col gap-2.5">
          <p className="micro-label text-text-faint">Sanitization profile</p>
          <div
            role="radiogroup"
            aria-label="Sanitization profile"
            className="flex flex-col gap-2"
          >
            {PROFILES.map((p) => {
              const isSelected = profile === p.id;
              return (
                <label
                  key={p.id}
                  data-testid={`profile-option-${p.id}`}
                  className={`flex cursor-pointer flex-col gap-1 rounded-control border p-3 text-left transition-colors duration-150 ease-out focus-within:ring-1 focus-within:ring-brass ${
                    isSelected
                      ? 'border-brass bg-surface text-text ring-1 ring-brass/40'
                      : 'border-border bg-surface/50 text-text-dim hover:border-border-strong hover:bg-surface hover:text-text active:bg-bg'
                  }`}
                >
                  <input
                    type="radio"
                    name="sanitize-profile"
                    value={p.id}
                    checked={isSelected}
                    onChange={() => setProfile(p.id)}
                    className="sr-only"
                  />
                  <div className="flex items-center justify-between">
                    <span className="font-sans text-body font-medium text-text flex items-center gap-2">
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full border ${
                          isSelected
                            ? 'border-brass bg-brass ring-2 ring-surface'
                            : 'border-outline-variant bg-transparent'
                        }`}
                        aria-hidden
                      />
                      {p.label}
                    </span>
                    {p.badge && (
                      <span className="rounded bg-brand/20 px-1.5 py-0.5 font-mono text-[10px] font-medium text-brand-bright uppercase tracking-wider">
                        {p.badge}
                      </span>
                    )}
                  </div>
                  <p className="pl-5 text-label text-text-dim">
                    {p.description}
                  </p>
                  {p.caution && isSelected && (
                    <div
                      data-testid="full-trace-caution"
                      className="mt-1 ml-5 rounded border border-heat-2/40 bg-heat-2/10 px-2 py-1 text-label font-medium text-heat-2"
                    >
                      {p.caution}
                    </div>
                  )}
                </label>
              );
            })}
          </div>
        </div>

        {/* Command section */}
        <div className="mt-5 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="micro-label text-text-faint">CLI command</p>
            <span className="text-[11px] text-text-faint">
              Run in your terminal to export
            </span>
          </div>

          <div className="relative rounded-control border border-border bg-bg p-3">
            <code
              data-testid="rendered-export-command"
              className="block font-mono text-label text-text break-all select-all leading-relaxed"
            >
              {commandInfo.command}
            </code>
          </div>

          <div className="flex items-center justify-between gap-2 mt-1">
            <p
              data-testid="export-scope-sentence"
              className="text-label text-text-dim flex-1"
            >
              {commandInfo.scopeSentence}
            </p>
            <button
              type="button"
              onClick={handleCopy}
              data-testid="copy-export-command-button"
              className={`inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 font-sans text-label font-medium transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass ${
                copied
                  ? 'bg-success-emerald/20 text-success-emerald border border-success-emerald/40'
                  : 'bg-brand text-white hover:bg-brand-bright active:bg-brand/90'
              }`}
            >
              {copied ? (
                <>
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Copied!
                </>
              ) : (
                <>
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  Copy command
                </>
              )}
            </button>
          </div>

          {copyError && (
            <p
              data-testid="copy-error-hint"
              className="text-label text-heat-2 mt-1"
            >
              Clipboard access denied. Select and copy the command manually
              below.
            </p>
          )}
        </div>

        {/* Footer note */}
        <div className="mt-4 border-t border-border pt-3 text-[11px] text-text-faint">
          The dashboard creates no files and makes no network requests. Report
          generation happens only inside the CLI.
        </div>
      </div>
    </div>
  );
}
