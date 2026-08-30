# Delta for cli

## MODIFIED Requirements

### Requirement: Command surface
The system SHALL expose `view`, `list`, `export`, `demo`, `pricing`, and
`index` commands with documented flags, SHALL treat a bare `runray`
invocation as `runray view` with default options, and SHALL use exit
codes: 0 success, 1 execution error, 3 no data found. `view`, `list`, and
`export` SHALL accept `--no-index` to bypass the persistent run index.
`runray list --json` run summaries SHALL additionally report
`unpricedLlmCalls` and `unpricedTokens`, and discovery (`view`, `list`,
`export`) SHALL print a single stderr warning naming the unpriced models
when any run's cost coverage is below 100%; stdout of `--json` SHALL remain
clean.

#### Scenario: Index bypass
- GIVEN a populated index
- WHEN `runray list --no-index` runs
- THEN the index is neither read nor written and output comes from a fresh
  parse

### Requirement: Zero-config watch
When `--watch` is active and no explicit path or configured data roots are
given, the system SHALL watch each adapter's default root directories that
exist on disk (honoring `--source`), and on change SHALL rebuild the served
snapshot re-parsing only candidates whose files changed, notifying
connected clients via the existing SSE channel.

#### Scenario: Incremental rebuild
- GIVEN 200 indexed runs and one session file modified during watch
- WHEN the snapshot rebuilds
- THEN exactly one candidate is re-parsed

## ADDED Requirements

### Requirement: Persistent run index
The system SHALL maintain a persistent local index of parsed runs, keyed by
adapter id, run reference, and redaction mode, and stamped with the index
format version, schema version, and generator version; on every build the
system SHALL serve a candidate from the index only when its recorded file
mtimes and sizes match the candidate's current files and all version stamps
match, re-parsing and upserting otherwise. Runs served from the index SHALL
be byte-identical, after recomputing pricing, normalization, and insights,
to runs produced by a fresh parse of the same files. A build in redacted
mode SHALL never read index rows written by an unredacted parse. Failed
parses SHALL NOT be cached. The index SHALL live under a user-level cache
directory (overridable via `RUNRAY_INDEX_DIR`) and SHALL never be written
when indexing is disabled.

#### Scenario: Warm start serves identical output
- GIVEN a completed `runray view` populated the index
- WHEN `runray view` runs again with unchanged source logs
- THEN no candidate is re-parsed and the served runs are byte-identical to a
  fresh `--no-index` parse

#### Scenario: Dirty file re-parsed
- GIVEN an indexed session whose source file has since grown
- WHEN the next build runs
- THEN only that candidate is re-parsed and its index row replaced; all
  other runs come from the index

#### Scenario: Upgrade invalidates
- GIVEN index rows written by an older runray version
- WHEN a build runs after upgrading
- THEN every row is treated as a miss and re-parsed

#### Scenario: Redaction isolation
- GIVEN the index contains only rows written by unredacted parses
- WHEN `runray view --redact` runs
- THEN all candidates are parsed fresh in redacted mode and no unredacted
  row content is served

### Requirement: History survives log rotation
In zero-config discovery (no explicit path argument), the system SHALL merge
indexed runs whose source files no longer exist into the build, in the same
deterministic order and subject to the same `--source` and `--since` filters
and redaction-mode isolation; an explicit path argument SHALL exclude
rotated history. The system SHALL provide `runray index` with `status`,
`clear`, and `prune --older-than <duration>` to inspect and explicitly
remove indexed data.

#### Scenario: Rotated run still listed
- GIVEN an indexed run whose source JSONL was deleted by log rotation
- WHEN `runray list` runs with no path argument
- THEN the run still appears, in correct newest-first order

#### Scenario: Explicit path excludes history
- GIVEN rotated runs exist in the index
- WHEN `runray view <path>` runs
- THEN only runs discovered under `<path>` are served

#### Scenario: Deliberate removal
- GIVEN indexed runs older than 90 days
- WHEN `runray index prune --older-than 90d` runs
- THEN those rows are removed and `runray index status` reflects the new
  counts

#### Scenario: Rotated run's transcript degrades structurally
- GIVEN a run served from the index whose source log was rotated away
- WHEN the transcript endpoint is called for one of its spans
- THEN the response is a structured `unavailable` status, never a crash
