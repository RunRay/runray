/**
 * Browser-safe pricing engine (add-profiler-depth C1/X1). Pure math over
 * pricing tables and token counts — no snapshot, no node builtins, no
 * adapter imports (schema types only, erased at compile time). This module
 * is exported as `@runray/core/pricing` and must stay bundleable by Vite
 * for the visualizer and offline exports; the browser-safe import-graph
 * test enforces that. Matching: exact → prefix → alias → separator-loose
 * retry (05-ARCHITECTURE §2.3). Insight dollars and the interactive what-if
 * panel share THIS implementation — byte-identical math is the product's
 * trust story.
 */

import type { Run, Span } from '@runray/schema';

export interface PricingEntry {
  modelPattern: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  /** Default (5-minute TTL) cache-write rate. */
  cacheWritePerMTok: number;
  /** 1-hour-TTL cache-write rate, when the source publishes one. */
  cacheWrite1hPerMTok?: number;
}

export interface PricingTable {
  snapshotDate: string;
  source: 'litellm-snapshot';
  /** Model-name aliases resolved before matching (e.g. vendor renames). */
  aliases: Record<string, string>;
  entries: PricingEntry[];
}

/** Boundary characters allowed right after a prefix match (dated variants etc.). */
const PREFIX_BOUNDARY = new Set(['-', '.', ':', '@']);

export function canonicalModelName(model: string): string {
  return model
    .toLowerCase()
    .trim()
    .replace(/^[a-z0-9_.-]+\//, '') // provider prefix, e.g. anthropic/claude-…
    .replace(/-latest$/, '');
}

/**
 * Version separators differ between catalogs for the SAME model: LiteLLM
 * ships `claude-opus-4-5`, while OpenCode's zen provider records it as
 * `claude-opus-4.5`. Collapsing a `.` that sits between two digits to `-`
 * folds both spellings onto one key, so a dot-form log matches a dash-form
 * snapshot (and vice versa) instead of dropping out as `costSource:
 * 'unknown'`.
 */
export function looseModelKey(canonical: string): string {
  return canonical.replace(/(\d)\.(?=\d)/g, '$1-');
}

/** Longest prefix wins; a verbatim match outranks the separator-loose one
 * of the same length. Exact matches short-circuit before any of this. */
interface PrefixHit {
  entry: PricingEntry;
  length: number;
  verbatim: boolean;
}

function betterPrefix(hit: PrefixHit, best: PrefixHit | undefined): boolean {
  if (best === undefined) return true;
  if (hit.length !== best.length) return hit.length > best.length;
  return hit.verbatim && !best.verbatim;
}

function prefixHit(
  entry: PricingEntry,
  pattern: string,
  canon: string,
  verbatim: boolean,
): PrefixHit | undefined {
  if (!canon.startsWith(pattern)) return undefined;
  if (!PREFIX_BOUNDARY.has(canon[pattern.length] ?? '')) return undefined;
  return { entry, length: pattern.length, verbatim };
}

/**
 * exact → longest prefix (on a word boundary) → alias, per 05-ARCHITECTURE
 * §2.3, with every comparison also tried on separator-normalized keys
 * (`looseModelKey`) so a dot-form log id meets a dash-form catalog. An
 * exact match — in either spelling — always beats a prefix, so
 * `claude-sonnet-4.6` prices as `claude-sonnet-4-6` rather than falling
 * back to the coarser `claude-sonnet-4` family rate. Loose keys never
 * invent a match the catalog does not contain: they only re-spell the
 * version separator.
 */
export function matchModel(
  table: PricingTable,
  model: string,
): PricingEntry | undefined {
  let canon = canonicalModelName(model);
  const alias = table.aliases[canon];
  if (alias !== undefined) canon = alias;
  const looseCanon = looseModelKey(canon);

  let best: PrefixHit | undefined;
  let looseExact: PricingEntry | undefined;
  for (const entry of table.entries) {
    const pattern = entry.modelPattern;
    if (pattern === canon) return entry;
    const loosePattern = looseModelKey(pattern);
    if (looseExact === undefined && loosePattern === looseCanon) {
      looseExact = entry;
      continue;
    }
    const hit =
      prefixHit(entry, pattern, canon, true) ??
      prefixHit(entry, loosePattern, looseCanon, false);
    if (hit !== undefined && betterPrefix(hit, best)) best = hit;
  }
  return looseExact ?? best?.entry;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
}

export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Adapter-emitted attribute carrying the 1-hour-TTL share of
 * `tokens.cacheWrite` (a count, never content — redact-safe). The schema's
 * token quad is frozen, so the TTL split travels in span attributes.
 */
export const CACHE_WRITE_1H_ATTR = 'tracepulse.cacheWrite1hTokens';

/** NaN-safe [0, cacheWrite] clamp — the ONE definition of the invariant
 * every cost path relies on, regardless of caller hygiene. */
function clampOneHour(cacheWrite1h: number, cacheWrite: number): number {
  if (!Number.isFinite(cacheWrite1h) || !Number.isFinite(cacheWrite)) return 0;
  return Math.min(Math.max(0, cacheWrite1h), Math.max(0, cacheWrite));
}

/** 1h share of cacheWrite from span attributes, clamped to [0, cacheWrite].
 * Numeric strings are accepted: OTLP emitters routinely encode int64
 * attribute values as decimal strings, and silently dropping the count
 * would underprice the span with no signal. Rounding matches the
 * claude-code adapter's `int()` so both ingest paths agree. */
export function cacheWrite1hTokens(
  attributes: Record<string, unknown> | undefined,
  tokens: TokenCounts,
): number {
  const raw = attributes?.[CACHE_WRITE_1H_ATTR];
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return clampOneHour(Math.round(n), tokens.cacheWrite);
}

/** 1h cache-write rate for THIS entry: the published rate when the table
 * carries one; else Anthropic's documented 1h premium (2× the base input
 * rate) for claude entries — matched by substring, so bedrock/vertex-style
 * ids (`us.anthropic.claude-…`) and hand-written user tables qualify too.
 * Any other provider has no TTL-tiered cache product, so a 1h share
 * carried over from an Anthropic source span (e.g. a what-if reprice
 * target) bills at the entry's plain write rate — the engine never invents
 * a premium a provider does not charge. */
function cacheWrite1hRate(entry: PricingEntry): number {
  if (entry.cacheWrite1hPerMTok !== undefined) return entry.cacheWrite1hPerMTok;
  return entry.modelPattern.includes('claude')
    ? entry.inputPerMTok * 2
    : entry.cacheWritePerMTok;
}

/** The blended cache-write dollar numerator (`tokens × perMTok`, before
 * the /1e6) — the ONE definition of the 5m/1h blend algebra, shared by the
 * span-cost path and the effective-rate path so they can never diverge.
 * `oneHour` must already be clamped. */
function cacheWriteComponent(
  entry: PricingEntry,
  tokens: TokenCounts,
  oneHour: number,
): number {
  return (
    (tokens.cacheWrite - oneHour) * entry.cacheWritePerMTok +
    oneHour * cacheWrite1hRate(entry)
  );
}

/**
 * Effective per-MTok rate of a span's whole cache write: the 5m/1h blend at
 * this entry's rates. Insight rules that price re-written cache tokens MUST
 * use this instead of raw `cacheWritePerMTok`, so waste dollars reconcile
 * with the span costs computed by the same table ("byte-identical math").
 */
export function effectiveCacheWriteRate(
  entry: PricingEntry,
  tokens: TokenCounts,
  cacheWrite1h: number,
): number {
  const total = tokens.cacheWrite;
  if (!(total > 0)) return entry.cacheWritePerMTok;
  const oneHour = clampOneHour(cacheWrite1h, total);
  return cacheWriteComponent(entry, tokens, oneHour) / total;
}

/** Reasoning tokens are billed at the output rate (v0.1 simplification).
 * `cacheWrite1h` is the 1-hour-TTL share of `tokens.cacheWrite`; it is
 * re-clamped here (NaN-safe) so the invariant is local — an unclamped
 * caller can never produce a negative 5m term, price more 1h tokens than
 * were written, or poison the total with NaN. */
export function computeCostUSD(
  entry: PricingEntry,
  tokens: TokenCounts,
  cacheWrite1h = 0,
): number {
  const oneHour = clampOneHour(cacheWrite1h, tokens.cacheWrite);
  const usd =
    (tokens.input * entry.inputPerMTok +
      (tokens.output + (tokens.reasoning ?? 0)) * entry.outputPerMTok +
      tokens.cacheRead * entry.cacheReadPerMTok +
      cacheWriteComponent(entry, tokens, oneHour)) /
    1e6;
  return round6(usd);
}

/**
 * Versioned, hardcoded model-tier ladders (C4): per family, stages ordered
 * most→least capable. `test` decides stage membership on the canonical
 * model name (most-specific stages listed first within a family); `target`
 * is the canonical id a downgrade suggestion resolves against the
 * EFFECTIVE table — a refreshed table missing every lower target degrades
 * to "no suggestion", never a bad one. The snapshot build script warns
 * when a target vanishes from a refreshed snapshot.
 */
export interface TierStage {
  /** Stable stage id, e.g. 'claude/opus'. */
  id: string;
  /** Canonical model id suggested when downgrading INTO this stage. */
  target: string;
  test(canonicalModel: string): boolean;
}

export const MODEL_TIERS: readonly (readonly TierStage[])[] = [
  [
    {
      id: 'claude/fable',
      target: 'claude-fable-5',
      test: (m) => m.startsWith('claude-') && m.includes('-fable'),
    },
    {
      id: 'claude/opus',
      target: 'claude-opus-4-8',
      test: (m) => m.startsWith('claude-') && m.includes('-opus'),
    },
    {
      id: 'claude/sonnet',
      target: 'claude-sonnet-5',
      test: (m) => m.startsWith('claude-') && m.includes('-sonnet'),
    },
    {
      id: 'claude/haiku',
      target: 'claude-haiku-4-5',
      test: (m) => m.startsWith('claude-') && m.includes('-haiku'),
    },
  ],
  [
    // most-specific first: nano before mini before the flagship catch-all
    {
      id: 'gpt/nano',
      target: 'gpt-5.4-nano',
      test: (m) => m.startsWith('gpt-5') && m.includes('-nano'),
    },
    {
      id: 'gpt/mini',
      target: 'gpt-5.4-mini',
      test: (m) => m.startsWith('gpt-5') && m.includes('-mini'),
    },
    {
      id: 'gpt/flagship',
      target: 'gpt-5.5',
      test: (m) => m.startsWith('gpt-5'),
    },
  ],
  [
    {
      id: 'gemini/flash-lite',
      target: 'gemini-3.1-flash-lite',
      test: (m) => m.startsWith('gemini-') && m.includes('flash-lite'),
    },
    {
      id: 'gemini/flash',
      target: 'gemini-3.5-flash',
      test: (m) => m.startsWith('gemini-') && m.includes('-flash'),
    },
    {
      id: 'gemini/pro',
      target: 'gemini-3.1-pro-preview',
      test: (m) => m.startsWith('gemini-') && m.includes('-pro'),
    },
  ],
];

/** Capability order within each family, most→least capable. */
const LADDER_ORDER: readonly (readonly string[])[] = [
  ['claude/fable', 'claude/opus', 'claude/sonnet', 'claude/haiku'],
  ['gpt/flagship', 'gpt/mini', 'gpt/nano'],
  ['gemini/pro', 'gemini/flash', 'gemini/flash-lite'],
];

export interface DowngradeSuggestion {
  /** Canonical target model id (a MODEL_TIERS stage target). */
  target: string;
  entry: PricingEntry;
}

/**
 * The next-cheaper same-family stage whose target resolves in the
 * effective table with nonzero base rates (guards zero-rate preview
 * entries). Walks further down when an intermediate stage is missing;
 * models outside every ladder, or already at the bottom, yield nothing.
 * Deterministic, offline — no network, no config.
 */
export function suggestedDowngrade(
  model: string,
  table: PricingTable,
): DowngradeSuggestion | undefined {
  const canon = canonicalModelName(model);
  for (let f = 0; f < MODEL_TIERS.length; f++) {
    const stages = MODEL_TIERS[f];
    const order = LADDER_ORDER[f];
    if (!stages || !order) continue;
    const stage = stages.find((s) => s.test(canon));
    if (stage === undefined) continue;
    const from = order.indexOf(stage.id);
    for (let i = from + 1; i < order.length; i++) {
      const next = stages.find((s) => s.id === order[i]);
      if (next === undefined) continue;
      const entry = matchModel(table, next.target);
      if (
        entry !== undefined &&
        entry.inputPerMTok > 0 &&
        entry.outputPerMTok > 0
      ) {
        return { target: next.target, entry };
      }
    }
    return undefined; // in a ladder, but nothing cheaper resolves
  }
  return undefined;
}

/**
 * What-if repricing (C5/C8): the same token quads at target rates — an
 * ESTIMATE, never a quote (tokenizer variance is acknowledged in every
 * consumer's copy). Unknown-cost spans never fabricate a delta; they taint
 * their subtree `unpriced` and stay out of the safe figure.
 */

export interface RepricedSpan {
  spanId: string;
  model: string;
  /** Target model this span was repriced at (itself when unmapped). */
  target: string;
  /** Current cost — undefined when costSource is 'unknown'. */
  currentUSD: number | undefined;
  repricedUSD: number | undefined;
  /** repriced − current; undefined when either side is unknown. */
  deltaUSD: number | undefined;
}

export type SubtreeRiskFlag =
  | 'errors'
  | 'tool-fanout'
  | 'long-context'
  | 'unpriced';

export interface RepriceRiskThresholds {
  /** tool_call+mcp_call count at/above which a subtree is fanout-risky. */
  riskToolCalls: number;
  /** input+cacheRead tokens at/above which one llm call is context-risky. */
  riskContextTokens: number;
}

export const DEFAULT_REPRICE_RISK: RepriceRiskThresholds = {
  riskToolCalls: 25,
  riskContextTokens: 150_000,
};

/**
 * One attribution cell: an innermost subagent subtree, or the main session
 * (`rootId: null`). These cells are THE canonical subtree attribution —
 * the treemap's own-values and insight quantification must both derive
 * from them so no two surfaces can disagree.
 */
export interface RepricedSubtree {
  rootId: string | null;
  name: string;
  llmCalls: number;
  currentUSD: number;
  repricedUSD: number;
  deltaUSD: number;
  /** Stable order: errors, tool-fanout, long-context, unpriced. */
  flags: SubtreeRiskFlag[];
}

export interface RepriceResult {
  /** Per llm_call span, in run (normalized) order. */
  spans: RepricedSpan[];
  /** Attribution cells, |delta| descending then rootId ascending. */
  subtrees: RepricedSubtree[];
  currentUSD: number;
  repricedUSD: number;
  deltaUSD: number;
  /** Delta summed over flag-free subtrees only. */
  safeDeltaUSD: number;
}

/**
 * Default source→target mapping: each distinct model maps to its suggested
 * downgrade, or to itself (zero delta) when none resolves. Deterministic:
 * models enumerated in sorted order.
 */
export function downgradeMap(
  run: Run,
  table: PricingTable,
): Map<string, string> {
  const models = new Set<string>();
  for (const s of run.spans) {
    if (s.kind === 'llm_call' && s.llm !== undefined) models.add(s.llm.model);
  }
  const out = new Map<string, string>();
  for (const model of [...models].sort()) {
    out.set(model, suggestedDowngrade(model, table)?.target ?? model);
  }
  return out;
}

/** Reprice llm spans against a source→target mapping (order preserved). */
export function repriceSpans(
  spans: readonly Span[],
  table: PricingTable,
  targets: ReadonlyMap<string, string>,
): RepricedSpan[] {
  const out: RepricedSpan[] = [];
  for (const s of spans) {
    if (s.kind !== 'llm_call' || s.llm === undefined) continue;
    const model = s.llm.model;
    const target = targets.get(model) ?? model;
    const current = s.llm.costSource === 'unknown' ? undefined : s.llm.costUSD;
    if (target === model) {
      // self-mapped: contributes zero delta by definition (C8) — never
      // recomputed, so reported costs keep their reported figure
      out.push({
        spanId: s.id,
        model,
        target,
        currentUSD: current,
        repricedUSD: current,
        deltaUSD: current === undefined ? undefined : 0,
      });
      continue;
    }
    const entry = matchModel(table, target);
    if (current === undefined || entry === undefined) {
      out.push({
        spanId: s.id,
        model,
        target,
        currentUSD: current,
        repricedUSD: undefined,
        deltaUSD: undefined,
      });
      continue;
    }
    const repriced = computeCostUSD(
      entry,
      s.llm.tokens,
      cacheWrite1hTokens(s.attributes, s.llm.tokens),
    );
    out.push({
      spanId: s.id,
      model,
      target,
      currentUSD: current,
      repricedUSD: repriced,
      deltaUSD: round6(repriced - current),
    });
  }
  return out;
}

const SUBTREE_FLAG_ORDER: readonly SubtreeRiskFlag[] = [
  'errors',
  'tool-fanout',
  'long-context',
  'unpriced',
];

/** Innermost owner (nearest subagent ancestor; null = main session). */
function buildOwnerIndex(run: Run): Map<string, string | null> {
  const byId = new Map(run.spans.map((s) => [s.id, s]));
  const owner = new Map<string, string | null>();
  const resolve = (span: Span): string | null => {
    const cached = owner.get(span.id);
    if (cached !== undefined) return cached;
    const parent = span.parentId === null ? undefined : byId.get(span.parentId);
    const result =
      parent === undefined
        ? null
        : parent.kind === 'subagent'
          ? parent.id
          : resolve(parent);
    owner.set(span.id, result);
    return result;
  };
  for (const span of run.spans) resolve(span);
  return owner;
}

/**
 * Reprice a run into per-span deltas and canonical attribution cells with
 * risk flags. `targets` defaults to the downgrade map; risk thresholds
 * default to DEFAULT_REPRICE_RISK (callers that thread the configurable
 * insight thresholds pass them explicitly).
 */
export function repriceRun(
  run: Run,
  table: PricingTable,
  targets: ReadonlyMap<string, string> = downgradeMap(run, table),
  risk: RepriceRiskThresholds = DEFAULT_REPRICE_RISK,
): RepriceResult {
  const spans = repriceSpans(run.spans, table, targets);
  const bySpanId = new Map(spans.map((r) => [r.spanId, r]));
  const owner = buildOwnerIndex(run);

  interface CellAcc {
    rootId: string | null;
    name: string;
    llmCalls: number;
    currentUSD: number;
    deltaUSD: number;
    flags: Set<SubtreeRiskFlag>;
    toolCalls: number;
  }
  const cells = new Map<string | null, CellAcc>();
  const ensureCell = (rootId: string | null, name: string): CellAcc => {
    const existing = cells.get(rootId);
    if (existing !== undefined) return existing;
    const fresh: CellAcc = {
      rootId,
      name,
      llmCalls: 0,
      currentUSD: 0,
      deltaUSD: 0,
      flags: new Set(),
      toolCalls: 0,
    };
    cells.set(rootId, fresh);
    return fresh;
  };

  ensureCell(null, 'main session');
  for (const s of run.spans) {
    if (s.kind === 'subagent') ensureCell(s.id, s.agent?.name ?? s.name);
  }

  for (const s of run.spans) {
    // the subagent root span belongs to its own subtree ("inside" includes
    // the root — a failed delegation flags its own cell risky)
    const cell = cells.get(
      s.kind === 'subagent' ? s.id : (owner.get(s.id) ?? null),
    );
    if (cell === undefined) continue;
    if (s.status === 'error') cell.flags.add('errors');
    if (s.kind === 'tool_call' || s.kind === 'mcp_call') cell.toolCalls += 1;
    if (s.kind === 'llm_call' && s.llm !== undefined) {
      cell.llmCalls += 1;
      const tokens = s.llm.tokens;
      if (tokens.input + tokens.cacheRead >= risk.riskContextTokens) {
        cell.flags.add('long-context');
      }
      const priced = bySpanId.get(s.id);
      if (priced !== undefined) {
        if (priced.currentUSD !== undefined) {
          cell.currentUSD += priced.currentUSD;
        }
        if (priced.deltaUSD !== undefined) cell.deltaUSD += priced.deltaUSD;
        else cell.flags.add('unpriced');
      }
    }
  }
  for (const cell of cells.values()) {
    if (cell.toolCalls >= risk.riskToolCalls) cell.flags.add('tool-fanout');
  }

  const subtrees: RepricedSubtree[] = [...cells.values()]
    .map((c) => ({
      rootId: c.rootId,
      name: c.name,
      llmCalls: c.llmCalls,
      currentUSD: round6(c.currentUSD),
      repricedUSD: round6(c.currentUSD + c.deltaUSD),
      deltaUSD: round6(c.deltaUSD),
      flags: SUBTREE_FLAG_ORDER.filter((f) => c.flags.has(f)),
    }))
    .sort(
      (a, b) =>
        Math.abs(b.deltaUSD) - Math.abs(a.deltaUSD) ||
        ((a.rootId ?? '') < (b.rootId ?? '')
          ? -1
          : (a.rootId ?? '') > (b.rootId ?? '')
            ? 1
            : 0),
    );

  const currentUSD = round6(
    spans.reduce((acc, s) => acc + (s.currentUSD ?? 0), 0),
  );
  const deltaUSD = round6(spans.reduce((acc, s) => acc + (s.deltaUSD ?? 0), 0));
  const safeDeltaUSD = round6(
    subtrees
      .filter((c) => c.flags.length === 0)
      .reduce((acc, c) => acc + c.deltaUSD, 0),
  );
  return {
    spans,
    subtrees,
    currentUSD,
    repricedUSD: round6(currentUSD + deltaUSD),
    deltaUSD,
    safeDeltaUSD,
  };
}

/**
 * Unpriced-cost coverage (C7): how much of a run's llm activity carries no
 * price (`costSource: 'unknown'`) — the honesty statistic behind every
 * "totals are understated" banner and waste-figure caveat. Derived purely
 * from spans, recomputed on demand, never persisted (the frozen RunTotals
 * cannot carry it). The UI mirrors this computation in `ui/lib/coverage.ts`.
 */
export interface UnpricedCoverage {
  llmCalls: number;
  unpricedLlmCalls: number;
  /** Full token quad (incl. reasoning) summed over unpriced calls. */
  unpricedTokens: number;
  /** Offending model names, sorted ascending. */
  models: string[];
  complete: boolean;
}

export function unpricedCoverage(run: Run): UnpricedCoverage {
  let llmCalls = 0;
  let unpricedLlmCalls = 0;
  let unpricedTokens = 0;
  const models = new Set<string>();
  for (const s of run.spans) {
    if (s.kind !== 'llm_call' || s.llm === undefined) continue;
    llmCalls += 1;
    if (s.llm.costSource !== 'unknown') continue;
    unpricedLlmCalls += 1;
    const t = s.llm.tokens;
    unpricedTokens +=
      t.input + t.output + t.cacheRead + t.cacheWrite + (t.reasoning ?? 0);
    models.add(s.llm.model);
  }
  return {
    llmCalls,
    unpricedLlmCalls,
    unpricedTokens,
    models: [...models].sort(),
    complete: unpricedLlmCalls === 0,
  };
}
