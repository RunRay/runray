import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  bundledPricing,
  convertLitellmPricing,
  LITELLM_PRICING_URL,
  type PricingTable,
  stripBom,
} from '@runray/core';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-write.js';

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

const rate = z.number().nonnegative();

/** The override on disk: what `refreshPricing` writes, checked on every
 * read, since the file can be edited or left behind by an older version. */
const pricingTableSchema = z.looseObject({
  snapshotDate: z.string(),
  source: z.literal('litellm-snapshot'),
  aliases: z.record(z.string(), z.string()),
  entries: z
    .array(
      z.looseObject({
        modelPattern: z.string().min(1),
        inputPerMTok: rate,
        outputPerMTok: rate,
        cacheReadPerMTok: rate,
        cacheWritePerMTok: rate,
        cacheWrite1hPerMTok: rate.optional(),
      }),
    )
    .min(1, 'no models'),
});

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'not a pricing table';
  const where = issue.path.join('.');
  return where === '' ? issue.message : `${where}: ${issue.message}`;
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
  let reason: string;
  try {
    const result = pricingTableSchema.safeParse(JSON.parse(text));
    if (result.success) return result.data as PricingTable;
    reason = describeIssue(result.error);
  } catch (err) {
    reason = (err as Error).message;
  }
  process.stderr.write(
    `warning: ignoring invalid pricing override ${path} (${reason}); using the bundled snapshot\n`,
  );
  return undefined;
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
  /** Chat models left out because a published rate was unusable. */
  skipped: Array<{ model: string; problem: string }>;
}

/** About ten times today's list (3 MB uncompressed). */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REFRESH_TIMEOUT_MS = 60_000;

/** The top level of LiteLLM's list: one object, keyed by model. */
const litellmListSchema = z.record(z.string(), z.unknown());

/** Reads the body, refusing it as soon as it passes `maxBytes`. The
 * declared length is checked first, so an oversized reply is never read. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const tooLarge = () =>
    new Error(
      `the price list is larger than ${maxBytes / 1024 / 1024} MiB; refusing to read it`,
    );
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchPriceList(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  try {
    const res = await fetchImpl(LITELLM_PRICING_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok)
      throw new Error(`pricing fetch failed: ${res.status} ${res.statusText}`);
    // GitHub serves the list as text/plain, so only an HTML page is refused
    // up front: that is a proxy or captive portal answering instead.
    if (/^\s*text\/html\b/i.test(res.headers.get('content-type') ?? '')) {
      await res.body?.cancel();
      throw new Error(
        'pricing fetch returned an HTML page, not the price list (a proxy or captive portal?)',
      );
    }
    return await readCapped(res, maxBytes);
  } catch (err) {
    if ((err as Error).name === 'TimeoutError')
      throw new Error(`pricing fetch timed out after ${timeoutMs / 1000}s`);
    throw err;
  }
}

/**
 * Explicit opt-in network fetch; everything else in the product is offline.
 * The reply is untrusted: it is size-capped, parsed, shape-checked and
 * converted (which drops models with unusable rates), and must still hold
 * at least half as many models as the bundled snapshot. Only then is the
 * override replaced, atomically; any failure leaves it untouched.
 */
export async function refreshPricing(
  options: {
    path?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<RefreshResult> {
  const path = options.path ?? userPricingPath();
  const text = await fetchPriceList(
    options.fetchImpl ?? fetch,
    options.timeoutMs ?? REFRESH_TIMEOUT_MS,
    options.maxBytes ?? MAX_RESPONSE_BYTES,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (err) {
    throw new Error(
      `the price list is not valid JSON (${(err as Error).message})`,
    );
  }
  const list = litellmListSchema.safeParse(parsed);
  if (!list.success)
    throw new Error('the price list is not a JSON object keyed by model');

  const skipped: RefreshResult['skipped'] = [];
  const table = convertLitellmPricing(list.data, {
    snapshotDate: new Date().toISOString().slice(0, 10),
    onInvalid: (model, problem) => skipped.push({ model, problem }),
  });
  const bundled = bundledPricing().entries.length;
  if (table.entries.length < Math.ceil(bundled / 2)) {
    throw new Error(
      `the price list has only ${table.entries.length} usable models, under half of the ${bundled} in the bundled snapshot; it looks truncated`,
    );
  }

  writeFileAtomic(path, `${JSON.stringify(table, null, 2)}\n`);
  return {
    path,
    entries: table.entries.length,
    snapshotDate: table.snapshotDate,
    skipped,
  };
}
