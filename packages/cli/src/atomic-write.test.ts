import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from './atomic-write.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

const dir = mkdtempSync(join(tmpdir(), 'runray-atomic-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('writeFileAtomic', () => {
  it('creates missing directories and leaves only the target', () => {
    const path = join(dir, 'a', 'b', 'file.json');
    writeFileAtomic(path, 'first');
    expect(readFileSync(path, 'utf8')).toBe('first');
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['file.json']);
  });

  it('replaces an existing file', () => {
    const path = join(dir, 'replace.json');
    writeFileSync(path, 'old');
    writeFileAtomic(path, 'new');
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  it('keeps the old file and removes the temp file when the swap fails', () => {
    const caseDir = mkdtempSync(join(dir, 'fail-'));
    const path = join(caseDir, 'file.json');
    writeFileSync(path, 'old');
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('EXDEV: cross-device link not permitted');
    });
    expect(() => writeFileAtomic(path, 'new')).toThrow(/EXDEV/);
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(readdirSync(caseDir)).toEqual(['file.json']);
  });

  it('keeps the old file and removes the temp file when the write fails', () => {
    const caseDir = mkdtempSync(join(dir, 'full-'));
    const path = join(caseDir, 'file.json');
    writeFileSync(path, 'old');
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    expect(() => writeFileAtomic(path, 'new')).toThrow(/ENOSPC/);
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(readdirSync(caseDir)).toEqual(['file.json']);
  });
});

describe('writeFileAtomic on Windows, target locked for a moment', () => {
  const platform = process.platform;
  const as = (value: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value });
  afterEach(() => {
    as(platform);
    vi.mocked(renameSync).mockClear();
  });
  const locked = (code: string) => () => {
    throw Object.assign(new Error(`${code}: resource busy or locked`), {
      code,
    });
  };

  it('retries the swap until the lock lifts', () => {
    as('win32');
    const caseDir = mkdtempSync(join(dir, 'locked-'));
    const path = join(caseDir, 'file.json');
    writeFileSync(path, 'old');
    vi.mocked(renameSync)
      .mockImplementationOnce(locked('EPERM'))
      .mockImplementationOnce(locked('EBUSY'));
    writeFileAtomic(path, 'new');
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(renameSync).toHaveBeenCalledTimes(3);
    expect(readdirSync(caseDir)).toEqual(['file.json']);
  });

  it('gives up after a few tries and keeps the old file', () => {
    as('win32');
    const caseDir = mkdtempSync(join(dir, 'stuck-'));
    const path = join(caseDir, 'file.json');
    writeFileSync(path, 'old');
    vi.mocked(renameSync).mockImplementation(locked('EACCES'));
    try {
      expect(() => writeFileAtomic(path, 'new')).toThrow(/EACCES/);
      // the first try and five retries
      expect(renameSync).toHaveBeenCalledTimes(6);
    } finally {
      // back to the real rename for the tests after this one
      vi.mocked(renameSync).mockReset();
    }
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(readdirSync(caseDir)).toEqual(['file.json']);
  });

  it('does not retry elsewhere, where EPERM is a real refusal', () => {
    as('linux');
    const caseDir = mkdtempSync(join(dir, 'posix-'));
    const path = join(caseDir, 'file.json');
    writeFileSync(path, 'old');
    vi.mocked(renameSync).mockImplementationOnce(locked('EPERM'));
    expect(() => writeFileAtomic(path, 'new')).toThrow(/EPERM/);
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(readFileSync(path, 'utf8')).toBe('old');
  });
});
