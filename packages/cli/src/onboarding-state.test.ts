import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  filterOnboardingPatch,
  getOnboardingState,
  readState,
  resetInMemoryState,
  resolveStatePath,
  updateOnboardingState,
  writeState,
} from './onboarding-state.js';

describe('onboarding-state', () => {
  beforeEach(() => {
    resetInMemoryState();
  });

  describe('resolveStatePath', () => {
    it('honours XDG_CONFIG_HOME when set and non-empty', () => {
      const env = { XDG_CONFIG_HOME: '/custom/xdg' };
      expect(resolveStatePath(env, 'linux')).toBe(
        join('/custom/xdg', 'runray', 'state.json'),
      );
      expect(resolveStatePath(env, 'win32')).toBe(
        join('/custom/xdg', 'runray', 'state.json'),
      );
    });

    it('uses APPDATA on Windows when XDG_CONFIG_HOME is unset', () => {
      const env = { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' };
      expect(resolveStatePath(env, 'win32')).toBe(
        join('C:\\Users\\test\\AppData\\Roaming', 'runray', 'state.json'),
      );
    });

    it('defaults to ~/.config/runray/state.json on Linux/macOS when XDG_CONFIG_HOME is unset', () => {
      const env = { HOME: '/home/testuser' };
      expect(resolveStatePath(env, 'linux')).toBe(
        join('/home/testuser', '.config', 'runray', 'state.json'),
      );
      expect(resolveStatePath(env, 'darwin')).toBe(
        join('/home/testuser', '.config', 'runray', 'state.json'),
      );
    });
  });

  describe('filterOnboardingPatch', () => {
    it('filters patch to known keys and value shapes dropping rest silently', () => {
      const raw = {
        welcomeDismissedAt: '2026-08-10T09:13:00Z',
        tours: { dashboard: 'completed', badVal: 123 },
        hints: ['time-view', 456],
        unknownKey: 'secret',
        badWelcome: 123,
      };
      const filtered = filterOnboardingPatch(raw);
      expect(filtered).toEqual({
        welcomeDismissedAt: '2026-08-10T09:13:00Z',
        tours: { dashboard: 'completed' },
        hints: ['time-view'],
      });
    });

    it('allows null for welcomeDismissedAt', () => {
      expect(filterOnboardingPatch({ welcomeDismissedAt: null })).toEqual({
        welcomeDismissedAt: null,
      });
    });

    it('filters checklist to boolean values dropping rest silently', () => {
      const raw = {
        checklist: {
          tracesIndexed: true,
          waterfallInspected: true,
          invalidVal: 'yes',
          badNum: 1,
        },
      };
      expect(filterOnboardingPatch(raw)).toEqual({
        checklist: {
          tracesIndexed: true,
          waterfallInspected: true,
        },
      });
    });
  });

  describe('reader & writer contract', () => {
    it('returns empty state when file is absent and does not create the file', () => {
      const testDir = join(
        tmpdir(),
        `tp-test-absent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const filePath = join(testDir, 'state.json');

      const state = readState(filePath);
      expect(state).toEqual({});
      expect(existsSync(filePath)).toBe(false);
    });

    it('returns empty state when file contains malformed JSON without throwing', () => {
      const testDir = join(
        tmpdir(),
        `tp-test-malformed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'state.json');
      writeFileSync(filePath, 'not json { bad syntax');

      expect(() => readState(filePath)).not.toThrow();
      expect(readState(filePath)).toEqual({});
    });

    it('returns empty state when file is unreadable without throwing', () => {
      if (process.platform === 'win32') return; // POSIX permissions test
      const testDir = join(
        tmpdir(),
        `tp-test-unreadable-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'state.json');
      writeFileSync(filePath, JSON.stringify({ version: 1 }));
      chmodSync(filePath, 0o000);

      try {
        expect(() => readState(filePath)).not.toThrow();
        expect(readState(filePath)).toEqual({});
      } finally {
        chmodSync(filePath, 0o600);
      }
    });

    it('swallows write failures when directory is read-only after applying in memory', () => {
      if (process.platform === 'win32') return; // POSIX permissions test
      const testDir = join(
        tmpdir(),
        `tp-test-readonly-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(testDir, { recursive: true });
      chmodSync(testDir, 0o500); // read/exec only, no write

      const filePath = join(testDir, 'state.json');

      try {
        expect(() =>
          updateOnboardingState({ hints: ['time-view'] }, filePath),
        ).not.toThrow();

        // Reflected in memory
        expect(getOnboardingState(filePath)).toEqual({
          hints: ['time-view'],
        });
        // File on disk was not created due to permissions
        expect(existsSync(filePath)).toBe(false);
      } finally {
        chmodSync(testDir, 0o700);
      }
    });

    it('preserves unknown top-level keys across writes (unknown-key round-trip)', () => {
      const testDir = join(
        tmpdir(),
        `tp-test-unknown-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'state.json');

      const initialDoc = {
        version: 1,
        customAppSetting: 'preserved',
        nestedCustom: { k: 'v' },
        onboarding: { tours: { dashboard: 'completed' } },
      };
      writeFileSync(filePath, JSON.stringify(initialDoc, null, 2));

      updateOnboardingState({ tours: { run: 'skipped' } }, filePath);

      const writtenContent = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(writtenContent) as Record<string, unknown>;

      expect(parsed.customAppSetting).toBe('preserved');
      expect(parsed.nestedCustom).toEqual({ k: 'v' });
      expect(parsed.onboarding).toEqual({
        tours: { dashboard: 'completed', run: 'skipped' },
      });
    });

    it('creates file with mode 0600 on POSIX', () => {
      if (process.platform === 'win32') return;
      const testDir = join(
        tmpdir(),
        `tp-test-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const filePath = join(testDir, 'state.json');

      writeState({ version: 1 }, filePath);

      expect(existsSync(filePath)).toBe(true);
      const stat = statSync(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('concurrent writers leave a complete parseable document', async () => {
      const testDir = join(
        tmpdir(),
        `tp-test-concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const filePath = join(testDir, 'state.json');

      const writes = Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() => {
          updateOnboardingState(
            { tours: { [`tour_${i}`]: 'completed' } },
            filePath,
          );
        }),
      );

      await Promise.all(writes);

      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
      const parsed = JSON.parse(content) as Record<string, unknown>;
      expect(parsed.onboarding).toBeDefined();
    });
  });
});
