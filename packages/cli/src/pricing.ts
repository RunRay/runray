import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  bundledPricing,
  convertLitellmPricing,
  LITELLM_PRICING_URL,
  type PricingTable,
  stripBom,
} from '@runray/core';

/**
 * User pricing override (05-ARCHITECTURE §2.3/§3): `runray pricing
 * --refresh` is THE ONLY permitted network operation in the product — an
 * explicit opt-in that overwrites `~/.config/runray/pricing.json`. All
 * commands prefer that file over the bundled snapshot when it is valid.
 */

export function userPricingPath(): string {
  const runrayPath = join(homedir(), '.config', 'runray', 'pricing.json');
  if (existsSync(runrayPath)) return runrayPath;
  const legacyPath = join(homedir(), '.config', 'tracepulse', 'pricing.json');
  if (existsSync(legacyPath)) return legacyPath;
  return runrayPath;
}

function isPricingTable(v: unknown): v is PricingTable {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as PricingTable).snapshotDate === 'string' &&
    Array.isArray((v as PricingTable).entries)
  );
}

export function loadUserPricing(
  path = userPricingPath(),
): PricingTable | undefined {
  let text: string;
  try {
    text = stripBom(readFileSync(path, 'utf8'));
  } catch {
    return undefined; // no override — the normal case
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPricingTable(parsed)) return parsed;
    throw new Error('not a pricing table');
  } catch (err) {
    process.stderr.write(
      `warning: ignoring invalid pricing override ${path} (${(err as Error).message}); using the bundled snapshot\n`,
    );
    return undefined;
  }
}

export interface EffectivePricing {
  table: PricingTable;
  origin: 'user' | 'bundled';
  path?: string;
}

export function effectivePricing(path = userPricingPath()): EffectivePricing {
  const user = loadUserPricing(path);
  if (user !== undefined) return { table: user, origin: 'user', path };
  return { table: bundledPricing(), origin: 'bundled' };
}

export interface RefreshResult {
  path: string;
  entries: number;
  snapshotDate: string;
}

/** Explicit opt-in network fetch; everything else in the product is offline. */
export async function refreshPricing(
  options: { path?: string; fetchImpl?: typeof fetch } = {},
): Promise<RefreshResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const path = options.path ?? userPricingPath();
  const res = await fetchImpl(LITELLM_PRICING_URL);
  if (!res.ok)
    throw new Error(`pricing fetch failed: ${res.status} ${res.statusText}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const table = convertLitellmPricing(raw, {
    snapshotDate: new Date().toISOString().slice(0, 10),
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
  return {
    path,
    entries: table.entries.length,
    snapshotDate: table.snapshotDate,
  };
}
