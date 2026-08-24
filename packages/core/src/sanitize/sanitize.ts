import type { Run, Span, TraceFile } from '@runray/schema';
import {
  createIdentityTable,
  type IdentityTable,
  scrubIdentity,
} from './identity.js';
import type { SanitizeProfile } from './profile.js';
import { pruneToMetadata } from './prune.js';

function redactRunText(run: Run): Run {
  const { title: _title, ...rest } = run;
  const spans: Span[] = run.spans.map((span) => {
    if (!span.content) return span;
    const nullContent: Record<string, null> = {};
    for (const k of Object.keys(span.content)) {
      nullContent[k] = null;
    }
    return {
      ...span,
      content: nullContent,
    };
  });
  return {
    ...rest,
    spans,
  };
}

export function sanitizeRun(
  run: Run,
  profile: SanitizeProfile = 'full',
  table?: IdentityTable,
): Run {
  if (profile === 'full') {
    return run;
  }
  const textRedacted = redactRunText(run);
  const scrubbed = scrubIdentity(textRedacted, table);
  if (profile === 'metadata-only') {
    return pruneToMetadata(scrubbed);
  }
  return scrubbed;
}

export function sanitizeTraceFile(
  traceFile: TraceFile,
  profile: SanitizeProfile = 'full',
): TraceFile {
  if (profile === 'full') {
    return traceFile;
  }
  const table = createIdentityTable(traceFile.runs);
  return {
    ...traceFile,
    runs: traceFile.runs.map((r) => sanitizeRun(r, profile, table)),
  };
}

export function sanitize<T extends Run | TraceFile>(
  target: T,
  profile: SanitizeProfile = 'full',
): T {
  if ('schemaVersion' in target && Array.isArray((target as TraceFile).runs)) {
    return sanitizeTraceFile(target as TraceFile, profile) as T;
  }
  return sanitizeRun(target as Run, profile) as T;
}
