import type { TraceFile } from '@runray/schema';

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
 * Export provenance strip (Phase 6 / Task 7).
 * Rendered only when `live === false`.
 * Displays session count, generation date, version, read-only status, and prompt redaction status.
 * Contains no filesystem paths, no dismiss control, and no interactive state.
 */
export function ProvenanceStrip({ traceFile }: { traceFile: TraceFile }) {
  const hasPrompts = hasUnredactedPrompts(traceFile);
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
        hasPrompts
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
          <span className="text-text-faint">·</span>
          {hasPrompts ? (
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
