import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

/**
 * Hermetic copy of the committed claude-code fixtures for tests that scan the
 * whole directory (the CLI e2e suites). Only files git tracks are copied, so
 * nothing machine-local leaks in: not the perf fixture in `large/` (tens of
 * MB, git-ignored, see its README; scanning it doubled the CLI e2e time on
 * machines that have it, never in CI), not the raw sessions under a `raw/`
 * folder, not a freshly scrubbed fixture that isn't committed yet. Any of
 * those adds a run that differs per machine. Copied once per vitest run
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
  const files = trackedFixtures(repoRoot, 'fixtures/claude-code');
  if (files === undefined) {
    // no git (a source archive): copy the tree minus the git-ignored parts
    cpSync(source, target, {
      recursive: true,
      filter: (path) => {
        const parts = relative(source, path).split(sep);
        return parts[0] !== 'large' && !parts.includes('raw');
      },
    });
  } else {
    for (const file of files) {
      const to = join(target, file);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(join(source, file), to);
    }
  }
  project.provide('claudeCodeFixtures', target);
  return () => rmSync(runDir, { recursive: true, force: true });
}

/**
 * The committed files under `dir` (a repo-relative POSIX path), relative to
 * it, without the perf fixture's folder (its README is tracked). Tracked
 * files deleted from the working tree are skipped. `undefined` when git
 * can't list them.
 */
function trackedFixtures(repoRoot: string, dir: string): string[] | undefined {
  const source = join(repoRoot, dir);
  let out: string;
  try {
    out = execFileSync('git', ['ls-files', '-z', '--', dir], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch {
    return undefined;
  }
  return out
    .split('\0')
    .filter((path) => path !== '')
    .map((path) => relative(source, join(repoRoot, path)))
    .filter(
      (file) =>
        file.split(sep)[0] !== 'large' && existsSync(join(source, file)),
    );
}
