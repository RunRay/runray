import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abbreviateHome } from './discover.js';
import type { OnboardingBlock } from './onboarding-state.js';
import { resetInMemoryState } from './onboarding-state.js';
import { createProgram } from './program.js';

const fixturesDir = fileURLToPath(
  new URL('../../../fixtures/claude-code', import.meta.url),
);

/**
 * The wizard is driven by stubbing the prompt library, not by an env-var
 * escape hatch in `onboarding.ts`: a test seam that ships in the binary is a
 * way to skip the menu in production.
 */
const wizardSelection = { value: 'sample' as string };
const selectSpy = vi.fn(async () => wizardSelection.value);

vi.mock('@clack/prompts', () => ({
  intro: () => {},
  outro: () => {},
  note: () => {},
  cancel: () => {},
  select: (...args: unknown[]) => selectSpy(...(args as [])),
  text: async () => '',
  isCancel: (v: unknown) => typeof v === 'symbol',
}));

vi.setConfig({ testTimeout: 30_000 });

describe('onboarding e2e & regression suite', () => {
  let tempXdgDir: string;
  let origXdg: string | undefined;
  let origStdinTTY: boolean | undefined;
  let origStderrTTY: boolean | undefined;

  beforeEach(() => {
    resetInMemoryState();
    wizardSelection.value = 'sample';
    selectSpy.mockReset();
    selectSpy.mockImplementation(async () => wizardSelection.value);
    tempXdgDir = mkdtempSync(join(tmpdir(), 'runray-e2e-xdg-'));
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempXdgDir;

    origStdinTTY = process.stdin.isTTY;
    origStderrTTY = process.stderr.isTTY;
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (origXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = origXdg;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    if (origStdinTTY !== undefined) process.stdin.isTTY = origStdinTTY;
    if (origStderrTTY !== undefined) process.stderr.isTTY = origStderrTTY;
    process.exitCode = undefined;

    rmSync(tempXdgDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('Task 4.16: Non-TTY regression tests', () => {
    it('list --json prints [] and nothing else on stdout, non-TTY', async () => {
      process.stdin.isTTY = false;
      process.stderr.isTTY = false;

      const emptyDir = mkdtempSync(join(tmpdir(), 'runray-empty-dir-'));
      const consoleLogSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        const prog = createProgram();
        await prog.parseAsync(['node', 'runray', 'list', emptyDir, '--json']);

        expect(process.exitCode).toBe(3);
        const stdout = consoleLogSpy.mock.calls
          .map((c) => c.join(' '))
          .join('\n');
        expect(stdout).toBe('[]');
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('diff --json with missing ref exits 3, stdout clean', async () => {
      process.stdin.isTTY = false;
      process.stderr.isTTY = false;

      const consoleLogSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const prog = createProgram();
      await prog.parseAsync([
        'node',
        'runray',
        'diff',
        'nonexistentA',
        'nonexistentB',
        fixturesDir,
        '--json',
      ]);

      expect(process.exitCode).toBe(3);
      const stdout = consoleLogSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(stdout).toBe('');
      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderr).toContain("No single run matches 'nonexistentA'");
    });

    it('no prompt reachable without a TTY', async () => {
      process.stdin.isTTY = false;
      process.stderr.isTTY = false;

      const emptyDir = mkdtempSync(join(tmpdir(), 'runray-empty-dir-'));
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        const prog = createProgram();
        await prog.parseAsync(['node', 'runray', 'view', emptyDir]);

        expect(process.exitCode).toBe(3);
        const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(stderr).toContain('No agent sessions found.');
        expect(selectSpy).not.toHaveBeenCalled();
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('--serve-empty works without a TTY', async () => {
      process.stdin.isTTY = false;
      process.stderr.isTTY = false;

      const emptyDir = mkdtempSync(join(tmpdir(), 'runray-empty-dir-'));
      const consoleLogSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      try {
        const prog = createProgram();
        await prog.parseAsync([
          'node',
          'runray',
          'view',
          emptyDir,
          '--serve-empty',
          '--no-open',
        ]);

        const stdout = consoleLogSpy.mock.calls
          .map((c) => c.join(' '))
          .join('\n');
        expect(stdout).toContain(
          'RunRay viewing 0 run(s) at http://127.0.0.1:',
        );
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('--serve-empty publishes rootsScanned as {path, verdict}, ~-abbreviated', async () => {
      process.stdin.isTTY = false;
      process.stderr.isTTY = false;

      const consoleLogSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      const prog = createProgram();
      // no explicit path: zero-config roots, so the home-abbreviating branch runs
      await prog.parseAsync([
        'node',
        'runray',
        'view',
        '--source',
        'otlp',
        '--serve-empty',
        '--no-open',
      ]);

      const stdout = consoleLogSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout)?.[0];
      expect(url).toBeDefined();

      const viewConfig = (await (
        await fetch(new URL('/api/viewconfig', url))
      ).json()) as {
        rootsScanned?: Array<Record<string, unknown>>;
      };

      // The UI's EmptyScreen reads `verdict`; a rename here renders it blank.
      for (const root of viewConfig.rootsScanned ?? []) {
        expect(Object.keys(root).sort()).toEqual(['path', 'verdict']);
        expect(['missing', 'empty', 'unreadable']).toContain(root.verdict);
        expect(String(root.path)).not.toContain(homedir());
      }
    });
  });

  describe('Task 4.17: Banner and state tests', () => {
    it('banner prints once never twice on stderr, never on stdout', async () => {
      process.stdin.isTTY = true;
      process.stderr.isTTY = true;

      const consoleLogSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const prog1 = createProgram();
      await prog1.parseAsync(['node', 'runray', 'demo', '--no-open']);

      const stdout1 = consoleLogSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      const stderr1 = stderrSpy.mock.calls.map((c) => String(c[0])).join('');

      expect(stdout1).not.toContain('first run. Nothing leaves this machine.');
      expect(stderr1).toContain('first run. Nothing leaves this machine.');
      expect(stderr1).toContain(
        'This is a scrubbed sample session, not your data.',
      );

      consoleLogSpy.mockClear();
      stderrSpy.mockClear();

      const prog2 = createProgram();
      await prog2.parseAsync(['node', 'runray', 'demo', '--no-open']);

      const stderr2 = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderr2).not.toContain('first run. Nothing leaves this machine.');
      expect(stderr2).not.toContain('This is a scrubbed sample session');
    });

    it('banner absent under --json', async () => {
      process.stdin.isTTY = true;
      process.stderr.isTTY = true;

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const consoleLogSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      const prog = createProgram();
      await prog.parseAsync(['node', 'runray', 'list', fixturesDir, '--json']);

      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const stdout = consoleLogSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');

      expect(stderr).not.toContain('first run');
      expect(stdout).not.toContain('first run');
      expect(stdout).toContain('claude-code');
    });

    it('corrupt state.json still serves', async () => {
      process.stdin.isTTY = true;
      process.stderr.isTTY = true;

      const stateFile = join(tempXdgDir, 'runray', 'state.json');
      mkdirSync(join(tempXdgDir, 'runray'), { recursive: true });
      writeFileSync(stateFile, '{{ invalid json string');

      const consoleLogSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      const prog = createProgram();
      await prog.parseAsync(['node', 'runray', 'demo', '--no-open']);

      const stdout = consoleLogSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      expect(stdout).toContain('RunRay demo:');
    });

    it('explicit wrong [path] presents no wizard', async () => {
      process.stdin.isTTY = true;
      process.stderr.isTTY = true;

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const nonExistent = join(tempXdgDir, 'does-not-exist');
      const prog = createProgram();
      await prog.parseAsync(['node', 'runray', 'view', nonExistent]);

      expect(process.exitCode).toBe(3);
      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderr).toContain('No agent sessions found.');
      // Terminal output is `~`-abbreviated and slash-normalised (cli spec,
      // 'Paths abbreviated in terminal output'), so asserting the raw path
      // only passes where the temp dir sits outside $HOME — not on Windows.
      expect(stderr).toContain(abbreviateHome(nonExistent));
    });
  });

  describe('Task 4.18: CLI e2e suite with onboarding API & silent second run', () => {
    it('first run under temp XDG_CONFIG_HOME → wizard branch → server up → GET /api/onboarding reflects state → second run is silent', async () => {
      process.stdin.isTTY = true;
      process.stderr.isTTY = true;
      wizardSelection.value = 'sample';

      const consoleLogSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const emptyDir = mkdtempSync(join(tmpdir(), 'runray-empty-e2e-'));

      try {
        const prog1 = createProgram();
        // Interactive view with 0 runs (--source otlp) triggers wizard -> sample branch -> starts server
        await prog1.parseAsync([
          'node',
          'runray',
          'view',
          '--source',
          'otlp',
          '--no-open',
        ]);

        const stdout1 = consoleLogSpy.mock.calls
          .map((c) => c.join(' '))
          .join('\n');
        const stderr1 = stderrSpy.mock.calls.map((c) => String(c[0])).join('');

        expect(stderr1).toContain('first run. Nothing leaves this machine.');
        expect(stdout1).toContain('RunRay demo:');

        // Extract server URL
        const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout1);
        expect(match).toBeDefined();
        const serverUrl = match?.[0];
        expect(serverUrl).toBeDefined();

        // GET /api/onboarding reflects state
        const res = await fetch(new URL('/api/onboarding', serverUrl));
        expect(res.status).toBe(200);
        const onboardingData = (await res.json()) as OnboardingBlock;
        expect(onboardingData).toBeDefined();

        // POST /api/onboarding patch
        const postRes = await fetch(new URL('/api/onboarding', serverUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ welcomeDismissedAt: '2026-08-11T12:00:00Z' }),
        });
        expect(postRes.status).toBe(200);
        const updatedOnboarding = (await postRes.json()) as OnboardingBlock;
        expect(updatedOnboarding.welcomeDismissedAt).toBe(
          '2026-08-11T12:00:00Z',
        );

        // Second run is silent (banner suppressed, demo bridge suppressed)
        consoleLogSpy.mockClear();
        stderrSpy.mockClear();

        const prog2 = createProgram();
        await prog2.parseAsync(['node', 'runray', 'demo', '--no-open']);

        const stderr2 = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(stderr2).not.toContain('first run');
        expect(stderr2).not.toContain('This is a scrubbed sample session');
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });
});
