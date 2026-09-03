import type { Run, Span } from '@runray/schema';
import type { PricingEntry, PricingTable } from '../pricing/engine.js';
import {
  cacheWrite1hTokens,
  effectiveCacheWriteRate,
  matchModel,
  repriceRun,
  repriceSpans,
  round6,
  suggestedDowngrade,
} from '../pricing/engine.js';
import {
  buildScopeIndex,
  chronological,
  chronologicalLlmCalls,
  detectRetryClusters,
  endMs,
  type RetryCluster,
  scopedSameModelPairs,
  startMs,
} from './helpers.js';
import type { Finding, InsightRule, RuleContext, Thresholds } from './index.js';

/**
 * The rule set (add-profiler-depth B3–B8, C6), in the FROZEN registration
 * order the insight ids depend on: the v0 five (retry-loop, low-cache-hit,
 * context-bloat, expensive-subagent, dead-end-run), then model-mismatch,
 * then cache-prefix-break, idle-cache-expiry, fixed-context-overhead,
 * duplicate-read, scattered-tool-failures, oversized-output. Each finding
 * cites concrete numbers in `detail` and carries one actionable
 * `suggestion`; findings are constructed in schema field order (golden
 * stability) and emitted in first-evidence chronological order. Every rule
 * registers presentation metadata in `meta.ts` (test-enforced).
 */

function usd(x: number): string {
  return `$${x.toFixed(2)}`;
}
function tok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Rate card for waste estimates: the run's dominant model (most input tokens). */
function dominantModel(spans: readonly Span[]): string | undefined {
  const byModel = new Map<string, number>();
  for (const s of spans) {
    if (s.kind !== 'llm_call' || !s.llm) continue;
    byModel.set(
      s.llm.model,
      (byModel.get(s.llm.model) ?? 0) +
        s.llm.tokens.input +
        s.llm.tokens.cacheRead,
    );
  }
  return [...byModel.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  )[0]?.[0];
}

function dominantModelEntry(run: Run, pricing: PricingTable) {
  const dominant = dominantModel(run.spans);
  return dominant === undefined ? undefined : matchModel(pricing, dominant);
}

/** The llm calls a retry cluster bills: parents of the failures plus
 * same-scope llm calls inside the first→last failure window (B6 — parallel
 * sibling subtrees are never billed for a loop they did not run). */
function claimedLlmIds(
  cluster: RetryCluster,
  scopeIndex: Map<string, string>,
  sortedLlms: readonly Span[],
  llmIds: ReadonlySet<string>,
): Set<string> {
  const first = cluster.failures[0];
  const last = cluster.failures[cluster.failures.length - 1];
  const out = new Set<string>();
  if (!first || !last) return out;
  const windowStart = startMs(first);
  const windowEnd = startMs(last);
  // failure-parent llm calls are always claimed
  for (const f of cluster.failures) {
    if (f.parentId !== null && llmIds.has(f.parentId)) out.add(f.parentId);
  }
  // same-scope llm calls inside [windowStart, windowEnd] — binary-search the
  // window on the chronologically sorted array instead of scanning every llm
  // per cluster (was O(clusters·llms), the measured retry-loop quadratic)
  let lo = 0;
  let hi = sortedLlms.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (startMs(sortedLlms[mid] as Span) >= windowStart) hi = mid;
    else lo = mid + 1;
  }
  for (let i = lo; i < sortedLlms.length; i++) {
    const l = sortedLlms[i] as Span;
    if (startMs(l) > windowEnd) break;
    if (scopeIndex.get(l.id) === cluster.scopeId) out.add(l.id);
  }
  return out;
}

const retryLoop: InsightRule = {
  id: 'retry-loop',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const clusters = detectRetryClusters(run, ctx.thresholds.retryLoop);
    if (clusters.length === 0) return [];
    const scopeIndex = buildScopeIndex(run);
    const llms = chronological(run.spans.filter((s) => s.kind === 'llm_call'));
    const byId = new Map(llms.map((l) => [l.id, l]));
    const llmIds = new Set(llms.map((l) => l.id));
    // clusters are chronological; each llm call is billed to the FIRST cluster
    // whose window claims it, so overlapping same-scope clusters never
    // double-count the same dollars into wastedEstimate (mirrors dead-end-run)
    const alreadyBilled = new Set<string>();
    return clusters.map((cluster) => {
      const first = cluster.failures[0] as Span;
      const claimed = claimedLlmIds(cluster, scopeIndex, llms, llmIds);
      let wasted = 0;
      for (const id of claimed) {
        if (alreadyBilled.has(id)) continue;
        alreadyBilled.add(id);
        wasted += byId.get(id)?.llm?.costUSD ?? 0;
      }
      wasted = round6(wasted);
      const n = cluster.failures.length;
      return {
        ruleId: 'retry-loop',
        title: `${first.name} failed ${n}× in a row`,
        detail: `The same ${first.name} call failed ${n} consecutive attempts, driving ~${usd(wasted)} of same-scope model calls between the first and last attempt.`,
        spanIds: cluster.failures.map((s) => s.id),
        estimatedWasteUSD: wasted,
        suggestion: `Fix the failing ${first.name} invocation before retrying — each repeat re-bills the full context.`,
      };
    });
  },
};

const lowCacheHit: InsightRule = {
  id: 'low-cache-hit',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const cfg = ctx.thresholds;
    const { hitRate } = run.totals.cache;
    const { total } = run.totals.costUSD;
    const { llmCalls } = run.totals.counts;
    const t = cfg.lowCacheHit;
    if (
      hitRate >= t.maxHitRate ||
      total <= t.minCostUSD ||
      llmCalls < t.minLlmCalls
    )
      return [];

    const { input, cacheRead } = run.totals.tokens;
    const entry = dominantModelEntry(run, ctx.pricing);
    // hitRate = cacheRead / (cacheRead + input), so lifting it from h to the
    // target t means converting (t − h) × (input + cacheRead) tokens from the
    // input rate to the cache-read rate — scaling by bare `input` (the
    // uncached fraction) understated the target's savings whenever any reads
    // were already cached
    const waste =
      entry === undefined
        ? undefined
        : round6(
            (Math.max(0, t.targetHitRate - hitRate) *
              (input + cacheRead) *
              (entry.inputPerMTok - entry.cacheReadPerMTok)) /
              1e6,
          );
    const evidence = run.spans
      .filter(
        (s) =>
          s.kind === 'llm_call' &&
          s.llm &&
          s.llm.tokens.input > 0 &&
          s.llm.tokens.cacheRead === 0,
      )
      .slice(0, 5)
      .map((s) => s.id);
    return [
      {
        ruleId: 'low-cache-hit',
        title: `Cache hit-rate at ${(hitRate * 100).toFixed(1)}%`,
        detail: `Only ${tok(cacheRead)} of ${tok(cacheRead + input)} input-class tokens were served from cache; a stable session prefix would have converted most of the ${tok(input)} input tokens to cache reads.`,
        spanIds: evidence,
        ...(waste === undefined ? {} : { estimatedWasteUSD: waste }),
        suggestion:
          'Resume the same session for follow-up prompts instead of starting fresh.',
      },
    ];
  },
};

function median3(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[1] ?? 0;
}

const contextBloat: InsightRule = {
  id: 'context-bloat',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const cfg = ctx.thresholds;
    const llms = run.spans.filter((s) => s.kind === 'llm_call' && s.llm);
    if (llms.length < 6) return [];
    const inputs = llms.map((s) => s.llm?.tokens.input ?? 0);
    const first = median3(inputs.slice(0, 3));
    const last3 = llms.slice(-3);
    const last = median3(inputs.slice(-3));
    const t = cfg.contextBloat;
    if (last <= t.multiplier * first || last <= t.minMedianInputTokens)
      return [];

    const culprits = run.spans
      .filter(
        (s) =>
          (s.kind === 'tool_call' || s.kind === 'mcp_call') &&
          (s.tool?.outputBytes ?? 0) > 0,
      )
      .sort(
        (a, b) =>
          (b.tool?.outputBytes ?? 0) - (a.tool?.outputBytes ?? 0) ||
          (a.id < b.id ? -1 : 1),
      )
      .slice(0, t.topCulprits);
    const entry = dominantModelEntry(run, ctx.pricing);
    // cumulative excess beyond the opening baseline (B5) — the old
    // trailing-window approximation understated by ~(llmCalls/3)×
    const excessTokens = inputs
      .slice(3)
      .reduce((acc, v) => acc + Math.max(0, v - first), 0);
    const waste =
      entry === undefined
        ? undefined
        : round6((excessTokens * entry.inputPerMTok) / 1e6);
    return [
      {
        ruleId: 'context-bloat',
        title: `Context grew from ${tok(first)} to ${tok(last)} input tokens`,
        detail: `The median input of the last three model calls (${tok(last)}) is over ${t.multiplier}× the median of the first three (${tok(first)}); ~${tok(excessTokens)} cumulative excess input tokens were re-paid beyond the opening baseline. The largest tool outputs listed in evidence are the likely culprits.`,
        spanIds: [...last3.map((s) => s.id), ...culprits.map((s) => s.id)],
        ...(waste === undefined ? {} : { estimatedWasteUSD: waste }),
        suggestion:
          'Trim or paginate large tool outputs before they land in the context window.',
      },
    ];
  },
};

interface SubtreeInfo {
  root: Span;
  llmSpans: Span[];
  costUSD: number;
}

/** Innermost subagent subtrees qualifying as expensive (shared with
 * model-mismatch so the same dollars are never claimed twice — C6). */
function expensiveSubagentSubtrees(
  run: Run,
  thresholds: Thresholds,
): SubtreeInfo[] {
  const total = run.totals.costUSD.total;
  if (total <= 0) return [];
  const byId = new Map(run.spans.map((s) => [s.id, s]));
  const children = new Map<string, Span[]>();
  for (const s of run.spans) {
    if (s.parentId === null) continue;
    const list = children.get(s.parentId) ?? [];
    list.push(s);
    children.set(s.parentId, list);
  }
  const collectLlm = (root: Span): Span[] => {
    const out: Span[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const span = stack.pop();
      if (!span) break;
      if (span.kind === 'llm_call') out.push(span);
      for (const child of children.get(span.id) ?? []) stack.push(child);
    }
    return out;
  };
  const isDescendant = (span: Span, ancestorId: string): boolean => {
    let cur = span.parentId;
    while (cur !== null) {
      if (cur === ancestorId) return true;
      cur = byId.get(cur)?.parentId ?? null;
    }
    return false;
  };
  const t = thresholds.expensiveSubagent;
  const infos = run.spans
    .filter((s) => s.kind === 'subagent')
    .map((root) => {
      const llmSpans = collectLlm(root);
      return {
        root,
        llmSpans,
        costUSD: round6(
          llmSpans.reduce((acc, l) => acc + (l.llm?.costUSD ?? 0), 0),
        ),
      };
    })
    .filter(
      (i) =>
        i.costUSD > t.minShareOfRunCost * total && i.costUSD > t.minCostUSD,
    );
  // report only the innermost qualifying subagent — the actionable one
  return infos.filter(
    (i) =>
      !infos.some(
        (other) => other !== i && isDescendant(other.root, i.root.id),
      ),
  );
}

const expensiveSubagent: InsightRule = {
  id: 'expensive-subagent',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const total = run.totals.costUSD.total;
    if (total <= 0) return [];
    return expensiveSubagentSubtrees(run, ctx.thresholds).map((info) => {
      const cost = info.costUSD;
      const share = Math.round((cost / total) * 100);
      const name = info.root.agent?.name ?? info.root.name;
      // quantify via the repricing primitive at the suggested cheaper tier
      const dom = dominantModel(info.llmSpans);
      const sugg =
        dom === undefined ? undefined : suggestedDowngrade(dom, ctx.pricing);
      let saving: number | undefined;
      if (sugg !== undefined) {
        const targets = new Map<string, string>();
        for (const l of info.llmSpans) {
          if (l.llm !== undefined) targets.set(l.llm.model, sugg.target);
        }
        const repriced = repriceSpans(info.llmSpans, ctx.pricing, targets);
        const delta = repriced.reduce((acc, r) => acc + (r.deltaUSD ?? 0), 0);
        if (-delta > 0) saving = round6(-delta);
      }
      const base = `The ${name} subtree cost ${usd(cost)} of the run's ${usd(total)} (${share}%).`;
      // "say why" honestly: no-tier-resolves and tier-resolves-but-reprices-
      // no-cheaper are different reasons (unpriced spans, reported costs at
      // or below the target's rates) — the old copy claimed the first in both
      const noEstimate =
        sugg === undefined
          ? 'No cheaper same-family tier resolves in the pricing table, so no saving estimate is available.'
          : `A cheaper tier (${sugg.target}) resolves, but the subtree's calls could not be repriced cheaper (unpriced or already at/below that rate), so no saving estimate is available.`;
      return {
        ruleId: 'expensive-subagent',
        title: `Subagent ${name} consumed ${share}% of the run`,
        detail:
          saving === undefined
            ? `${base} ${noEstimate}`
            : `${base} At ${sugg?.target} rates the same tokens would have cost ~${usd(saving)} less.`,
        spanIds: [info.root.id],
        ...(saving === undefined ? {} : { estimatedWasteUSD: saving }),
        suggestion:
          saving === undefined
            ? `Delegate ${name} to a cheaper model — its subtree dominates the run's spend.`
            : `Delegating ${name} to ${sugg?.target} would have cost ~${usd(saving)} less (−${Math.round((saving / cost) * 100)}%), assuming identical token usage.`,
      };
    });
  },
};

const deadEndRun: InsightRule = {
  id: 'dead-end-run',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const nonSession = run.spans.filter((s) => s.kind !== 'session');
    const last = nonSession[nonSession.length - 1];
    const sessionError = run.spans.find(
      (s) => s.kind === 'session' && s.status === 'error',
    );
    const terminal =
      sessionError ?? (last?.status === 'error' ? last : undefined);
    if (terminal === undefined) return [];
    const total = run.totals.costUSD.total;

    // failed-tail attribution (B3): the productive marker is the last
    // successful tool span carrying code-change counts — the schema's only
    // outcome signal (same one deriveTotals uses)
    const markers = chronological(
      run.spans.filter(
        (s) =>
          (s.kind === 'tool_call' || s.kind === 'mcp_call') &&
          s.status === 'ok' &&
          (s.tool?.linesAdded !== undefined ||
            s.tool?.linesRemoved !== undefined),
      ),
    );
    const marker = markers[markers.length - 1];

    let waste = total;
    let detail = `The session terminated on a failing ${terminal.name} (${terminal.statusReason ?? 'error'}) after spending ${usd(total)} with no completed outcome.`;
    let suggestion =
      'Fix the terminal failure and rerun — the whole spend produced no result.';
    if (marker !== undefined) {
      const markerT = ms(marker.startedAt);
      const llms = chronological(
        run.spans.filter((s) => s.kind === 'llm_call'),
      );
      const llmIds = new Set(llms.map((l) => l.id));
      const scopeIndex = buildScopeIndex(run);
      const clusters = detectRetryClusters(run, ctx.thresholds.retryLoop);
      const claimed = new Set<string>();
      for (const cluster of clusters) {
        for (const id of claimedLlmIds(cluster, scopeIndex, llms, llmIds))
          claimed.add(id);
      }
      const tail = llms.filter(
        (l) => startMs(l) > markerT && !claimed.has(l.id),
      );
      waste = round6(
        Math.max(
          0,
          tail.reduce((acc, l) => acc + (l.llm?.costUSD ?? 0), 0),
        ),
      );
      detail = `The session terminated on a failing ${terminal.name} (${terminal.statusReason ?? 'error'}); ~${usd(waste)} of model calls after the last completed code change (${marker.name}) produced no result.`;
      suggestion =
        'Fix the terminal failure and rerun the failed tail — the spend before the last completed change is not lost.';
    }
    return [
      {
        ruleId: 'dead-end-run',
        title: 'Run ended in an error',
        detail,
        spanIds: [terminal.id],
        estimatedWasteUSD: waste,
        suggestion,
      },
    ];
  },
};

const modelMismatch: InsightRule = {
  id: 'model-mismatch',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const t = ctx.thresholds.modelMismatch;
    const byId = new Map(run.spans.map((s) => [s.id, s]));
    const excludedRoots = new Set(
      expensiveSubagentSubtrees(run, ctx.thresholds).map((i) => i.root.id),
    );
    const withinExcluded = (rootId: string | null): boolean => {
      let cur: string | null = rootId;
      while (cur !== null) {
        if (excludedRoots.has(cur)) return true;
        cur = byId.get(cur)?.parentId ?? null;
      }
      return false;
    };

    const models = [
      ...new Set(
        run.spans
          .filter((s) => s.kind === 'llm_call' && s.llm !== undefined)
          .map((s) => s.llm?.model ?? ''),
      ),
    ].sort();

    const findings: Finding[] = [];
    for (const model of models) {
      const sugg = suggestedDowngrade(model, ctx.pricing);
      if (sugg === undefined) continue;
      const result = repriceRun(
        run,
        ctx.pricing,
        new Map([[model, sugg.target]]),
        {
          riskToolCalls: t.riskToolCalls,
          riskContextTokens: t.riskContextTokens,
        },
      );
      const safeCells = result.subtrees.filter(
        (c) => c.flags.length === 0 && !withinExcluded(c.rootId),
      );
      const safeCellIds = new Set(safeCells.map((c) => c.rootId));
      const saving = round6(-safeCells.reduce((acc, c) => acc + c.deltaUSD, 0));
      if (saving < t.minSavingsUSD) continue;

      // per-span cell membership mirrors the engine's innermost-owner rule
      const ownerOf = (spanId: string): string | null => {
        let cur = byId.get(spanId)?.parentId ?? null;
        while (cur !== null) {
          const parent = byId.get(cur);
          if (parent === undefined) return null;
          if (parent.kind === 'subagent') return parent.id;
          cur = parent.parentId;
        }
        return null;
      };
      const modelSpans = result.spans.filter((s) => s.model === model);
      const safeSpans = modelSpans.filter(
        (s) => s.deltaUSD !== undefined && safeCellIds.has(ownerOf(s.spanId)),
      );
      const safeCurrent = round6(
        safeSpans.reduce((acc, s) => acc + (s.currentUSD ?? 0), 0),
      );
      const risky = result.subtrees.filter(
        (c) =>
          c.flags.length > 0 && !withinExcluded(c.rootId) && c.deltaUSD !== 0,
      ).length;
      const delegated = result.subtrees.filter(
        (c) => withinExcluded(c.rootId) && c.llmCalls > 0,
      ).length;
      const evidence = [...safeSpans]
        .sort(
          (a, b) =>
            (a.deltaUSD ?? 0) - (b.deltaUSD ?? 0) ||
            (a.spanId < b.spanId ? -1 : 1),
        )
        .slice(0, 5)
        .map((s) => s.spanId);

      const notes = [
        ...(risky > 0
          ? [`${risky} subtree(s) excluded as risky (errors/fan-out/context)`]
          : []),
        ...(delegated > 0
          ? [`${delegated} subtree(s) covered by the delegation finding`]
          : []),
      ];
      findings.push({
        ruleId: 'model-mismatch',
        title: `${modelSpans.length} calls on ${model} could run on ${sugg.target}`,
        detail: `${modelSpans.length} llm calls ran on ${model}; at ${sugg.target} rates the risk-free portion would cost ${usd(round6(safeCurrent - saving))} instead of ${usd(safeCurrent)} (−${usd(saving)}), estimated on identical token usage.${notes.length > 0 ? ` ${notes.join('; ')}.` : ''}`,
        spanIds: evidence,
        estimatedWasteUSD: saving,
        suggestion: `Try ${sugg.target} for this work — the risk-free portion reprices ${usd(saving)} cheaper.`,
      });
    }
    // first-evidence chronological order (engine contract) — the model loop
    // iterates alphabetically, which is not the same thing
    const startOf = new Map(run.spans.map((s) => [s.id, ms(s.startedAt)]));
    const firstEvidence = (f: Finding): number =>
      Math.min(
        ...f.spanIds.map((id) => startOf.get(id) ?? Number.POSITIVE_INFINITY),
      );
    return findings.sort(
      (a, b) =>
        firstEvidence(a) - firstEvidence(b) ||
        (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
    );
  },
};

/** Effective cache-write rate of one span's write at this entry's rates:
 * the 5m/1h blend from the adapter-recorded TTL split — the SAME math the
 * cost engine billed, so waste dollars reconcile with span costUSD. */
function spanCacheWriteRate(entry: PricingEntry, s: Span): number {
  const t = s.llm?.tokens;
  if (t === undefined) return entry.cacheWritePerMTok;
  return effectiveCacheWriteRate(entry, t, cacheWrite1hTokens(s.attributes, t));
}

/**
 * Per llm span: was the LIVE cache at that point written with a
 * majority-1h TTL? The TTL belongs to the cached prefix, not to the span
 * that happens to precede a gap — a pure-read turn carries no write of its
 * own, so the flag is taken from the most recent WRITING span in the same
 * (scope, model) stream (the same grouping as scopedSameModelPairs). The
 * majority test (1h share ≥ half the write) keeps a stray token of either
 * tier from flipping the whole cache's TTL.
 */
function liveCache1hIndex(run: Run): Set<string> {
  const scope = buildScopeIndex(run);
  const groups = new Map<string, Span[]>();
  for (const s of chronologicalLlmCalls(run)) {
    const key = `${scope.get(s.id) ?? s.id} ${s.llm?.model ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const live1h = new Set<string>();
  for (const list of groups.values()) {
    let writerIs1h = false;
    for (const s of list) {
      const t = s.llm?.tokens;
      if (t !== undefined && t.cacheWrite > 0) {
        writerIs1h = cacheWrite1hTokens(s.attributes, t) * 2 >= t.cacheWrite;
      }
      if (writerIs1h) live1h.add(s.id);
    }
  }
  return live1h;
}

/** Idle-expiry predicate shared for the B4/B5 precedence rule. The idle
 * threshold is the cache's actual TTL: when the live prefix at the pre-gap
 * span was written with a majority-1h share (`live1h`, from
 * liveCache1hIndex), the cache lived 60 minutes and a shorter gap cannot
 * have expired it — the configured `minIdleMinutes` (provider default TTL)
 * applies to 5m caches only. */
function isIdleExpiryPair(
  a: Span,
  b: Span,
  cfg: Thresholds['idleCacheExpiry'],
  live1h: boolean,
): boolean {
  const gapMs = ms(b.startedAt) - ms(a.endedAt ?? a.startedAt);
  const ttlMinutes = live1h
    ? Math.max(cfg.minIdleMinutes, 60)
    : cfg.minIdleMinutes;
  return (
    gapMs >= ttlMinutes * 60_000 &&
    (b.llm?.tokens.cacheWrite ?? 0) >= cfg.rewriteFloorTokens
  );
}

const cachePrefixBreak: InsightRule = {
  id: 'cache-prefix-break',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const cfg = ctx.thresholds.cachePrefixBreak;
    const findings: Finding[] = [];
    const live1h = liveCache1hIndex(run);
    for (const [a, b] of scopedSameModelPairs(run)) {
      const aRead = a.llm?.tokens.cacheRead ?? 0;
      const bRead = b.llm?.tokens.cacheRead ?? 0;
      const bWrite = b.llm?.tokens.cacheWrite ?? 0;
      if (
        aRead < cfg.minPrefixTokens ||
        bRead > cfg.collapseRatio * aRead ||
        bWrite < cfg.rewriteFloorTokens
      )
        continue;
      // cause-specific attribution: an idle gap claims the pair (B4/B5)
      if (
        isIdleExpiryPair(a, b, ctx.thresholds.idleCacheExpiry, live1h.has(a.id))
      )
        continue;
      const entry =
        b.llm === undefined ? undefined : matchModel(ctx.pricing, b.llm.model);
      const rewritten = Math.min(bWrite, aRead);
      const waste =
        entry === undefined
          ? undefined
          : round6(
              (rewritten *
                (spanCacheWriteRate(entry, b) - entry.cacheReadPerMTok)) /
                1e6,
            );
      findings.push({
        ruleId: 'cache-prefix-break',
        title: `Cache prefix broke mid-session (${tok(aRead)} → ${tok(bRead)} cached)`,
        detail: `Between two consecutive ${b.llm?.model} calls the cache read collapsed from ${tok(aRead)} to ${tok(bRead)} tokens while ${tok(bWrite)} tokens were re-written — content that was already cached was paid for again at the write premium.`,
        spanIds: [a.id, b.id],
        ...(waste === undefined ? {} : { estimatedWasteUSD: waste }),
        suggestion:
          'Keep the session prefix stable — editing early context or reconfiguring tools mid-session invalidates the cache.',
      });
    }
    return findings;
  },
};

const idleCacheExpiry: InsightRule = {
  id: 'idle-cache-expiry',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const cfg = ctx.thresholds.idleCacheExpiry;
    const findings: Finding[] = [];
    const live1h = liveCache1hIndex(run);
    for (const [a, b] of scopedSameModelPairs(run)) {
      if (!isIdleExpiryPair(a, b, cfg, live1h.has(a.id))) continue;
      const aRead = a.llm?.tokens.cacheRead ?? 0;
      const aWrite = a.llm?.tokens.cacheWrite ?? 0;
      const bWrite = b.llm?.tokens.cacheWrite ?? 0;
      const lost = Math.min(bWrite, aRead + aWrite);
      if (lost <= 0) continue; // nothing cached before the gap — nothing expired
      const entry =
        b.llm === undefined ? undefined : matchModel(ctx.pricing, b.llm.model);
      const waste =
        entry === undefined
          ? undefined
          : round6(
              (lost * (spanCacheWriteRate(entry, b) - entry.cacheReadPerMTok)) /
                1e6,
            );
      const gapMin = Math.round(
        (ms(b.startedAt) - ms(a.endedAt ?? a.startedAt)) / 60_000,
      );
      findings.push({
        ruleId: 'idle-cache-expiry',
        title: `Idle gap of ${gapMin}m expired the cache`,
        detail: `After ${gapMin} minutes of inactivity the provider cache TTL lapsed; the next ${b.llm?.model} call re-wrote ${tok(bWrite)} tokens of prefix that had been cached before the gap.`,
        spanIds: [a.id, b.id],
        ...(waste === undefined ? {} : { estimatedWasteUSD: waste }),
        suggestion:
          'Batch prompts or close the session instead of leaving it idle past the cache TTL.',
      });
    }
    return findings;
  },
};

const fixedContextOverhead: InsightRule = {
  id: 'fixed-context-overhead',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const cfg = ctx.thresholds.fixedContextOverhead;
    // scope to the main session: a subagent runs its own fresh context, so its
    // calls neither carry nor re-read the session's opening footprint. Counting
    // them inflated both the footprint owner (llms[0]) and the re-read
    // multiplier (llms.length − 1).
    const scope = buildScopeIndex(run);
    const scopeKind = new Map(run.spans.map((s) => [s.id, s.kind]));
    const llms = chronologicalLlmCalls(run).filter(
      (l) => scopeKind.get(scope.get(l.id) ?? '') !== 'subagent',
    );
    const first = llms[0];
    if (first?.llm === undefined || llms.length < cfg.minLlmCalls) return [];
    const t = first.llm.tokens;
    const footprint = t.input + t.cacheRead + t.cacheWrite;
    if (footprint < cfg.floorTokens) return [];
    const overhead = footprint - cfg.floorTokens;
    const entry = dominantModelEntry(run, ctx.pricing);
    // honest pricing (B5): the overhead is written once and READ (cheap) on
    // every later call — never priced at the full input rate. The write leg
    // uses the first call's 5m/1h blend DELIBERATELY: the estimate models
    // the overhead as cached prefix, and a hypothetical write inherits the
    // TTL the session actually caches at (all-1h session → 1h write), even
    // though the blend ratio comes from a smaller real write.
    const waste =
      entry === undefined
        ? undefined
        : round6(
            (overhead *
              (spanCacheWriteRate(entry, first) +
                entry.cacheReadPerMTok * (llms.length - 1))) /
              1e6,
          );
    return [
      {
        ruleId: 'fixed-context-overhead',
        title: `Session starts with a ${tok(footprint)}-token context footprint`,
        detail: `The first model call already carried ${tok(footprint)} input-class tokens (tool definitions, project instructions, attachments); ${tok(overhead)} tokens above the ${tok(cfg.floorTokens)} floor were written once and re-read on each of the ${llms.length - 1} later calls.`,
        spanIds: [first.id],
        ...(waste === undefined ? {} : { estimatedWasteUSD: waste }),
        suggestion:
          'Trim MCP tool definitions and project instructions — fixed context is re-paid by every call in every session.',
      },
    ];
  },
};

const duplicateRead: InsightRule = {
  id: 'duplicate-read',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const cfg = ctx.thresholds.duplicateRead;
    const attr = (s: Span, key: string): string | undefined => {
      const v = (s.attributes as Record<string, unknown>)[key];
      return typeof v === 'string' ? v : undefined;
    };
    const getTargetKey = (s: Span) =>
      attr(s, 'runray.targetKey') ?? attr(s, 'tracepulse.targetKey');
    const getTargetKind = (s: Span) =>
      attr(s, 'runray.targetKind') ?? attr(s, 'tracepulse.targetKind');
    const getTargetDisplay = (s: Span) =>
      attr(s, 'runray.target') ?? attr(s, 'tracepulse.target');
    const tools = chronological(
      run.spans.filter(
        (s) =>
          (s.kind === 'tool_call' || s.kind === 'mcp_call') &&
          s.status === 'ok' &&
          getTargetKey(s) !== undefined,
      ),
    );
    // reads bucket by (scope, targetKey): a re-read is only redundant within
    // ONE context window, so parallel subagents each reading the same file are
    // not billed against each other. Writes bucket by target only — a write
    // anywhere changes the file, legitimizing a later read in any scope.
    const scope = buildScopeIndex(run);
    const readsByScopeKey = new Map<string, Span[]>();
    const writesByKey = new Map<string, Span[]>();
    for (const s of tools) {
      const key = getTargetKey(s) as string;
      const kind = getTargetKind(s);
      if (kind === 'file-read') {
        const sk = `${scope.get(s.id) ?? s.id} ${key}`;
        const list = readsByScopeKey.get(sk) ?? [];
        list.push(s);
        readsByScopeKey.set(sk, list);
      } else if (kind === 'file-write') {
        const list = writesByKey.get(key) ?? [];
        list.push(s);
        writesByKey.set(key, list);
      }
    }

    const entry = dominantModelEntry(run, ctx.pricing);
    const findings: Finding[] = [];
    for (const [scopeKey, reads] of readsByScopeKey) {
      if (reads.length < 2) continue;
      const key = scopeKey.slice(scopeKey.indexOf(' ') + 1);
      const writes = writesByKey.get(key) ?? [];
      // writes are chronological (built from the chronological `tools` scan);
      // binary-search each read pair's window instead of rescanning every
      // write and re-parsing timestamps per pair (was O(reads·writes))
      const writeMs = writes.map(startMs);
      const hasWriteIn = (lo: number, hi: number): boolean => {
        // first write with ms > lo
        let a = 0;
        let b = writeMs.length;
        while (a < b) {
          const mid = (a + b) >> 1;
          if ((writeMs[mid] as number) > lo) b = mid;
          else a = mid + 1;
        }
        return a < writeMs.length && (writeMs[a] as number) <= hi;
      };
      const wasted: Span[] = [];
      for (let i = 1; i < reads.length; i++) {
        const cur = reads[i] as Span;
        if (!hasWriteIn(startMs(reads[i - 1] as Span), startMs(cur))) {
          wasted.push(cur);
        }
      }
      if (wasted.length < cfg.minRepeats - 1) continue;
      const wastedBytes = wasted.reduce(
        (acc, s) => acc + (s.tool?.outputBytes ?? 0),
        0,
      );
      // bytes/4 is an explicit token heuristic — the re-read content
      // re-enters the context as fresh input once
      const waste =
        entry === undefined
          ? undefined
          : round6(((wastedBytes / 4) * entry.inputPerMTok) / 1e6);
      const display = getTargetDisplay(reads[0] as Span);
      // copy counts the REDUNDANT re-reads, not all reads — a write between
      // some pair legitimizes the read after it, and saying "N× without
      // changes" with the total count would be factually wrong then
      findings.push({
        ruleId: 'duplicate-read',
        title: `Same file re-read ${wasted.length}× without changes`,
        detail: `${display === undefined ? 'The same target' : `“${display}”`} was read ${reads.length} times; ${wasted.length} of those read(s) had no write in between and re-entered ≈${tok(Math.round(wastedBytes / 4))} tokens of unchanged content into the context.`,
        // evidence: the reference read + the redundant ones (legitimate
        // post-write reads are not part of the claim)
        spanIds: [reads[0] as Span, ...wasted].slice(0, 10).map((s) => s.id),
        ...(waste === undefined ? {} : { estimatedWasteUSD: waste }),
        suggestion:
          'Reference the earlier read instead — the file did not change between reads.',
      });
    }
    return findings.sort((a, b) => {
      const fa = a.spanIds[0] ?? '';
      const fb = b.spanIds[0] ?? '';
      const sa = tools.findIndex((s) => s.id === fa);
      const sb = tools.findIndex((s) => s.id === fb);
      return sa - sb;
    });
  },
};

const scatteredToolFailures: InsightRule = {
  id: 'scattered-tool-failures',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const cfg = ctx.thresholds.scatteredToolFailures;
    const toolCalls = run.totals.counts.toolCalls;
    if (toolCalls === 0) return [];
    const clusters = detectRetryClusters(run, ctx.thresholds.retryLoop);
    const claimed = new Set(
      clusters.flatMap((c) => c.failures.map((s) => s.id)),
    );
    const failures = chronological(
      run.spans.filter(
        (s) =>
          (s.kind === 'tool_call' || s.kind === 'mcp_call') &&
          s.status === 'error' &&
          !claimed.has(s.id),
      ),
    );
    if (
      failures.length < cfg.minFailures ||
      failures.length / toolCalls < cfg.minErrorShare
    )
      return [];

    // price the distinct llm calls that reacted to the failures. Group llm
    // calls by scope once (each list stays chronological) and binary-search
    // the first same-scope call at/after each failure — the old llms.find
    // from index 0 per failure was O(failures·llms)
    const scopeIndex = buildScopeIndex(run);
    const llms = chronologicalLlmCalls(run);
    const llmsByScope = new Map<string, Span[]>();
    for (const l of llms) {
      const sid = scopeIndex.get(l.id) ?? l.id;
      const list = llmsByScope.get(sid) ?? [];
      list.push(l);
      llmsByScope.set(sid, list);
    }
    const reactions = new Set<string>();
    for (const f of failures) {
      const after = endMs(f);
      const scoped = llmsByScope.get(scopeIndex.get(f.id) ?? f.id);
      if (scoped === undefined) continue;
      let lo = 0;
      let hi = scoped.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (startMs(scoped[mid] as Span) >= after) hi = mid;
        else lo = mid + 1;
      }
      if (lo < scoped.length) reactions.add((scoped[lo] as Span).id);
    }
    const waste = round6(
      llms
        .filter((l) => reactions.has(l.id))
        .reduce((acc, l) => acc + (l.llm?.costUSD ?? 0), 0),
    );
    const byName = new Map<string, number>();
    for (const f of failures) byName.set(f.name, (byName.get(f.name) ?? 0) + 1);
    const dominant = [...byName.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    )[0]?.[0];
    const share = Math.round((failures.length / toolCalls) * 100);
    return [
      {
        ruleId: 'scattered-tool-failures',
        title: `${failures.length} scattered tool failures outside retry loops`,
        detail: `${failures.length} of ${toolCalls} tool calls (${share}%) failed outside any retry loop; the model calls reacting to them cost ~${usd(waste)}.`,
        spanIds: failures.slice(0, 10).map((s) => s.id),
        estimatedWasteUSD: waste,
        suggestion: `Investigate ${dominant} — it accounts for the largest share of the scattered failures.`,
      },
    ];
  },
};

const oversizedOutput: InsightRule = {
  id: 'oversized-output',
  evaluate(run: Run, ctx: RuleContext): Finding[] {
    const cfg = ctx.thresholds.oversizedOutput;
    const offenders = run.spans
      .filter(
        (s) =>
          (s.kind === 'tool_call' || s.kind === 'mcp_call') &&
          (s.tool?.outputBytes ?? 0) >= cfg.minOutputBytes,
      )
      .sort(
        (a, b) =>
          (b.tool?.outputBytes ?? 0) - (a.tool?.outputBytes ?? 0) ||
          (a.id < b.id ? -1 : 1),
      );
    if (offenders.length === 0) return [];
    const totalBytes = offenders.reduce(
      (acc, s) => acc + (s.tool?.outputBytes ?? 0),
      0,
    );
    const entry = dominantModelEntry(run, ctx.pricing);
    const waste =
      entry === undefined
        ? undefined
        : round6(((totalBytes / 4) * entry.inputPerMTok) / 1e6);
    const top = offenders[0];
    return [
      {
        ruleId: 'oversized-output',
        title: `${offenders.length} oversized tool output${offenders.length === 1 ? '' : 's'} entered the context`,
        detail: `${offenders.length} tool call(s) returned ≥${tok(cfg.minOutputBytes)} bytes (largest: ${top?.name} at ${tok(top?.tool?.outputBytes ?? 0)} bytes); ≈${tok(Math.round(totalBytes / 4))} tokens of tool output entered the context. Output utility is unknowable, so this is an opportunity, never burned waste.`,
        spanIds: offenders.slice(0, cfg.topOffenders).map((s) => s.id),
        ...(waste === undefined ? {} : { estimatedWasteUSD: waste }),
        suggestion:
          'Paginate or filter large tool outputs before they land in the context window.',
      },
    ];
  },
};

/** FROZEN registration order (B8) — insight ids depend on it. */
export const V0_RULES: readonly InsightRule[] = [
  retryLoop,
  lowCacheHit,
  contextBloat,
  expensiveSubagent,
  deadEndRun,
  modelMismatch,
  cachePrefixBreak,
  idleCacheExpiry,
  fixedContextOverhead,
  duplicateRead,
  scatteredToolFailures,
  oversizedOutput,
];
