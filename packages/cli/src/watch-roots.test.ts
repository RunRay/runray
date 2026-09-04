import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWatchRoots } from './discover.js';
import { createNotifier } from './server.js';
import { watchRoots } from './watch.js';

/**
 * Regression for the silent zero-config `--watch` bug (audit item 2 /
 * profiler-depth A1): with no explicit path, watch targets must come from
 * the adapters' default roots — before the fix the guard left the watcher
 * unattached and the UI never refreshed.
 */

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'runray-watch-')));
  prevEnv = process.env.OPENCODE_DATA_DIR;
  // opencode's default root honors this env var — gives the test a real,
  // existing zero-config root without touching the user's home directory
  process.env.OPENCODE_DATA_DIR = dir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.OPENCODE_DATA_DIR;
  else process.env.OPENCODE_DATA_DIR = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveWatchRoots', () => {
  it('returns explicit roots verbatim, unfiltered', () => {
    const missing = join(dir, 'does-not-exist');
    expect(resolveWatchRoots([missing])).toEqual([missing]);
  });

  it('zero-config: includes existing adapter default roots', () => {
    expect(resolveWatchRoots([])).toContain(dir);
  });

  it('honors --source: a claude filter excludes the opencode root', () => {
    expect(resolveWatchRoots([], 'claude')).not.toContain(dir);
  });

  it('never breaks on the import-only otlp source (no roots to watch)', () => {
    expect(resolveWatchRoots([], 'otlp')).toEqual([]);
  });
});

describe('zero-config watch chain', () => {
  it('a file change under a default root reaches the notifier', async () => {
    const targets = resolveWatchRoots([]);
    expect(targets).toContain(dir);

    const notifier = createNotifier();
    const fired = new Promise<void>((resolve) => {
      notifier.subscribe(() => resolve());
    });
    const watcher = watchRoots([dir], notifier, 50);
    try {
      // wait for chokidar's initial scan to finish (deterministic) rather
      // than racing a fixed sleep — a write before 'ready' is swallowed
      await watcher.ready;
      writeFileSync(join(dir, 'ses_new.json'), '{}');
      await expect(
        Promise.race([
          fired.then(() => 'changed'),
          new Promise((r) => setTimeout(() => r('timeout'), 10_000)),
        ]),
      ).resolves.toBe('changed');
    } finally {
      await watcher.close();
    }
  }, 15_000);
});
