export { SCHEMA_VERSION } from '@runray/schema';
export type {
  Candidate,
  ParseOptions,
  RawRun,
  RawSpan,
  RunWarning,
  SourceAdapter,
} from './adapter.js';
export type { AdapterRegistry } from './adapters/index.js';
export { adapters, createAdapterRegistry } from './adapters/index.js';
export type {
  AlignedPair,
  DiffDelta,
  RunDiff,
  RunDiffHeader,
  SpanAlignment,
  SubtreePairDelta,
} from './diff/index.js';
export { diffRuns } from './diff/index.js';
export type {
  Finding,
  InsightRule,
  RuleContext,
  ThresholdOverrides,
  Thresholds,
} from './insights/index.js';
export {
  applyInsights,
  DEFAULT_THRESHOLDS,
  resolveThresholds,
  V0_RULES,
} from './insights/index.js';
export type { NormalizeOptions } from './normalize.js';
export { normalize } from './normalize.js';
export type {
  DowngradeSuggestion,
  PricingEntry,
  PricingTable,
  RepricedSpan,
  RepricedSubtree,
  RepriceResult,
  RepriceRiskThresholds,
  SubtreeRiskFlag,
  TierStage,
  TokenCounts,
  UnpricedCoverage,
} from './pricing/index.js';
export {
  bundledPricing,
  CACHE_WRITE_1H_ATTR,
  cacheWrite1hTokens,
  computeCostUSD,
  DEFAULT_REPRICE_RISK,
  downgradeMap,
  effectiveCacheWriteRate,
  MODEL_TIERS,
  matchModel,
  priceRun,
  repriceRun,
  repriceSpans,
  suggestedDowngrade,
  unpricedCoverage,
} from './pricing/index.js';
export type { ConvertOptions } from './pricing/litellm.js';
export {
  convertLitellmPricing,
  DEFAULT_PRICING_PROVIDERS,
  LITELLM_PRICING_URL,
} from './pricing/litellm.js';
export { stripBom } from './text.js';
export type {
  TranscriptOptions,
  TranscriptProvenance,
  TranscriptSegment,
  TranscriptSlice,
} from './transcript.js';
export { readTranscriptSlice } from './transcript.js';
