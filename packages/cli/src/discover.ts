import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  adapters,
  applyInsights,
  createIdentityTable,
  normalize,
  type PricingTable,
  priceRun,
  pruneToMetadata,
  resolveProfile,
  type SanitizeProfile,
  scrubIdentity,
  type ThresholdOverrides,
  unpricedCoverage,
  V0_RULES,
} from '@runray/core';
import { type Run, SCHEMA_VERSION, type TraceFile } from '@runray/schema';

/** CLI `--source` values map onto adapter ids. */
const SOURCE_ALIASES: Record<string, string> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  opencode: 'opencode',
  otlp: 'otlp',
};

export interface DiscoverOptions {
  /** Scan roots; empty = each adapter's zero-config default locations. */
  paths: string[];
  source?: string;
  /** Only candidates modified within this window (ms). */
  sinceMs?: number;
  redact: boolean;
  /** Explicit profile selection (or inferred from options). */
  profile?: SanitizeProfile;
  /** Scrub local identifiers (paths, project names, branch names). */
  scrubPaths?: boolean;
  /** Prune spans to container spans only. */
  metadataOnly?: boolean;
  thresholds?: ThresholdOverrides;
  /** Effective pricing table (user override or bundled snapshot). */
  pricing?: PricingTable;
  generatorVersion: string;
}

export type RootVerdict = 'missing' | 'empty' | 'unreadable';

export interface ScannedRoot {
  path: string;
  verdict: RootVerdict;
}

export function classifyRoot(root: string): RootVerdict {
  try {
    if (!existsSync(root)) {
      return 'missing';
    }
    accessSync(root, constants.R_OK);
    const s = statSync(root);
    if (s.isDirectory()) {
      readdirSync(root);
    }
    return 'empty';
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') return 'missing';
    if (code === 'EACCES' || code === 'EPERM') return 'unreadable';
    if (!existsSync(root)) return 'missing';
    return 'unreadable';
  }
}

export function abbreviateHome(p: string, home: string = homedir()): string {
  if (p === home) return '~';
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  if (process.platform === 'win32') {
    const normP = p.replace(/\\/g, '/');
    const normHome = home.replace(/\\/g, '/');
    // Windows paths are case-insensitive: a lowercase drive and user name
    // denote the same directory and readdir accepts both, and pasted roots
    // routinely arrive lowercased. Comparing case-sensitively left such a
    // root unabbreviated, leaking the username into shareable output.
    // Slice off the original so the tail keeps the user casing.
    const foldedP = normP.toLowerCase();
    const foldedHome = normHome.toLowerCase();
    if (foldedP === foldedHome) return '~';
    if (foldedP.startsWith(`${foldedHome}/`))
      return `~${normP.slice(normHome.length)}`;
  }
  return p;
}

export interface FormatNoDataHintsOptions {
  source?: string;
  homeDir?: string;
}

export function formatNoDataHints(
  rootsScanned: ScannedRoot[],
  options: FormatNoDataHintsOptions = {},
): string {
  const lines: string[] = ['No agent sessions found.', '', 'Checked:'];

  for (const root of rootsScanned) {
    const abbr = abbreviateHome(root.path, options.homeDir);
    const indented = `  ${abbr}`;
    const padded = indented.padEnd(Math.max(56, indented.length + 2));
    lines.push(`${padded}${root.verdict}`);
  }

  if (options.source !== undefined) {
    lines.push(`(scan limited to --source ${options.source})`);
  }

  const hasUnreadable = rootsScanned.some((r) => r.verdict === 'unreadable');
  if (hasUnreadable) {
    lines.push(
      'One location could not be read. Check permissions, or pass the folder directly.',
    );
  }

  lines.push(
    '',
    'RunRay reads logs coding agents already write. There is nothing to set',
    'up. Two ways forward:',
    '',
    '  Run any agent session once, then:   runray view',
    '  Logs live somewhere else:           runray view <path>',
    '',
    'No agent sessions on this machine? Try the sample session:  runray demo',
    '',
  );

  return lines.join('\n');
}

/**
 * Watch targets for `--watch` (A1). Explicit roots are watched verbatim;
 * zero-config watches the union of every adapter's `defaultRoots()`
 * (honoring `--source`), filtered to directories that exist — before this,
 * zero-config `--watch` silently watched nothing. OTLP contributes no roots
 * (import-only source).
 */
export function resolveWatchRoots(paths: string[], source?: string): string[] {
  if (paths.length > 0) return paths;
  const wantedSource =
    source === undefined ? undefined : SOURCE_ALIASES[source.toLowerCase()];
  const out: string[] = [];
  for (const adapter of adapters.all()) {
    if (wantedSource !== undefined && adapter.id !== wantedSource) continue;
    for (const root of adapter.defaultRoots()) {
      if (existsSync(root)) out.push(root);
    }
  }
  return out;
}

/**
 * Scan roots for discovery reporting (D8). Union of every adapter's
 * `defaultRoots()` (honoring `--source`), WITHOUT filtering for `existsSync`.
 * Explicit paths are returned verbatim.
 */
export function resolveScanRoots(paths: string[], source?: string): string[] {
  if (paths.length > 0) return paths;
  const wantedSource =
    source === undefined ? undefined : SOURCE_ALIASES[source.toLowerCase()];
  const out: string[] = [];
  for (const adapter of adapters.all()) {
    if (wantedSource !== undefined && adapter.id !== wantedSource) continue;
    for (const root of adapter.defaultRoots()) {
      out.push(root);
    }
  }
  return out;
}

/** Parse `7d` / `24h` / `30m` into milliseconds. */
export function parseSince(value: string): number {
  const m = /^(\d+)([dhm])$/.exec(value.trim());
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new Error(
      `invalid --since value "${value}" (expected e.g. 7d, 24h, 30m)`,
    );
  }
  const n = Number(m[1]);
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2]];
  return n * (unit ?? 0);
}

export interface DiscoveryResult {
  traceFile: TraceFile;
  candidatesScanned: number;
  rootsScanned: ScannedRoot[];
  /** Candidates whose parse failed (locked db, corrupt document, …) — their
   * clear, actionable errors are surfaced without killing the other runs. */
  errors: Array<{ runRef: string; message: string }>;
}

/**
 * Zero-config discovery → full pipeline (parse → price → normalize →
 * insights) → one TraceFile. Runs are ordered newest-first; `--since`
 * filters on file mtime before any parsing happens.
 */
export async function buildTraceFile(
  options: DiscoverOptions,
): Promise<DiscoveryResult> {
  const wantedSource =
    options.source === undefined
      ? undefined
      : SOURCE_ALIASES[options.source.toLowerCase()];
  if (options.source !== undefined && wantedSource === undefined) {
    throw new Error(
      `unknown --source "${options.source}" (claude|opencode|otlp)`,
    );
  }
  const cutoff =
    options.sinceMs === undefined ? undefined : Date.now() - options.sinceMs;

  const shouldStripText = Boolean(
    options.redact ||
      options.profile === 'sanitized' ||
      options.profile === 'metadata-only' ||
      options.metadataOnly,
  );
  const shouldScrubIdentity = Boolean(
    options.scrubPaths ||
      options.profile === 'sanitized' ||
      options.profile === 'metadata-only' ||
      options.metadataOnly,
  );
  const shouldPrune = Boolean(
    options.metadataOnly || options.profile === 'metadata-only',
  );
  const effectiveProfile: SanitizeProfile =
    options.profile ??
    resolveProfile({
      stripText: shouldStripText,
      scrubIdentity: shouldScrubIdentity,
      pruneSpans: shouldPrune,
    });
  const parseRedact =
    shouldStripText ||
    effectiveProfile === 'sanitized' ||
    effectiveProfile === 'metadata-only';

  const scanRoots = resolveScanRoots(options.paths, options.source);
  const rootsScanned: ScannedRoot[] = scanRoots.map((path) => ({
    path,
    verdict: classifyRoot(path),
  }));

  const parsedRuns: Run[] = [];
  const errors: DiscoveryResult['errors'] = [];
  let candidatesScanned = 0;
  for (const adapter of adapters.all()) {
    if (wantedSource !== undefined && adapter.id !== wantedSource) continue;
    const candidates = await adapter.detect(options.paths);
    for (const candidate of candidates) {
      candidatesScanned++;
      if (cutoff !== undefined && candidate.mtimeMs < cutoff) continue;
      // one bad candidate (locked opencode.db, corrupt import file) must not
      // kill zero-config discovery — collect its error, keep the other runs
      try {
        const raw = await adapter.parse(candidate, { redact: parseRedact });
        parsedRuns.push(normalize(priceRun(raw, options.pricing)));
      } catch (err) {
        errors.push({
          runRef: candidate.runRef,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const identityTable =
    shouldScrubIdentity ||
    effectiveProfile === 'sanitized' ||
    effectiveProfile === 'metadata-only'
      ? createIdentityTable(parsedRuns)
      : undefined;

  const runs: Run[] = [];
  for (const normalized of parsedRuns) {
    const scrubbed = identityTable
      ? scrubIdentity(normalized, identityTable)
      : normalized;
    const withInsights = applyInsights(
      scrubbed,
      options.thresholds ?? {},
      V0_RULES,
      options.pricing,
    );
    const finalRun =
      shouldPrune || effectiveProfile === 'metadata-only'
        ? pruneToMetadata(withInsights)
        : withInsights;
    runs.push(finalRun);
  }
  runs.sort((a, b) => {
    const diff = Date.parse(b.startedAt) - Date.parse(a.startedAt);
    if (diff !== 0) return diff;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    // total order even for same-id runs (see collapseDuplicateRunIds) so the
    // survivor of a collapse is deterministic across platforms
    const fa = a.source.files.join(' ');
    const fb = b.source.files.join(' ');
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });

  return {
    traceFile: {
      schemaVersion: SCHEMA_VERSION,
      generator: { name: 'runray', version: options.generatorVersion },
      generatedAt: new Date().toISOString(),
      runs: collapseDuplicateRunIds(runs),
    },
    candidatesScanned,
    rootsScanned,
    errors,
  };
}

/**
 * `run.id` is a stable hash of the source session id(s) — deterministic but
 * NOT unique: one OpenCode session captured in several storage formats
 * (db/storage/export) normalizes to the same id (docs/02-DATA-MODEL). Every
 * id-keyed consumer expects one run per id — `runray diff`/`export`
 * resolve a ref to a single run, the UI keys routing/selection/transcript
 * lookup off the id — so N identical ids leave a run un-addressable (diff
 * exits 3 with a hint that can't disambiguate; the UI must `~n`-suffix, which
 * then fails transcript resolution). Collapse duplicates at this single load
 * boundary, keeping the first in the caller's stable sort order — the same
 * choice `runray demo` already makes for the same fixtures.
 */
export function collapseDuplicateRunIds(runs: readonly Run[]): Run[] {
  const byId = new Map<string, Run>();
  for (const run of runs) if (!byId.has(run.id)) byId.set(run.id, run);
  return [...byId.values()];
}

/** Print collected per-candidate errors to stderr (never stdout — `--json`
 * output must stay clean). */
export function reportDiscoveryErrors(
  errors: DiscoveryResult['errors'],
  loadedCount?: number,
): void {
  for (const e of errors) {
    process.stderr.write(`warning: skipped ${e.runRef}: ${e.message}\n`);
  }
  if (errors.length > 0 && loadedCount !== undefined) {
    const noun = errors.length === 1 ? 'The session' : 'The sessions';
    process.stderr.write(
      `${noun} above could not be read; the other ${loadedCount} loaded normally. A locked\ndatabase or a partly written file is skipped, never guessed at.\n`,
    );
  }
}

/**
 * One stderr warning per build when any run's cost coverage is below 100%
 * (C7): silently understated totals are the audit's first trust-breaker.
 * Never stdout — `--json` output must stay clean.
 */
export function reportUnpricedCoverage(traceFile: TraceFile): void {
  let calls = 0;
  let runsAffected = 0;
  const models = new Set<string>();
  for (const run of traceFile.runs) {
    const c = unpricedCoverage(run);
    if (c.complete) continue;
    runsAffected += 1;
    calls += c.unpricedLlmCalls;
    for (const m of c.models) models.add(m);
  }
  if (runsAffected === 0) return;
  process.stderr.write(
    `warning: ${calls} llm call(s) across ${runsAffected} run(s) have no price — totals are understated; models: ${[...models].sort().join(', ')}; try \`runray pricing --refresh\`\n`,
  );
  process.stderr.write(
    `Unpriced models are listed, never guessed — their spans show tokens without\na dollar figure. Refresh prices with:  runray pricing --refresh\n`,
  );
}
