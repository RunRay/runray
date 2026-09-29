import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TranscriptSlice } from '@runray/core';
import { type Run, SCHEMA_VERSION, type TraceFile } from '@runray/schema';

/**
 * `runray demo` data (cli spec "Instant demo"): `demo/runs/`, built by
 * `pnpm demo:build` from the scrubbed goldens. The goldens keep their real
 * token counts, timings and span trees; their lorem text is replaced with a
 * coherent storyline per session (scripts/demo/stories.ts), so the sample
 * is free of real prompt text by construction and still reads like real
 * work. Two layouts, monorepo-first for the same stale-copy reason as
 * `resolveUiDistDir`:
 * - monorepo checkout: `demo/runs/`,
 * - published package: `prepack` copies it into `cli/assets/demo`.
 */
export function resolveDemoDataDir(): string | undefined {
  const candidates = ['../../../demo/runs/', '../assets/demo/'];
  for (const rel of candidates) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(dir) && collectRunFiles(dir).length > 0) return dir;
  }
  return undefined;
}

/**
 * The demo ships normalized runs only: their provenance names the sessions
 * they were built from, which exist on no one's disk. Answer the transcript
 * endpoint with a plain status instead of an ENOENT from the reader.
 */
export const DEMO_TRANSCRIPT: TranscriptSlice = {
  status: 'unavailable',
  reason: 'the demo includes normalized runs only, not raw session logs',
};

/** All `<source>/<slug>.json` run files under the demo data dir. */
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
  // deterministic but NOT unique: the OpenCode cross-era goldens capture one
  // session three ways (storage/sqlite/export), all with the same id. The
  // demo build picks one of them, but the UI keys routing and selection off
  // `run.id`, so a duplicate would leave all but one copy unreachable. Keep
  // collapsing duplicates here, first in a stable sorted-path order so the
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
