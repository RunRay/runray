import type { TraceFile } from '@runray/schema';

/**
 * Single-file export (05-ARCHITECTURE §3, ADR-5): the template is the
 * dashboard with everything inlined; injecting `window.__RUNRAY_DATA__`
 * turns it into a report that renders offline from `file://`.
 */

/**
 * Inject one `window.<name>` global into the export template's `<head>`
 * (X4 — the single injection helper for `__RUNRAY_DATA__`,
 * `__RUNRAY_PRICING__`, and `__RUNRAY_VIEW_CONFIG__`).
 *
 * Sanitization: every angle bracket inside the JSON becomes its unicode
 * escape (backslash-u003c), which JSON.parse round-trips losslessly. That
 * covers both ways embedded text could break out of the script element: a
 * literal `</script>` and a `<!--` (HTML-comment parsing inside scripts).
 * The data script is a classic script, so it runs during parse — before
 * the app's inline module, which is always deferred.
 */
export function injectGlobal(
  template: string,
  name: string,
  payload: unknown,
): string {
  if (!template.includes('</head>')) {
    throw new Error('export template has no <head>; rebuild the UI');
  }
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const tag = `<script>window.${name}=${json};</script>`;
  // Replacer function: a plain string replacement would expand `$&` etc.
  // occurring inside prompt text.
  return template.replace('</head>', () => `${tag}</head>`);
}

/** Inject the trace data into the export template's `<head>`. */
export function injectTraceData(
  template: string,
  traceFile: TraceFile,
): string {
  return injectGlobal(template, '__RUNRAY_DATA__', traceFile);
}

export type ExportConsent = 'proceed' | 'ask' | 'abort';

/**
 * Privacy guard (cli spec "Redaction guard"): an unredacted export contains
 * full prompt/output text, so it needs `--redact`, `--yes`, or an
 * interactive confirmation; non-interactive without either aborts.
 */
export function exportConsent(opts: {
  redact: boolean;
  yes: boolean;
  interactive: boolean;
}): ExportConsent {
  if (opts.redact || opts.yes) return 'proceed';
  return opts.interactive ? 'ask' : 'abort';
}

/**
 * Narrow a discovered TraceFile to one run by id (exact, then unique
 * prefix). Returns `undefined` when nothing matches — the caller treats that
 * as "no data found" (exit 3).
 */
export function selectRun(
  traceFile: TraceFile,
  runId: string,
): TraceFile | undefined {
  const exact = traceFile.runs.filter((run) => run.id === runId);
  const matches =
    exact.length > 0
      ? exact
      : traceFile.runs.filter((run) => run.id.startsWith(runId));
  if (matches.length !== 1) return undefined;
  return { ...traceFile, runs: matches };
}
