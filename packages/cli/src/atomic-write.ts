import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Waits between rename attempts on Windows, where an antivirus scanner or an
 * editor holding the target open makes the swap fail for a moment
 * (EPERM, EACCES, EBUSY). About 0.3 s in all, then the error stands.
 */
const RENAME_RETRY_MS = [10, 20, 40, 80, 160];
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `renameSync`, retried while Windows reports the target as locked. Never
 * unlinks the target first: the old file must survive a failed swap. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const delay = RENAME_RETRY_MS[attempt];
      if (
        process.platform !== 'win32' ||
        delay === undefined ||
        code === undefined ||
        !TRANSIENT_RENAME_CODES.has(code)
      ) {
        throw err;
      }
      sleepSync(delay);
    }
  }
}

/**
 * Replaces `path` in one step. The content goes to a fresh temp file next to
 * it, created exclusively so a planted file or symlink is never written
 * through, and a rename swaps it in (retried briefly on Windows while the
 * target is locked). On any failure the old file stays as it was and the
 * temp file is removed.
 */
export function writeFileAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(path)}.tmp.${randomUUID()}`);
  let created = false;
  try {
    const fd = openSync(tmpPath, 'wx');
    created = true;
    try {
      writeFileSync(fd, content, 'utf8');
    } finally {
      closeSync(fd);
    }
    renameWithRetry(tmpPath, path);
    created = false;
  } catch (err) {
    if (created) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // already gone
      }
    }
    throw err;
  }
}
