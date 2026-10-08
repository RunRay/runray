import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

/**
 * Hermetic copy of the committed claude-code fixtures for tests that scan the
 * whole directory (the CLI e2e suites). `fixtures/claude-code/large/` holds
 * the machine-local perf fixture (tens of MB, git-ignored, see its README);
 * scanning it doubled the CLI e2e time on machines that have it, never in
 * CI, and added a run that differs per machine. Copied once per vitest run
 * (~24 MB, well under a second) under node_modules/.cache, so paths keep the
 * same shape as in the repo, and removed on teardown. Tests read it with
 * `claudeCodeFixtures()` from packages/cli/src/test-fixtures.ts.
 */
export default function setup(project: TestProject): () => void {
  const repoRoot = fileURLToPath(new URL('.', import.meta.url));
  const source = join(repoRoot, 'fixtures', 'claude-code');
  const cacheDir = join(repoRoot, 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  // unique per run: two vitest processes in one checkout must not collide
  const runDir = mkdtempSync(join(cacheDir, 'runray-fixtures-'));
  const target = join(runDir, 'claude-code');
  cpSync(source, target, {
    recursive: true,
    filter: (path) => relative(source, path).split(sep)[0] !== 'large',
  });
  project.provide('claudeCodeFixtures', target);
  return () => rmSync(runDir, { recursive: true, force: true });
}
