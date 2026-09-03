import { describe, expect, it } from 'vitest';
import { extractToolTarget, toolTargetAttributes } from './target.js';

describe('extractToolTarget', () => {
  it('recognizes claude-code file tools with their kinds', () => {
    const read = extractToolTarget('claude-code', 'Read', {
      file_path: '/src/a.ts',
    });
    expect(read?.kind).toBe('file-read');
    expect(read?.key).toMatch(/^[0-9a-f]{16}$/);
    expect(read?.display).toBe('a.ts');

    for (const tool of ['Edit', 'MultiEdit', 'Write']) {
      expect(
        extractToolTarget('claude-code', tool, { file_path: '/src/a.ts' })
          ?.kind,
      ).toBe('file-write');
    }
    expect(
      extractToolTarget('claude-code', 'NotebookEdit', {
        notebook_path: '/nb/x.ipynb',
      })?.kind,
    ).toBe('file-write');
  });

  it('same path → same key across read and write kinds and adapters', () => {
    const ccRead = extractToolTarget('claude-code', 'Read', {
      file_path: '/src/a.ts',
    });
    const ccEdit = extractToolTarget('claude-code', 'Edit', {
      file_path: '/src/a.ts',
    });
    const ocRead = extractToolTarget('opencode', 'read', {
      filePath: '/src/a.ts',
    });
    expect(ccRead?.key).toBe(ccEdit?.key);
    expect(ccRead?.key).toBe(ocRead?.key);
  });

  it('windows and posix separators normalize to one identity', () => {
    const win = extractToolTarget('claude-code', 'Read', {
      file_path: 'D:\\src\\a.ts',
    });
    const posix = extractToolTarget('claude-code', 'Read', {
      file_path: 'D:/src/a.ts',
    });
    expect(win?.key).toBe(posix?.key);
  });

  it('commands hash only the executable token', () => {
    const a = extractToolTarget('claude-code', 'Bash', {
      command: 'git commit -m "x"',
    });
    const b = extractToolTarget('claude-code', 'Bash', {
      command: 'git push origin main',
    });
    expect(a?.kind).toBe('command');
    expect(a?.key).toBe(b?.key);
    expect(a?.display).toBe('git');
    const abs = extractToolTarget('opencode', 'bash', {
      command: '/usr/bin/git status',
    });
    expect(abs?.display).toBe('git');
  });

  it('unrecognized tools and missing fields yield nothing', () => {
    expect(extractToolTarget('claude-code', 'Glob', { pattern: '*' })).toBe(
      undefined,
    );
    expect(extractToolTarget('claude-code', 'Read', {})).toBe(undefined);
    expect(extractToolTarget('claude-code', 'Bash', { command: '   ' })).toBe(
      undefined,
    );
    expect(extractToolTarget('opencode', 'Read', { filePath: '/a' })).toBe(
      undefined, // opencode tool names are lowercase
    );
  });

  it('a tool named after an Object.prototype member does not crash', () => {
    // An untrusted transcript can name a tool `constructor`, `toString`,
    // `hasOwnProperty`, `__proto__`, `valueOf` — a bare index lookup would
    // resolve to the inherited member and throw on spec.fields.map.
    for (const name of [
      'constructor',
      'toString',
      'hasOwnProperty',
      '__proto__',
      'valueOf',
    ]) {
      expect(extractToolTarget('claude-code', name, { file_path: '/a' })).toBe(
        undefined,
      );
      expect(
        toolTargetAttributes('opencode', name, { filePath: '/a' }, false),
      ).toEqual({});
    }
  });

  it('display token is capped at 80 chars', () => {
    const long = `/dir/${'x'.repeat(200)}.ts`;
    const t = extractToolTarget('claude-code', 'Read', { file_path: long });
    expect(t?.display.length).toBe(80);
  });
});

describe('toolTargetAttributes', () => {
  it('identity survives redaction; display does not', () => {
    const input = { file_path: '/src/a.ts' };
    const open = toolTargetAttributes('claude-code', 'Read', input, false);
    const redacted = toolTargetAttributes('claude-code', 'Read', input, true);
    expect(redacted['runray.targetKey']).toBe(open['runray.targetKey']);
    expect(redacted['runray.targetKind']).toBe('file-read');
    expect(open['runray.target']).toBe('a.ts');
    expect('runray.target' in redacted).toBe(false);
  });

  it('unrecognized tools get an empty attributes object', () => {
    expect(toolTargetAttributes('claude-code', 'Glob', {}, false)).toEqual({});
  });
});

describe('PowerShell commands (Claude Code on Windows)', () => {
  it('hash the executable token like Bash, so a loop of failing commands has an identity', () => {
    const a = extractToolTarget('claude-code', 'PowerShell', {
      command: 'git status',
    });
    const b = extractToolTarget('claude-code', 'PowerShell', {
      command: 'git log --oneline -5',
    });
    const bash = extractToolTarget('claude-code', 'Bash', {
      command: 'git status',
    });
    expect(a?.kind).toBe('command');
    expect(a?.key).toBe(b?.key);
    expect(a?.key).toBe(bash?.key);
    expect(a?.display).toBe('git');
  });
});
