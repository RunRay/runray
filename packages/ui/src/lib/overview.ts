/**
 * Sessions overview aggregates (visualizer spec: "Sessions overview
 * aggregates"): everything derives from the already-loaded runs — no new
 * data, no requests. Pure and testable.
 */

import { ruleClass } from '@runray/core/insights-meta';
import type { Insight, Run } from '@runray/schema';
import { toolSpendLeaderboard } from './cost-breakdown';
import { toolDurationStatsAcrossRuns } from './time-breakdown';

export interface OverviewTotals {
  costUSD: number;
  wastedUSD: number;
  tokens: number;
  sessions: number;
  linesAdded: number;
  linesRemoved: number;
}

export function aggregateTotals(runs: readonly Run[]): OverviewTotals {
  const totals: OverviewTotals = {
    costUSD: 0,
    wastedUSD: 0,
    tokens: 0,
    sessions: runs.length,
    linesAdded: 0,
    linesRemoved: 0,
  };
  for (const run of runs) {
    totals.costUSD += run.totals.costUSD.total;
    totals.wastedUSD += run.totals.costUSD.wastedEstimate;
    totals.tokens += run.totals.tokens.total;
    totals.linesAdded += run.totals.codeChanges?.linesAdded ?? 0;
    totals.linesRemoved += run.totals.codeChanges?.linesRemoved ?? 0;
  }
  return totals;
}

export interface DaySpend {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  costUSD: number;
  /** Waste estimate of runs started that day — the chart's second channel. */
  wastedUSD: number;
  runs: number;
  /** Cost by model on this day (the chart's "By model" breakdown). */
  byModel: Record<string, number>;
  /** Cost by source tool on this day (the chart's "By source" breakdown). */
  bySource: Record<string, number>;
}

function formatDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Local calendar day of an ISO timestamp, `YYYY-MM-DD`. The one day-bucketing
 * definition — the period filter (filter-runs.ts) must slice on exactly the
 * days this chart renders.
 */
export function localDay(iso: string): string {
  return formatDay(new Date(iso));
}

/**
 * Cost bucketed per local day of run start, gaps filled with zero days so
 * the rhythm of spending is visible. Capped to the most recent `maxDays`.
 */
interface DayBucket {
  costUSD: number;
  wastedUSD: number;
  runs: number;
  byModel: Record<string, number>;
  bySource: Record<string, number>;
}

export function spendByDay(runs: readonly Run[], maxDays = 30): DaySpend[] {
  if (runs.length === 0) return [];
  const byDay = new Map<string, DayBucket>();
  for (const run of runs) {
    const day = localDay(run.startedAt);
    const entry = byDay.get(day) ?? {
      costUSD: 0,
      wastedUSD: 0,
      runs: 0,
      byModel: {},
      bySource: {},
    };
    entry.costUSD += run.totals.costUSD.total;
    entry.wastedUSD += run.totals.costUSD.wastedEstimate;
    entry.runs += 1;
    for (const [model, cost] of Object.entries(run.totals.costUSD.byModel)) {
      entry.byModel[model] = (entry.byModel[model] ?? 0) + cost;
    }
    const source = run.source.tool;
    entry.bySource[source] =
      (entry.bySource[source] ?? 0) + run.totals.costUSD.total;
    byDay.set(day, entry);
  }
  const days = [...byDay.keys()].sort();
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return [];

  const out: DaySpend[] = [];
  const cursor = new Date(`${first}T00:00:00`);
  const end = new Date(`${last}T00:00:00`);
  while (cursor.getTime() <= end.getTime()) {
    const day = formatDay(cursor);
    const entry = byDay.get(day);
    out.push({
      day,
      costUSD: entry?.costUSD ?? 0,
      wastedUSD: entry?.wastedUSD ?? 0,
      runs: entry?.runs ?? 0,
      byModel: entry?.byModel ?? {},
      bySource: entry?.bySource ?? {},
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out.slice(-maxDays);
}

export interface RankEntry {
  name: string;
  costUSD: number;
  tokens: number;
}

/** Cost/Tokens ranked by project name (runs without a project group as "—"). */
export function topProjects(runs: readonly Run[], limit = 5): RankEntry[] {
  const byName = new Map<string, { costUSD: number; tokens: number }>();
  for (const run of runs) {
    const name = run.project?.name ?? '—';
    const entry = byName.get(name) ?? { costUSD: 0, tokens: 0 };
    entry.costUSD += run.totals.costUSD.total;
    entry.tokens += run.totals.tokens.total;
    byName.set(name, entry);
  }
  return rank(byName, limit);
}

/** Cost/Tokens ranked by model, straight from the per-run byModel rollups. */
export function topModels(runs: readonly Run[], limit = 5): RankEntry[] {
  const byName = new Map<string, { costUSD: number; tokens: number }>();
  for (const run of runs) {
    for (const [model, cost] of Object.entries(run.totals.costUSD.byModel)) {
      const entry = byName.get(model) ?? { costUSD: 0, tokens: 0 };
      entry.costUSD += cost;
      byName.set(model, entry);
    }
    for (const span of run.spans) {
      if (span.llm?.model) {
        const model = span.llm.model;
        const entry = byName.get(model) ?? { costUSD: 0, tokens: 0 };
        const tok = span.llm.tokens;
        entry.tokens += tok.input + tok.output + tok.cacheRead + tok.cacheWrite;
        byName.set(model, entry);
      }
    }
  }
  return rank(byName, limit);
}

/** Cost/Tokens ranked by source tool (claude-code · opencode · otlp). */
export function topSources(runs: readonly Run[], limit = 5): RankEntry[] {
  const byName = new Map<string, { costUSD: number; tokens: number }>();
  for (const run of runs) {
    const source = run.source.tool;
    const entry = byName.get(source) ?? { costUSD: 0, tokens: 0 };
    entry.costUSD += run.totals.costUSD.total;
    entry.tokens += run.totals.tokens.total;
    byName.set(source, entry);
  }
  return rank(byName, limit);
}

function rank(
  byName: Map<string, { costUSD: number; tokens: number }>,
  limit: number,
): RankEntry[] {
  return [...byName.entries()]
    .map(([name, { costUSD, tokens }]) => ({ name, costUSD, tokens }))
    .sort(
      (a, b) =>
        b.costUSD - a.costUSD ||
        b.tokens - a.tokens ||
        (a.name < b.name ? -1 : 1),
    )
    .slice(0, limit);
}

export interface WasteEntry {
  runId: string;
  runTitle: string;
  insight: Insight;
}

export interface RuleGroup {
  /** The `ruleId` verbatim as core emitted it — the UI keeps no rule registry. */
  ruleId: string;
  /** Number of findings in the group. */
  count: number;
  /** Distinct runs the findings came from. */
  sessionCount: number;
  totalUSD: number;
  /** Highest severity across the group's findings — drives the group pill. */
  worstSeverity: Insight['severity'];
  /** The findings, worst-first. */
  entries: WasteEntry[];
}

const SEVERITY_RANK: Record<Insight['severity'], number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

/**
 * Cross-run waste grouped by rule (add-dashboard-extensions D4): every
 * waste-bearing insight, keyed by its `ruleId` verbatim, with the group total,
 * finding count, and distinct-session count. Groups are ordered by total waste
 * descending (ties by ruleId); findings inside keep the worst-first order.
 * Presentation only — no cap, no rule registry.
 */
export function wasteByRule(runs: readonly Run[]): RuleGroup[] {
  const byRule = new Map<string, WasteEntry[]>();
  for (const run of runs) {
    for (const insight of run.insights) {
      if ((insight.estimatedWasteUSD ?? 0) <= 0) continue;
      const entry: WasteEntry = {
        runId: run.id,
        runTitle: run.title ?? run.source.tool,
        insight,
      };
      const list = byRule.get(insight.ruleId);
      if (list === undefined) byRule.set(insight.ruleId, [entry]);
      else list.push(entry);
    }
  }
  const groups: RuleGroup[] = [];
  for (const [ruleId, entries] of byRule) {
    entries.sort(
      (a, b) =>
        (b.insight.estimatedWasteUSD ?? 0) -
          (a.insight.estimatedWasteUSD ?? 0) ||
        (a.insight.id < b.insight.id ? -1 : 1),
    );
    const totalUSD = entries.reduce(
      (acc, e) => acc + (e.insight.estimatedWasteUSD ?? 0),
      0,
    );
    const worstSeverity = entries.reduce<Insight['severity']>(
      (worst, e) =>
        SEVERITY_RANK[e.insight.severity] > SEVERITY_RANK[worst]
          ? e.insight.severity
          : worst,
      'info',
    );
    groups.push({
      ruleId,
      count: entries.length,
      sessionCount: new Set(entries.map((e) => e.runId)).size,
      totalUSD,
      worstSeverity,
      entries,
    });
  }
  groups.sort(
    (a, b) => b.totalUSD - a.totalUSD || (a.ruleId < b.ruleId ? -1 : 1),
  );
  return groups;
}

/**
 * The tool that failed most across the visible runs (KPI note "worst: …").
 * Tallies error tool spans by tool name; ties break by name for stability.
 * Null when nothing errored.
 */
export function worstToolError(
  runs: readonly Run[],
): { name: string; count: number } | null {
  const byTool = new Map<string, number>();
  for (const run of runs) {
    for (const span of run.spans) {
      if (span.tool?.isError !== true) continue;
      const name = span.tool.name || span.name || 'tool';
      byTool.set(name, (byTool.get(name) ?? 0) + 1);
    }
  }
  let best: { name: string; count: number } | null = null;
  for (const [name, count] of byTool) {
    if (
      best === null ||
      count > best.count ||
      (count === best.count && name < best.name)
    ) {
      best = { name, count };
    }
  }
  return best;
}

/**
 * The single priciest llm call across the visible runs (KPI note "priciest
 * single call: $…"). 0 when nothing is priced.
 */
export function mostExpensiveCall(runs: readonly Run[]): number {
  let max = 0;
  for (const run of runs) {
    for (const span of run.spans) {
      const cost = span.llm?.costUSD;
      if (cost !== undefined && span.llm?.costSource !== 'unknown') {
        max = Math.max(max, cost);
      }
    }
  }
  return max;
}

export interface CacheAggregate {
  /**
   * Token-weighted hit-rate across runs: ΣcacheRead / (ΣcacheRead + Σinput).
   * Mirrors the per-run definition in core (normalize.ts) exactly — a naive
   * mean of per-run rates would over-weight tiny sessions.
   */
  hitRate: number;
  /** Total input-class tokens served from cache — "N served from cache". */
  cacheReadTokens: number;
}

export function cacheAggregate(runs: readonly Run[]): CacheAggregate {
  let cacheRead = 0;
  let input = 0;
  for (const run of runs) {
    cacheRead += run.totals.tokens.cacheRead;
    input += run.totals.tokens.input;
  }
  const denom = cacheRead + input;
  return {
    hitRate: denom === 0 ? 0 : cacheRead / denom,
    cacheReadTokens: cacheRead,
  };
}

export interface ErrorRate {
  /** toolErrors / toolCalls across runs, 0 when nothing ran (0..1). */
  rate: number;
  errors: number;
  calls: number;
}

export function errorRate(runs: readonly Run[]): ErrorRate {
  let errors = 0;
  let calls = 0;
  for (const run of runs) {
    errors += run.totals.counts.toolErrors;
    calls += run.totals.counts.toolCalls;
  }
  return { rate: calls === 0 ? 0 : errors / calls, errors, calls };
}

export interface SessionCostStats {
  averageUSD: number;
  medianUSD: number;
}

/**
 * Mean and median per-session cost. Median resists the one runaway session
 * that the mean can't — reporting both says whether spend is typical or
 * skewed.
 */
export function sessionCostStats(runs: readonly Run[]): SessionCostStats {
  if (runs.length === 0) return { averageUSD: 0, medianUSD: 0 };
  const costs = runs.map((r) => r.totals.costUSD.total).sort((a, b) => a - b);
  const sum = costs.reduce((acc, c) => acc + c, 0);
  const mid = Math.floor(costs.length / 2);
  const medianUSD =
    costs.length % 2 === 0
      ? ((costs[mid - 1] ?? 0) + (costs[mid] ?? 0)) / 2
      : (costs[mid] ?? 0);
  return { averageUSD: sum / costs.length, medianUSD };
}

/**
 * Dashboard savings aggregate (D1): the honest headline for the
 * potential-savings panel. Split is CLASS-SUMMED via the rule-metadata
 * registry — never "total minus wastedEstimate" (the engine caps
 * wastedEstimate at run cost, and remainder arithmetic would silently
 * reclassify capped-off burned waste as opportunity). Unknown rule ids
 * fall into the opportunity bucket under their literal slug (open set).
 */
export interface SavingsSummary {
  /** Σ run.totals.costUSD.wastedEstimate — waste-class, engine-capped. */
  burnedUSD: number;
  burnedTokens: number;
  /** Σ estimatedWasteUSD over opportunity-class findings. */
  opportunityUSD: number;
  opportunityTokens: number;
  /** Top rule groups by summed estimate (the "top changes" list). */
  topChanges: RuleGroup[];
  findings: number;
}

export function savingsSummary(runs: readonly Run[], topN = 3): SavingsSummary {
  let burnedUSD = 0;
  let burnedTokens = 0;
  let opportunityUSD = 0;
  let opportunityTokens = 0;
  let findings = 0;

  for (const run of runs) {
    burnedUSD += run.totals.costUSD.wastedEstimate;
    if (run.totals.costUSD.total > 0) {
      const wasteRatio =
        run.totals.costUSD.wastedEstimate / run.totals.costUSD.total;
      burnedTokens += Math.round(wasteRatio * run.totals.tokens.total);
    } else if (run.totals.costUSD.wastedEstimate > 0) {
      burnedTokens += Math.round(run.totals.tokens.total * 0.2); // Fallback estimate for zero-cost models
    }

    for (const insight of run.insights) {
      findings += 1;
      if (ruleClass(insight.ruleId) === 'opportunity') {
        const usd = insight.estimatedWasteUSD ?? 0;
        opportunityUSD += usd;
        if (run.totals.costUSD.total > 0) {
          opportunityTokens += Math.round(
            (usd / run.totals.costUSD.total) * run.totals.tokens.total,
          );
        } else {
          opportunityTokens += Math.round(run.totals.tokens.total * 0.15);
        }
      }
    }
  }

  return {
    burnedUSD,
    burnedTokens,
    opportunityUSD,
    opportunityTokens,
    topChanges: wasteByRule(runs).slice(0, topN),
    findings,
  };
}

/**
 * Cross-run tool ranking for the dashboard "By tool" card (E5): merges the
 * per-run attributed leaderboards by tool name (the equal-split turn
 * attribution stays in cost-breakdown.ts — single source), EXCLUDES the
 * orchestration remainder, and attaches cross-run p95 durations. Figures
 * are labelled "attributed" by the card — the split is a heuristic.
 */
export interface ToolRankEntry {
  name: string;
  mcpServer?: string;
  costUSD: number;
  calls: number;
  p95Ms: number;
}

/** Full attributed-tool leaderboard (all tools, sorted) — the honest
 * denominator for mcpShare; `topTools` is just its head. */
function allToolEntries(runs: readonly Run[]): ToolRankEntry[] {
  const merged = new Map<
    string,
    { costUSD: number; calls: number; mcpServer?: string }
  >();
  for (const run of runs) {
    for (const tool of toolSpendLeaderboard(run.spans)) {
      if (tool.orchestration === true) continue;
      const entry = merged.get(tool.name) ?? { costUSD: 0, calls: 0 };
      entry.costUSD += tool.costUSD;
      entry.calls += tool.calls;
      if (tool.mcpServer !== undefined) entry.mcpServer = tool.mcpServer;
      merged.set(tool.name, entry);
    }
  }
  const p95ByName = new Map(
    toolDurationStatsAcrossRuns(runs).map((s) => [s.name, s.p95Ms]),
  );
  const entries: ToolRankEntry[] = [...merged.entries()].map(([name, e]) => ({
    name,
    ...(e.mcpServer === undefined ? {} : { mcpServer: e.mcpServer }),
    costUSD: e.costUSD,
    calls: e.calls,
    p95Ms: p95ByName.get(name) ?? 0,
  }));
  entries.sort((a, b) => b.costUSD - a.costUSD || (a.name < b.name ? -1 : 1));
  return entries;
}

export function topTools(runs: readonly Run[], limit = 8): ToolRankEntry[] {
  return allToolEntries(runs).slice(0, limit);
}

/** The "are my MCP servers eating my limit" callout under the card. */
export interface McpShare {
  costUSD: number;
  /** Share of ATTRIBUTED spend (orchestration excluded); 0 when none. */
  share: number;
  topServer: string | null;
}

/** Computed over the FULL leaderboard, not the displayed top-N — otherwise
 * tools ranked below the cutoff distort the share, dollars, and top server. */
export function mcpShare(runs: readonly Run[]): McpShare {
  const entries = allToolEntries(runs);
  const total = entries.reduce((acc, e) => acc + e.costUSD, 0);
  const byServer = new Map<string, number>();
  let mcpUSD = 0;
  for (const e of entries) {
    if (e.mcpServer === undefined) continue;
    mcpUSD += e.costUSD;
    byServer.set(e.mcpServer, (byServer.get(e.mcpServer) ?? 0) + e.costUSD);
  }
  const topServer =
    [...byServer.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    )[0]?.[0] ?? null;
  return {
    costUSD: mcpUSD,
    share: total > 0 ? mcpUSD / total : 0,
    topServer,
  };
}
