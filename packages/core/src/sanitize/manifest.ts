import {
  resolveProfile,
  type SanitizeIntents,
  type SanitizeProfile,
} from './profile.js';

export interface SanitizationManifest {
  profile: SanitizeProfile;
  textRedacted: boolean;
  pathsScrubbed: boolean;
  spansPruned: boolean;
}

/**
 * Manifest producer (D6, trace-sanitization spec).
 * Produces { profile, textRedacted, pathsScrubbed, spansPruned },
 * carrying no filesystem path, outside TraceFile.
 */
export function createManifest(
  profileOrIntents: SanitizeProfile | SanitizeIntents,
  explicitIntents?: SanitizeIntents,
): SanitizationManifest {
  if (typeof profileOrIntents === 'string') {
    const profile = profileOrIntents;
    if (explicitIntents !== undefined) {
      const explicitProfile = resolveProfile(explicitIntents);
      const textRedacted = Boolean(
        explicitIntents.textRedacted ??
          explicitIntents.stripText ??
          (profile === 'sanitized' ||
            profile === 'metadata-only' ||
            explicitProfile === 'sanitized' ||
            explicitProfile === 'metadata-only'),
      );
      const pathsScrubbed = Boolean(
        explicitIntents.pathsScrubbed ??
          explicitIntents.scrubIdentity ??
          (profile === 'sanitized' ||
            profile === 'metadata-only' ||
            explicitProfile === 'sanitized' ||
            explicitProfile === 'metadata-only'),
      );
      const spansPruned = Boolean(
        explicitIntents.spansPruned ??
          explicitIntents.pruneSpans ??
          (profile === 'metadata-only' || explicitProfile === 'metadata-only'),
      );
      return {
        profile,
        textRedacted,
        pathsScrubbed,
        spansPruned,
      };
    }
    switch (profile) {
      case 'metadata-only':
        return {
          profile: 'metadata-only',
          textRedacted: true,
          pathsScrubbed: true,
          spansPruned: true,
        };
      case 'sanitized':
        return {
          profile: 'sanitized',
          textRedacted: true,
          pathsScrubbed: true,
          spansPruned: false,
        };
      case 'full':
        return {
          profile: 'full',
          textRedacted: false,
          pathsScrubbed: false,
          spansPruned: false,
        };
    }
  }

  const intents = profileOrIntents;
  const profile = resolveProfile(intents);
  const textRedacted = Boolean(
    intents.textRedacted ??
      intents.stripText ??
      (profile === 'sanitized' || profile === 'metadata-only'),
  );
  const pathsScrubbed = Boolean(
    intents.pathsScrubbed ??
      intents.scrubIdentity ??
      (profile === 'sanitized' || profile === 'metadata-only'),
  );
  const spansPruned = Boolean(
    intents.spansPruned ?? intents.pruneSpans ?? profile === 'metadata-only',
  );

  return {
    profile,
    textRedacted,
    pathsScrubbed,
    spansPruned,
  };
}
