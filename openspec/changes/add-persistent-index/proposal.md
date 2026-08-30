# Proposal: add-persistent-index

## Why

The post-MVP audit found the
analysis layer ephemeral: every `view`/`list`/`export` re-parses all history
from scratch (months of `~/.claude/projects` JSONL on every cold start —
AgentsView markets 84–223× speedups over ccusage from sqlite indexing on
exactly this), history dies with source-log rotation, and every `--watch`
change event triggers a full re-scan of everything.

This ships as its own change — deliberately separated from
add-profiler-depth — because it **revises add-local-trace-viewer's explicit
non-goal "no database"**. That revision deserves a decision reviewable (and
rejectable) on its own, without blocking the profiler work. The honest
framing of the revision: the index is a derived *cache* of parse artifacts,
not a source of truth — `TraceFile` remains the only contract between CLI
and UI, derived data (pricing, totals, insights) is still recomputed on
every build, and deleting the index loses nothing but speed and rotated
history.

## What Changes

Extends capability **cli** (the schema and the UI payload are untouched):

- **Persistent run index**: a local better-sqlite3 store of adapter parse
  artifacts (`RawRun`), keyed `(adapterId, runRef, redactMode)` and stamped
  with index-format/schema/generator versions; freshness by file
  mtime + size; incremental sync (only dirty candidates re-parse); failed
  parses never cached; index-served output byte-identical to a fresh parse
  (test-enforced).
- **History survives log rotation**: rows whose source files vanished are
  retained and merged into zero-config builds (explicit paths exclude them);
  removal is explicit via `runray index prune`/`clear`.
- **Incremental watch rebuilds**: a `--watch` change event re-parses only
  candidates whose files changed (extends add-profiler-depth's zero-config
  watch fix).
- **Command surface**: new `runray index` subcommand
  (`status`/`clear`/`prune --older-than`), `--no-index` on
  `view`/`list`/`export`, and config `"index": false`.

## Impact

- **Affected specs:** cli (2 MODIFIED — Command surface, Zero-config watch;
  2 ADDED — Persistent run index, History survives log rotation).
- **Affected code:** `packages/core` (new `store/run-index.ts`, exported
  `openRunIndex()`), `packages/cli` (`discover.ts` integration,
  `program.ts`, `config.ts`, new `index-cmd.ts`), `docs/05-ARCHITECTURE.md`.
- **Dependencies:** no new external dependencies — better-sqlite3 is
  already a core runtime dependency (OpenCode adapter). Depends on
  **add-profiler-depth**: final adapter parse output and the Batch-1 golden
  regen (this change's equivalence matrix is built once against final
  output), the capture-once pricing wiring (the watch rebuild path that
  consults the index is the same path that re-captures pricing), the
  `defaultRoots()` watch fix, and the transcript endpoint's structured
  `unavailable` handling (rotated runs have dangling provenance paths).
- **Golden discipline:** zero golden impact — this change alters no
  normalizer, rule, pricing, or ordering behavior, and the equivalence test
  enforces exactly that. If any golden flaps, the index integration is
  wrong by definition.
- **Privacy surface:** unredacted `RawRun` blobs are a second on-disk copy
  of prompt text, same sensitivity class as the source logs they mirror,
  in a location users don't know about — mitigated by 0600 permissions,
  redact-variant key isolation, `--no-index`, `index clear/prune`, and a
  docs note. This is sign-off item 1 below.
- **Out of scope (explicit):** any cross-machine or team sync; caching
  derived `Run`s (violates the recompute convention); silent TTL/retention
  (removal stays explicit in v1); watching OTLP sources (import-only,
  `defaultRoots()` is empty).

## Decisions requiring human sign-off

1. Unredacted `RawRun` blobs as a second on-disk copy of prompt text —
   acceptability vs an "index only redacted variants by default" posture;
   and whether `runray index status` should be surfaced in first-run
   output for transparency.
2. Disk-growth posture: explicit prune only (v1 design) vs a default
   retention window (e.g. 180d).
3. Generator-version invalidation is coarse: any upgrade re-parses once,
   and monorepo devs without a version bump can see stale cache (dev
   guidance: `--no-index` / `index clear`; CI always cold-builds via the
   equivalence test). Accepted trade for zero per-adapter version
   bookkeeping — flag if per-adapter version constants are preferred.
4. First-contact double parse: `list` (always redacted) and default `view`
   (unredacted) populate separate index variants. Accepted v1 cost; a core
   `redactRawRun()` transform (validated by a fixture-wide property test)
   is the recorded future option.
