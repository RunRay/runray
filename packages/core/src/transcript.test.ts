import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readTranscriptSlice } from './transcript.js';

/**
 * Transcript reader (D4) against existing SCRUBBED fixtures only — never
 * fabricated logs. Redaction must refuse before any I/O; missing files and
 * unsupported sources return structured statuses.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const claudeFile = join(
  repoRoot,
  'fixtures',
  'claude-code',
  'simple',
  'simple.jsonl',
);
const exportFile = join(
  repoRoot,
  'fixtures',
  'opencode',
  'export-json',
  'simple.json',
);
const dbFile = join(
  repoRoot,
  'fixtures',
  'opencode',
  'sqlite',
  'simple',
  'opencode.db',
);

/** First 1-based line whose record matches the predicate. */
function findLine(
  file: string,
  predicate: (record: Record<string, unknown>) => boolean,
): number {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    try {
      const record: unknown = JSON.parse(line);
      if (
        typeof record === 'object' &&
        record !== null &&
        predicate(record as Record<string, unknown>)
      ) {
        return i + 1;
      }
    } catch {
      // skip unparseable lines
    }
  }
  throw new Error('no matching line in fixture');
}

describe('readTranscriptSlice', () => {
  it('redact refuses BEFORE any file I/O (works on a nonexistent path)', async () => {
    const slice = await readTranscriptSlice(
      { file: join(repoRoot, 'definitely', 'missing.jsonl'), line: 1 },
      'claude-code',
      { redact: true },
    );
    expect(slice.status).toBe('redacted');
  });

  it('serves role-labeled segments from a claude-code JSONL line', async () => {
    const line = findLine(claudeFile, (r) => r.type === 'assistant');
    const slice = await readTranscriptSlice(
      { file: claudeFile, line },
      'claude-code',
      { redact: false },
    );
    expect(slice.status).toBe('ok');
    if (slice.status !== 'ok') return;
    expect(slice.segments.length).toBeGreaterThan(0);
    expect(slice.truncated).toBe(false);
    for (const seg of slice.segments) {
      expect(seg.label.length).toBeGreaterThan(0);
    }
  });

  it('missing files degrade structurally, never a crash', async () => {
    const slice = await readTranscriptSlice(
      { file: join(repoRoot, 'rotated-away.jsonl'), line: 3 },
      'claude-code',
      { redact: false },
    );
    expect(slice.status).toBe('unavailable');
    if (slice.status === 'unavailable') {
      expect(slice.reason).toContain('unavailable');
    }
  });

  it('a line beyond the end of the file is unavailable', async () => {
    const slice = await readTranscriptSlice(
      { file: claudeFile, line: 10_000_000 },
      'claude-code',
      { redact: false },
    );
    expect(slice.status).toBe('unavailable');
  });

  it('otlp imports are unsupported', async () => {
    const slice = await readTranscriptSlice({ file: 'whatever.json' }, 'otlp', {
      redact: false,
    });
    expect(slice.status).toBe('unsupported');
  });

  it('resolves a record by id inside an opencode export bundle', async () => {
    const doc = JSON.parse(readFileSync(exportFile, 'utf8')) as {
      messages: Array<{ info: { id: string } }>;
    };
    const recordId = doc.messages[0]?.info.id;
    expect(recordId).toBeDefined();
    const slice = await readTranscriptSlice(
      { file: exportFile, recordId },
      'opencode',
      { redact: false },
    );
    expect(slice.status).toBe('ok');
    if (slice.status !== 'ok') return;
    expect(slice.segments.length).toBeGreaterThan(0);
  });

  it('an unknown record id in an export bundle is unavailable, not the whole doc', async () => {
    // the bundle has no top-level id; an unresolvable recordId must NOT fall
    // back to serving the entire session document
    const slice = await readTranscriptSlice(
      { file: exportFile, recordId: 'msg_does-not-exist' },
      'opencode',
      { redact: false },
    );
    expect(slice.status).toBe('unavailable');
  });

  it('reads an opencode sqlite record strictly read-only', async () => {
    const mod = (await import('better-sqlite3')) as unknown as {
      default: new (
        p: string,
        o: { readonly: boolean; fileMustExist: boolean },
      ) => {
        prepare(sql: string): { get(): { id?: string } | undefined };
        close(): void;
      };
    };
    const db = new mod.default(dbFile, {
      readonly: true,
      fileMustExist: true,
    });
    const row = db.prepare('SELECT id FROM message LIMIT 1').get();
    db.close();
    expect(row?.id).toBeDefined();
    const slice = await readTranscriptSlice(
      { file: dbFile, recordId: row?.id },
      'opencode',
      { redact: false },
    );
    expect(slice.status).toBe('ok');
  });

  it('unknown sqlite record ids are unavailable', async () => {
    const slice = await readTranscriptSlice(
      { file: dbFile, recordId: 'msg_does_not_exist' },
      'opencode',
      { redact: false },
    );
    expect(slice.status).toBe('unavailable');
  });
});
