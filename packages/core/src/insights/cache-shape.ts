import type { Span } from '@runray/schema';

/**
 * The shape of a cache-prefix break, read from the two calls' token quads.
 * Shared by the `cache-prefix-break` rule (which words its finding by the
 * shape) and the browser-safe waste module (which groups a session's
 * breaks by it), so the two can never disagree on what a break was.
 * Import-free apart from schema types.
 */

/** Input-class tokens of one call: what the model had in front of it,
 * whichever rate each part was billed at. */
export function contextTokens(s: Span): number {
  const t = s.llm?.tokens;
  return t === undefined ? 0 : t.input + t.cacheRead + t.cacheWrite;
}

/**
 * What survived a prefix break: `compaction` when the breaking call's
 * context shrank below the ratio (the history was summarized and written
 * once as a new prefix), `front` when fewer than the base tokens stayed
 * cached (the tool list, system prompt or a setting changed — everything
 * from the front was written again), else `history` (the fixed front
 * stayed cached; the conversation after it was written again). The
 * estimate never depends on the shape; the copy and the grouping do,
 * because the lever differs.
 */
export type BreakShape = 'compaction' | 'front' | 'history';

export interface BreakShapeThresholds {
  /** Below this many cached tokens after the break, the front of the
   * prompt itself changed (tools, system prompt, a setting). */
  baseRetainedTokens: number;
  /** A breaking call whose context is below this share of the previous
   * call's was a compaction, not an invalidation. */
  shrinkRatio: number;
}

export const DEFAULT_BREAK_SHAPE: BreakShapeThresholds = {
  baseRetainedTokens: 5_000,
  shrinkRatio: 0.6,
};

export function breakShape(
  a: Span,
  b: Span,
  cfg: BreakShapeThresholds = DEFAULT_BREAK_SHAPE,
): BreakShape {
  if (contextTokens(b) < cfg.shrinkRatio * contextTokens(a)) {
    return 'compaction';
  }
  if ((b.llm?.tokens.cacheRead ?? 0) < cfg.baseRetainedTokens) return 'front';
  return 'history';
}
