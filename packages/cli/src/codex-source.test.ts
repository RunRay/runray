import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { adapters } from '@runray/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTraceFile,
  classifyRoot,
  formatNoDataHints,
  resolveScanRoots,
  resolveWatchRoots,
} from './discover.js';
import { SETUP_GUIDES_TEXT } from './onboarding.js';
import { createProgram } from './program.js';
import { claudeCodeFixtures, codexFixtures } from './test-fixtures.js';

/**
 * Codex as a source of the CLI (add-codex-adapter 5.2): registered after
 * OpenCode, reachable through `--source codex`, counted among the
 * zero-config roots, and named in the setup guides.
 */

// one committed file, read where it lies; whole-folder scans go through
// codexFixtures(), which leaves the machine-local perf fixture out
const SIMPLE = join(
  fileURLToPath(new URL('../../../fixtures/codex', import.meta.url)),
  'simple',
  'rollout-2026-09-17T19-11-16-01a0b059-e3b9-7a20-87cc-da1f5e28e984.jsonl',
);

const build = (paths: string[], source?: string) =>
  buildTraceFile({
    paths,
    ...(source === undefined ? {} : { source }),
    redact: true,
    generatorVersion: '0',
  });

let dir: string;
let prevCodexHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runray-codex-'));
  prevCodexHome = process.env.CODEX_HOME;
});

afterEach(() => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('the adapter registry', () => {
  it('holds Codex after OpenCode and before the import-only OTLP', () => {
    expect(adapters.all().map((a) => a.id)).toEqual([
      'claude-code',
      'opencode',
      'codex',
      'otlp',
    ]);
  });
});

describe('a folder of Codex rollouts, no source filter', () => {
  it('lists each session once as a Codex run, with nothing skipped', async () => {
    const { traceFile, errors, candidatesScanned } = await build([
      codexFixtures(),
    ]);
    // simple and zstd are one thread stored twice: one candidate, one run
    expect(candidatesScanned).toBe(7);
    expect(errors).toEqual([]);
    expect(traceFile.runs.map((r) => r.source.tool)).toEqual(
      Array.from({ length: 7 }, () => 'codex'),
    );
    expect(new Set(traceFile.runs.map((r) => r.id)).size).toBe(7);
  });

  it('keeps a rollout dropped next to a Claude Code transcript out of the Claude Code adapter', async () => {
    const project = join(dir, 'project');
    mkdirSync(project);
    const transcript = [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 'next-to-a-rollout',
        timestamp: '2026-07-02T13:00:00Z',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 'next-to-a-rollout',
        timestamp: '2026-07-02T13:00:05Z',
        message: {
          id: 'm1',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
          content: [{ type: 'text', text: 'hi' }],
        },
      },
    ];
    writeFileSync(
      join(project, 'next-to-a-rollout.jsonl'),
      `${transcript.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    copyFileSync(SIMPLE, join(project, 'rollout-2026-09-17-copy.jsonl'));

    const { traceFile, errors, candidatesScanned } = await build([dir]);
    // two files, two candidates: neither adapter takes the other's file
    expect(candidatesScanned).toBe(2);
    expect(errors).toEqual([]);
    expect(traceFile.runs.map((r) => r.source.tool).sort()).toEqual([
      'claude-code',
      'codex',
    ]);
  });
});

describe('--source codex', () => {
  it('limits discovery to Codex among sessions of two agents', async () => {
    const paths = [claudeCodeFixtures(), codexFixtures()];
    const both = await build(paths);
    const tools = new Set(both.traceFile.runs.map((r) => r.source.tool));
    expect(tools).toEqual(new Set(['claude-code', 'codex']));

    const codex = await build(paths, 'codex');
    expect(codex.traceFile.runs).toHaveLength(7);
    expect(codex.traceFile.runs.every((r) => r.source.tool === 'codex')).toBe(
      true,
    );
    // the alias is matched like the others, whatever its case
    expect((await build([dir], 'Codex')).traceFile.runs).toEqual([]);

    const claude = await build(paths, 'claude');
    expect(claude.traceFile.runs.some((r) => r.source.tool === 'codex')).toBe(
      false,
    );
  });

  it('names codex among the choices when the source is unknown', async () => {
    await expect(build([dir], 'foo')).rejects.toThrow(
      'unknown --source "foo" (claude|opencode|codex|otlp)',
    );
  });

  it('is in the help text of every command that takes --source', () => {
    const withSource = createProgram().commands.flatMap((command) =>
      command.options
        .filter((option) => option.long === '--source')
        .map((option) => [command.name(), option.description] as const),
    );
    expect(withSource.map(([name]) => name).sort()).toEqual([
      'diff',
      'export',
      'list',
      'view',
    ]);
    for (const [name, description] of withSource) {
      expect(description, name).toBe(
        'only one source: claude | opencode | codex | otlp',
      );
    }
  });

  it('`runray list <fixtures> --source codex --json` lists the fixture sessions', async () => {
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line) => {
      out.push(String(line));
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      await createProgram().parseAsync([
        'node',
        'runray',
        'list',
        codexFixtures(),
        '--source',
        'codex',
        '--json',
      ]);
      const listed = JSON.parse(out.join('\n')) as Array<{
        id: string;
        source: string;
      }>;
      expect(listed).toHaveLength(7);
      expect(listed.every((run) => run.source === 'codex')).toBe(true);
      const skipped = stderr.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('skipped'));
      expect(skipped).toEqual([]);
    } finally {
      log.mockRestore();
      stderr.mockRestore();
      process.exitCode = 0;
    }
  });
});

describe('zero-config roots', () => {
  it('include the Codex sessions directory, after the OpenCode root', () => {
    delete process.env.CODEX_HOME;
    const sessions = join(homedir(), '.codex', 'sessions');
    const roots = resolveScanRoots([]);
    expect(roots).toContain(sessions);
    expect(roots.indexOf(sessions)).toBeGreaterThan(
      roots.findIndex((root) => root.includes('opencode')),
    );
    expect(resolveScanRoots([], 'codex')).toEqual([sessions]);
    expect(resolveScanRoots([], 'claude')).not.toContain(sessions);
  });

  it('follow CODEX_HOME', () => {
    process.env.CODEX_HOME = dir;
    expect(resolveScanRoots([], 'codex')).toEqual([join(dir, 'sessions')]);
  });

  it('are reported with a verdict when no agent has any session', async () => {
    const missing = join(dir, 'home', '.codex', 'sessions');
    expect(classifyRoot(missing)).toBe('missing');
    const text = formatNoDataHints(
      [{ path: missing, verdict: classifyRoot(missing) }],
      { homeDir: join(dir, 'home') },
    );
    expect(text).toMatch(/^ {2}~\/\.codex\/sessions +missing$/m);

    process.env.CODEX_HOME = join(dir, 'empty-home');
    const { traceFile, rootsScanned } = await build([], 'codex');
    expect(traceFile.runs).toEqual([]);
    expect(rootsScanned).toEqual([
      { path: join(dir, 'empty-home', 'sessions'), verdict: 'missing' },
    ]);
  });

  it('are watched once the sessions directory exists, subject to --source', () => {
    process.env.CODEX_HOME = dir;
    const sessions = join(dir, 'sessions');
    expect(resolveWatchRoots([])).not.toContain(sessions);
    mkdirSync(sessions);
    expect(resolveWatchRoots([])).toContain(sessions);
    expect(resolveWatchRoots([], 'codex')).toEqual([sessions]);
    expect(resolveWatchRoots([], 'claude')).not.toContain(sessions);
  });
});

describe('a Codex session that changes between two builds of a watch', () => {
  const lines = readFileSync(SIMPLE, 'utf8').split('\n').filter(Boolean);
  const NAME = 'rollout-2026-09-17T19-11-16-growing.jsonl';

  function sessionsDir(): string {
    process.env.CODEX_HOME = dir;
    const day = join(dir, 'sessions', '2026', '09', '17');
    mkdirSync(day, { recursive: true });
    return day;
  }

  it('shows the new spans once its rollout has grown', async () => {
    const day = sessionsDir();
    const file = join(day, NAME);
    const half = Math.ceil(lines.length / 2);
    writeFileSync(file, `${lines.slice(0, half).join('\n')}\n`);
    const [early] = (await build([], 'codex')).traceFile.runs;

    writeFileSync(file, `${lines.join('\n')}\n`);
    const { traceFile, errors } = await build([], 'codex');
    const [late] = traceFile.runs;

    expect(errors).toEqual([]);
    expect(traceFile.runs).toHaveLength(1);
    expect(late?.id).toBe(early?.id);
    expect(late?.spans.length ?? 0).toBeGreaterThan(early?.spans.length ?? 0);
  });

  it('is listed once, under the same run id, after Codex compressed it', async () => {
    const day = sessionsDir();
    const plain = join(day, NAME);
    const text = `${lines.join('\n')}\n`;
    writeFileSync(plain, text);
    const before = (await build([], 'codex')).traceFile.runs;

    // Codex writes the compressed file first and removes the plain one after
    writeFileSync(`${plain}.zst`, zstdCompressSync(Buffer.from(text, 'utf8')));
    const during = await build([], 'codex');
    unlinkSync(plain);
    const after = await build([], 'codex');

    expect(readdirSync(day)).toEqual([`${NAME}.zst`]);
    for (const { traceFile, errors } of [during, after]) {
      expect(errors).toEqual([]);
      expect(traceFile.runs.map((r) => r.id)).toEqual(before.map((r) => r.id));
    }
    expect(after.traceFile.runs[0]?.spans.length).toBe(before[0]?.spans.length);
    expect(after.traceFile.runs[0]?.source.files[0]).toMatch(/\.jsonl\.zst$/);
  });
});

describe('the setup guides', () => {
  const headings = SETUP_GUIDES_TEXT.split('\n').filter((line) =>
    /^[A-Z]/.test(line),
  );

  it('have a Codex entry between OpenCode and other agents', () => {
    expect(headings.slice(0, 4)).toEqual([
      'Claude Code',
      'OpenCode',
      'Codex',
      'Other agents (Cursor, custom pipelines)',
    ]);
  });

  it('say Codex needs no setup, where its sessions are and how to make one', () => {
    const start = SETUP_GUIDES_TEXT.indexOf('\nCodex\n');
    const entry = SETUP_GUIDES_TEXT.slice(
      start,
      SETUP_GUIDES_TEXT.indexOf('\nOther agents'),
    );
    expect(entry).toContain('Nothing to configure.');
    expect(entry).toContain('~/.codex/sessions');
    expect(entry).toMatch(/Run: {2}codex "[^"]+" +then: {2}runray view/);
    expect(entry.match(/Run:/g)).toHaveLength(1);
  });

  it('count the sources in the closing line', () => {
    expect(headings).toHaveLength(5);
    expect(headings[4]).toBe(
      'All four are read locally. RunRay makes no network calls.',
    );
  });

  it('fit a terminal 80 columns wide', () => {
    for (const line of SETUP_GUIDES_TEXT.split('\n'))
      expect(line.length, line).toBeLessThanOrEqual(80);
  });
});
