# Delta for cli

## ADDED Requirements

### Requirement: Codex in the source filter
Every command that takes `--source` SHALL accept `codex`, limit discovery to
the Codex adapter when given it, and list `codex` in the option's help text
and in the error for an unknown source.

#### Scenario: Filter to Codex
- GIVEN Claude Code and Codex sessions on the machine
- WHEN `runray list --source codex` runs
- THEN only Codex runs are listed

#### Scenario: Unknown source names the choices
- GIVEN `runray view --source foo`
- WHEN the command runs
- THEN the error lists `claude`, `opencode`, `codex` and `otlp`

### Requirement: Codex in zero-config roots
With no path given, discovery reporting and `--watch` SHALL include the
Codex sessions directory among the roots, subject to `--source`. The no-data
report SHALL list it with its verdict like any other root.

#### Scenario: No sessions anywhere
- GIVEN a machine with no agent data
- WHEN `runray view` runs
- THEN the "Checked:" list includes `~/.codex/sessions` marked `missing`

#### Scenario: Watching a live Codex session
- GIVEN `runray view --watch` with no path and a Codex session in progress
- WHEN the session's rollout grows
- THEN the dashboard refreshes with the new spans

#### Scenario: Compression during a watch
- GIVEN a watched rollout that Codex replaces with its compressed form
- WHEN the next refresh runs
- THEN the session is listed once, under the same run id

### Requirement: Codex in the setup guides
The setup guides shown by the no-data wizard SHALL have a Codex entry that
says nothing needs configuring, names the sessions directory and gives one
command that produces a session.

#### Scenario: Guides list Codex
- GIVEN the setup guides text
- WHEN it is rendered
- THEN it has a Codex entry between OpenCode and other agents, and the
  closing line counts the sources correctly

### Requirement: Transcript slices for Codex spans
The transcript slice endpoint SHALL return the source record behind a Codex
span from its provenance line, for plain and compressed rollouts, as
role-labelled segments under the existing size cap. With redaction on it
SHALL return `redacted` without opening the file.

#### Scenario: Command span
- GIVEN an unredacted Codex run and a command span
- WHEN its transcript slice is requested
- THEN the response is `ok` with the command and its output as labelled
  segments

#### Scenario: Compressed rollout
- GIVEN a span whose provenance file is a `.jsonl.zst` rollout
- WHEN its transcript slice is requested
- THEN the response is `ok` with the same segments the plain file would give

#### Scenario: Rollout compressed since the build
- GIVEN a span whose provenance names a `.jsonl` file that has since been
  replaced by its compressed form
- WHEN its transcript slice is requested
- THEN the response is `unavailable` with a reason, not an error
