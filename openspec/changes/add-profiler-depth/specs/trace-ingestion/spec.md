# Delta for trace-ingestion

## MODIFIED Requirements

### Requirement: Claude Code JSONL parsing
The system SHALL parse Claude Code JSONL session files into the normalized
schema, reconstructing the span tree from record parent links, pairing
tool_use with tool_result records, and representing subagent transcripts as
subagent spans nested under the spawning tool_call span — or, for sidecar
adoptions whose spawning tool_use is unresolvable, under the enclosing
agent's subagent span. Child transcripts live in separate
`agent-<agentId>.jsonl` files under `<session-uuid>/subagents/`; joins are
resolved per the "Sidecar-linked subagent transcripts" requirement (a
tool-result `agentId` on ANY tool, then the `agent-<id>.meta.json`
sidecar). Legacy-era markers (`Task` tool_use anywhere, or
`isSidechain: true` in the MAIN transcript) SHALL still parse as flat
spans with a run warning; `isSidechain: true` inside an agent transcript
is the modern era's normal shape and SHALL NOT trip the legacy warning.

#### Scenario: Modern agent transcripts are not legacy
- GIVEN a CC ≥2.2 session whose agent transcripts carry
  `isSidechain: true` on every record while the main transcript does not
- WHEN the session is ingested
- THEN the run carries no legacy-format warning and the subagent spans
  nest normally

## ADDED Requirements

### Requirement: Discoverable adapter default roots
Every source adapter SHALL expose its zero-config default root directories
via `defaultRoots()`, and `detect()` SHALL derive its default scan locations
from the same method, so that discovery and file-watching can never diverge;
adapters without on-disk default locations (OTLP import) SHALL return an
empty list.

#### Scenario: Single source of truth
- GIVEN the Claude Code adapter
- WHEN `detect([])` scans zero-config locations
- THEN the directories scanned are exactly `defaultRoots()`

#### Scenario: Import-only adapter
- GIVEN the OTLP adapter
- WHEN `defaultRoots()` is called
- THEN it returns an empty list and zero-config watch ignores it

### Requirement: Tool target identity capture
Adapters SHALL capture, for recognized file and command tools, a normalized
target identity into span.attributes: a deterministic hash key
(`runray.targetKey`) and a kind (`runray.targetKind`: file-read,
file-write, or command) in all modes, and a short display token
(`runray.target`) only when redaction is off. The hash SHALL be computed
in core from the normalized target (POSIX path, or command executable
token) so identical targets yield identical keys across spans, runs, and
redaction modes; raw target text SHALL never appear in attributes under
redaction. Unrecognized tools SHALL carry no target keys. Reserved
adapter-emitted attribute keys SHALL use the `runray.` prefix.

#### Scenario: Identity survives redaction
- GIVEN the same session parsed with redact on and redact off
- WHEN tool_call spans are compared
- THEN `runray.targetKey` and `runray.targetKind` are byte-identical in
  both, and `runray.target` is present only without redaction

#### Scenario: Cross-adapter identity
- GIVEN a Claude Code Read of /src/a.ts and an OpenCode read of the same
  path
- WHEN both are parsed
- THEN both spans carry the same `runray.targetKey` with kind file-read

### Requirement: OpenCode MCP tool classification
The OpenCode adapter SHALL classify MCP tool invocations as `mcp_call` spans
with `tool.mcpServer` populated; because the OpenCode on-disk formats carry
no explicit MCP marker, classification SHALL use a built-in-tool allowlist
plus name-prefix heuristic, and every heuristically classified span SHALL
carry `attributes["runray.mcpDetection"] = "name-heuristic"`; built-in
tools, including underscore-named ones, SHALL never be classified as MCP;
and the classification SHALL be identical across all three storage eras.

#### Scenario: MCP tool classified
- GIVEN an OpenCode session (SCRUBBED fixture) containing a
  `context7_query-docs`-style tool part
- WHEN the adapter parses it
- THEN the span has kind `mcp_call`, `tool.mcpServer` set to the server
  prefix, and `attributes["runray.mcpDetection"]` set to `name-heuristic`

#### Scenario: Built-in underscore tool untouched
- GIVEN an OpenCode session using `apply_patch`
- WHEN the adapter parses it
- THEN the span remains kind `tool_call` with no `mcpServer`

#### Scenario: Existing goldens stable
- GIVEN the committed OpenCode fixtures, which contain no MCP tool names
- WHEN goldens are regenerated
- THEN the normalized output is byte-identical

### Requirement: Sidecar-linked subagent transcripts
The claude-code adapter SHALL link subagent transcripts through every join
the storage format provides, in precedence order: a `toolUseResult.agentId`
on ANY tool's result record (synchronous `Agent` calls and forked skills
alike — a fork's spawning tool is e.g. `Skill`, its subagent name falling
back to `toolUseResult.commandName`), then the transcript's
`agent-<id>.meta.json` sidecar, whose `toolUseId` names the spawning
tool_use span and whose `parentAgentId` names the enclosing agent for
nested background spawns. Sidecar adoption SHALL iterate deterministically
(sorted agent-id order, to a fixpoint) so children link after their
parents, and transcripts with no resolvable join SHALL be skipped with a
run warning naming their count.

#### Scenario: Forked skill carries the delegated cost
- GIVEN a session whose `Skill` tool result carries
  `toolUseResult: { status: 'forked', agentId, commandName }` and a
  matching `agent-<id>.jsonl`
- WHEN the session is ingested
- THEN a subagent span named after the commandName nests under the Skill
  tool_call and the fork's transcript spans (and cost) join the run

#### Scenario: Background agent linked only by its sidecar
- GIVEN an `agent-<id>.jsonl` referenced by NO tool result, with a sidecar
  `agent-<id>.meta.json` carrying `toolUseId` and `parentAgentId`
- WHEN the session is ingested
- THEN the transcript nests under the spawning tool_use span (falling back
  to the enclosing agent's span), named from the sidecar's
  `name`/`agentType`, with `description` as the redactable delegation
  reason

#### Scenario: No join available
- GIVEN an agent transcript with neither a tool-result agentId nor a
  readable sidecar
- WHEN the session is ingested
- THEN the transcript is skipped and the run carries a warning counting
  the unlinked transcripts

### Requirement: Tool error text capture
Adapters SHALL keep the first 200 characters of a failed tool result's text
as the tool span's `content.outputPreview`, under the same content contract
as every other preview: present only when redaction is off, `null` under
`--redact`. Successful tool results SHALL carry no preview (their size is
recorded, their text is not). The Claude Code adapter SHALL recognize
`PowerShell` as a command tool for target identity, exactly like `Bash`.

#### Scenario: A failed Bash call keeps its error
- GIVEN a tool_result with `is_error: true` whose text starts
  "ENOENT: no such file"
- WHEN the transcript is parsed without redaction
- THEN the tool span's `outputPreview` starts with that text, and the same
  span parsed with redaction carries `outputPreview: null`

#### Scenario: Successful output is sized, not quoted
- GIVEN a successful Read of a 5 kB file
- WHEN the transcript is parsed
- THEN the tool span records `outputBytes` and no content preview
