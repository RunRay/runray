import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Run, SCHEMA_VERSION, type TraceFile } from '@runray/schema';

/**
 * `runray demo` data (cli spec "Instant demo"): the scrubbed normalized
 * goldens double as the bundled sample — already schema-valid, insight- and
 * cost-annotated, and free of real prompt text by construction. Two layouts,
 * monorepo-first for the same stale-copy reason as `resolveUiDistDir`:
 * - monorepo checkout: `fixtures/normalized/`,
 * - published package: `prepack` copies the goldens into `cli/assets/demo`.
 */
export function resolveDemoDataDir(): string | undefined {
  const candidates = ['../../../fixtures/normalized/', '../assets/demo/'];
  for (const rel of candidates) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(dir) && collectRunFiles(dir).length > 0) return dir;
  }
  return undefined;
}

/** All `<source>/<variant>.json` golden files under the demo data dir. */
function collectRunFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const sourceDir = join(dir, entry);
    if (!statSync(sourceDir).isDirectory()) continue;
    for (const file of readdirSync(sourceDir)) {
      if (file.endsWith('.json')) files.push(join(sourceDir, file));
    }
  }
  return files;
}

/** Wrap the bundled runs in a TraceFile envelope, newest first like `view`. */
export function loadDemoTraceFile(
  dir: string,
  generatorVersion: string,
): TraceFile {
  // `run.id` is a stable hash of the source session id(s) (docs/02-DATA-MODEL),
  // deterministic but NOT unique: the OpenCode cross-era goldens deliberately
  // capture one session three ways (storage/sqlite/export) to prove the
  // adapter's cross-era equivalence, so all three normalize to the same id.
  // The goldens double as the demo sample, so a naive concatenation would
  // showcase that session three times and — because the UI keys routing and
  // selection off `run.id` — leave two of the three unreachable. Collapse
  // duplicates here, keeping the first in a stable sorted-path order so the
  // choice is deterministic across platforms (readdir order is not).
  const byId = new Map<string, Run>();
  for (const file of collectRunFiles(dir).sort()) {
    const run = JSON.parse(readFileSync(file, 'utf8')) as Run;
    if (!byId.has(run.id)) byId.set(run.id, run);
  }
  const runs = [...byId.values()];
  runs.sort((a, b) => {
    const diff = Date.parse(b.startedAt) - Date.parse(a.startedAt);
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'runray', version: generatorVersion },
    generatedAt: new Date().toISOString(),
    runs,
  };
}
