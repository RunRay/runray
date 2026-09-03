import {
  createManifest,
  resolveProfile,
  type SanitizationManifest,
  type SanitizeProfile,
} from '@runray/core';
import type { TraceFile } from '@runray/schema';

/**
 * Single-file export (05-ARCHITECTURE §3, ADR-5): the template is the
 * dashboard with everything inlined; injecting `window.__RUNRAY_DATA__`
 * turns it into a report that renders offline from `file://`.
 */

export interface ExportFlagOptions {
  redact?: boolean;
  redactPrompts?: boolean;
  scrubPaths?: boolean;
  anonymize?: boolean;
  metadataOnly?: boolean;
}

export interface ResolvedExportSanitization {
  stripText: boolean;
  scrubIdentity: boolean;
  pruneSpans: boolean;
  profile: SanitizeProfile;
  manifest: SanitizationManifest;
}

/**
 * Pure resolver from CLI export flags and config to resolved intents,
 * named profile, and report manifest (Task 3.1, cli "Export sanitization flags").
 */
export function resolveExportSanitization(
  opts: ExportFlagOptions,
  config?: { redact?: boolean },
): ResolvedExportSanitization {
  const redactPrompts = Boolean(opts.redactPrompts ?? false);
  const redactFlag = Boolean(opts.redact ?? false);
  const scrubPaths = Boolean(opts.scrubPaths ?? false);
  const anonymize = Boolean(opts.anonymize ?? false);
  const metadataOnly = Boolean(opts.metadataOnly ?? false);
  const configRedact = Boolean(config?.redact ?? false);

  const stripText =
    redactFlag || redactPrompts || anonymize || metadataOnly || configRedact;
  const scrubIdentity = scrubPaths || anonymize || metadataOnly;
  const pruneSpans = metadataOnly;

  const profile = resolveProfile({
    stripText,
    scrubIdentity,
    pruneSpans,
  });

  const manifest = createManifest(profile, {
    stripText,
    scrubIdentity,
    pruneSpans,
  });

  return {
    stripText,
    scrubIdentity,
    pruneSpans,
    profile,
    manifest,
  };
}

/**
 * Inject one `window.<name>` global into the export template's `<head>`
 * (X4 — the single injection helper for `__RUNRAY_DATA__`,
 * `__RUNRAY_PRICING__`, and `__RUNRAY_VIEW_CONFIG__`).
 *
 * Sanitization: every angle bracket inside the JSON becomes its unicode
 * escape (backslash-u003c), which JSON.parse round-trips losslessly. That
 * covers both ways embedded text could break out of the script element: a
 * literal `</script>` and a `<!--` (HTML-comment parsing inside scripts).
 * Line terminators U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR)
 * are also escaped (backslash-u2028, backslash-u2029) to avoid JavaScript parse errors
 * in classic <script> blocks in ECMAScript parsers / older browser environments.
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
  const json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
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
 * Privacy guard (cli spec "Consent guard responds to text redaction only"):
 * an unredacted export contains full prompt/output text, so it needs text
 * redaction (`redact: true`), `--yes`, or an interactive confirmation;
 * `--scrub-paths` alone does NOT satisfy it. Non-interactive without
 * text redaction or `--yes` aborts.
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
