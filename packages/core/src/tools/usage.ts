/**
 * Tool usage aggregation (tool-usage capability, design T7 and T11): a run's
 * resolved tool spans as ranked rows, with the figures every consumer shows.
 * A pure function of the spans, deterministic in every ordering.
 *
 * Time attribution (design D2): a call's whole duration goes to its primary
 * tool. When the command ran other tools too, the same duration is reported
 * as the primary's `sharedMs` and as `alsoRanMs` on each of the others,
 * never in their totals, so row totals add up to the calls they sum.
 *
 * Summed tool time (`summedMs`) is the duration of closed tool and MCP calls
 * minus three kinds of span that are aggregated apart: calls that contain a
 * subagent (their time is the subagent's own calls, counted once), calls
 * that wait on the person, and hook spans. It is a sum, not wall-clock:
 * parallel calls overlap.
 */
import type { Span } from '@runray/schema';
import { TOOL_FLAGS, type ToolFlag } from './attributes.js';
import {
  type IdentityContext,
  identityContext,
  type ToolFamily,
  type ToolIdentity,
  toolIdentity,
} from './identity.js';
import { ACTIVITIES, type Activity, toolById } from './registry.js';

/** Figures of a set of calls. */
export interface UsageStats {
  /** Every call, including calls still in progress. */
  calls: number;
  /** Calls whose status is `error`. */
  errors: number;
  /** Calls with no recorded end: counted, adding no time to any figure. */
  open: number;
  /** Summed duration of the closed calls. */
  totalMs: number;
  /** The part of `totalMs` spent in commands that also ran other tools. */
  sharedMs: number;
  /** Nearest-rank percentiles and maximum over the closed calls. */
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Calls per result flag. */
  flags: Record<ToolFlag, number>;
}

export interface ToolSubRow extends UsageStats {
  /** Unique within its row. */
  id: string;
  /** Closed vocabulary: a subcommand or an MCP tool name. */
  sub?: string;
  /** Free-form: a script or program name. Absent under redaction. */
  detail?: string;
  /** `sub` and `detail` joined; empty for calls that have neither. */
  label: string;
  /** The activity holding most of the sub-row's time. */
  activity: Activity;
}

export interface ToolRow extends UsageStats {
  /** Unique within the whole result. */
  id: string;
  family: ToolFamily;
  key: string;
  label: string;
  /** `key` is an id of the closed tool registry. */
  registry: boolean;
  /** A short-lived shell tool: the Time view folds these into one group. */
  utility: boolean;
  /** False for shell calls of a trace produced before classification. */
  classified: boolean;
  /** The activity holding most of the row's time. */
  activity: Activity;
  /**
   * Duration of commands led by another tool in which this tool also ran.
   * Reported beside the total, never inside it.
   */
  alsoRanMs: number;
  alsoRanCalls: number;
  /**
   * One entry per subcommand and, where the trace carries it, per script or
   * program name. Empty when no call has either; otherwise the entries
   * partition the row.
   */
  subs: ToolSubRow[];
}

export interface ActivityTotal {
  activity: Activity;
  calls: number;
  totalMs: number;
}

/** Spans kept out of summed tool time, aggregated on their own. */
export interface UsageGroup {
  rows: ToolRow[];
  calls: number;
  totalMs: number;
}

export interface ToolUsage {
  /** Summed tool time; see the module comment for what it leaves out. */
  summedMs: number;
  /** The calls behind `summedMs`, including calls still in progress. */
  calls: number;
  /** Ranked by total time, then by key. */
  rows: ToolRow[];
  /** Partition of `summedMs`, in the order of ACTIVITIES; no empty entries. */
  activities: ActivityTotal[];
  /** Calls that contain a subagent, by agent type. */
  agents: UsageGroup;
  /** Hook spans, by hook name. */
  hooks: UsageGroup;
  /** Calls that waited on the person, by tool. */
  waiting: UsageGroup;
  /** Shell calls without tool-usage attributes: a pre-classification trace. */
  unclassifiedShellCalls: number;
}

export interface ToolUsageOptions {
  /**
   * Narrow `rows` to calls of these activities. Every other figure stays
   * run-wide, so a share keeps its denominator while the table is filtered.
   */
  activities?: readonly Activity[];
}

/** Nearest-rank percentile over a sorted-ascending array (deterministic). */
function nearestRank(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(1, Math.ceil((percentile / 100) * sorted.length)) - 1;
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

function ms(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** A span's duration, or `undefined` while it is still in progress. */
function closedDuration(span: Span): number | undefined {
  if (span.status === 'in_progress') return undefined;
  if (span.durationMs !== undefined) return span.durationMs;
  const start = ms(span.startedAt);
  const end = ms(span.endedAt);
  if (start === undefined || end === undefined) return undefined;
  return Math.max(0, end - start);
}

/**
 * How long a delegation ran. A call that launches its agent in the
 * background returns at once, so the subagent span it contains can outlast
 * it; the longer of the two is the delegation.
 */
function delegationDuration(
  span: Span,
  context: IdentityContext,
): number | undefined {
  let longest = closedDuration(span);
  for (const sub of context.subagents.get(span.id) ?? []) {
    const d = closedDuration(sub);
    if (d !== undefined && (longest === undefined || d > longest)) longest = d;
  }
  return longest;
}

class Tally {
  calls = 0;
  errors = 0;
  open = 0;
  totalMs = 0;
  sharedMs = 0;
  readonly durations: number[] = [];
  readonly flags: Record<ToolFlag, number>;
  readonly byActivity = new Map<Activity, number>();

  constructor(private readonly fallback: Activity) {
    this.flags = Object.fromEntries(
      TOOL_FLAGS.map((flag) => [flag, 0]),
    ) as Record<ToolFlag, number>;
  }

  add(span: Span, id: ToolIdentity, duration: number | undefined): void {
    this.calls++;
    if (span.status === 'error') this.errors++;
    for (const flag of id.flags) this.flags[flag]++;
    if (!this.byActivity.has(id.activity)) this.byActivity.set(id.activity, 0);
    if (duration === undefined) {
      this.open++;
      return;
    }
    this.totalMs += duration;
    if (id.also.length > 0) this.sharedMs += duration;
    this.durations.push(duration);
    this.byActivity.set(
      id.activity,
      (this.byActivity.get(id.activity) ?? 0) + duration,
    );
  }

  /** Most time first; on a tie the earlier entry of ACTIVITIES. */
  activity(): Activity {
    let best: Activity | undefined;
    let bestMs = -1;
    for (const activity of ACTIVITIES) {
      const total = this.byActivity.get(activity);
      if (total !== undefined && total > bestMs) {
        best = activity;
        bestMs = total;
      }
    }
    return best ?? this.fallback;
  }

  stats(): UsageStats {
    const sorted = [...this.durations].sort((a, b) => a - b);
    return {
      calls: this.calls,
      errors: this.errors,
      open: this.open,
      totalMs: this.totalMs,
      sharedMs: this.sharedMs,
      p50Ms: nearestRank(sorted, 50),
      p95Ms: nearestRank(sorted, 95),
      maxMs: sorted[sorted.length - 1] ?? 0,
      flags: { ...this.flags },
    };
  }
}

interface SubTally {
  sub?: string;
  detail?: string;
  tally: Tally;
}

interface RowTally {
  id: string;
  family: ToolFamily;
  key: string;
  label: string;
  registry: boolean;
  utility: boolean;
  classified: boolean;
  tally: Tally;
  alsoRanMs: number;
  alsoRanCalls: number;
  subs: Map<string, SubTally>;
}

function rowId(family: ToolFamily, registry: boolean, key: string): string {
  return `${family}/${registry ? 'registry' : 'name'}/${key}`;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

class RowSet {
  private readonly rows = new Map<string, RowTally>();

  private row(
    family: ToolFamily,
    registry: boolean,
    key: string,
    label: string,
    utility: boolean,
    classified: boolean,
    fallback: Activity,
  ): RowTally {
    const id = rowId(family, registry, key);
    let row = this.rows.get(id);
    if (row === undefined) {
      row = {
        id,
        family,
        key,
        label,
        registry,
        utility,
        classified,
        tally: new Tally(fallback),
        alsoRanMs: 0,
        alsoRanCalls: 0,
        subs: new Map(),
      };
      this.rows.set(id, row);
    }
    return row;
  }

  add(span: Span, id: ToolIdentity, duration: number | undefined): void {
    const row = this.row(
      id.family,
      id.registry,
      id.key,
      id.label,
      id.utility,
      id.classified,
      id.activity,
    );
    row.tally.add(span, id, duration);

    const subId = JSON.stringify([id.sub ?? null, id.detail ?? null]);
    let sub = row.subs.get(subId);
    if (sub === undefined) {
      sub = {
        ...(id.sub === undefined ? {} : { sub: id.sub }),
        ...(id.detail === undefined ? {} : { detail: id.detail }),
        tally: new Tally(id.activity),
      };
      row.subs.set(subId, sub);
    }
    sub.tally.add(span, id, duration);

    for (const other of id.also) {
      const def = toolById(other);
      if (def === undefined) continue;
      const also = this.row(
        'shell',
        true,
        def.id,
        def.label,
        def.utility === true || def.plumbing === true,
        true,
        def.activity,
      );
      also.alsoRanCalls++;
      if (duration !== undefined) also.alsoRanMs += duration;
    }
  }

  finish(): ToolRow[] {
    const out: ToolRow[] = [];
    for (const row of this.rows.values()) {
      const subs: ToolSubRow[] = [];
      const named = [...row.subs.values()].some(
        (s) => s.sub !== undefined || s.detail !== undefined,
      );
      if (named) {
        for (const [id, s] of row.subs) {
          subs.push({
            id,
            ...(s.sub === undefined ? {} : { sub: s.sub }),
            ...(s.detail === undefined ? {} : { detail: s.detail }),
            label: [s.sub, s.detail].filter((p) => p !== undefined).join(' '),
            activity: s.tally.activity(),
            ...s.tally.stats(),
          });
        }
        subs.sort(
          (a, b) =>
            b.totalMs - a.totalMs ||
            byText(a.label, b.label) ||
            byText(a.id, b.id),
        );
      }
      out.push({
        id: row.id,
        family: row.family,
        key: row.key,
        label: row.label,
        registry: row.registry,
        utility: row.utility,
        classified: row.classified,
        activity: row.tally.activity(),
        ...row.tally.stats(),
        alsoRanMs: row.alsoRanMs,
        alsoRanCalls: row.alsoRanCalls,
        subs,
      });
    }
    out.sort(
      (a, b) =>
        b.totalMs - a.totalMs || byText(a.key, b.key) || byText(a.id, b.id),
    );
    return out;
  }
}

function group(set: RowSet): UsageGroup {
  const rows = set.finish();
  let calls = 0;
  let totalMs = 0;
  for (const row of rows) {
    calls += row.calls;
    totalMs += row.totalMs;
  }
  return { rows, calls, totalMs };
}

/** Aggregate a run's tool, MCP and hook spans. */
export function toolUsage(
  spans: readonly Span[],
  options: ToolUsageOptions = {},
): ToolUsage {
  const context = identityContext(spans);
  const ranked = new RowSet();
  const agents = new RowSet();
  const hooks = new RowSet();
  const waiting = new RowSet();
  const byActivity = new Map<Activity, { calls: number; totalMs: number }>();
  let summedMs = 0;
  let calls = 0;
  let unclassifiedShellCalls = 0;

  for (const span of spans) {
    const id = toolIdentity(span, context);
    if (id === undefined) continue;
    if (id.family === 'hook') {
      hooks.add(span, id, closedDuration(span));
      continue;
    }
    if (id.container) {
      agents.add(span, id, delegationDuration(span, context));
      continue;
    }
    if (id.activity === 'human') {
      waiting.add(span, id, closedDuration(span));
      continue;
    }

    const duration = closedDuration(span);
    calls++;
    if (!id.classified) unclassifiedShellCalls++;
    const total = byActivity.get(id.activity) ?? { calls: 0, totalMs: 0 };
    total.calls++;
    if (duration !== undefined) {
      total.totalMs += duration;
      summedMs += duration;
    }
    byActivity.set(id.activity, total);
    if (
      options.activities === undefined ||
      options.activities.includes(id.activity)
    ) {
      ranked.add(span, id, duration);
    }
  }

  const activities: ActivityTotal[] = [];
  for (const activity of ACTIVITIES) {
    const total = byActivity.get(activity);
    if (total !== undefined) activities.push({ activity, ...total });
  }
  return {
    summedMs,
    calls,
    rows: ranked.finish(),
    activities,
    agents: group(agents),
    hooks: group(hooks),
    waiting: group(waiting),
    unclassifiedShellCalls,
  };
}
