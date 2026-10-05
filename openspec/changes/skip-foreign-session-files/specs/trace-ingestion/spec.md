# Delta for trace-ingestion

## ADDED Requirements

### Requirement: Files that are not sessions are skipped
The system SHALL NOT emit a run for a candidate whose content is not a session of the adapter that picked it. A Claude Code `.jsonl` without any `user` or `assistant` record, or without any record `timestamp`, SHALL be skipped. An OpenCode storage-era session file or export document whose session lacks an `id` or a numeric `time.created` SHALL be skipped. Discovery SHALL report each skipped candidate on stderr with its reason and SHALL continue with the other candidates. A session with a timestamped prompt and no reply SHALL still be ingested.

#### Scenario: Another tool's JSONL in a Claude Code scan root
- GIVEN a scanned folder holding a Claude Code session and a `.jsonl` log from another tool whose records carry timestamps but no `user` or `assistant` type
- WHEN discovery runs
- THEN only the session becomes a run, no run starts in 1970, and the log is reported as skipped with the reason

#### Scenario: Transcript without a timestamp
- GIVEN a `.jsonl` holding only summary records, or user records without a `timestamp`
- WHEN it is parsed as a Claude Code candidate
- THEN it is skipped with the reason instead of becoming a run dated 1970

#### Scenario: OpenCode lookalike
- GIVEN a `storage/session/<project>/ses_*.json` file, or an export document passing the text sniff, whose session has no `id` or no `time.created`
- WHEN it is parsed as an OpenCode candidate
- THEN it is skipped with the reason

#### Scenario: Unanswered prompt kept
- GIVEN a Claude Code transcript with one timestamped `user` record and no reply
- WHEN it is ingested
- THEN it becomes a run starting at that timestamp
