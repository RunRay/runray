# Design: add-persistent-index

Decisions that shape the implementation; the spec delta states the *what*,
this records the *why* and the rejected alternatives.

## D1 — The index lives in `packages/core`, on better-sqlite3

`packages/core/src/store/run-index.ts` (`openRunIndex()`), consumed by
`packages/cli/src/discover.ts`. better-sqlite3 is already a core runtime
dependency (OpenCode adapter) — zero new dependencies. Rejected: JSON
sidecar (full rewrite per sync, no incremental upsert, whole history in
memory — exactly what months of `~/.claude/projects` breaks); store in
`packages/cli` (new dep entry there, plus cli would have to define a
serialization of core's internal `RawRun`).

## D2 — Cache the parse artifact (`RawRun`), never the derived `Run`

The index stores `parse()` output — the expensive step (file IO +
JSONL/sqlite decoding). Pricing → normalize → insights are recomputed on
every build from the cached `RawRun`, exactly as today. This honors the
binding convention "derived data is always recomputed", makes
`pricing --refresh`, threshold edits, and new insight rules take effect
with **no cache invalidation**, and shrinks the invalidation surface to
parse-affecting changes only. Blobs are gzipped JSON (`node:zlib`, builtin).
Rejected: caching the final `Run` — fastest reads, but every
pricing/threshold/rule change becomes a cache-coherency bug class and it
violates the recompute convention. This is also what makes the "no
database" revision honest: the sqlite file is a disposable cache, not a
source of truth.

## D3 — Cache key, freshness, and invalidation

Row identity `(adapterId, runRef, redactMode)`; freshness = stored
`mtimeMs + sizeBytes` aggregated over `candidate.files` (both already
produced by `detect()` at zero parse cost); version stamp = index format +
`SCHEMA_VERSION` + generator version — any mismatch is a miss. Using the
generator version as the coarse "code changed" signal means any runray
upgrade re-parses once — deliberate: zero per-adapter version bookkeeping,
and it cannot silently go stale in a release (a forgotten per-adapter bump
would be the worse failure mode). Failed parses (locked opencode.db,
corrupt file) are never cached; they retry every build, preserving today's
error-reporting behavior.

## D4 — Redact mode is part of the row key, end-to-end

A redacted build can only read rows written by a redacted parse —
unredacted content is unreachable by key construction, not by a filter that
could be bypassed (redaction happened in core's parser before the blob was
written). Accepted cost: `list` (always redacted) and default `view`
(unredacted) populate separate variants, so first contact may parse twice.
Rejected for v1: storing only unredacted blobs and deriving redacted output
via a core `redactRawRun()` transform — still "redaction in core", but it
must provably null every content-bearing field any adapter emits (including
free-form `attributes`); a missed field is a privacy bug. Recorded as the
future option, gated on a fixture-wide
`parse(redact) === redactRawRun(parse(raw))` property test.

## D5 — On-disk location and lifecycle

Resolution order: `RUNRAY_INDEX_DIR` env → `$XDG_CACHE_HOME/runray` →
win32 `%LOCALAPPDATA%\runray\cache` → `~/.cache/runray`. File
`index-v1.sqlite` — the format version is in the name so a format bump
abandons rather than migrates. WAL mode + `busy_timeout` so concurrent
processes (`view --watch` + `list` in another shell) neither corrupt nor
block; directory `0o700`, files `0o600` on POSIX. Escape hatches:
`--no-index` (never reads or writes) and config `"index": false`;
`runray index status/clear/prune` for inspection and explicit removal.

## D6 — Rotated history survives, with guard rails

Rows whose `candidate.files` no longer exist are retained and merged into
the build — the "history outlives log rotation" feature. Guard rails:
merged only in zero-config discovery (an explicit `[path]` argument means
"exactly this directory"; injecting unrelated history there would be
astonishing); `--source` and `--since` filter rotated rows too (adapterId
and mtimeMs are stored per row); rotated rows serve only in the matching
redact variant. Merged runs flow through the same recompute pipeline and
the same newest-first sort, so ordering stays deterministic. Removal is
explicit only — no silent TTL in v1.

## D7 — Determinism is test-enforced equivalence

Contract: for any candidate whose files exist, index-served pipeline output
is byte-identical to a fresh parse. The test parameterizes over **every
fixture**: (1) cold build into a temp `RUNRAY_INDEX_DIR`; (2) warm build
(asserted parse-free via store counters); (3) `--no-index` baseline —
byte-compare `runs` across all three (`generatedAt` is the sole exclusion,
a wall-clock stamp by design), in both redact modes. This also pins the
JSON round-trip property of `RawRun` (optional fields dropped by stringify
stay dropped). New fixtures landed by other changes automatically extend
the matrix (the test is parameterized, not enumerated).

## D8 — Incremental watch falls out of D2/D3 for free

add-profiler-depth's watch fix already clears the memoized TraceFile on a
change event; with the index active, the next rebuild re-parses **only**
candidates whose mtime/size moved — no chokidar-event-path bookkeeping.
This extends (MODIFIED) the Zero-config watch requirement with an
incrementality clause.

## D9 — Interactions with add-profiler-depth (lands strictly after it)

- The rebuild path that consults the index is the same single path that
  re-captures effective pricing (its X4): parse artifacts cached, pricing
  and insights recomputed every build — capture-once semantics stay
  coherent.
- The equivalence matrix (D7) is built once against final adapter parse
  output — i.e. after target-identity attributes, MCP classification, and
  the Batch-1 golden regen.
- Rotated rows create runs whose `provenance.file` no longer exists; the
  transcript endpoint already returns structured `unavailable` on missing
  files — an explicit test covers "run served from the index after rotation
  → transcript pane says unavailable".
- OTLP stays unwatched and largely unindexed-by-default in zero-config
  (`defaultRoots()` is empty — import-only source); the `--watch` help text
  says so.

## D10 — Known-duplicate run ids stay untouched

The index keys on `(adapterId, runRef, redactMode)`, never on run id — no
interaction with the intentional duplicate-run-id behavior in `demo`, and
the UI keeps its `dedupeRunIds` load boundary.
