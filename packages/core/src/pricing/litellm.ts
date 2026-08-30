import type { PricingEntry, PricingTable } from './engine.js';

/**
 * Pure conversion of LiteLLM's price list into our PricingTable. No network
 * here — core never fetches (AGENTS.md). Callers own the transport: the
 * build-time snapshot script and the explicit `runray pricing --refresh`.
 */

export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** Providers relevant to local coding agents (Claude Code, common OpenCode configs). */
export const DEFAULT_PRICING_PROVIDERS: readonly string[] = [
  'anthropic',
  'openai',
  'gemini',
  'xai',
  'deepseek',
  'mistral',
];

interface LitellmEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
}

function isEntry(v: unknown): v is LitellmEntry {
  return typeof v === 'object' && v !== null;
}

function canonicalKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/^[a-z0-9_.-]+\//, '')
    .replace(/-latest$/, '');
}

function perMTok(perToken: number | undefined, fallback: number): number {
  if (typeof perToken !== 'number' || !Number.isFinite(perToken))
    return fallback;
  return Math.round(perToken * 1e6 * 1e6) / 1e6; // per-MTok, 6 decimals
}

export interface ConvertOptions {
  snapshotDate: string;
  providers?: readonly string[];
}

export function convertLitellmPricing(
  raw: Record<string, unknown>,
  options: ConvertOptions,
): PricingTable {
  const providers = new Set(options.providers ?? DEFAULT_PRICING_PROVIDERS);
  const byPattern = new Map<
    string,
    { entry: PricingEntry; hadPrefix: boolean }
  >();
  for (const [key, value] of Object.entries(raw)) {
    if (!isEntry(value)) continue;
    if (value.mode !== 'chat') continue;
    if (
      value.litellm_provider === undefined ||
      !providers.has(value.litellm_provider)
    )
      continue;
    if (typeof value.input_cost_per_token !== 'number') continue;

    const pattern = canonicalKey(key);
    const hadPrefix = key.includes('/');
    const input = perMTok(value.input_cost_per_token, 0);
    const write5m = perMTok(value.cache_creation_input_token_cost, input);
    const write1h = perMTok(value.cache_creation_input_token_cost_above_1hr, 0);
    const entry: PricingEntry = {
      modelPattern: pattern,
      inputPerMTok: input,
      outputPerMTok: perMTok(value.output_cost_per_token, 0),
      // no cache pricing published → conservative fallback to the input rate
      cacheReadPerMTok: perMTok(value.cache_read_input_token_cost, input),
      cacheWritePerMTok: write5m,
      // 1h-TTL write rate: stored only when published AND plausible — a 1h
      // write always costs at least the 5m write and no provider charges
      // beyond a few multiples of it (Anthropic's real ratio is 1.6×). The
      // upstream list is known to zero-fill and copy-paste this field
      // (2026-08: claude-3-haiku carried 20× its own write rate, claude-3-
      // opus a 1h rate BELOW its 5m rate); out-of-band values are dropped
      // so the engine derives the provider premium instead.
      ...(write1h > 0 && write1h >= write5m && write1h <= write5m * 4
        ? { cacheWrite1hPerMTok: write1h }
        : {}),
    };
    const existing = byPattern.get(pattern);
    // prefer the un-prefixed (canonical) LiteLLM key when both exist
    if (existing === undefined || (existing.hadPrefix && !hadPrefix)) {
      byPattern.set(pattern, { entry, hadPrefix });
    }
  }
  const entries = [...byPattern.values()]
    .map((e) => e.entry)
    .sort((a, b) => (a.modelPattern < b.modelPattern ? -1 : 1));
  return {
    snapshotDate: options.snapshotDate,
    source: 'litellm-snapshot',
    aliases: {},
    entries,
  };
}
