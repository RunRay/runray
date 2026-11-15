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
role-labelled segments under the existing size cap. Where that record is
completed by a later one, the slice SHALL include it: the output handed back
for a call the model made, and the person's prompt for a turn. With
redaction on it SHALL return `redacted` without opening the file.

#### Scenario: Command span
- GIVEN an unredacted Codex run and a command span
- WHEN its transcript slice is requested
- THEN the response is `ok` with the command and its output as labelled
  segments

#### Scenario: Call answered in a later record
- GIVEN a span read from a call the model made, whose output is a later
  record with the same call id
- WHEN its transcript slice is requested
- THEN the response holds the call's arguments and that output, and no other
  call's output

#### Scenario: Turn span
- GIVEN a turn whose first user message opens with a harness block followed
  by what the person typed
- WHEN the turn's transcript slice is requested
- THEN the response is one segment labelled `user` with the person's text in
  full and none of the harness block

#### Scenario: Turn of the approval reviewer
- GIVEN a turn span of a reviewer thread, whose first message is the review
  the harness asked for
- WHEN its transcript slice is requested
- THEN that message is shown under a label of its own, not under the
  person's

#### Scenario: Compressed rollout
- GIVEN a span whose provenance file is a `.jsonl.zst` rollout
- WHEN its transcript slice is requested
- THEN the response is `ok` with the same segments the plain file would give

#### Scenario: Rollout compressed since the build
- GIVEN a span whose provenance names a `.jsonl` file that has since been
  replaced by its compressed form
- WHEN its transcript slice is requested
- THEN the response is `unavailable` with a reason, not an error

### Requirement: Transcript slices keep identifiers and binary data out
A transcript slice of a Codex span SHALL NOT show the account id, user id,
repository URL or commit of a session record, nor an account's rate limits,
and SHALL name binary data (an image, a generated file) instead of showing
it, whether the data is the whole of a segment or a run inside its text.

#### Scenario: Session span
- GIVEN a session record that holds an account id, a user id, a repository
  URL and a commit
- WHEN the session span's transcript slice is requested
- THEN the response shows the session's instructions and what it was run
  with, and none of those four values

#### Scenario: Generated image
- GIVEN an action whose result is an image in base64
- WHEN its transcript slice is requested
- THEN the result segment reads `(not text)` and holds none of the data

#### Scenario: Image inside the text a tool handed back
- GIVEN a call whose output is a string holding JSON with a base64 image
- WHEN the slice of the call is requested
- THEN the output segment shows the JSON with the image named, not shown
