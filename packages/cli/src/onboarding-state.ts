import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Surface C (the seam): durable per-user onboarding state.
 *
 * File contract:
 * - Location: $XDG_CONFIG_HOME/tracepulse/state.json, or %APPDATA%\tracepulse\state.json on Windows,
 *   defaulting to ~/.config/tracepulse/state.json.
 * - Permissions: 0600 on POSIX.
 * - Atomicity: write temporary file in the same directory, then rename.
 * - Unknown top-level keys preserved across writes.
 * - Degradation: absent, unreadable, or malformed JSON returns empty state, never throws.
 * - Write failures: swallowed after applying in memory.
 */

export interface OnboardingBlock {
  welcomeDismissedAt?: string | null;
  tours?: Record<string, string>;
  hints?: string[];
}

export interface StateDocument {
  version?: number;
  firstSeenAt?: string | null;
  demoSeenAt?: string | null;
  hintsShown?: string[];
  onboarding?: OnboardingBlock;
  [key: string]: unknown;
}

let inMemoryDocument: StateDocument | null = null;

/**
 * Resets the in-memory document state (primarily for test isolation).
 */
export function resetInMemoryState(): void {
  inMemoryDocument = null;
}

/**
 * Resolves the state file path based on environment variables and platform.
 */
export function resolveStatePath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== '') {
    const runrayPath = join(env.XDG_CONFIG_HOME, 'runray', 'state.json');
    if (existsSync(runrayPath)) return runrayPath;
    const legacyPath = join(env.XDG_CONFIG_HOME, 'tracepulse', 'state.json');
    if (existsSync(legacyPath)) return legacyPath;
    return runrayPath;
  }
  if (platform === 'win32' && env.APPDATA && env.APPDATA.trim() !== '') {
    const runrayPath = join(env.APPDATA, 'runray', 'state.json');
    if (existsSync(runrayPath)) return runrayPath;
    const legacyPath = join(env.APPDATA, 'tracepulse', 'state.json');
    if (existsSync(legacyPath)) return legacyPath;
    return runrayPath;
  }
  const home = env.HOME ?? homedir();
  const runrayPath = join(home, '.config', 'runray', 'state.json');
  if (existsSync(runrayPath)) return runrayPath;
  const legacyPath = join(home, '.config', 'tracepulse', 'state.json');
  if (existsSync(legacyPath)) return legacyPath;
  return runrayPath;
}

/**
 * Filters an incoming onboarding patch to known keys and value shapes.
 * Drops unknown keys and invalid shapes silently.
 */
export function filterOnboardingPatch(patch: unknown): OnboardingBlock {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return {};
  }
  const obj = patch as Record<string, unknown>;
  const result: OnboardingBlock = {};

  if (
    'welcomeDismissedAt' in obj &&
    (typeof obj.welcomeDismissedAt === 'string' ||
      obj.welcomeDismissedAt === null)
  ) {
    result.welcomeDismissedAt = obj.welcomeDismissedAt;
  }

  if (
    'tours' in obj &&
    typeof obj.tours === 'object' &&
    obj.tours !== null &&
    !Array.isArray(obj.tours)
  ) {
    const toursObj = obj.tours as Record<string, unknown>;
    const tours: Record<string, string> = {};
    for (const [k, v] of Object.entries(toursObj)) {
      if (typeof v === 'string') {
        tours[k] = v;
      }
    }
    result.tours = tours;
  }

  if ('hints' in obj && Array.isArray(obj.hints)) {
    const hints: string[] = [];
    for (const item of obj.hints) {
      if (typeof item === 'string') {
        hints.push(item);
      }
    }
    result.hints = hints;
  }

  return result;
}

function mergeOnboardingBlocks(
  base?: OnboardingBlock,
  patch?: OnboardingBlock,
): OnboardingBlock {
  if (!base && !patch) return {};
  if (!base) return { ...patch };
  if (!patch) return { ...base };

  const merged: OnboardingBlock = { ...base, ...patch };

  if (base.tours || patch.tours) {
    merged.tours = { ...(base.tours ?? {}), ...(patch.tours ?? {}) };
  }

  if (base.hints || patch.hints) {
    const set = new Set<string>([
      ...(base.hints ?? []),
      ...(patch.hints ?? []),
    ]);
    merged.hints = Array.from(set);
  }

  return merged;
}

function mergeStateDocuments(
  ...docs: Array<Partial<StateDocument> | undefined>
): StateDocument {
  const result: StateDocument = {};
  for (const doc of docs) {
    if (!doc) continue;
    for (const [key, value] of Object.entries(doc)) {
      if (key === 'onboarding') {
        result.onboarding = mergeOnboardingBlocks(
          result.onboarding,
          value as OnboardingBlock,
        );
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

function readStateFromDiskOnly(filePath: string): StateDocument {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as StateDocument;
      }
    }
  } catch {
    // Malformed JSON, unreadable, or missing file: return empty state
  }
  return {};
}

/**
 * Reads the state document from disk (or in-memory cache if updated).
 * Never throws, never creates the file on read.
 */
export function readState(statePath?: string): StateDocument {
  const filePath = statePath ?? resolveStatePath();
  const diskDoc = readStateFromDiskOnly(filePath);

  if (inMemoryDocument === null) {
    return diskDoc;
  }

  return mergeStateDocuments(diskDoc, inMemoryDocument);
}

/**
 * Writes a patch to state document lazily with mode 0600.
 * Writes atomically via a temp file in the same directory plus rename.
 * Shallow-merges into existing document and swallows write failures after applying in memory.
 */
export function writeState(
  patch: Partial<StateDocument>,
  statePath?: string,
): StateDocument {
  const filePath = statePath ?? resolveStatePath();
  const currentDisk = readStateFromDiskOnly(filePath);

  const merged = mergeStateDocuments(
    currentDisk,
    inMemoryDocument ?? {},
    patch,
  );

  inMemoryDocument = merged;

  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = join(
      dir,
      `.state.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
    const content = JSON.stringify(merged, null, 2);
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    if (process.platform !== 'win32') {
      try {
        chmodSync(tmpPath, 0o600);
      } catch {
        // ignore chmod failure
      }
    }
    renameSync(tmpPath, filePath);
  } catch {
    // Swallow write failures after applying in memory
  }

  return inMemoryDocument;
}

/**
 * Returns the onboarding sub-block from the state document.
 */
export function getOnboardingState(statePath?: string): OnboardingBlock {
  return readState(statePath).onboarding ?? {};
}

/**
 * Updates the onboarding sub-block with a shallow-merged patch.
 */
export function updateOnboardingState(
  patch: OnboardingBlock,
  statePath?: string,
): OnboardingBlock {
  const filtered = filterOnboardingPatch(patch);
  const updatedDoc = writeState({ onboarding: filtered }, statePath);
  return updatedDoc.onboarding ?? {};
}
