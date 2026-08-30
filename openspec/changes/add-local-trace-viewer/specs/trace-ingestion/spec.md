# Delta for trace-ingestion

## ADDED Requirements

### Requirement: Zero-config source discovery
The system SHALL discover agent session data in known default locations (Claude Code projects directory, OpenCode data directory) without any configuration, and SHALL accept an explicit path argument that overrides discovery.

#### Scenario: Default discovery
- GIVEN Claude Code sessions exist under `~/.claude/projects`
- WHEN the user runs `runray view` with no arguments
- THEN discovered runs are listed without any prior configuration

#### Scenario: Explicit path
- GIVEN a directory containing supported log files
- WHEN the user runs `runray view <path>`
- THEN only sources under `<path>` are ingested

### Requirement: Claude Code JSONL parsing
The system SHALL parse Claude Code JSONL session files into the normalized schema, reconstructing the span tree from record parent links, pairing tool_use with tool_result records, and representing subagent transcripts as subagent spans nested under the spawning agent tool_call. v0.1 supports the current storage era (`Agent` tool; child transcript in a separate `agent-<agentId>.jsonl` under `<session-uuid>/subagents/`, joined via the tool result's `agentId`). When legacy-era markers are encountered (`Task` tool_use or `isSidechain: true` records), the records SHALL still parse as flat spans and the run SHALL carry a warning that legacy subagent nesting is unsupported.

#### Scenario: Subagent nesting
- GIVEN a session where the `Agent` tool spawned a subagent
- WHEN the session is ingested
- THEN subagent spans appear as children of the spawning tool_call span with `depth` incremented

#### Scenario: Legacy-era session
- GIVEN a session containing `Task` tool_use or `isSidechain: true` records
- WHEN the session is ingested
- THEN all records parse as flat spans and the run carries a warning naming the unsupported legacy subagent format

#### Scenario: Separate subagent transcript files
- GIVEN a session whose `Agent` calls produced transcripts under `<session-uuid>/subagents/`
- WHEN the session is ingested
- THEN the child transcripts' records normalize as spans within the same run, nested under their spawning tool_call, and each span's provenance points at the child file

#### Scenario: Malformed line tolerance
- GIVEN a JSONL file containing one unparseable line
- WHEN the file is ingested
- THEN remaining records are parsed, and the run carries a warning naming the file and line

### Requirement: OpenCode multi-era parsing
The system SHALL ingest OpenCode sessions from legacy file storage, from the SQLite database opened read-only, and from `opencode export` JSON files, producing identical normalized structure across eras for equivalent sessions.

#### Scenario: SQLite read-only
- GIVEN OpenCode is running and holds its database
- WHEN ingestion cannot obtain read access
- THEN the system reports a clear, actionable error and does not modify or lock the database

### Requirement: OTLP JSON import (best-effort)
The system SHALL import OTLP/JSON trace files (OTel Collector file-exporter output), mapping `resourceSpans` into normalized spans, carrying `gen_ai.*` attributes unchanged into span `attributes`, and grouping spans into runs by session id. Claude Code beta span names are pinned in fixtures; unrecognized span shapes SHALL degrade to `kind: other` rather than fail the import.

#### Scenario: Claude Code beta trace import
- GIVEN an OTLP/JSON file exported from Claude Code native traces (beta)
- WHEN the file is imported
- THEN spans sharing a session id form one run, `gen_ai.*` attributes pass through to span `attributes`, and subagent nesting follows the span parent links

#### Scenario: Unknown span shapes
- GIVEN an OTLP/JSON file containing spans with unrecognized names or attributes
- WHEN the file is imported
- THEN those spans normalize as `kind: other` with provenance, and the import succeeds

### Requirement: Deterministic normalization with provenance
The system SHALL produce deterministic, stably-ordered normalized output validating against the published JSON Schema, and every span SHALL carry provenance sufficient to locate its source record. When a span's `parentId` references a record absent from the run (a dangling reference — a `null` parentId is a legal root), the normalizer SHALL apply the Flat Trace Fallback: orphaned spans are re-parented to the run root with recomputed `depth`, chronological ordering is preserved, and the run carries a warning naming the affected spans.

#### Scenario: Golden stability
- GIVEN any fixture in the repository
- WHEN normalization runs twice
- THEN outputs are byte-identical and schema-valid

#### Scenario: Flat Trace Fallback on broken hierarchy
- GIVEN a source log where spans reference parent records missing from the log
- WHEN the run is normalized
- THEN the orphaned spans attach to the run root in chronological order, the output remains schema-valid and deterministic, and a run warning identifies the affected spans
