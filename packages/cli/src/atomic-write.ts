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
 * Replaces `path` in one step. The content goes to a fresh temp file next to
 * it, created exclusively so a planted file or symlink is never written
 * through, and a rename swaps it in. On any failure the old file stays as it
 * was and the temp file is removed.
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
    renameSync(tmpPath, path);
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
