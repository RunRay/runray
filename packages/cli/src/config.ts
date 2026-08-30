import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripBom, type ThresholdOverrides } from '@runray/core';

/**
 * `runray.config.json` (05-ARCHITECTURE §3): looked up in the current
 * working directory, then `~/.config/runray/`. `--config <file>` overrides
 * the search; a missing/broken explicit file is an error, silent otherwise.
 */

/**
 * Opt-in reference window for the limit display mode (E1). Config presence
 * only makes the UI toggle AVAILABLE — the toggle itself stays off by
 * default, and nothing here talks to any provider quota API.
 */
export interface LimitWindowConfig {
  /** Window length in days (default 7, applied UI-side). */
  days?: number;
  resetDay?: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  /** Local hour 0–23 the window resets at (default 0). */
  resetHour?: number;
  budgetUSD?: number;
  budgetTokens?: number;
}

export interface CliConfig {
  insights?: { thresholds?: ThresholdOverrides };
  redact?: boolean;
  dataRoots?: string[];
  port?: number;
  limitWindow?: LimitWindowConfig;
}

const RESET_DAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

/** Drop invalid limitWindow fields with a warning; never fail the load. */
function sanitizeLimitWindow(raw: unknown): LimitWindowConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    if (raw !== undefined) {
      process.stderr.write(
        'warning: ignoring invalid limitWindow config (expected an object)\n',
      );
    }
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  const out: LimitWindowConfig = {};
  if (typeof v.days === 'number' && v.days >= 1 && v.days <= 90) {
    out.days = Math.floor(v.days);
  }
  if (typeof v.resetDay === 'string' && RESET_DAYS.has(v.resetDay)) {
    out.resetDay = v.resetDay as LimitWindowConfig['resetDay'];
  }
  if (
    typeof v.resetHour === 'number' &&
    v.resetHour >= 0 &&
    v.resetHour <= 23
  ) {
    out.resetHour = Math.floor(v.resetHour);
  }
  if (typeof v.budgetUSD === 'number' && v.budgetUSD > 0) {
    out.budgetUSD = v.budgetUSD;
  }
  if (typeof v.budgetTokens === 'number' && v.budgetTokens > 0) {
    out.budgetTokens = v.budgetTokens;
  }
  const dropped = Object.keys(v).filter(
    (k) => !(k in out) || out[k as keyof LimitWindowConfig] === undefined,
  );
  if (dropped.length > 0) {
    process.stderr.write(
      `warning: ignoring invalid limitWindow field(s): ${dropped.sort().join(', ')}\n`,
    );
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readConfigFile(path: string): CliConfig {
  const parsed: unknown = JSON.parse(stripBom(readFileSync(path, 'utf8')));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid config (expected a JSON object): ${path}`);
  }
  const config = parsed as CliConfig;
  const limitWindow = sanitizeLimitWindow(
    (parsed as Record<string, unknown>).limitWindow,
  );
  if (limitWindow === undefined) delete config.limitWindow;
  else config.limitWindow = limitWindow;
  return config;
}

export function loadConfig(
  explicitPath?: string,
  cwd = process.cwd(),
): CliConfig {
  if (explicitPath !== undefined) return readConfigFile(explicitPath);
  for (const candidate of [
    join(cwd, 'runray.config.json'),
    join(cwd, 'tracepulse.config.json'),
    join(homedir(), '.config', 'runray', 'runray.config.json'),
    join(homedir(), '.config', 'tracepulse', 'tracepulse.config.json'),
  ]) {
    try {
      return readConfigFile(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(
        `failed to read config ${candidate}: ${(err as Error).message}`,
      );
    }
  }
  return {};
}
