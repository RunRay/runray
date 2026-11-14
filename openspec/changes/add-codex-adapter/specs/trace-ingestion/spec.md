# Delta for trace-ingestion

## ADDED Requirements

### Requirement: Codex is a named source
The TraceFile contract SHALL name Codex as a source: `source.tool` accepts
`codex` and `source.format` accepts `codex-jsonl`, and the contract version
SHALL be `0.2.0`. No other field, enum value or meaning in the contract
SHALL change with it.

#### Scenario: A Codex run validates
- GIVEN a run produced from a Codex rollout
- WHEN it is validated against the published JSON Schema
- THEN it validates, with `source.tool: "codex"` and
  `source.format: "codex-jsonl"`

#### Scenario: Earlier documents stay valid in shape
- GIVEN a TraceFile written under contract version 0.1.0
- WHEN its runs are validated against the 0.2.0 run schema
- THEN every run validates unchanged

### Requirement: Codex rollout discovery
The Codex adapter SHALL discover sessions with no configuration under
`$CODEX_HOME/sessions` when `CODEX_HOME` is set and `~/.codex/sessions`
otherwise, at any directory depth, taking files named `rollout-*.jsonl` and
`rollout-*.jsonl.zst`. Its default root SHALL be the sessions directory, not
the Codex home. It SHALL read no file other than rollouts.

#### Scenario: Zero-config discovery
- GIVEN rollouts under `~/.codex/sessions/2026/10/13/`
- WHEN discovery runs with no path and no source filter
- THEN each root thread among them is one candidate with format
  `codex-jsonl`

#### Scenario: CODEX_HOME moves the root
- GIVEN `CODEX_HOME` set to another directory that holds `sessions/`
- WHEN the adapter reports its default roots
- THEN the one root is `sessions` under that directory

#### Scenario: Derived databases are not read
- GIVEN a Codex home with SQLite files next to `sessions/`
- WHEN a session is discovered and parsed
- THEN no SQLite file is opened and none appears in `source.files`

#### Scenario: Other files in a scanned folder
- GIVEN a scanned folder holding `notes.jsonl` next to a rollout
- WHEN the Codex adapter scans it
- THEN only the rollout is a candidate

#### Scenario: One thread in both forms
- GIVEN the same thread present as `.jsonl` and as `.jsonl.zst`
- WHEN discovery runs
- THEN it yields one candidate, read from the plain file

### Requirement: Compressed rollouts
The Codex adapter SHALL read zstd-compressed rollouts as it reads plain
ones, producing identical runs from identical content. Where the runtime
cannot decompress zstd, a compressed candidate SHALL be skipped with one
message that names the Node.js version required, and plain rollouts SHALL
still load.

#### Scenario: Same content, either form
- GIVEN one rollout stored plain and the same bytes stored compressed
- WHEN both are parsed
- THEN the two runs are identical except for the file name in
  `source.files` and `provenance.file`

#### Scenario: Runtime without zstd
- GIVEN a runtime with no zstd support and a folder with one compressed and
  one plain rollout
- WHEN discovery runs
- THEN the plain session loads, the compressed one is reported as skipped
  with a message naming the Node.js version that reads it, and the exit code
  is that of a successful load

#### Scenario: Large rollout
- GIVEN a compressed rollout that expands to several hundred megabytes with
  single records of several megabytes
- WHEN it is parsed
- THEN it is read as a stream and produces a run

### Requirement: Codex session and turn spans
A Codex run SHALL have one `session` span whose id is the thread id from the
rollout's first record, and one `turn` span per turn the rollout brackets,
with the turn's own id, start, end and duration. A turn the person
interrupted SHALL be `cancelled`; a turn that completed with an error SHALL
be `error` with the error code as `statusReason`; a turn the file ends inside
SHALL be `in_progress`.

#### Scenario: Run identity and project
- GIVEN a rollout whose first record carries an id, a working directory and
  a git branch
- WHEN it is parsed
- THEN the session span's id and `agent.sessionId` are that id, and the run's
  project carries the directory and the branch

#### Scenario: Interrupted turn
- GIVEN a turn that ends in an abort record with the reason `interrupted`
- WHEN it is parsed
- THEN its span is `cancelled` with `statusReason: "interrupted"`

#### Scenario: Turn ended by an API error
- GIVEN a turn whose completion record carries the error code
  `usage_limit_exceeded`
- WHEN it is parsed
- THEN its span is `error` with `statusReason: "usage_limit_exceeded"`

#### Scenario: Completion for a turn that never started
- GIVEN a rollout in which turn B starts, a completion record for an id no
  start record carries follows, and then B's own completion
- WHEN it is parsed
- THEN there is one turn span, B, ending at its own completion, and the
  stray completion produces no span and no warning

#### Scenario: Prompt preview skips harness context
- GIVEN a turn whose first user message is an environment-context block the
  harness wrote and whose second is the person's prompt
- WHEN it is parsed without redaction
- THEN the turn's `promptPreview` is the start of the person's prompt

#### Scenario: Rollout with no turn
- GIVEN a root rollout that holds only its first record
- WHEN discovery reaches it
- THEN it is skipped without a warning

### Requirement: Codex LLM calls
The Codex adapter SHALL emit one `llm_call` span per API response recorded in
the rollout, taking the response's own usage counters, the model of the turn
it belongs to and the provider the session names. Token counts SHALL come
from per-response usage only, never from differences of running thread
totals. `costSource` SHALL be left for the cost engine to set.

#### Scenario: One span per response
- GIVEN a turn with three usage records
- WHEN it is parsed
- THEN the turn has three `llm_call` children whose ids are the three
  response ids

#### Scenario: Totals match the thread counter
- GIVEN a root thread whose running thread total started at zero
- WHEN it is parsed
- THEN the token total over its own `llm_call` spans equals the thread total
  in its last usage record

#### Scenario: Inherited thread total
- GIVEN a child thread whose first usage record already shows a thread total
  far above that record's own usage
- WHEN it is parsed
- THEN its `llm_call` spans sum to the per-response usage, not to the thread
  total

#### Scenario: Response with no usage record
- GIVEN a turn that was aborted after the model emitted a tool call and
  before a usage record was written
- WHEN it is parsed
- THEN no `llm_call` is emitted for that response and its tool span hangs
  from the turn

### Requirement: Codex token conversion
Codex counts cached input inside input and reasoning inside output. The
adapter SHALL convert each usage record to disjoint counts: `cacheRead` is
the cached input, `cacheWrite` the cache-write input, `input` the remainder
of input, `reasoning` the reasoning output and `output` the remainder of
output, none below zero. The five SHALL sum to the record's total.

#### Scenario: Cached input is not counted twice
- GIVEN a usage record with input 10,000 of which 8,000 cached, output 500
  of which 300 reasoning, total 10,500
- WHEN it is parsed
- THEN the span carries input 2,000, cacheRead 8,000, cacheWrite 0, output
  200 and reasoning 300

#### Scenario: Hit rate reflects the cache
- GIVEN a run made of that one call
- WHEN totals are derived
- THEN `cache.hitRate` is 0.8

#### Scenario: Inconsistent counters
- GIVEN a usage record whose cached input exceeds its input
- WHEN it is parsed
- THEN `input` is zero, not negative, and the run still validates

### Requirement: Legacy Codex token events
For a rollout that has no per-response usage records, the adapter SHALL emit
one `llm_call` per running token event whose thread total differs from the
previous event's, using that event's last-response counters. Repeated events
and events with no counters SHALL be skipped. A token event before the
rollout's first turn SHALL NOT become a call: it is the total the thread
started from. In a rollout that has usage records, running token events
SHALL be ignored.

#### Scenario: Repeated event
- GIVEN a legacy rollout with two consecutive token events showing the same
  thread total
- WHEN it is parsed
- THEN one `llm_call` is emitted for the pair

#### Scenario: Both kinds present
- GIVEN a rollout with usage records and running token events
- WHEN it is parsed
- THEN the number of `llm_call` spans equals the number of usage records

#### Scenario: Inherited counter
- GIVEN a child rollout with no usage records whose first token event comes
  before its first turn and shows the total its parent had reached
- WHEN it is parsed
- THEN no `llm_call` is emitted for that event, and the next event whose
  total differs from it is one

### Requirement: Codex tool spans are harness actions
The adapter SHALL emit a tool span for each action the harness records as
completed (a command, a file change, an MCP call, a web search, a sleep, an
image view), with that action's own times, outcome and exit code. A
model-level tool call SHALL become a span only when no action is attributed
to it. An MCP call SHALL be an `mcp_call` span carrying its server.

#### Scenario: Script that ran two commands
- GIVEN one `exec` call during which the harness recorded two commands
- WHEN it is parsed
- THEN two `tool_call` spans named `exec_command` are emitted and no span is
  named `exec`

#### Scenario: Call that did nothing recorded
- GIVEN an `exec` call with an output and no harness action
- WHEN it is parsed
- THEN one `tool_call` span named `exec` is emitted, spanning the call to its
  output

#### Scenario: Failed command
- GIVEN a command the harness recorded as failed with exit code 1
- WHEN it is parsed
- THEN its span is `error` with `tool.isError: true` and `tool.exitCode: 1`

#### Scenario: MCP call
- GIVEN an MCP action on server `linear` calling `list_issues`
- WHEN it is parsed
- THEN an `mcp_call` span named `list_issues` carries
  `tool.mcpServer: "linear"`

#### Scenario: Action recorded after its call's output
- GIVEN an `exec` call, its output record, and then a command action with
  no call open, all in one turn
- WHEN it is parsed
- THEN one span named `exec_command` is emitted under that call's
  `llm_call`, and no span is named `exec`

#### Scenario: Command that outlives its call
- GIVEN an `exec` call that returned while its command was still running,
  and a later `wait` call during which the command ended
- WHEN it is parsed
- THEN the `exec_command` span hangs from the `llm_call` of the `exec` call,
  no span is named `exec`, and the `wait` call is a span of its own

#### Scenario: Action with no call in its turn
- GIVEN a command action in a turn in which no call has been made
- WHEN it is parsed
- THEN its span hangs from the turn

#### Scenario: Legacy shell call
- GIVEN a legacy rollout where the model called `shell` and the output
  reports exit code 2
- WHEN it is parsed
- THEN one span named `shell` is emitted with `tool.exitCode: 2`

#### Scenario: Tool counts are not doubled
- GIVEN a run with 10 model-level calls that produced 12 harness actions,
  each call producing at least one
- WHEN totals are derived
- THEN `counts.toolCalls` is 12

### Requirement: Codex commands are unwrapped before identity capture
A Codex command is an argv that starts with its shell. The adapter SHALL
take the script out of a recognised shell wrapper (PowerShell, POSIX shells,
`cmd`) and capture target identity and tool usage from the script, in the
dialect the wrapper names. The wrapper SHALL NOT be the identity. The script
SHALL NOT be stored.

#### Scenario: PowerShell wrapper
- GIVEN the command `["pwsh.exe", "-Command", "pnpm test"]`
- WHEN it is parsed
- THEN the span carries `runray.tool: "pnpm"` and the same
  `runray.toolSub`, `runray.toolActivity` and `runray.targetKey` a Claude
  Code `PowerShell` call with the command `pnpm test` gets

#### Scenario: Two commands, two identities
- GIVEN the commands `["pwsh.exe", "-Command", "git status"]` and
  `["pwsh.exe", "-Command", "pnpm build"]`
- WHEN both are parsed
- THEN their `runray.targetKey` values differ

#### Scenario: POSIX wrapper
- GIVEN the command `["bash", "-lc", "cargo test"]`
- WHEN it is parsed
- THEN the span carries `runray.tool: "cargo"` classified in the POSIX
  dialect

#### Scenario: Script given as a string
- GIVEN a legacy `shell_command` call whose command is the string
  `Get-ChildItem C:\repo\src | Select-Object -First 5`
- WHEN it is parsed
- THEN the script is classified in the PowerShell dialect and the span
  carries a `runray.targetKey`

#### Scenario: No wrapper
- GIVEN the command `["git", "status"]`
- WHEN it is parsed
- THEN the span carries `runray.tool: "git"` and `runray.toolSub: "status"`

#### Scenario: Redaction
- GIVEN the PowerShell scenario above parsed with redaction on
- WHEN the span is inspected
- THEN `runray.tool`, `runray.toolSub`, `runray.toolActivity` and
  `runray.targetKey` are unchanged, `runray.target` is absent, and no
  attribute holds the script

### Requirement: Codex file changes
A file-change action SHALL become one tool span named `apply_patch`. On
success it SHALL carry `linesAdded` and `linesRemoved` counted over every
path it changed. It SHALL carry file-write target identity only when it
changed exactly one path.

#### Scenario: Update counted from its diff
- GIVEN a successful change that updates one file with a diff of 3 added and
  1 removed lines
- WHEN it is parsed
- THEN the span carries `linesAdded: 3`, `linesRemoved: 1`,
  `runray.targetKind: "file-write"` and a `runray.targetKey`

#### Scenario: Diff headers are not lines
- GIVEN an update whose diff includes `---` and `+++` header lines
- WHEN lines are counted
- THEN the headers are not counted

#### Scenario: Several files
- GIVEN a successful change that adds one file of 10 lines and updates
  another with 2 added lines
- WHEN it is parsed
- THEN the span carries `linesAdded: 12` and no target identity

#### Scenario: Failed change
- GIVEN a change the harness recorded as failed
- WHEN it is parsed
- THEN its span is `error` and carries no line counts

### Requirement: Codex child threads nest under their parent
A rollout that names a parent thread SHALL NOT be a run of its own when its
parent is among the scanned files. It SHALL appear in the parent's run as a
`subagent` span, with its own turns and calls beneath, attached to the parent
turn its first turn names, or to the session span with a run warning when
that turn is absent. The approval reviewer SHALL be named
`subagent:guardian`.

#### Scenario: Reviewer thread
- GIVEN a root rollout and a reviewer rollout naming it as parent and naming
  one of its turns
- WHEN discovery and parsing run
- THEN there is one run, in which a `subagent:guardian` span hangs from that
  turn and holds the reviewer's `llm_call` spans

#### Scenario: Reviewer tokens count in the run
- GIVEN that run
- WHEN totals are derived
- THEN the run's token totals include the reviewer's calls and
  `counts.subagents` is 1

#### Scenario: Child that never ran
- GIVEN a child rollout with no turn
- WHEN its parent is parsed
- THEN no span and no warning is produced for it

#### Scenario: Orphan child
- GIVEN a child rollout whose parent is not among the scanned files
- WHEN discovery runs
- THEN the child is a candidate of its own

#### Scenario: Unknown parent turn
- GIVEN a child whose named parent turn does not exist in the parent rollout
- WHEN the parent is parsed
- THEN the subagent span hangs from the session span and the run carries a
  warning naming the child

### Requirement: Codex content and identifiers stay in the parser
With redaction on, prompt, output and error previews of a Codex run SHALL be
null and `runray.target` absent. In every mode the adapter SHALL emit nothing
from the session's base instructions, repository URL, commit hash, account
or user identifiers, encrypted reasoning, rate-limit snapshots, scripts,
command text, patch bodies or tool output.

#### Scenario: Redacted parse
- GIVEN any Codex rollout parsed with redaction on
- WHEN the run is serialised
- THEN every `content` field is null and the run has no title

#### Scenario: Identifiers never appear
- GIVEN a rollout whose first record carries an account id and a repository
  URL, parsed with redaction off
- WHEN the run is serialised
- THEN neither value appears anywhere in it

#### Scenario: Redaction parity
- GIVEN the same rollout parsed with redaction on and off
- WHEN both runs are sanitised with the `sanitized` profile
- THEN the two results are identical

### Requirement: Codex parsing tolerates unknown records
The adapter SHALL skip a record whose type it does not know without a
warning, report an unparseable line as a run warning with its line number,
and treat every field of a known record as optional. A file that is not a
rollout SHALL be skipped with a reason, per "Files that are not sessions are
skipped".

#### Scenario: Unknown record type
- GIVEN a rollout with a record of a type the adapter has no rule for
- WHEN it is parsed
- THEN the run is produced and carries no warning about that record

#### Scenario: Broken line
- GIVEN a rollout whose line 40 is not valid JSON
- WHEN it is parsed
- THEN the run is produced with a warning naming line 40

#### Scenario: Line separator inside a string
- GIVEN a record whose tool output holds an unescaped U+2028 character
- WHEN the rollout is parsed
- THEN the record is read whole, the run carries no warning about it, and
  the records after it keep their line numbers

#### Scenario: Not a rollout
- GIVEN a file named `rollout-x.jsonl` whose first record is not a session
  record
- WHEN discovery reaches it
- THEN it is reported as skipped with a reason and no run is produced

#### Scenario: Deterministic output
- GIVEN the same rollout and its children parsed twice
- WHEN the two runs are compared
- THEN they are byte-identical

### Requirement: Codex rollouts are not Claude Code candidates
The Claude Code adapter SHALL NOT take a Codex rollout as a candidate, so a
folder scanned by both adapters yields each session once and no skip warning
for the other adapter's files.

#### Scenario: Explicit folder with rollouts
- GIVEN `runray view <folder>` on a folder of Codex rollouts
- WHEN discovery runs with no source filter
- THEN each session is listed once as a Codex run and no warning says a file
  is not a Claude Code session
