/**
 * Three named sanitization profiles (add-sanitized-export D7, trace-sanitization spec).
 *
 * - `full`: byte-identical to unredacted output (default for local inspection).
 * - `sanitized`: redacted prompt/output text PLUS scrubbed paths and identifiers.
 * - `metadata-only`: `sanitized` PLUS span tree pruned to container spans (session/subagent).
 */
export type SanitizeProfile = 'full' | 'sanitized' | 'metadata-only';

export interface SanitizeIntents {
  stripText?: boolean;
  textRedacted?: boolean;
  scrubIdentity?: boolean;
  pathsScrubbed?: boolean;
  pruneSpans?: boolean;
  spansPruned?: boolean;
}

export function isSanitizeProfile(val: unknown): val is SanitizeProfile {
  return val === 'full' || val === 'sanitized' || val === 'metadata-only';
}

/**
 * Pure resolver from three independent intents (strip text, scrub identity, prune spans)
 * to exactly one named profile.
 *
 * - Pruning spans implies a metadata-only profile.
 * - Stripping text AND scrubbing identity resolves to `sanitized`.
 * - Otherwise (neither or only one intent set), resolves to `full`.
 */
export function resolveProfile(
  input?: SanitizeProfile | SanitizeIntents,
): SanitizeProfile {
  if (input === undefined) return 'full';
  if (typeof input === 'string') {
    if (isSanitizeProfile(input)) return input;
    return 'full';
  }

  const prune = Boolean(input.pruneSpans ?? input.spansPruned);
  const strip = Boolean(input.stripText ?? input.textRedacted);
  const scrub = Boolean(input.scrubIdentity ?? input.pathsScrubbed);

  if (prune) return 'metadata-only';
  if (strip && scrub) return 'sanitized';
  return 'full';
}

/** The canonical 3-boolean intent map for a given named profile. */
export function profileIntents(profile: SanitizeProfile): {
  stripText: boolean;
  scrubIdentity: boolean;
  pruneSpans: boolean;
} {
  switch (profile) {
    case 'metadata-only':
      return { stripText: true, scrubIdentity: true, pruneSpans: true };
    case 'sanitized':
      return { stripText: true, scrubIdentity: true, pruneSpans: false };
    case 'full':
      return { stripText: false, scrubIdentity: false, pruneSpans: false };
  }
}
