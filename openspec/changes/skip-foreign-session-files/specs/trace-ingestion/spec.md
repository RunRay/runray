# Delta for trace-ingestion

## ADDED Requirements

### Requirement: Files that are not sessions are skipped
The system SHALL NOT emit a run for a candidate whose content is not a session, and SHALL NOT emit a run that has no usable start time (one that would start on 1970-01-01, such as an empty run), whichever adapter produced it. Each such candidate SHALL be skipped while discovery continues with the other candidates. Unless stated otherwise below, the skip SHALL be reported on stderr with its reason.

- **Claude Code.** A `.jsonl` without any `user` or `assistant` record, or without any record `timestamp`, is not a session. If it carries Claude Code's own markers (a `sessionId`, or `summary`, `file-history-snapshot` or `queue-operation` records), it SHALL be skipped without a warning: it is a session that hasn't started yet, or a summary-only file. Any other such file SHALL be skipped with a warning. A session with a timestamped prompt and no reply SHALL still be ingested.
- **OpenCode.** A storage-era session file or export document whose session lacks an `id` or a numeric `time.created` SHALL be skipped with a warning. A child session without `time.created` SHALL start at the span it hangs under, and the run SHALL carry a warning naming the child.

#### Scenario: Another tool's JSONL in a Claude Code scan root
- GIVEN a scanned folder holding a Claude Code session and a `.jsonl` log from another tool whose records carry timestamps but no `user` or `assistant` type
- WHEN discovery runs
- THEN only the session becomes a run, no run starts in 1970, and the log is reported as skipped with the reason

#### Scenario: Claude Code session before its first prompt
- GIVEN a scanned folder holding a Claude Code session and a `.jsonl` that so far holds only a timestamped `queue-operation` record carrying a `sessionId`
- WHEN discovery runs
- THEN only the first session becomes a run and nothing is reported as skipped

#### Scenario: No usable start, any adapter
- GIVEN an OTLP/JSON file whose spans carry no start time
- WHEN discovery runs
- THEN no run is emitted for it and it is reported as skipped because the run would start on 1970-01-01

#### Scenario: OpenCode lookalike
- GIVEN a `storage/session/<project>/ses_*.json` file, or an export document passing the text sniff, whose session has no `id` or no `time.created`
- WHEN it is parsed as an OpenCode candidate
- THEN it is skipped with the reason

#### Scenario: OpenCode child without a start time
- GIVEN a storage-era session whose `task` tool call and spawned child session both lack timestamps
- WHEN it is ingested
- THEN the child's subagent span starts with the call's message, no span starts in 1970, and the run carries a warning naming the child

#### Scenario: Unanswered prompt kept
- GIVEN a Claude Code transcript with one timestamped `user` record and no reply
- WHEN it is ingested
- THEN it becomes a run starting at that timestamp
