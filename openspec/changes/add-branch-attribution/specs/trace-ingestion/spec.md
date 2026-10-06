# Delta for trace-ingestion

## ADDED Requirements

### Requirement: Git branch capture
The system SHALL record the git branch a run started on in `project.gitBranch` when the source records one, and SHALL NOT derive it from the state of a repository at scan time.

- **Claude Code.** The branch SHALL be the first non-empty `gitBranch` in the main transcript.
- **OTLP.** The branch SHALL come from the first resource, in document order, whose attributes name one, read in the order `vcs.ref.head.name`, `vcs.repository.ref.name`, `git.branch`. Failing that, it SHALL come from the attributes of the earliest-starting span that names one, not the first span in the document. A `vcs.*` value whose matching type attribute (`vcs.ref.head.type`, `vcs.repository.ref.type`) is `tag` SHALL be skipped.
- **OpenCode.** OpenCode storage records no branch, so OpenCode runs SHALL carry none.
- An empty branch value SHALL count as no branch.

#### Scenario: Branch from OTLP resource attributes
- GIVEN an OTLP document whose resource carries `vcs.ref.head.name = feat/export`
- WHEN the run is parsed
- THEN `project.gitBranch` is `feat/export`

#### Scenario: The session's span, not an operation's
- GIVEN an OTLP document without branch resource attributes, whose first exported span is a tool span with `git.branch = release/1.2`, and whose root span started earlier with `vcs.ref.head.name = feat/x`
- WHEN the run is parsed
- THEN `project.gitBranch` is `feat/x`

#### Scenario: A tag is not a branch
- GIVEN an OTLP resource with `vcs.ref.head.name = v1.2.0` and `vcs.ref.head.type = tag`, and no other branch attribute
- WHEN the run is parsed
- THEN the run has no `project.gitBranch`

#### Scenario: OpenCode does not guess
- GIVEN an OpenCode session whose directory is a git checkout
- WHEN the run is parsed
- THEN the run has no `project.gitBranch`, and parsing reads nothing inside `.git`
