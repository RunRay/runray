import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  Candidate,
  ParseOptions,
  RawRun,
  SourceAdapter,
} from '../adapter.js';
import { isCompressedRollout, readRolloutLines } from '../rollout-lines.js';

/**
 * Codex adapter (change `add-codex-adapter`). Codex writes one "rollout" per
 * thread:
 *
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<start time>-<thread id>.jsonl
 *
 * (`~/.codex/sessions` when `CODEX_HOME` is unset) and later compresses it in
 * place to `.jsonl.zst`. Each line is one record,
 * `{timestamp, ordinal, type, payload}`, and the first one is `session_meta`.
 *
 * Rollouts are the only input (design T1). The SQLite files next to
 * `sessions/` are projections of them with names that change between
 * releases; none is opened, so the adapter needs no SQLite binding and cannot
 * lock a running Codex.
 *
 * A thread whose `session_meta` names a `parent_thread_id` is a child thread
 * (on every machine surveyed: the approval reviewer). It is not a run of its
 * own: its file joins the candidate of its root thread, and `parse()` nests
 * it there as a subagent (design D2).
 *
 * Not registered yet (task 5.2), so discovery does not reach it.
 */

/** A rollout file name, plain or compressed. Anything else in a scanned
 * folder is never opened. */
const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl(\.zst)?$/i;

/** `YYYY/MM/DD` is three levels under the sessions root; the bound leaves
 * room for a root given a few levels above it (the Codex home, a backup
 * folder) and is the one the other adapters use. */
const MAX_DEPTH = 6;

/** The marker record `scripts/scrub-fixture.ts` writes on line one of a
 * fixture, under its current name and the two the project had before. */
const SCRUB_MARKER_TYPES = new Set([
  'x-runray-scrub',
  'x-tracepulse-scrub',
  'x-tracellm-scrub',
]);

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

function defaultRoots(): string[] {
  const env = process.env.CODEX_HOME;
  const home =
    env !== undefined && env !== '' ? env : join(homedir(), '.codex');
  // `sessions`, not the Codex home: the home holds databases Codex writes
  // every few seconds, and zero-config watch would rebuild on each write
  return [join(home, 'sessions')];
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Rollout files under a root, at any depth (`raw/` trees and node_modules
 * excluded). Symbolic links are not followed: a directory entry that is a
 * link is neither a directory nor a file here. */
async function findRollouts(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const name = basename(root);
  if (name === 'raw' || name === 'node_modules') return [];
  const out: string[] = [];
  for (const entry of await safeReaddir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await findRollouts(path, depth + 1)));
    else if (entry.isFile() && ROLLOUT_FILE_RE.test(entry.name)) out.push(path);
  }
  return out;
}

/** What discovery needs from a rollout: which thread it is and whose child. */
interface RolloutHead {
  threadId?: string;
  parentThreadId?: string;
}

/**
 * The first record of a rollout, read as a stream that stops there (the
 * largest first record surveyed is 49 KB; nothing after it is read or
 * decompressed). A leading scrub marker is stepped over.
 *
 * Never throws. A file that cannot be read here (not a rollout, cut short,
 * compressed on a runtime without zstd) comes back with no thread id, stays
 * a candidate of its own, and `parse()` reports the reason for it.
 */
async function readHead(file: string): Promise<RolloutHead> {
  try {
    for await (const { text } of readRolloutLines(file)) {
      if (text.trim() === '') continue;
      const record: unknown = JSON.parse(text);
      if (!isObj(record)) return {};
      const type = str(record.type);
      if (type !== undefined && SCRUB_MARKER_TYPES.has(type)) continue;
      if (type !== 'session_meta' || !isObj(record.payload)) return {};
      return {
        threadId: str(record.payload.id),
        parentThreadId: str(record.payload.parent_thread_id),
      };
    }
  } catch {
    // unreadable or not JSON: no head
  }
  return {};
}

async function statInto(
  files: string[],
): Promise<{ mtimeMs: number; sizeBytes: number }> {
  let mtimeMs = 0;
  let sizeBytes = 0;
  for (const f of files) {
    try {
      const s = await stat(f);
      mtimeMs = Math.max(mtimeMs, s.mtimeMs);
      sizeBytes += s.size;
    } catch {
      // gone since the scan: still listed; parse() will report it
    }
  }
  return { mtimeMs, sizeBytes };
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function detect(roots: string[]): Promise<Candidate[]> {
  const scanRoots = roots.length > 0 ? roots : defaultRoots();
  const found = new Set<string>();
  for (const root of scanRoots) {
    for (const file of await findRollouts(root)) found.add(file);
  }
  const files = [...found].sort(byText);

  // One file per thread. A thread in both forms is read from the plain file,
  // the one a live session appends to; between two files of the same form
  // the first in path order stands. Files with no thread id cannot collide.
  const fileOfThread = new Map<string, string>();
  const parentOfThread = new Map<string, string>();
  const unidentified: string[] = [];
  for (const file of files) {
    const head = await readHead(file);
    if (head.threadId === undefined) {
      unidentified.push(file);
      continue;
    }
    const standing = fileOfThread.get(head.threadId);
    const replaces =
      standing !== undefined &&
      isCompressedRollout(standing) &&
      !isCompressedRollout(file);
    if (standing !== undefined && !replaces) continue;
    fileOfThread.set(head.threadId, file);
    if (head.parentThreadId === undefined) parentOfThread.delete(head.threadId);
    else parentOfThread.set(head.threadId, head.parentThreadId);
  }

  // A child joins the candidate of its root thread, found by following
  // parent links, so a child of a child lands in the same run. A thread
  // whose parent was not scanned is the top of its own candidate (an orphan
  // child). A thread on a parent cycle stands alone: no file written by
  // Codex is, and standing alone cannot loop or lose it.
  const rootOf = (threadId: string): string => {
    const seen = new Set([threadId]);
    let current = threadId;
    for (;;) {
      const parent = parentOfThread.get(current);
      if (parent === undefined || !fileOfThread.has(parent)) return current;
      if (seen.has(parent)) return threadId;
      seen.add(parent);
      current = parent;
    }
  };
  const membersOfRoot = new Map<string, string[]>();
  for (const [threadId, file] of fileOfThread) {
    const root = rootOf(threadId);
    if (root === threadId) continue;
    const members = membersOfRoot.get(root);
    if (members === undefined) membersOfRoot.set(root, [file]);
    else members.push(file);
  }

  const candidates: Candidate[] = [];
  const add = async (rootFile: string, children: string[]) => {
    // the root first, then its children in path order, which is the order
    // they were started in (the name begins with the start time)
    const candidateFiles = [rootFile, ...children.sort(byText)];
    candidates.push({
      runRef: rootFile,
      format: 'codex-jsonl',
      files: candidateFiles,
      ...(await statInto(candidateFiles)),
    });
  };
  for (const file of unidentified) await add(file, []);
  for (const [threadId, file] of fileOfThread) {
    if (rootOf(threadId) !== threadId) continue;
    await add(file, membersOfRoot.get(threadId) ?? []);
  }
  return candidates.sort((a, b) => byText(a.runRef, b.runRef));
}

export const codexAdapter: SourceAdapter = {
  id: 'codex',

  defaultRoots,

  detect,

  async parse(_candidate: Candidate, _opts: ParseOptions): Promise<RawRun> {
    // Tasks 2.2 to 4.2 of `add-codex-adapter`. Nothing can call this before
    // then: the adapter is registered in 5.2.
    throw new Error('the Codex adapter cannot parse a rollout yet');
  },
};
