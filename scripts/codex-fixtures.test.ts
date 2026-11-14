import { existsSync, readdirSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRolloutLines } from '../packages/core/src/rollout-lines.js';
import { BLOB_PLACEHOLDER, ROLLOUT_FILE } from './scrub-codex.js';
import { LOREM, MARKER } from './scrub-lib.js';

/**
 * The committed Codex fixtures hold nothing but structure.
 *
 * This reads the scrubbed files only, with its own idea of what is allowed,
 * so it does not inherit a blind spot of the scrubber: every string in every
 * record must be lorem, an id, a timestamp, a canonical path, a line the
 * harness writes, the blob placeholder, or an identifier-shaped value under
 * one of a short list of structural keys. Anything else fails the test and
 * names the key, never the value.
 *
 * It is the standing form of the checks docs/04-SAMPLE-LOGS.md §5 asks for
 * before a fixture is committed.
 */

const fixtures = fileURLToPath(new URL('../fixtures/codex', import.meta.url));
const VARIANTS = [
  'compaction',
  'guardian',
  'legacy',
  'simple',
  'tool-errors',
  'zstd',
];

function rollouts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'raw') out.push(...rollouts(path)); // git-ignored input
    } else if (ROLLOUT_FILE.test(entry.name)) out.push(path);
  }
  return out.sort();
}

/** Keys whose value is an enum, a tool or model name, or a version. */
const STRUCTURAL_KEYS = new Set([
  'type',
  'kind',
  'role',
  'phase',
  'status',
  'reason',
  'codex_error_info',
  'thread_source',
  'turn_trigger',
  'name',
  'namespace',
  'server',
  'tool',
  'model',
  'model_provider',
  'cli_version',
  'originator',
  'source',
  'other',
  'id',
]);
const STRUCTURAL_VALUE = /^[A-Za-z0-9 _.:+-]{1,80}$/;
const ARGV_FLAG = /^[-/][A-Za-z]{1,24}$/;

const ID =
  /^([a-z]+[_-])?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[a-z]+_[A-Za-z0-9]{10,}$|^(item|rollout|auto-compact)-\d+$|^anon_[0-9a-f]{8}$|^0{40}$|^[A-Za-z0-9_-]{50,60}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const EXAMPLE_REPO = 'https://example.com/user/project.git';
const HARNESS_LINE =
  /^(Script (completed|failed|terminated)|Script error:|Script running with cell ID \d+|Wall time:? \d+(\.\d+)? seconds|Exit code: -?\d+|Total output lines: \d+|Output:|Plan updated|Success\. Updated the following files:|\\ No newline at end of file|\*\*\* (Begin Patch|End Patch|End of File)|@@)$/;
const WRAPPER =
  /^([A-Za-z]:)?([\\/][a-z]+)*[\\/]?(pwsh|powershell|bash|zsh|sh|dash|cmd|apply_patch)(\.exe)?$/i;

/** Lorem as the scrubber writes it: words, or `x`-joined words, the last
 * one possibly cut short; a key made unique gets a `_2` suffix. */
function isLorem(value: string): boolean {
  const piece = (w: string) => w === '' || LOREM.some((l) => l.startsWith(w));
  return value.replace(/_\d+$/, '').split(/[ x]/).every(piece);
}

function isCanonicalPath(value: string): boolean {
  const segments = value.replace(/\.\d+$/, '').split('/');
  return segments.every(
    (seg, i) =>
      seg === '' ||
      seg === '.' ||
      seg === '..' ||
      (i <= 3 && ['home', 'user', 'project'].includes(seg)) ||
      (/^[a-z]+(\.[A-Za-z0-9]{1,8})?$/.test(seg) &&
        isLorem(seg.replace(/\.[A-Za-z0-9]{1,8}$/, ''))),
  );
}

function isWrapperPath(value: string): boolean {
  if (!WRAPPER.test(value)) return false;
  return value
    .split(/[\\/]/)
    .slice(0, -1)
    .every((seg) => seg === '' || /^[A-Za-z]:$/.test(seg) || isLorem(seg));
}

function lineIsClean(raw: string): boolean {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line === '' || isLorem(line) || HARNESS_LINE.test(line)) return true;
  const file =
    /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.*)$/.exec(line);
  if (file) return isCanonicalPath(file[1] ?? '');
  const hunk = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/.exec(line);
  if (hunk) return isLorem(hunk[1] ?? '');
  if (line.startsWith('@@ ')) return isLorem(line.slice(3));
  if (/^(\+\+\+|---)/.test(line)) return isLorem(line.slice(3));
  if (/^[+\- ]/.test(line)) return isLorem(line.slice(1));
  return false;
}

function isClean(value: string): boolean {
  return (
    value === '' ||
    value === BLOB_PLACEHOLDER ||
    value === EXAMPLE_REPO ||
    ID.test(value) ||
    TIMESTAMP.test(value) ||
    isCanonicalPath(value) ||
    isWrapperPath(value) ||
    value.split('\n').every(lineIsClean)
  );
}

/** Keys under which a string that is not clean was found. */
function offendingKeys(value: unknown, key: string, found: Set<string>): void {
  if (typeof value === 'string') {
    if (isClean(value)) return;
    if (STRUCTURAL_KEYS.has(key) && STRUCTURAL_VALUE.test(value)) return;
    if (key === 'command' && ARGV_FLAG.test(value)) return;
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        // call arguments and legacy outputs are JSON inside a string
        offendingKeys(JSON.parse(value), key, found);
        return;
      } catch {
        // not JSON: an offending string like any other
      }
    }
    found.add(key === '' ? '(top level)' : key);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) offendingKeys(item, key, found);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) offendingKeys(v, k, found);
  }
}

async function linesOf(file: string): Promise<string[]> {
  const out: string[] = [];
  for await (const { text } of readRolloutLines(file)) out.push(text);
  return out;
}

const files = rollouts(fixtures);
const label = (file: string) => relative(fixtures, file).replace(/\\/g, '/');

describe('the checker', () => {
  const keysOf = (record: unknown): string[] => {
    const found = new Set<string>();
    offendingKeys(record, '', found);
    return [...found].sort();
  };

  it('accepts what the scrubber writes', () => {
    expect(
      keysOf({
        timestamp: '2026-10-13T09:00:00.000Z',
        type: 'event_msg',
        payload: {
          turn_id: '0199f3a0-aaaa-7bbb-8ccc-ddddeeeeffff',
          cwd: '/home/user/project/loremxip/dolor.cs',
          text: 'lorem ipsum dol\nsit amet',
          command: ['C:\\loremxipsu\\pwsh.exe', '-Command', 'magna aliqua'],
          output: 'Script failed\nWall time 1.4 seconds\nOutput:\nenim minim',
          arguments: '{"command":["apply_patch","*** Begin Patch\\n+lorem"]}',
          image_url: BLOB_PLACEHOLDER,
        },
      }),
    ).toEqual([]);
  });

  it('rejects prose, a real path, a foreign value under a structural key and data in nested JSON', () => {
    expect(
      keysOf({
        payload: {
          text: 'Please round the VAT in the billing portal',
          cwd: 'C:\\Users\\alice\\work\\billing-portal',
          name: 'see https://acme.example/roadmap',
          command: ['pwsh.exe', '-Command', 'Get-ChildItem'],
          arguments: '{"workdir":"D:/work/billing-portal"}',
          unified_diff: '@@ -1,2 +1,2 @@\n-var vat = 0.23m;',
        },
      }),
    ).toEqual(['command', 'cwd', 'name', 'text', 'unified_diff', 'workdir']);
  });
});

describe('fixtures/codex', () => {
  it('has every variant of the fixture set', () => {
    for (const variant of VARIANTS) {
      expect(rollouts(join(fixtures, variant)).length, variant).toBeGreaterThan(
        0,
      );
    }
  });

  it.each(files.map((file) => [label(file), file]))(
    '%s holds the marker, parses, and carries nothing but structure',
    async (_name, file) => {
      const lines = await linesOf(file);

      const marker = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(marker.marker).toBe(MARKER);
      expect(marker.source).toBe('codex');
      const first = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
      expect(first.type).toBe('session_meta');

      const username = userInfo().username.toLowerCase();
      const host = hostname().toLowerCase();
      const offending = new Set<string>();
      const hits = new Set<string>();
      for (const [i, text] of lines.entries()) {
        if (i === 0 || text === '') continue;
        const lower = text.toLowerCase();
        if (username.length >= 3 && lower.includes(username))
          hits.add('OS user name');
        if (host.length >= 3 && lower.includes(host)) hits.add('host name');
        if (/sk-[A-Za-z0-9_-]{8,}/.test(text)) hits.add('sk- key');
        if (/\b[0-9a-fA-F]{32,}\b/.test(text.replace(/0{40}/g, '')))
          hits.add('32+ hex');
        if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text))
          hits.add('e-mail');
        if (text.replace(EXAMPLE_REPO, '').includes('://')) hits.add('URL');
        // lorem, ids and Codex's own enums are ASCII; prose often is not
        if (/[^\t\n\r -~]/.test(text)) hits.add('non-ASCII character');
        offendingKeys(JSON.parse(text), '', offending);
      }
      expect([...hits], 'pattern hits').toEqual([]);
      expect([...offending].sort(), 'keys holding a non-lorem value').toEqual(
        [],
      );
    },
  );

  it('stores the simple session a second time, compressed, with the same content', async () => {
    const [plain] = rollouts(join(fixtures, 'simple'));
    const [packed] = rollouts(join(fixtures, 'zstd'));
    expect(plain?.endsWith('.jsonl')).toBe(true);
    expect(packed?.endsWith('.jsonl.zst')).toBe(true);
    expect(await linesOf(packed ?? '')).toEqual(await linesOf(plain ?? ''));
  });
});
