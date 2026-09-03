# Delta for error-triage

New capability. A failed call is signalled everywhere in the visualizer
(sessions table, sessions list, Inspector counts, timeline rows) and
explained nowhere; on real sessions only a fifth of failures are cited by a
finding, a third are the agent's normal check-and-fix loop, and under a tenth
are something the person can act on. This capability reads a class and an
owner from each failure so the product can say who has a lever, and groups a
session's failures into clusters with what they cost and whether the tool
came back.

## ADDED Requirements

### Requirement: Error classification
The system SHALL classify every failed span (`status: error` of kind
`tool_call`, `mcp_call` or `llm_call`) into exactly one error class from a
fixed registry, and every class SHALL map to exactly one owner from the set
`you` (the person's environment or configuration), `tooling` (the Browser
pane, a preview server, an MCP server), `agent` (the model's own slip),
`model` (the model call itself failed), `work` (the agent's expected
feedback: a check that did not pass) and `unknown`. Classification SHALL be
a pure, deterministic function of the span — its kind, tool name, exit code
and `content.outputPreview` — implemented as an ordered pattern list where
the first match wins, and SHALL live in `packages/core` under a browser-safe
subpath so the visualizer never carries a copy. Without failure text
(redacted sessions, sources that carry none) the class SHALL fall back to
what the span shape tells: an `mcp_call` is an MCP server error, a shell
wrapper's non-zero `tool.exitCode` is a non-zero exit, a model call is a
model error, anything else is unclassified. Cancelled spans SHALL never be
classified as failures.

#### Scenario: A shell quoting error is the person's
- GIVEN a failed Bash span whose preview starts "/usr/bin/bash: -c: line
  126: unexpected EOF while looking for matching `''"
- WHEN it is classified
- THEN the class is `shell-syntax` with owner `you`

#### Scenario: A failing test run is expected feedback
- GIVEN a failed PowerShell span whose preview contains "Failing tests:"
- WHEN it is classified
- THEN the class is `check-failed` with owner `work`

#### Scenario: A pane timeout is tooling
- GIVEN a failed `mcp__Claude_Browser__computer` span whose preview says
  "Screenshot timed out after 5s"
- WHEN it is classified
- THEN the class is `pane-timeout` with owner `tooling`

#### Scenario: Redaction falls back to shape
- GIVEN the same session parsed with `--redact`
- WHEN its failures are classified
- THEN an MCP failure is `mcp-error`, a Bash failure with `exitCode: 1` is
  `exit-nonzero`, a Read failure is `unclassified`, and the triage reports
  that text was unavailable

### Requirement: Error clusters, reaction cost and recovery
The system SHALL group a run's failures into clusters keyed by class and
tool name (model name for model-call failures), each carrying its
occurrences in chronological order. For every occurrence the system SHALL
record (a) the reaction cost — the cost of the first model call in the same
scope (subagent or session) that starts at or after the failure ends, with
each model call claimed by at most one failure so two failures answered by
one call bill it once; and (b) the recovery — whether the next call of the
same tool in the same scope succeeded, failed, or never happened, with the
delay. Each cluster SHALL carry an outcome: `recovered` when the last
occurrence's tool came back, `looping` when three or more of its occurrences
failed consecutively or a retry-loop finding cites one of them, else
`unrecovered`; and the ids of the findings whose evidence includes one of its
occurrences. Clusters SHALL be ordered by owner (you, tooling, agent, model,
work, unknown), then first occurrence, then key, and the whole triage SHALL
be a pure function of the run independent of span input order.

#### Scenario: One reaction, two failures
- GIVEN an Edit failure and a Bash failure in the same turn followed by one
  model call costing $0.50
- WHEN the run is triaged
- THEN the chronologically first failure's cluster carries $0.50 and the
  other carries $0.00, and the run's reaction total is $0.50

#### Scenario: A subagent's failure reacts inside the subagent
- GIVEN a Read failure inside a subagent, followed by a main-session model
  call and then a subagent model call
- WHEN the run is triaged
- THEN the reaction cost is the subagent call's, not the main session's

#### Scenario: Recovery is the same tool's next call
- GIVEN a Bash failure followed 2 s later by a successful Bash call
- WHEN the run is triaged
- THEN the occurrence's recovery is `ok` after 2000 ms and the cluster's
  outcome is `recovered`

### Requirement: Attention signal
The system SHALL derive from a run's triage whether it needs the person's
attention: true when any cluster has owner `you`, or when a cluster outside
owner `work` is `unrecovered` and no tool call of any kind succeeded after
its last failure (the session never got past it). A tool the agent
abandoned for a workaround mid-session, cancelled calls, model-call
failures owned by the model, and expected feedback SHALL never raise it on
their own. The
visualizer SHALL tint a run's error count by this signal (alarm when
attention is needed, neutral otherwise) rather than by the count alone.

#### Scenario: Recovered slips are quiet
- GIVEN a run whose only failures are two path-not-found slips each followed
  by a successful call of the same tool
- WHEN the attention signal is derived
- THEN it is false and the error count renders neutral

#### Scenario: A failing test at the end is not an alarm
- GIVEN a run whose last call is a failed test run
- WHEN the attention signal is derived
- THEN it is false

#### Scenario: An abandoned tool the session moved past is not an alarm
- GIVEN a navigate failure never followed by another navigate call, but
  followed by successful calls of other tools
- WHEN the attention signal is derived
- THEN it is false

### Requirement: Error-class playbooks
Every error class SHALL carry a label, a one-line explanation, an owner and
a playbook (causes; actions for Claude Code, OpenCode and a custom agent;
limits) in a registry that is the single source for the Inspector, the
Errors tab and the docs. The "Errors, class by class" block in
docs/08-FINDINGS.md SHALL be generated from the registry by
`pnpm docs:playbooks` and a test SHALL fail when the committed block
differs from what the registry renders. Every lever named in a playbook
SHALL be verified against the source's current documentation before it is
added.

#### Scenario: Docs drift fails the build
- GIVEN a change to a class's actions without regenerating the docs
- WHEN `pnpm test` runs
- THEN the error-classes drift test fails naming the stale block
