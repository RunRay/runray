import { describe, expect, it } from 'vitest';
import { errorPreview, exitCodeOf, isUserRejection } from './error-preview.js';

const BATCH_LOG = [
  '[navigate] navigated to http://localhost:4326',
  '',
  'Tab Context:',
  '- Executed on tabId: seed',
  '- Available tabs:',
  '  • tabId seed: "RunRay" (http://localhost:4326)',
  '',
  '[computer:screenshot] Screenshot size: 800x450',
  '',
  'actions[2] (computer:screenshot) failed: screenshot failed: Screenshot timed out after 5s: the page did not finish rendering in time. (2 completed, 0 remaining)',
].join('\n');

describe('errorPreview — where the failure is named', () => {
  it('starts a batch log at its failing step, not at the successful ones', () => {
    const p = errorPreview(BATCH_LOG);
    expect(p?.startsWith('actions[2] (computer:screenshot) failed:')).toBe(
      true,
    );
    expect(p?.length).toBeLessThanOrEqual(200);
  });

  it('skips the shell wrapper line when nothing names the failure', () => {
    const text =
      'Exit code 1\n/usr/bin/bash: line 1: cd: packages/ui/src: No such file or directory';
    expect(errorPreview(text)).toBe(
      '/usr/bin/bash: line 1: cd: packages/ui/src: No such file or directory',
    );
  });

  it('jumps past a stack preamble to the Error line', () => {
    const text = [
      'Exit code 1',
      'node:fs:440',
      '    return binding.readFileUtf8(path, stringToFlags(options.flag));',
      '                   ^',
      "Error: ENOENT: no such file or directory, open 'D:\\tmp\\x.json'",
      '    at Object.readFileSync (node:fs:440:20)',
    ].join('\n');
    expect(errorPreview(text)?.startsWith('Error: ENOENT')).toBe(true);
  });

  it('never picks a line that says there was no error', () => {
    const text = 'Exit code 1\nlint: 3 files failed\nDone with 0 errors';
    expect(errorPreview(text)).toBe('lint: 3 files failed\nDone with 0 errors');
    const only = 'Exit code 1\nRan 12 tests, 0 errors';
    expect(errorPreview(only)).toBe('Ran 12 tests, 0 errors');
  });

  it('counts the plural as naming a failure', () => {
    const text =
      'Compiling...\nLinking...\nBuild finished with 5 errors and 0 warnings.';
    expect(errorPreview(text)).toBe(
      'Build finished with 5 errors and 0 warnings.',
    );
    expect(errorPreview('step one\n2 exceptions were thrown')).toBe(
      '2 exceptions were thrown',
    );
  });

  it('keeps a single-line harness error unchanged', () => {
    const text =
      '<tool_use_error>String to replace not found in file. String: x</tool_use_error>';
    expect(errorPreview(text)).toBe(text);
  });

  it('caps at max characters and preserves undefined/empty distinctly', () => {
    expect(errorPreview(undefined)).toBeUndefined();
    expect(errorPreview('')).toBe('');
    expect(errorPreview('   \n  ')).toBe('   \n  ');
    expect(errorPreview(`x failed ${'y'.repeat(500)}`, 50)?.length).toBe(50);
  });

  it('tolerates CRLF line endings', () => {
    const text = 'Exit code 2\r\nsed: cannot read x: No such file\r\n';
    expect(errorPreview(text)?.startsWith('sed: cannot read x')).toBe(true);
  });
});

describe('exitCodeOf', () => {
  it('reads the wrapper line, with or without the Error: prefix', () => {
    expect(exitCodeOf('Exit code 1\nboom')).toBe(1);
    expect(exitCodeOf('Error: Exit code 49\nnie znaleziono Python')).toBe(49);
  });
  it('is undefined when the text does not start with one', () => {
    expect(exitCodeOf('boom\nExit code 1')).toBeUndefined();
    expect(exitCodeOf(undefined)).toBeUndefined();
    expect(exitCodeOf('')).toBeUndefined();
  });
});

describe('isUserRejection', () => {
  it('recognizes the harness phrasings for a declined call', () => {
    expect(
      isUserRejection(
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
      ),
    ).toBe(true);
    expect(
      isUserRejection(
        "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
      ),
    ).toBe(true);
    expect(isUserRejection('[Request interrupted by user for tool use]')).toBe(
      true,
    );
    expect(
      isUserRejection(
        'Error: The user rejected permission to use this specific tool call.',
      ),
    ).toBe(true);
    expect(isUserRejection('Tool execution aborted')).toBe(true);
  });
  it('is false for real failures and missing text', () => {
    expect(isUserRejection('Exit code 1\nPermission denied')).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });
});
