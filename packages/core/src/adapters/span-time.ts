import type { RawSpan } from '../adapter.js';

/** Milliseconds from one instant to a later one: never negative, and
 * nothing when there is no end or a time does not parse. */
export function durationBetween(
  startedAt: string,
  endedAt: string | undefined,
): number | undefined {
  if (endedAt === undefined) return undefined;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/** Deeper than any tree an adapter builds. A walk towards the root that
 * goes on past it is on a cycle, and stops. */
const MAX_ANCESTORS = 64;

/**
 * Containers must cover their children. A `session` and a `subagent` span
 * are containers: each is made to end no earlier than anything under it,
 * at any depth (an agent that outlives the call that started it, a child
 * thread that outlasts its parent's file). Other kinds are left as their
 * source brackets them.
 *
 * A container's start is moved back only for the spans `pullsStart` names:
 * most spans start at a record their container was already open for, and a
 * start an adapter computed (an end minus a duration) must not move the
 * session before its first record.
 */
export function extendContainers(
  spans: RawSpan[],
  pullsStart: (span: RawSpan, container: RawSpan) => boolean,
): void {
  const byId = new Map(spans.map((s) => [s.id, s]));
  for (const span of spans) {
    const end = span.endedAt ?? span.startedAt;
    let parentId = span.parentId;
    for (let up = 0; parentId !== null && up < MAX_ANCESTORS; up++) {
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.kind === 'subagent' || parent.kind === 'session') {
        if (
          pullsStart(span, parent) &&
          Date.parse(span.startedAt) < Date.parse(parent.startedAt)
        ) {
          parent.startedAt = span.startedAt;
          parent.durationMs = durationBetween(parent.startedAt, parent.endedAt);
        }
        if ((parent.endedAt ?? parent.startedAt) < end) {
          parent.endedAt = end;
          parent.durationMs = durationBetween(parent.startedAt, end);
        }
      }
      parentId = parent.parentId;
    }
  }
}
