import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

/**
 * Hermetic copies of the committed claude-code and codex fixtures for tests
 * that scan a whole source directory (the CLI e2e suites). Only files git
 * tracks are copied, so nothing machine-local leaks in: not the perf fixture
 * in `large/` (tens of MB, git-ignored, see its README; scanning it doubled
 * the CLI e2e time on machines that have it, never in CI), not the raw
 * sessions under a `raw/` folder, not a freshly scrubbed fixture that isn't
 * committed yet. Any of those adds a run that differs per machine. Copied
 * once per vitest run (~40 MB, well under a second) under
 * node_modules/.cache, so paths keep the same shape as in the repo, and
 * removed on teardown. Tests read them with `claudeCodeFixtures()` and
 * `codexFixtures()` from packages/cli/src/test-fixtures.ts.
 */
export default function setup(project: TestProject): () => void {
  const repoRoot = fileURLToPath(new URL('.', import.meta.url));
  const cacheDir = join(repoRoot, 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  // unique per run: two vitest processes in one checkout must not collide
  const runDir = mkdtempSync(join(cacheDir, 'runray-fixtures-'));
  project.provide(
    'claudeCodeFixtures',
    copyCommitted(repoRoot, runDir, 'claude-code'),
  );
  project.provide('codexFixtures', copyCommitted(repoRoot, runDir, 'codex'));
  return () => rmSync(runDir, { recursive: true, force: true });
}

/** Copies the committed fixtures of one source into `runDir` and returns
 * the copy's path. */
function copyCommitted(
  repoRoot: string,
  runDir: string,
  sourceId: string,
): string {
  const source = join(repoRoot, 'fixtures', sourceId);
  const target = join(runDir, sourceId);
  const files = trackedFixtures(repoRoot, `fixtures/${sourceId}`);
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
  return target;
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
