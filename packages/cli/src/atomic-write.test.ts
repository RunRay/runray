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
import { afterAll, describe, expect, it, vi } from 'vitest';
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
