import type { Insight, Run, Span } from '@runray/schema';
import {
  type BreakShape,
  type BreakShapeThresholds,
  breakShape,
  contextTokens,
  DEFAULT_BREAK_SHAPE,
} from '../insights/cache-shape.js';
import { endMs, startMs } from '../insights/helpers.js';
import { RULE_META, type RuleClass, ruleClass } from '../insights/meta.js';
import {
  DEFAULT_SEVERITY_THRESHOLDS,
  gradeSeverity,
  type SeverityThresholds,
} from '../insights/severity.js';

/**
 * Run-level waste grouping (waste-grouping capability): a session's
 * findings grouped by rule, split by class (burned vs opportunity), each
 * group graded by its SUM the way the engine grades one finding, cent-level
 * groups folded, and every burned finding placed on the session's clock as
 * a leak event next to the context size of each model call. A pure
 * function of the run — the same numbers wherever they are rendered — and
 * deterministic in every ordering. Nothing here re-detects anything: the
 * findings are the engine's; this module only arranges them.
 */

export interface WasteOptions {
  /** Severity tiers for the group grade (the engine's defaults). */
  severity?: SeverityThresholds;
  /** Shape thresholds for cache-prefix breaks (the rule's defaults). */
  shape?: BreakShapeThresholds;
}

export interface WasteOccurrence {
  insightId: string;
  title: string;
  severity: Insight['severity'];
  /** The finding's estimate; 0 when it has none (see `priced`). */
  usd: number;
  priced: boolean;
  spanIds: string[];
  /** Offset from the run's start of the moment the leak happened: the
   * breaking or resumed call for cache findings, the first evidence
   * otherwise. Undefined when no evidence span resolves. */
  atMs: number | undefined;
  /** Offset of the end of the last evidence span. */
  untilMs: number | undefined;
  /** The evidence tool's name when the evidence is tool calls. */
  tool?: string;
  /** The breaking or resumed model call's model, for cache findings. */
  model?: string;
  /** cache-prefix-break only: what survived the break. */
  shape?: BreakShape;
  /** Cache findings: tokens read before and after, and re-written. */
  cache?: { readBefore: number; readAfter: number; rewritten: number };
  /** idle-cache-expiry only: the gap that expired the cache. */
  gapMs?: number;
}

export interface WasteGroup {
  ruleId: string;
  class: RuleClass;
  label: string;
  explain: string;
  count: number;
  /** Σ occurrence estimates (unpriced findings add nothing). */
  usd: number;
  /** usd / the run's priced cost; 0 when the run is unpriced. */
  share: number;
  /** Graded on the group's sum by the engine's own tiers. */
  severity: Insight['severity'];
  /** Every occurrence is priced and under the warning floor: cents. */
  folded: boolean;
  /** Any occurrence without an estimate — the sum is a lower bound. */
  unpriced: boolean;
  /** Largest first, then earliest, then id. */
  occurrences: WasteOccurrence[];
  /** cache-prefix-break only: count and sum per shape. */
  shapes?: Partial<Record<BreakShape, { count: number; usd: number }>>;
}

export type LeakKind = 'burn' | 'compaction' | 'idle';

export interface LeakEvent {
  /** burn = money paid for nothing at this point; compaction = a new
   * prefix written once (cheap, and a lever, so it is drawn apart); idle =
   * the gap during which the cache expired (the burn follows it). */
  kind: LeakKind;
  ruleId: string;
  insightId: string;
  /** Offsets from the run's start. */
  startMs: number;
  endMs: number;
  usd: number;
  /** The span to open in the timeline. */
  spanId: string;
  label: string;
}

export interface ContextPoint {
  offsetMs: number;
  /** Input-class tokens the call carried. */
  tokens: number;
  model: string;
  spanId: string;
}

export interface RunWaste {
  costUSD: number;
  /** The engine's capped waste-class rollup — the headline. */
  burnedUSD: number;
  burnedShare: number;
  /** Σ opportunity-class estimates: upper bounds, not additive. */
  opportunityUSD: number;
  burned: WasteGroup[];
  opportunities: WasteGroup[];
  findings: number;
  /** Findings inside folded groups. */
  folded: number;
  /** Any finding without an estimate. */
  unpriced: boolean;
  /** Chronological. */
  events: LeakEvent[];
  /** Every model call, chronological. */
  context: ContextPoint[];
}

const CACHE_PAIR_RULES = new Set(['cache-prefix-break', 'idle-cache-expiry']);

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function byIdThenTime(a: Span, b: Span): number {
  return startMs(a) - startMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function occurrenceOf(
  insight: Insight,
  spans: Span[],
  t0: number,
  shapeCfg: BreakShapeThresholds,
): WasteOccurrence {
  const priced = insight.estimatedWasteUSD !== undefined;
  const occ: WasteOccurrence = {
    insightId: insight.id,
    title: insight.title,
    severity: insight.severity,
    usd: insight.estimatedWasteUSD ?? 0,
    priced,
    spanIds: [...insight.spanIds],
    atMs: undefined,
    untilMs: undefined,
  };
  if (spans.length === 0) return occ;
  const ordered = [...spans].sort(byIdThenTime);
  const first = ordered[0] as Span;
  occ.atMs = startMs(first) - t0;
  occ.untilMs = Math.max(...ordered.map(endMs)) - t0;
  const firstTool = spans.find(
    (s) => s.kind === 'tool_call' || s.kind === 'mcp_call',
  );
  if (firstTool !== undefined)
    occ.tool = firstTool.tool?.name ?? firstTool.name;

  // cache findings cite exactly [before, after]; the leak is at `after`
  if (CACHE_PAIR_RULES.has(insight.ruleId) && spans.length === 2) {
    const [a, b] = spans as [Span, Span];
    if (a.llm !== undefined && b.llm !== undefined) {
      occ.atMs = startMs(b) - t0;
      occ.model = b.llm.model;
      if (insight.ruleId === 'cache-prefix-break') {
        occ.shape = breakShape(a, b, shapeCfg);
        occ.cache = {
          readBefore: a.llm.tokens.cacheRead,
          readAfter: b.llm.tokens.cacheRead,
          rewritten: Math.min(b.llm.tokens.cacheWrite, a.llm.tokens.cacheRead),
        };
      } else {
        occ.gapMs = Math.max(0, startMs(b) - endMs(a));
        occ.cache = {
          readBefore: a.llm.tokens.cacheRead,
          readAfter: b.llm.tokens.cacheRead,
          rewritten: b.llm.tokens.cacheWrite,
        };
      }
    }
  }
  return occ;
}

function eventsOf(
  insight: Insight,
  spans: Span[],
  occ: WasteOccurrence,
  t0: number,
): LeakEvent[] {
  if (spans.length === 0 || occ.atMs === undefined) return [];
  const base = {
    ruleId: insight.ruleId,
    insightId: insight.id,
    usd: occ.usd,
    label: insight.title,
  };
  if (CACHE_PAIR_RULES.has(insight.ruleId) && spans.length === 2) {
    const [a, b] = spans as [Span, Span];
    if (a.llm !== undefined && b.llm !== undefined) {
      const at = startMs(b) - t0;
      if (insight.ruleId === 'idle-cache-expiry') {
        return [
          {
            ...base,
            kind: 'idle',
            startMs: endMs(a) - t0,
            endMs: at,
            usd: 0,
            spanId: b.id,
          },
          { ...base, kind: 'burn', startMs: at, endMs: at, spanId: b.id },
        ];
      }
      return [
        {
          ...base,
          kind: occ.shape === 'compaction' ? 'compaction' : 'burn',
          startMs: at,
          endMs: at,
          spanId: b.id,
        },
      ];
    }
  }
  const ordered = [...spans].sort(byIdThenTime);
  return [
    {
      ...base,
      kind: 'burn',
      startMs: occ.atMs,
      endMs: occ.untilMs ?? occ.atMs,
      spanId: (ordered[0] as Span).id,
    },
  ];
}

function compareOccurrences(a: WasteOccurrence, b: WasteOccurrence): number {
  return (
    b.usd - a.usd ||
    (a.atMs ?? Number.MAX_SAFE_INTEGER) - (b.atMs ?? Number.MAX_SAFE_INTEGER) ||
    (a.insightId < b.insightId ? -1 : a.insightId > b.insightId ? 1 : 0)
  );
}

function compareGroups(a: WasteGroup, b: WasteGroup): number {
  return (
    b.usd - a.usd ||
    b.count - a.count ||
    (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)
  );
}

/**
 * Group a run's findings by rule and class, grade each group by its sum,
 * fold the cent-level ones, and place every burned finding on the clock.
 */
export function wasteRun(run: Run, opts: WasteOptions = {}): RunWaste {
  const sev = opts.severity ?? DEFAULT_SEVERITY_THRESHOLDS;
  const shapeCfg = opts.shape ?? DEFAULT_BREAK_SHAPE;
  const byId = new Map(run.spans.map((s) => [s.id, s]));
  const t0 = ms(run.startedAt);
  const costUSD = run.totals.costUSD.total;

  const occurrences = new Map<string, WasteOccurrence[]>();
  const events: LeakEvent[] = [];
  let unpriced = false;
  let opportunityUSD = 0;

  for (const insight of run.insights) {
    const spans = insight.spanIds
      .map((id) => byId.get(id))
      .filter((s): s is Span => s !== undefined);
    const occ = occurrenceOf(insight, spans, t0, shapeCfg);
    if (!occ.priced) unpriced = true;
    const list = occurrences.get(insight.ruleId) ?? [];
    list.push(occ);
    occurrences.set(insight.ruleId, list);
    if (ruleClass(insight.ruleId) === 'waste') {
      events.push(...eventsOf(insight, spans, occ, t0));
    } else {
      opportunityUSD += occ.usd;
    }
  }

  const burned: WasteGroup[] = [];
  const opportunities: WasteGroup[] = [];
  let folded = 0;
  for (const [ruleId, list] of occurrences) {
    list.sort(compareOccurrences);
    const usd = round6(list.reduce((acc, o) => acc + o.usd, 0));
    const anyUnpriced = list.some((o) => !o.priced);
    const anyPriced = list.some((o) => o.priced);
    const isFolded =
      !anyUnpriced && list.every((o) => o.usd < sev.warningFloorUSD);
    if (isFolded) folded += list.length;
    const meta = RULE_META[ruleId];
    const group: WasteGroup = {
      ruleId,
      class: ruleClass(ruleId),
      label: meta?.label ?? ruleId,
      explain: meta?.explain ?? '',
      count: list.length,
      usd,
      share: costUSD > 0 ? usd / costUSD : 0,
      severity: gradeSeverity(anyPriced ? usd : undefined, costUSD, sev),
      folded: isFolded,
      unpriced: anyUnpriced,
      occurrences: list,
    };
    if (ruleId === 'cache-prefix-break') {
      const shapes: WasteGroup['shapes'] = {};
      for (const o of list) {
        if (o.shape === undefined) continue;
        const cell = shapes[o.shape] ?? { count: 0, usd: 0 };
        cell.count += 1;
        cell.usd = round6(cell.usd + o.usd);
        shapes[o.shape] = cell;
      }
      group.shapes = shapes;
    }
    (group.class === 'waste' ? burned : opportunities).push(group);
  }
  burned.sort(compareGroups);
  opportunities.sort(compareGroups);

  events.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      a.endMs - b.endMs ||
      (a.insightId < b.insightId ? -1 : a.insightId > b.insightId ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );

  const context: ContextPoint[] = run.spans
    .filter((s) => s.kind === 'llm_call' && s.llm !== undefined)
    .sort(byIdThenTime)
    .map((s) => ({
      offsetMs: startMs(s) - t0,
      tokens: contextTokens(s),
      model: s.llm?.model ?? '',
      spanId: s.id,
    }));

  const burnedUSD = run.totals.costUSD.wastedEstimate;
  return {
    costUSD,
    burnedUSD,
    burnedShare: costUSD > 0 ? burnedUSD / costUSD : 0,
    opportunityUSD: round6(opportunityUSD),
    burned,
    opportunities,
    findings: run.insights.length,
    folded,
    unpriced,
    events,
    context,
  };
}
