# Tasks: add-persistent-index

All Track **A** (data: `packages/core`, `packages/cli`). Every task:
`pnpm lint && pnpm typecheck && pnpm test` green, **goldens untouched** —
this change alters no normalizer/rule/pricing output, and task 1.4 enforces
exactly that. Design references (D1–D10) point at `design.md`.

Lands strictly **after add-profiler-depth**: it needs the final adapter
parse output and Batch-1 goldens (for the equivalence matrix), the
capture-once pricing wiring in `program.ts` (shared rebuild path), the
`defaultRoots()` watch fix, and the transcript endpoint's structured
`unavailable` handling.

## 1. Index

- [ ] 1.1 A Run-index store `packages/core/src/store/run-index.ts`
      (D1–D5): better-sqlite3 (existing core dep — PR dependency note), WAL
      + busy_timeout, rows keyed `(adapterId, runRef, redactMode)` with
      mtime/size/version stamps and gzipped `RawRun` blobs; API
      `openRunIndex(dir)` → lookup/upsert/listRotated/status/prune/clear;
      dir resolution `RUNRAY_INDEX_DIR` → XDG → LOCALAPPDATA → ~/.cache,
      0600 perms; unit tests incl. version-mismatch miss, redact-variant
      isolation, JSON round-trip of optional fields, concurrency
      (Windows CI).
- [ ] 1.2 A Integrate the index into `buildTraceFile`
      (`packages/cli/src/discover.ts`) (D2, D3, D6): hit path skips
      `adapter.parse`, miss path parses + upserts, failed parses never
      cached; rotated-row merge only in zero-config with
      `--source`/`--since` applied; `--no-index` on `view`/`list`/`export`
      + config `"index": false` in `config.ts`; the watch rebuild consults
      the index and re-captures pricing in the one shared code path (D9);
      tests for hit/miss/dirty/rotated/explicit-path exclusion. Depends on
      1.1.
- [ ] 1.3 A `runray index` subcommand (`status`/`clear`/`prune
      --older-than`) in new `packages/cli/src/index-cmd.ts` (D5, D6):
      status prints path, size, per-adapter/variant row counts, version
      stamps; tests. Depends on 1.1. ∥ with 1.2.
- [ ] 1.4 A Fixture-parameterized equivalence test (D7): cold vs warm vs
      `--no-index`, byte-compare `runs` (generatedAt excluded), both redact
      modes, warm build asserted parse-free via store counters; wire into
      `pnpm test`. Depends on 1.2.
- [ ] 1.5 A Incremental-watch verification (D8): with the index active, a
      watch-triggered rebuild re-parses only dirty candidates (counter
      assertion), extending the existing zero-config watch e2e; plus the
      rotated-run transcript test — a run served from the index after log
      rotation yields a structured `unavailable` transcript status (D9);
      informal before/after timing note in the PR (audit item 2 speed
      claim). Depends on 1.2.

## 2. Docs

- [ ] 2.1 A `docs/05-ARCHITECTURE.md`: CLI surface rows for `--no-index`
      and `runray index`, module map entry for the core store, and a
      one-paragraph privacy note on index contents, location, permissions,
      and prune (D4, D5) — includes the sign-off outcome on unredacted
      blobs (proposal item 1).
