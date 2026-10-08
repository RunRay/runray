import { stripBom } from '../text.js';
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

const RATE_FIELDS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost',
  'cache_creation_input_token_cost_above_1hr',
] as const;

/** Rates stay `unknown` until checked: the list is remote, untrusted JSON. */
type LitellmEntry = { litellm_provider?: unknown; mode?: unknown } & {
  [K in (typeof RATE_FIELDS)[number]]?: unknown;
};

function isEntry(v: unknown): v is LitellmEntry {
  return typeof v === 'object' && v !== null;
}

/**
 * Highest per-token rate taken as a real price: $10,000 per million tokens,
 * far above anything published (2026: o1-pro output at $600). A higher,
 * negative or non-numeric rate means a corrupted entry, not a price.
 */
const MAX_RATE_PER_TOKEN = 0.01;

/** Why a rate can't be used; undefined when it can. Absent and null mean
 * "not published" and fall back like before. */
function rateProblem(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value))
    return 'is not a number';
  if (value < 0) return 'is negative';
  if (value > MAX_RATE_PER_TOKEN) return 'is above $10,000 per million tokens';
  return undefined;
}

function canonicalKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/^[a-z0-9_.-]+\//, '')
    .replace(/-latest$/, '');
}

function perMTok(perToken: unknown, fallback: number): number {
  if (typeof perToken !== 'number' || !Number.isFinite(perToken))
    return fallback;
  return Math.round(perToken * 1e6 * 1e6) / 1e6; // per-MTok, 6 decimals
}

export interface ConvertOptions {
  snapshotDate: string;
  providers?: readonly string[];
  /** Called for each chat model of a known provider that is left out
   * because a published rate is unusable (negative, absurd, not a number). */
  onInvalid?: (key: string, problem: string) => void;
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
      typeof value.litellm_provider !== 'string' ||
      !providers.has(value.litellm_provider)
    )
      continue;
    // no input price published: never priced, so nothing to report
    if (
      value.input_cost_per_token === undefined ||
      value.input_cost_per_token === null
    )
      continue;
    const problem = RATE_FIELDS.map((field) => {
      const reason = rateProblem(value[field]);
      return reason === undefined ? undefined : `${field} ${reason}`;
    }).find((reason) => reason !== undefined);
    if (problem !== undefined) {
      options.onInvalid?.(key, problem);
      continue;
    }

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

/** A price list that converts to fewer models than the caller expects. */
export class PriceListTooShortError extends Error {
  override readonly name = 'PriceListTooShortError';
  constructor(
    readonly models: number,
    readonly expected: number,
  ) {
    super(
      `the price list has only ${models} usable models, fewer than the ${expected} expected; it looks truncated`,
    );
  }
}

export interface PriceListOptions extends ConvertOptions {
  /** Fewer usable models than this refuses the list (at least 1). */
  minEntries: number;
}

/**
 * Turns the downloaded price list, untrusted text, into a PricingTable. It
 * must be JSON, an object keyed by model, and convert to at least
 * `minEntries` models. Shared by `pricing --refresh` and the snapshot build
 * script, which keep their own transport.
 */
export function priceListFromText(
  text: string,
  options: PriceListOptions,
): PricingTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (err) {
    throw new Error(
      `the price list is not valid JSON (${(err as Error).message})`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('the price list is not a JSON object keyed by model');
  const table = convertLitellmPricing(
    parsed as Record<string, unknown>,
    options,
  );
  const expected = Math.max(1, options.minEntries);
  if (table.entries.length < expected)
    throw new PriceListTooShortError(table.entries.length, expected);
  return table;
}
