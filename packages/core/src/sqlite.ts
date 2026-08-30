/**
 * better-sqlite3 loader — the single import site for the native module.
 *
 * better-sqlite3 is an OPTIONAL dependency of the published `runray` package
 * (packages/cli/package.json). It is needed for exactly one thing: reading the
 * OpenCode SQLite store read-only. Claude Code and OTLP — the larger audience
 * — never touch it, yet installing it dragged a deprecation warning from a
 * transitive `prebuild-install` across the very first line of `npx runray
 * demo`. Optional keeps that install quiet and lets `--omit=optional`
 * installs skip the native build entirely.
 *
 * The cost of optional is that the module may simply not be there, so every
 * import goes through `loadSqlite()`: a missing (or unloadable — ABI
 * mismatch, failed native build) module becomes one actionable
 * `SqliteUnavailableError` instead of an unhandled MODULE_NOT_FOUND. Callers
 * degrade the OpenCode SQLite source to "unavailable"; they never crash the
 * scan, and the other sources keep working.
 */

/** Row of an arbitrary query; callers narrow to the columns they select. */
export interface SqliteStatement<Row> {
  all(...params: unknown[]): Row[];
  get(...params: unknown[]): Row | undefined;
}

export interface SqliteDatabase<Row> {
  prepare(sql: string): SqliteStatement<Row>;
  close(): void;
}

/** The only open mode this product uses: read-only, never creating a file. */
export interface SqliteOpenOptions {
  readonly: boolean;
  fileMustExist: boolean;
}

export type SqliteConstructor<Row = Record<string, unknown>> = new (
  path: string,
  options: SqliteOpenOptions,
) => SqliteDatabase<Row>;

export const SQLITE_UNAVAILABLE_MESSAGE =
  'reading the OpenCode SQLite store needs better-sqlite3, an optional dependency that is not installed — ' +
  'reinstall without --omit=optional (npm) or --no-optional (pnpm/yarn), or run `npm i better-sqlite3`. ' +
  'Claude Code and OTLP sources are unaffected.';

/** Thrown when the optional native module cannot be loaded. Distinguishable
 * so callers can degrade the source instead of reporting a corrupt database. */
export class SqliteUnavailableError extends Error {
  readonly name = 'SqliteUnavailableError';
  constructor(cause?: unknown) {
    // A plain missing module needs no cause echoed — the fix is the message.
    // Anything else (ABI mismatch, half-built binding) is diagnostic and must
    // survive, or the user is told to install what is already installed.
    super(
      isModuleNotFound(cause)
        ? SQLITE_UNAVAILABLE_MESSAGE
        : `${SQLITE_UNAVAILABLE_MESSAGE} (load failed: ${cause instanceof Error ? cause.message : String(cause)})`,
    );
    if (cause !== undefined) this.cause = cause;
  }
}

export function isSqliteUnavailable(
  err: unknown,
): err is SqliteUnavailableError {
  return err instanceof SqliteUnavailableError;
}

const MODULE_NOT_FOUND_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
]);

/** Node reports a missing ESM/CJS specifier by `code`; bundled and mocked
 * loaders sometimes rethrow with the message only, hence the text fallback. */
function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && MODULE_NOT_FOUND_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : '';
  return /cannot find (module|package)/i.test(message);
}

/** Resolved once — including the failure, so a missing module costs one
 * failed resolution per process and not one per opencode.db found. */
let cached:
  | { ok: true; ctor: SqliteConstructor<never> }
  | { ok: false; err: SqliteUnavailableError }
  | undefined;

/**
 * The better-sqlite3 constructor, or a `SqliteUnavailableError`. `Row` is the
 * shape the caller's queries select; it is unchecked by design — sqlite is
 * dynamically typed and every call site validates what it reads.
 */
export async function loadSqlite<Row = Record<string, unknown>>(): Promise<
  SqliteConstructor<Row>
> {
  if (cached === undefined) {
    try {
      const mod = (await import('better-sqlite3')) as unknown as {
        default: SqliteConstructor<never>;
      };
      // The import alone proves nothing: better-sqlite3 loads its native
      // addon lazily inside the constructor, so a missing or ABI-mismatched
      // binding resolves fine here and only explodes later — as a raw
      // `bindings` dump from whichever opencode.db was scanned first, past
      // the point where it can be classified. Construct a throwaway
      // in-memory handle to force the binding to load now, so every failure
      // mode arrives as one SqliteUnavailableError.
      const probe = new mod.default(':memory:', {
        readonly: false,
        fileMustExist: false,
      });
      probe.close();
      cached = { ok: true, ctor: mod.default };
    } catch (err) {
      cached = { ok: false, err: new SqliteUnavailableError(err) };
    }
  }
  if (!cached.ok) throw cached.err;
  return cached.ctor as unknown as SqliteConstructor<Row>;
}
