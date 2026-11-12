import {
  ACTIVITY_LABELS,
  type Activity,
  type ToolUsage,
  toolUsage,
} from '@runray/core/tools';
import type { Run } from '@runray/schema';

/**
 * UI-side access to the core tool-usage aggregation (tool-usage
 * capability). The aggregation is a pure function of the run, computed once
 * per run object and cached in a WeakMap. Nothing here re-resolves or
 * re-sums anything: that stays in core. This file only arranges the figures
 * for the Time view: which activities get a colour, what a share reads as.
 */

const cache = new WeakMap<Run, ToolUsage>();

export function runToolUsage(run: Run): ToolUsage {
  let usage = cache.get(run);
  if (usage === undefined) {
    usage = toolUsage(run.spans);
    cache.set(run, usage);
  }
  return usage;
}

/** Bar order. Tailwind needs the class names spelled out to emit them. */
const ACTIVITY_FILLS = [
  'bg-activity-1',
  'bg-activity-2',
  'bg-activity-3',
  'bg-activity-4',
  'bg-activity-5',
  'bg-activity-6',
] as const;
const REST_FILL = 'bg-activity-rest';
const UNRESOLVED_FILL = 'hatch-unresolved';

export const REST_PART = 'rest';
export const UNRESOLVED_PART = 'unresolved';

export interface ActivityPart {
  /** The activity, or REST_PART / UNRESOLVED_PART. */
  id: string;
  kind: 'activity' | 'rest' | 'unresolved';
  label: string;
  /** The activities the part stands for: one, or every folded one. */
  activities: Activity[];
  /** Labels of the folded activities, largest first; empty otherwise. */
  members: string[];
  totalMs: number;
  calls: number;
  /** Share of summed tool time, 0–1. */
  share: number;
  /** Class that paints the part and its legend swatch. */
  fill: string;
}

/**
 * Summed tool time as the parts of one stacked bar. The six largest
 * activities get a colour of their own; the colours are handed out in the
 * fixed activity order, not by size, so a part keeps its neighbours from
 * run to run and the palette's neighbour separation is what the bar shows.
 * Everything smaller folds into one neutral part. Time no program could be
 * named for comes last, hatched, and is never folded into anything.
 */
export function activityParts(usage: ToolUsage): ActivityPart[] {
  const withTime = usage.activities.filter((a) => a.totalMs > 0);
  const named = withTime.filter((a) => a.activity !== 'other');
  const unresolved = withTime.find((a) => a.activity === 'other');
  const share = (ms: number) => (usage.summedMs > 0 ? ms / usage.summedMs : 0);

  // `named` is in activity order and the sort is stable, so equal times
  // keep that order: the choice of six is deterministic
  const largest = new Set(
    [...named]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, ACTIVITY_FILLS.length)
      .map((a) => a.activity),
  );

  const parts: ActivityPart[] = [];
  for (const a of named) {
    if (!largest.has(a.activity)) continue;
    parts.push({
      id: a.activity,
      kind: 'activity',
      label: ACTIVITY_LABELS[a.activity],
      activities: [a.activity],
      members: [],
      totalMs: a.totalMs,
      calls: a.calls,
      share: share(a.totalMs),
      fill: ACTIVITY_FILLS[parts.length] ?? REST_FILL,
    });
  }

  const folded = named
    .filter((a) => !largest.has(a.activity))
    .sort((a, b) => b.totalMs - a.totalMs);
  if (folded.length > 0) {
    const totalMs = folded.reduce((acc, a) => acc + a.totalMs, 0);
    const only = folded.length === 1 ? folded[0] : undefined;
    parts.push({
      id: REST_PART,
      kind: 'rest',
      label:
        only === undefined
          ? `${folded.length} smaller activities`
          : ACTIVITY_LABELS[only.activity],
      activities: folded.map((a) => a.activity),
      members:
        only === undefined
          ? folded.map((a) => ACTIVITY_LABELS[a.activity])
          : [],
      totalMs,
      calls: folded.reduce((acc, a) => acc + a.calls, 0),
      share: share(totalMs),
      fill: REST_FILL,
    });
  }

  if (unresolved !== undefined) {
    parts.push({
      id: UNRESOLVED_PART,
      kind: 'unresolved',
      label: ACTIVITY_LABELS.other,
      activities: ['other'],
      members: [],
      totalMs: unresolved.totalMs,
      calls: unresolved.calls,
      share: share(unresolved.totalMs),
      fill: UNRESOLVED_FILL,
    });
  }
  return parts;
}

/** `27%`, `<1%` for a sliver that would round to nothing, `0%` for none. */
export function formatShare(share: number): string {
  if (share <= 0) return '0%';
  const percent = share * 100;
  if (percent < 1) return '<1%';
  // a part may round up to 100 only when it is the whole
  if (percent > 99 && share < 1) return '>99%';
  return `${Math.round(percent)}%`;
}
