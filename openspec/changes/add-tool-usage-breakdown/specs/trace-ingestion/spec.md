# Delta for trace-ingestion

## ADDED Requirements

### Requirement: Shell tool usage capture
Adapters SHALL classify every shell tool call (Claude Code `Bash` and
`PowerShell`, OpenCode `bash`) per the tool-usage capability and stamp the
result into `span.attributes`: `runray.toolActivity` always; `runray.tool`,
`runray.toolSub`, `runray.toolVia` and `runray.toolsAlso` when resolved; and
`runray.toolName` and `runray.toolScript` only when redaction is off. The
command text SHALL NOT be stored.

#### Scenario: Compound command resolved
- GIVEN a Claude Code `Bash` call with the command
  `cd apps/web && pnpm exec vitest run 2>&1 | tail -20`
- WHEN the transcript is parsed
- THEN the tool span carries `runray.tool: "vitest"`,
  `runray.toolSub: "run"`, `runray.toolVia: "pnpm exec"` and
  `runray.toolActivity: "test"`, and no attribute holds the command text

#### Scenario: Also-ran tools
- GIVEN a shell call with the command `git add -A && pnpm build`
- WHEN the transcript is parsed
- THEN the span carries `runray.tool: "pnpm"` and
  `runray.toolsAlso: ["git"]`

#### Scenario: Identity survives redaction
- GIVEN the same session parsed with redact on and redact off
- WHEN shell tool spans are compared
- THEN `runray.tool`, `runray.toolSub`, `runray.toolVia`,
  `runray.toolsAlso` and `runray.toolActivity` are byte-identical in both,
  and `runray.toolName` and `runray.toolScript` are present only without
  redaction

#### Scenario: Unresolved command
- GIVEN a shell call whose program is outside the registry, parsed with
  redaction on
- WHEN the transcript is parsed
- THEN the span carries `runray.toolActivity: "other"` and no other
  tool-usage attribute

#### Scenario: Cross-adapter identity
- GIVEN a Claude Code `Bash` call and an OpenCode `bash` call with the same
  command
- WHEN both are parsed
- THEN both spans carry identical tool-usage attributes

#### Scenario: Target identity is untouched
- GIVEN any shell tool call
- WHEN the transcript is parsed
- THEN `runray.targetKey`, `runray.targetKind` and `runray.target` hold the
  values they held before this change

### Requirement: Command result flags
Where the source records it, adapters SHALL stamp `runray.toolFlags` on a
shell tool span with any of `background` (the call was sent to the
background), `timeout` (the harness cut it off) and `interrupted`, in that
fixed order and in every redaction mode. The attribute SHALL be absent when
no flag applies.

#### Scenario: Background command
- GIVEN a Claude Code `Bash` call made with `run_in_background: true`
- WHEN the transcript is parsed
- THEN the span carries `runray.toolFlags: ["background"]`

#### Scenario: Timed-out command
- GIVEN a Claude Code `Bash` result that records the harness timeout it hit
- WHEN the transcript is parsed
- THEN the span carries `runray.toolFlags: ["timeout"]`

#### Scenario: Ordinary command
- GIVEN a shell call that ran in the foreground to completion
- WHEN the transcript is parsed
- THEN the span carries no `runray.toolFlags` attribute

### Requirement: Skill identity capture
Where the source records which skill a skill-tool call invoked, adapters
SHALL stamp its name as `runray.skill` when redaction is off. Under redaction
the attribute SHALL be absent, and the span SHALL remain identifiable only by
its harness tool name.

#### Scenario: Skill named without redaction
- GIVEN a Claude Code `Skill` call invoking the skill `frontend-design`,
  parsed with redaction off
- WHEN the transcript is parsed
- THEN the span carries `runray.skill: "frontend-design"`

#### Scenario: Skill name withheld under redaction
- GIVEN the same call parsed with redaction on
- WHEN the transcript is parsed
- THEN the span carries no `runray.skill` attribute and is named `Skill`

### Requirement: Claude Code hook spans
The claude-code adapter SHALL emit a `hook` span for each hook record the
transcript carries: failed and cancelled hook runs, with their recorded
duration and outcome, and stop-hook summaries, with zero duration and the
number of hooks that ran as `runray.hookCount`. A hook span SHALL be named by
its hook event and matcher. Hook runs the transcript does not record SHALL
produce no span.

#### Scenario: Failed hook with a duration
- GIVEN a hook record for `PostToolUse:Edit` that ran 688 ms and exited with
  code 1
- WHEN the transcript is parsed
- THEN a `hook` span named `PostToolUse:Edit` is emitted with status `error`
  and duration 688 ms, ending at the record's timestamp

#### Scenario: Cancelled hook
- GIVEN a hook record marking a `UserPromptSubmit` hook as cancelled after it
  timed out
- WHEN the transcript is parsed
- THEN a `hook` span named `UserPromptSubmit` is emitted with status
  `cancelled`

#### Scenario: Stop-hook summary
- GIVEN a stop-hook summary record reporting three hooks and no errors
- WHEN the transcript is parsed
- THEN a zero-duration `hook` span named `Stop` is emitted with status `ok`
  and `runray.hookCount: 3`

#### Scenario: Successful tool hooks leave no trace
- GIVEN a session whose `PreToolUse` hooks all succeeded and wrote nothing to
  the transcript
- WHEN the transcript is parsed
- THEN no `hook` span is emitted for them

### Requirement: Hook spans attach to their trigger and stay out of tool totals
A hook span SHALL nest under the tool call that triggered it when the record
names one, and otherwise under the transcript's container span. Hook spans
SHALL NOT count toward the run's tool call or tool error totals, and SHALL NOT
change any insight finding.

#### Scenario: Nested under the triggering tool call
- GIVEN a failed `PostToolUse:Edit` hook record naming an `Edit` tool call
- WHEN the transcript is parsed
- THEN the hook span's parent is that `Edit` span

#### Scenario: Totals are unchanged
- GIVEN a transcript with hook records and the same transcript with those
  records removed
- WHEN both are ingested
- THEN `counts.toolCalls` and `counts.toolErrors` are equal in both

#### Scenario: Findings are unchanged
- GIVEN the committed fixtures
- WHEN they are ingested with hook spans emitted
- THEN the set of findings and their estimated waste are the ones produced
  without hook spans

### Requirement: Hook commands are classified, never stored
The command a hook ran is user configuration that may contain paths, so
adapters SHALL NOT store it. They SHALL classify it per the tool-usage
capability and stamp only the resulting tool-usage attributes, under the same
redaction rule as shell tool spans.

#### Scenario: Hook command reduced to a tool id
- GIVEN a failed hook whose command is
  `node /Users/alex/.claude/hooks/format.mjs`
- WHEN the transcript is parsed in either redaction mode
- THEN the hook span carries `runray.tool: "node"`, and no attribute or
  content field contains the path

### Requirement: Reserved tool-usage keys from OTLP are validated
The OTLP adapter SHALL accept an incoming closed-vocabulary tool-usage
attribute only when its value belongs to that key's vocabulary, in every
redaction mode, and SHALL drop it otherwise. Free-form tool-usage keys
arriving through OTLP SHALL be dropped under redaction, like `runray.target`.

#### Scenario: Value outside the vocabulary
- GIVEN an OTLP span carrying `runray.tool: "/Users/alex/bin/deploy"`
- WHEN it is imported
- THEN the attribute is absent from the span

#### Scenario: Valid value passes through
- GIVEN an OTLP span carrying `runray.tool: "docker"` and
  `runray.toolActivity: "infra"`
- WHEN it is imported with redaction on
- THEN both attributes are present

#### Scenario: Free-form key under redaction
- GIVEN an OTLP span carrying `runray.toolName: "acme-deploy"`
- WHEN it is imported with redaction on
- THEN the attribute is absent from the span
