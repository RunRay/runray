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
    let drops: NodeJS.Timeout | undefined;
    try {
      // chokidar's 'ready' only means its initial scan finished — it does NOT
      // mean the OS-level watch is delivering yet: `fs.watch` arms its
      // kqueue/FSEvents stream asynchronously, and a write landing inside that
      // arming window is dropped with no event at all. The window is sub-ms on
      // an idle machine but ~10ms under load, which is why a single write right
      // after 'ready' failed ~50% of parallel runs.
      // So wait on the condition instead of a guess: keep dropping session
      // files until one is observed. Each file is written exactly once, so
      // `awaitWriteFinish` settles each independently rather than having its
      // stability timer reset by the next drop.
      await watcher.ready;
      let n = 0;
      const drop = () => writeFileSync(join(dir, `ses_${n++}.json`), '{}');
      drop();
      drops = setInterval(drop, 250);
      await expect(
        Promise.race([
          fired.then(() => 'changed'),
          new Promise((r) => setTimeout(() => r('timeout'), 10_000)),
        ]),
      ).resolves.toBe('changed');
    } finally {
      clearInterval(drops);
      await watcher.close();
    }
  }, 15_000);
});
