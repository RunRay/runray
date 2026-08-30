import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run, TraceFile } from '@runray/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ClackPrompts,
  formatConfigSnippet,
  runWizard,
  shouldRunWizard,
  WIZARD_EXIT_TEXT,
  writeDemoBridge,
  writeFirstRunBanner,
  writeNextStepHints,
} from './onboarding.js';
import { readState, resetInMemoryState } from './onboarding-state.js';

describe('onboarding unit & wizard tests', () => {
  let tempDir: string;
  let statePath: string;

  beforeEach(() => {
    resetInMemoryState();
    tempDir = mkdtempSync(join(tmpdir(), 'tp-onboarding-test-'));
    statePath = join(tempDir, 'state.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('writeFirstRunBanner', () => {
    it('prints once per machine on stderr, never twice, never on stdout', () => {
      const isTTY = process.stderr.isTTY;
      process.stderr.isTTY = true;

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      try {
        writeFirstRunBanner(14, 2, '2026-07-01', statePath);
        expect(stderrSpy).toHaveBeenCalledTimes(1);
        const text = String(stderrSpy.mock.calls[0]?.[0]);
        expect(text).toContain('first run. Nothing leaves this machine.');
        expect(text).toContain('Read 14 session(s) from 2 location(s).');
        expect(stdoutSpy).not.toHaveBeenCalled();

        // Second invocation: silent
        stderrSpy.mockClear();
        writeFirstRunBanner(14, 2, '2026-07-01', statePath);
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        process.stderr.isTTY = isTTY;
      }
    });

    it('omits second line when runsCount is 0', () => {
      const isTTY = process.stderr.isTTY;
      process.stderr.isTTY = true;

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        writeFirstRunBanner(0, 0, '2026-07-01', statePath);
        expect(stderrSpy).toHaveBeenCalledTimes(1);
        const text = String(stderrSpy.mock.calls[0]?.[0]);
        expect(text).toContain('first run. Nothing leaves this machine.');
        expect(text).not.toContain('Read ');
      } finally {
        process.stderr.isTTY = isTTY;
      }
    });

    it('is suppressed on non-TTY stderr', () => {
      const isTTY = process.stderr.isTTY;
      process.stderr.isTTY = false;

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        writeFirstRunBanner(10, 1, '2026-07-01', statePath);
        expect(stderrSpy).not.toHaveBeenCalled();
        // ...and the machine is NOT marked as seen: a piped run must not
        // consume the banner the first interactive run exists to show.
        expect(readState(statePath).firstSeenAt).toBeUndefined();
      } finally {
        process.stderr.isTTY = isTTY;
      }
    });

    it('still prints on the first TTY run after a non-TTY run', () => {
      const isTTY = process.stderr.isTTY;
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        process.stderr.isTTY = false;
        writeFirstRunBanner(10, 1, '2026-07-01', statePath);
        expect(stderrSpy).not.toHaveBeenCalled();

        process.stderr.isTTY = true;
        writeFirstRunBanner(10, 1, '2026-07-01', statePath);
        const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(printed).toContain('first run. Nothing leaves this machine.');
        expect(readState(statePath).firstSeenAt).toBeDefined();
      } finally {
        process.stderr.isTTY = isTTY;
      }
    });

    it('corrupt state.json still serves (does not throw)', () => {
      writeFileSync(statePath, 'corrupt json {{');
      const isTTY = process.stderr.isTTY;
      process.stderr.isTTY = true;

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        expect(() =>
          writeFirstRunBanner(5, 1, '2026-07-01', statePath),
        ).not.toThrow();
        expect(stderrSpy).toHaveBeenCalledTimes(1);
      } finally {
        process.stderr.isTTY = isTTY;
      }
    });
  });

  describe('formatConfigSnippet (Windows paths)', () => {
    // The snippet is instructions the user is told to paste. Interpolating a
    // Windows path raw produced either invalid JSON or a silently corrupted
    // path, so following them broke every later command.
    it('emits JSON that parses back to the exact path', () => {
      const winPath = 'C:\\Users\\alice\\.claude\\projects';
      const snippet = formatConfigSnippet(winPath);
      const json = snippet.slice(
        snippet.indexOf('{'),
        snippet.lastIndexOf('}') + 1,
      );
      expect(JSON.parse(json)).toEqual({ dataRoots: [winPath] });
    });

    it('does not turn an escape-looking segment into a control character', () => {
      const winPath = 'C:\\temp\\runs';
      const snippet = formatConfigSnippet(winPath);
      const json = snippet.slice(
        snippet.indexOf('{'),
        snippet.lastIndexOf('}') + 1,
      );
      const parsed = JSON.parse(json) as { dataRoots: string[] };
      expect(parsed.dataRoots[0]).toBe(winPath);
      expect(parsed.dataRoots[0]).not.toContain('	');
    });

    it('quotes the command argument when the path contains spaces', () => {
      const spaced = 'C:\\Program Files\\logs';
      expect(formatConfigSnippet(spaced)).toContain(`runray view "${spaced}"`);
    });

    it('does not let a trailing separator escape the closing quote', () => {
      // `"C:\My Logs\"` reads as an escaped quote under Windows argv rules,
      // so the argument swallows the rest of the command line.
      const commandLine =
        formatConfigSnippet('C:\\My Logs\\').split('\n')[0] ?? '';
      expect(commandLine).toBe('To run this again:  runray view "C:\\My Logs"');
    });

    it('quotes a path whose metacharacters would split the command', () => {
      // No space, so the old predicate left this bare and cmd.exe would run
      // the tail as a second command.
      const nasty = 'C:\\logs&calc';
      expect(formatConfigSnippet(nasty)).toContain(`runray view "${nasty}"`);
    });
  });

  describe('shouldRunWizard', () => {
    it('returns true only when zero runs, stdin/stderr TTY, no explicit path, no serveEmpty', () => {
      const origStdin = process.stdin.isTTY;
      const origStderr = process.stderr.isTTY;
      process.stdin.isTTY = true;
      process.stderr.isTTY = true;

      try {
        expect(shouldRunWizard(0, undefined, false)).toBe(true);
        expect(shouldRunWizard(1, undefined, false)).toBe(false); // runs > 0
        expect(shouldRunWizard(0, '/custom/path', false)).toBe(false); // explicit path
        expect(shouldRunWizard(0, undefined, true)).toBe(false); // serveEmpty

        process.stdin.isTTY = false;
        expect(shouldRunWizard(0, undefined, false)).toBe(false); // non-TTY stdin

        process.stdin.isTTY = true;
        process.stderr.isTTY = false;
        expect(shouldRunWizard(0, undefined, false)).toBe(false); // non-TTY stderr
      } finally {
        process.stdin.isTTY = origStdin;
        process.stderr.isTTY = origStderr;
      }
    });
  });

  describe('writeDemoBridge', () => {
    it('prints demo bridge line once, suppressed on re-run', () => {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      writeDemoBridge(statePath);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(String(stderrSpy.mock.calls[0]?.[0])).toContain(
        'This is a scrubbed sample session, not your data.',
      );

      stderrSpy.mockClear();
      writeDemoBridge(statePath);
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  describe('writeNextStepHints', () => {
    const makeRun = (id: string, ageMsAgo: number, hasInsights = false): Run =>
      ({
        id,
        source: { tool: 'claude-code', format: 'claude-jsonl', files: ['/a'] },
        startedAt: new Date(Date.now() - ageMsAgo).toISOString(),
        spans: [],
        totals: {
          tokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
          costUSD: { total: 0, wastedEstimate: 0, byModel: {} },
          counts: {
            llmCalls: 0,
            toolCalls: 0,
            toolErrors: 0,
            subagents: 0,
            maxDepth: 1,
          },
          cache: { hitRate: 0 },
        },
        insights: hasInsights
          ? [{ ruleId: 'rule1', severity: 'warning', title: 't' }]
          : [],
      }) as unknown as Run;

    const makeTf = (runs: Run[]): TraceFile => ({
      schemaVersion: '0.1.0',
      generator: { name: 'runray', version: '0.1.0' },
      generatedAt: new Date().toISOString(),
      runs,
    });

    it('shows at most 2 hints on the first successful view, then never again', () => {
      const isTTY = process.stderr.isTTY;
      process.stderr.isTTY = true;

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        const tf = makeTf([
          makeRun('r1', 1 * 60 * 1000, true), // < 10m old, has insights
          makeRun('r2', 1 * 60 * 1000, false),
        ]);

        writeNextStepHints(tf, statePath);
        expect(stderrSpy).toHaveBeenCalledTimes(2);
        // Eligible: shortcuts, diff (runs>=2), watch (run<10m), export (insights). Priority order: shortcuts, diff
        expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('shortcuts');
        expect(String(stderrSpy.mock.calls[1]?.[0])).toContain('diff');

        const state = readState(statePath);
        expect(state.hintsShown).toEqual(['shortcuts', 'diff']);

        // Second run prints nothing, even though `watch` and `export` were
        // eligible and never shown: hints belong to the first successful view
        // only (cli spec, "Hints not repeated").
        stderrSpy.mockClear();
        writeNextStepHints(tf, statePath);
        expect(stderrSpy).not.toHaveBeenCalled();
        expect(readState(statePath).hintsShown).toEqual(['shortcuts', 'diff']);

        // Third run: still silent
        stderrSpy.mockClear();
        writeNextStepHints(tf, statePath);
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        process.stderr.isTTY = isTTY;
      }
    });
  });

  describe('runWizard branches', () => {
    it('branch sample → returns serve with demo trace', async () => {
      const mockPrompts: ClackPrompts = {
        intro: () => {},
        select: async () => 'sample',
        text: async () => '',
        isCancel: () => false,
        cancel: () => {},
      };

      const res = await runWizard(
        {
          rootsScanned: [{ path: '/test', verdict: 'missing' }],
          redact: false,
          generatorVersion: '0.1.0',
          statePath,
        },
        mockPrompts,
      );

      expect(res.action).toBe('serve');
      if (res.action === 'serve') {
        expect(res.isDemo).toBe(true);
        expect(res.traceFile.runs.length).toBeGreaterThan(0);
      }
    });

    it('branch guides → prints setup guides text and re-prompts, then exit', async () => {
      let callCount = 0;
      const mockPrompts: ClackPrompts = {
        intro: () => {},
        select: async () => {
          callCount++;
          return callCount === 1 ? 'guides' : 'exit';
        },
        text: async () => '',
        isCancel: () => false,
        cancel: () => {},
      };

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const res = await runWizard(
        {
          rootsScanned: [{ path: '/test', verdict: 'missing' }],
          redact: false,
          generatorVersion: '0.1.0',
          statePath,
        },
        mockPrompts,
      );

      expect(res.action).toBe('exit');
      if (res.action === 'exit') {
        expect(res.exitCode).toBe(3);
      }

      const allStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(allStderr).toContain('Claude Code');
      expect(allStderr).toContain('OpenCode');
      expect(allStderr).toContain('Other agents');
      expect(allStderr).toContain(WIZARD_EXIT_TEXT);
    });

    it('branch path → found → returns serve and prints config snippet', async () => {
      const sampleSessionDir = join(tempDir, 'sample-session');
      mkdirSync(sampleSessionDir, { recursive: true });
      const record = {
        type: 'user',
        uuid: 'u1',
        sessionId: 'test-sess',
        timestamp: '2026-07-02T13:00:00Z',
        cwd: '/tmp',
        message: { role: 'user', content: 'test' },
      };
      writeFileSync(
        join(sampleSessionDir, 'sess.jsonl'),
        `${JSON.stringify(record)}\n`,
      );

      const mockPrompts: ClackPrompts = {
        intro: () => {},
        select: async () => 'path',
        text: async () => sampleSessionDir,
        isCancel: () => false,
        cancel: () => {},
      };

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const res = await runWizard(
        {
          rootsScanned: [{ path: '/test', verdict: 'missing' }],
          redact: false,
          generatorVersion: '0.1.0',
          statePath,
        },
        mockPrompts,
      );

      expect(res.action).toBe('serve');
      if (res.action === 'serve') {
        expect(res.traceFile.runs.length).toBe(1);
        expect(res.configSnippetPath).toBe(sampleSessionDir);
      }

      const allStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      // The cli spec requires BOTH the repeatable invocation and the snippet
      expect(allStderr).toContain(`runray view ${sampleSessionDir}`);
      expect(allStderr).toContain(
        'To make this the default, add to runray.config.json',
      );
    });

    it('branch path → 3 failed attempts → exits 3', async () => {
      const mockPrompts: ClackPrompts = {
        intro: () => {},
        select: async () => 'path',
        text: async () => '/nonexistent/path',
        isCancel: () => false,
        cancel: () => {},
      };

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const res = await runWizard(
        {
          rootsScanned: [{ path: '/test', verdict: 'missing' }],
          redact: false,
          generatorVersion: '0.1.0',
          statePath,
        },
        mockPrompts,
      );

      expect(res.action).toBe('exit');
      if (res.action === 'exit') {
        expect(res.exitCode).toBe(3);
      }

      const allStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(allStderr).toContain('Nothing readable in /nonexistent/path.');
      expect(allStderr).toContain(WIZARD_EXIT_TEXT);
    });

    it('branch empty → returns serve with 0 runs and rootsScanned', async () => {
      const mockPrompts: ClackPrompts = {
        intro: () => {},
        select: async () => 'empty',
        text: async () => '',
        isCancel: () => false,
        cancel: () => {},
      };

      const roots = [{ path: '/test', verdict: 'missing' as const }];
      const res = await runWizard(
        {
          rootsScanned: roots,
          redact: false,
          generatorVersion: '0.1.0',
          statePath,
        },
        mockPrompts,
      );

      expect(res.action).toBe('serve');
      if (res.action === 'serve') {
        expect(res.traceFile.runs.length).toBe(0);
        expect(res.rootsScanned).toEqual(roots);
      }
    });

    it('branch exit / Ctrl-C → prints no data hints and exit text, exits 3', async () => {
      const cancelSymbol = Symbol('clack:cancel');
      const mockPrompts: ClackPrompts = {
        intro: () => {},
        select: async () => cancelSymbol,
        text: async () => '',
        isCancel: (v) => v === cancelSymbol,
        cancel: () => {},
      };

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const res = await runWizard(
        {
          rootsScanned: [{ path: '/test', verdict: 'missing' }],
          redact: false,
          generatorVersion: '0.1.0',
          statePath,
        },
        mockPrompts,
      );

      expect(res.action).toBe('exit');
      if (res.action === 'exit') {
        expect(res.exitCode).toBe(3);
      }

      const allStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(allStderr).toContain('No agent sessions found.');
      expect(allStderr).toContain(WIZARD_EXIT_TEXT);
    });
  });
});
