# Delta for cli

## MODIFIED Requirements

### Requirement: Command surface
The system SHALL expose `view`, `list`, `export`, `demo`, and `pricing`
commands with documented flags, SHALL treat a bare `runray` invocation as
`runray view` with default options, and SHALL use exit codes: 0 success,
1 execution error, 3 no data found.
`runray list --json` run summaries SHALL additionally report
`unpricedLlmCalls` and `unpricedTokens`, and discovery (`view`, `list`,
`export`) SHALL print a single stderr warning naming the unpriced models
when any run's cost coverage is below 100%; stdout of `--json` SHALL remain
clean.

#### Scenario: Bare invocation opens the viewer
- GIVEN a machine with supported agent logs
- WHEN `runray` runs with no arguments
- THEN it behaves exactly as `runray view`: discovers sessions and serves
  the dashboard

#### Scenario: Bare invocation with no data
- GIVEN a machine with no supported agent logs
- WHEN `runray` runs with no arguments
- THEN the process exits with code 3 and prints the commands that would
  generate data

#### Scenario: Understated totals are called out
- GIVEN discovered runs where one model has no price
- WHEN `runray list --json` runs
- THEN stdout carries the summaries including the unpriced counts and
  stderr carries one warning naming the model

## ADDED Requirements

### Requirement: Zero-config watch
When `--watch` is active and no explicit path or configured data roots are
given, the system SHALL watch each adapter's default root directories that
exist on disk (honoring `--source`), and on change SHALL rebuild the served
snapshot and notify connected clients via the existing SSE channel.

#### Scenario: Watch works with no arguments
- GIVEN sessions under `~/.claude/projects` and no config file
- WHEN `runray view --watch` runs and a session file is appended to
- THEN the server emits a change event and the next snapshot includes the
  new spans

### Requirement: Effective pricing delivery
The system SHALL capture the effective pricing table (user override, else
bundled snapshot) once per trace build and use that same table for span
pricing, insight evaluation, and delivery to the visualizer: the local
127.0.0.1 server SHALL serve it with origin and snapshot-date provenance at
`/api/pricing`, single-file exports SHALL embed the same payload beside the
trace data with identical sanitization, and `demo` SHALL serve the bundled
table. This introduces no network operation.

#### Scenario: Panel and insights agree
- GIVEN `runray view --watch` and a pricing refresh performed mid-session
- WHEN the watcher triggers a rebuild
- THEN the rebuilt trace's insights and the `/api/pricing` response reflect
  the same (new) table, and before the rebuild both reflected the same
  (old) table

#### Scenario: Export reprices offline
- GIVEN a report.html produced by `runray export`
- WHEN it is opened from file:// with networking disabled
- THEN the embedded pricing payload allows what-if repricing with the
  provenance shown

### Requirement: Transcript slice endpoint
The local server SHALL expose `GET /api/transcript?run=<id>&span=<id>`
returning the source-log content behind the identified span's provenance,
resolved exclusively from the server's own trace data (the client SHALL NOT
be able to supply file paths); responses SHALL be size-capped with a
truncation flag; when the server runs in redact mode the core reader SHALL
refuse before opening any file and the endpoint SHALL return a redacted
status; unknown run/span ids, missing files (a source log deleted after
parse), and unsupported sources SHALL return structured non-crash statuses;
the endpoint SHALL remain bound to 127.0.0.1 and perform no network
operations.

#### Scenario: Slice served for a known span
- GIVEN `runray view` without `--redact` and a claude-code run
- WHEN the endpoint is called with a valid run and span id
- THEN the JSONL record at the span's provenance line is returned as
  role-labeled text segments

#### Scenario: Redact is enforced in core
- GIVEN `runray view --redact`
- WHEN the endpoint is called with any valid ids
- THEN the response status is `redacted` and no file content is read or
  returned

#### Scenario: Missing source degrades structurally
- GIVEN a span whose source log was deleted after it was parsed
- WHEN the endpoint is called for that span
- THEN the response is a structured `unavailable` status, never a crash

#### Scenario: No path injection
- GIVEN a request attempting to smuggle a file path in any parameter
- WHEN the endpoint handles it
- THEN only run/span id lookup occurs; unresolvable ids yield a structured
  `unavailable` response

### Requirement: Limit window configuration
The CLI SHALL accept an optional `limitWindow` block in
`runray.config.json` (window length in days, reset day, reset hour,
optional `budgetUSD`/`budgetTokens`), serve it to the UI via
`GET /api/viewconfig` on the 127.0.0.1-only server, and embed it in
single-file exports alongside the trace data; the trace file payload and
schema SHALL be unchanged, and absence of the block SHALL leave all behavior
identical to today.

#### Scenario: Config served
- GIVEN a config file with a `limitWindow` block
- WHEN `runray view` runs and the UI fetches `/api/viewconfig`
- THEN the block is returned as JSON

#### Scenario: Embedded in export
- GIVEN the same config
- WHEN `runray export` writes report.html
- THEN the file contains the view config beside the embedded trace data and
  works offline

#### Scenario: No config, no change
- GIVEN no `limitWindow` block
- WHEN the UI loads
- THEN `/api/viewconfig` returns an empty object and no limit-mode toggle
  appears
