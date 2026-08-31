import type { TraceFile } from '@runray/schema';
import type { SanitizationManifest } from '../lib/load';
import { useAppStore } from '../store';

/**
 * Helper to check whether any span in a TraceFile contains unredacted prompt or output text.
 * When core parses with `redact: true`, `promptPreview` and `outputPreview` are explicitly set to `null`.
 */
export function hasUnredactedPrompts(traceFile: TraceFile): boolean {
  if (!traceFile?.runs) return false;
  for (const run of traceFile.runs) {
    if (!run.spans) continue;
    for (const span of run.spans) {
      if (
        typeof span.content?.promptPreview === 'string' &&
        span.content.promptPreview.length > 0
      ) {
        return true;
      }
      if (
        typeof span.content?.outputPreview === 'string' &&
        span.content.outputPreview.length > 0
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Export provenance strip (Task 5.1, visualizer "Export provenance strip").
 * Rendered only when `live === false`.
 * Reads the manifest and names the applied profile plus the three facts independently,
 * while keeping its own span inspection as a cross-check — a manifest claiming
 * redaction over present prompt text renders the warning treatment (D6).
 * Contains no filesystem paths, no dismiss control, and no interactive state.
 */
export function ProvenanceStrip({
  traceFile,
  manifest: explicitManifest,
}: {
  traceFile: TraceFile;
  manifest?: SanitizationManifest;
}) {
  const storeManifest = useAppStore((s) => s.viewConfig?.manifest);
  const manifest = explicitManifest ?? storeManifest;

  const hasPrompts = hasUnredactedPrompts(traceFile);
  // Cross-check (D6): if prompt text is present in spans, redaction is false even if manifest claimed otherwise
  const textRedacted = manifest
    ? manifest.textRedacted && !hasPrompts
    : !hasPrompts;
  const pathsScrubbed = manifest ? manifest.pathsScrubbed : false;
  const spansPruned = manifest ? manifest.spansPruned : false;
  const profile =
    manifest?.profile ??
    (textRedacted ? (pathsScrubbed ? 'sanitized' : 'full') : 'full');

  const isWarning = hasPrompts || !textRedacted;
  const count = traceFile.runs?.length ?? 0;
  const sessionText = count === 1 ? '1 session' : `${count} sessions`;
  const dateStr = traceFile.generatedAt
    ? traceFile.generatedAt.slice(0, 10)
    : '';
  const versionStr = traceFile.generator?.version ?? '0.1.0';

  return (
    <div
      data-testid="provenance-strip"
      className={`border-b px-4 py-2.5 text-body transition-colors duration-150 ${
        isWarning
          ? 'border-heat-2/30 bg-heat-2/10 text-text'
          : 'border-border bg-surface-2/60 text-text-dim'
      }`}
    >
      <div
        className="flex flex-col gap-0.5"
        data-testid="provenance-strip-content"
      >
        <div
          data-testid="provenance-strip-line1"
          className="flex flex-wrap items-center gap-x-1.5 font-sans text-body font-medium"
        >
          <span>Exported RunRay report</span>
          <span className="text-text-faint">·</span>
          <span>{sessionText}</span>
          <span className="text-text-faint">·</span>
          <span>
            generated {dateStr} by runray {versionStr}
          </span>
          <span className="text-text-faint">·</span>
          <span>read-only</span>
          {manifest?.profile && (
            <>
              <span className="text-text-faint">·</span>
              <span
                data-testid="provenance-profile"
                className="font-mono text-label text-text-dim"
              >
                profile: {profile}
              </span>
            </>
          )}
          <span className="text-text-faint">·</span>
          {isWarning ? (
            <span
              data-testid="provenance-redaction-status"
              className="inline-flex items-center rounded border border-heat-2/40 bg-heat-2/20 px-1.5 py-0.5 font-mono text-label font-medium text-heat-2"
            >
              contains prompt text
            </span>
          ) : (
            <span
              data-testid="provenance-redaction-status"
              className="font-mono text-label text-text-dim"
            >
              prompt text redacted
            </span>
          )}
          {pathsScrubbed && (
            <>
              <span className="text-text-faint">·</span>
              <span
                data-testid="provenance-paths-status"
                className="font-mono text-label text-text-dim"
              >
                identifiers scrubbed
              </span>
            </>
          )}
          {spansPruned && (
            <>
              <span className="text-text-faint">·</span>
              <span
                data-testid="provenance-spans-status"
                className="font-mono text-label text-text-dim"
              >
                spans pruned
              </span>
            </>
          )}
        </div>
        <p
          data-testid="provenance-strip-line2"
          className="text-label text-text-faint"
        >
          Generated locally from agent session logs. Nothing in this file was
          uploaded anywhere.
        </p>
      </div>
    </div>
  );
}
