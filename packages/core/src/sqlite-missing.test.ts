import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { opencodeAdapter } from './adapters/opencode.js';
import { loadSqlite, SqliteUnavailableError } from './sqlite.js';
import { readTranscriptSlice } from './transcript.js';

/**
 * better-sqlite3 is an optional dependency of the published package, so a
 * perfectly normal install (`npm i --omit=optional`, a failed native build,
 * a platform with no prebuild) has no such module. The contract this file
 * pins: a missing module degrades the OpenCode SQLite source to "unavailable"
 * with one actionable message, and never becomes an unhandled
 * MODULE_NOT_FOUND or a crashed scan.
 *
 * Own test file because the mock has to apply to the whole module graph and
 * `loadSqlite()` caches its verdict per process; vitest isolates modules per
 * file, so the other sqlite tests still see the real module.
 */
vi.mock('better-sqlite3', () => {
  throw Object.assign(
    new Error("Cannot find module 'better-sqlite3' imported from core"),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );
});

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'runray-nosqlite-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A file named opencode.db is all detect() keys off — it never parses it. */
function dbRoot(): string {
  const dir = mkdtempSync(join(tmp, 'root-'));
  writeFileSync(join(dir, 'opencode.db'), '');
  return dir;
}

describe('better-sqlite3 absent', () => {
  it('loadSqlite rejects with an actionable message, not MODULE_NOT_FOUND', async () => {
    await expect(loadSqlite()).rejects.toBeInstanceOf(SqliteUnavailableError);
    await expect(loadSqlite()).rejects.toThrow(
      /needs better-sqlite3.*--omit=optional.*npm i better-sqlite3/s,
    );
    // the raw loader error must not be what the user reads
    await expect(loadSqlite()).rejects.not.toThrow(/Cannot find module/);
  });

  it('detect() still returns the db as a candidate instead of throwing', async () => {
    const candidates = await opencodeAdapter.detect([dbRoot()]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.format).toBe('opencode-sqlite');
  });

  it('parse() reports the source as unavailable with the fix', async () => {
    const [candidate] = await opencodeAdapter.detect([dbRoot()]);
    if (candidate === undefined) throw new Error('unreachable');
    await expect(
      opencodeAdapter.parse(candidate, { redact: false }),
    ).rejects.toThrow(/needs better-sqlite3/);
  });

  it('the transcript reader degrades to a structured unavailable slice', async () => {
    const slice = await readTranscriptSlice(
      { file: join(dbRoot(), 'opencode.db'), recordId: 'msg_x' },
      'opencode',
      { redact: false },
    );
    expect(slice.status).toBe('unavailable');
    expect(slice.status === 'unavailable' ? slice.reason : '').toMatch(
      /needs better-sqlite3/,
    );
  });

  it('the file-storage era keeps working without the native module', async () => {
    const dir = join(repoRoot, 'fixtures', 'opencode', 'storage', 'simple');
    const candidates = (await opencodeAdapter.detect([dir])).filter(
      (c) => !/[/]raw[/]/.test(c.runRef),
    );
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error('unreachable');
    const raw = await opencodeAdapter.parse(candidate, { redact: false });
    expect(raw.spans.length).toBeGreaterThan(0);
  });
});
