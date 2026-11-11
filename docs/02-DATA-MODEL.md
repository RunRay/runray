# RunRay — Data Model (v0.1.0)

The internal schema is **the contract** between Track A (CLI/parsers) and Track B (UI). It is authored as zod types in `packages/schema`, from which `schema/runray.schema.json` is generated. The UI never sees raw agent logs — only this format.

## Design principles

1. **Superset-normalize.** Every source (Claude Code JSONL, OpenCode storage/SQLite, OTLP JSON) maps into one span tree. Source-specific extras go into `attributes` (using OTel GenAI `gen_ai.*` attribute names where a match exists) — we align with the emerging standard without hard-depending on it (GenAI semconv is still Development-stability).
2. **Derived data is computed, never trusted.** `totals` and `insights` are outputs of the normalizer/insight engine, recomputed from spans. OpenCode stores `cost: 0` in message files, so cost always flows through our pricing engine; `costSource` records whether a number was reported by the source or computed by us.
3. **Provenance everywhere.** Each span points back to its source file/record. The UI's "show raw" affordance and all debugging depend on it.
4. **Forward compatibility.** Unknown attributes pass through; `schemaVersion` is SemVer'd independently of the app. Breaking schema changes require a major bump + migration note.
5. **Privacy-aware.** Prompt/output text lives only in optional `content` fields that `--redact` nulls out while preserving counts and structure.

> **Versioning note (2026-07):** `content.delegationReason`, `tool.linesAdded`/`linesRemoved` and `totals.codeChanges` were added additively before any code exists, so they fold into v0.1.0 without a bump. Once `packages/schema` lands and v0.1 is frozen (task 1.2), any such addition requires a minor version bump.

## Entity overview

```
TraceFile
└── Run[]                       (one agent session / headless execution)
    ├── source, project, timing
    ├── Span[]                  (flat list; tree via parentId)
    │     ├── kind: session | turn | llm_call | tool_call | subagent | mcp_call | hook | other
    │     ├── llm?   (model, tokens, costUSD)
    │     ├── tool?  (name, mcpServer, isError)
    │     └── provenance
    ├── totals                  (derived rollups)
    └── Insight[]               (derived findings)
```

## Field reference (abridged — normative version is the JSON Schema)

### Run
| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable hash of source session id(s). |
| `source.tool` | enum | `claude-code` \| `opencode` \| `otlp` \| `unknown` |
| `source.format` | enum | `claude-jsonl` \| `opencode-storage` \| `opencode-sqlite` \| `opencode-export` \| `otlp-json` |
| `source.files[]` | string | Absolute paths read. |
| `project` | object | `{ name?, path?, gitBranch? }` — from cwd/session metadata when available. `gitBranch` is the branch the session started on: the first non-empty `gitBranch` of a Claude Code transcript, or an OTLP `vcs.ref.head.name` / `vcs.repository.ref.name` / `git.branch` attribute. OpenCode records none, and no adapter reads `.git`. |
| `title?` | string | Session title if the source provides one. |
| `startedAt` / `endedAt` | ISO 8601 | UTC. |
| `spans[]` | Span | Ordered by `startedAt`. |
| `totals` | RunTotals | Derived. |
| `insights[]` | Insight | Derived. |

### Span
| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique within Run. |
| `parentId` | string \| null | null = root. Subagent spans parent under the delegating `tool_call` (mirrors Claude Code's native OTel nesting). |
| `kind` | enum | see tree above. |
| `name` | string | e.g. `"Bash"`, `"claude-sonnet-4-6"`, `"subagent:code-reviewer"`, `"PostToolUse:Edit"`. |
| `status` | enum | `ok` \| `error` \| `cancelled` \| `in_progress` \| `unknown` |
| `statusReason?` | string | Short machine-ish reason (exit code, stop reason): `user-rejected` on a declined call, `exit 1` on a failed hook, `timeout` on a hook cancelled by its timeout. |
| `startedAt` / `endedAt?` / `durationMs?` | | `endedAt` may be absent for in-progress spans (watch mode). |
| `depth` | int | Delegation depth (root session = 0). Derived. |
| `llm?` | object | Only for `llm_call`: `provider`, `model`, `tokens {input, output, cacheRead, cacheWrite, reasoning?}`, `costUSD?`, `costSource: reported\|computed\|unknown`, `stopReason?`. |
| `tool?` | object | Only for `tool_call`/`mcp_call`: `name`, `mcpServer?`, `isError`, `exitCode?`, `outputBytes?`, `linesAdded?`, `linesRemoved?` (file-modifying tools only, when derivable from the source record). |
| `agent?` | object | For `subagent`/`session`: `{ name?, sessionId? }`. |
| `content?` | object | `{ promptPreview?, outputPreview?, delegationReason? }` — all prompt-derived text lives here and is nulled by `--redact`; previews are first N chars; `delegationReason` (subagent spans) is the Task description; tool spans carry `outputPreview` only for a failed or user-rejected result (N chars of its text starting at the line that names the failure). A user-rejected call has `status: cancelled` + `statusReason: user-rejected`, never `error`. |
| `attributes` | object | Passthrough bag; prefer `gen_ai.*` keys where applicable. Adapter-emitted keys use the reserved `runray.` prefix, listed under "Reserved span attributes". |
| `provenance` | object | `{ file, line?, recordId? }`. |

### Reserved span attributes (`runray.*`)

`attributes` is a free-form bag. Adapters use the reserved `runray.` prefix for facts the schema has no field for. Each key belongs to one of two privacy classes.

**Closed.** The value is a hash, an enum, a count or an entry from a fixed list in `packages/core` (`tools/registry.ts`). These keys are emitted in every redaction mode and survive the `sanitized` and `metadata-only` profiles.

**Free-form.** The value is text from the session. These keys are emitted only when redaction is off, and the sanitized profiles drop them.

| Key | Value | On which spans | Class |
|---|---|---|---|
| `runray.targetKey` | 16-hex hash of the normalized target: a POSIX path, or the first token of a command | recognized file and command tools | closed |
| `runray.targetKind` | `file-read` \| `file-write` \| `command` | same | closed |
| `runray.target` | basename or first command token, at most 80 chars | same | free-form |
| `runray.mcpDetection` | `name-heuristic` | OpenCode MCP calls classified by name | closed |
| `runray.toolActivity` | one of `explore`, `edit`, `run`, `check`, `build`, `test`, `vcs`, `deps`, `infra`, `cloud`, `data`, `web`, `system`, `devices`, `agent`, `human`, `integration`, `other` | every shell tool span (`Bash`, `PowerShell`, OpenCode `bash`), and every Claude Code hook span whose record names a command | closed |
| `runray.tool` | registry id of the program that did the work (`docker`, `vitest`) | shell and hook spans whose command resolved | closed |
| `runray.toolSub` | a subcommand from that tool's table (`compose up`, `diff`), or `run` / `script` / `inline` | when present | closed |
| `runray.toolVia` | the runner the tool was launched through (`npx`, `pnpm exec`, `bash -c`) | when a runner was unwrapped | closed |
| `runray.toolsAlso` | up to 8 other registry ids the command ran, in order of appearance | when non-empty | closed |
| `runray.toolFlags` | a subset of `background`, `timeout`, `interrupted`, in that order | Claude Code shell spans, when non-empty | closed |
| `runray.hookCount` | number of hook runs a stop-hook summary stands for | Claude Code `Stop` hook spans built from a summary | closed |
| `runray.toolName` | a program name outside the registry | shell and hook spans | free-form |
| `runray.toolScript` | a script, task or script-file name (`db:reset`, `deploy.sh`) | shell and hook spans | free-form |
| `runray.skill` | name of the invoked skill | skill tool spans | free-form |

Rules that hold for the tool-usage keys (`runray.tool*`, `runray.skill`):

- The command text is never stored. No argument, path or option value enters an attribute.
- An absent key means "does not apply". No key is emitted with an empty value.
- `runray.toolActivity` marks a span as classified. A shell span without it comes from a trace produced before tool identification.
- A redacted export still discloses the tool stack: it shows that a session ran `terraform` or `stripe`, the same way it already shows MCP server names. It never shows a program outside the registry, a script name or a skill name.
- A closed key arriving through OTLP is kept only when its value is inside the vocabulary, in every redaction mode. That is why the sanitizer can keep these keys by name without inspecting their values.
- `runray.targetKey` still hashes the first token of a command, so `cd apps && pnpm test` and `cd apps && git status` share a key. The primary tool is in `runray.tool`.

The registry, its labels and the vocabularies are exported as `@runray/core/tools`.

### Hook spans

A `hook` span is one hook run, or one report about several. Where it comes from decides how complete it is.

**Claude Code transcripts** record a hook in three shapes, and each becomes a span:

| Record | Span | Time |
|---|---|---|
| `attachment` of type `hook_non_blocking_error` | status `error`, `statusReason: "exit <code>"` | the record's `durationMs` |
| `attachment` of type `hook_cancelled` | status `cancelled`, `statusReason: "timeout"` when the record says it timed out | the record's `durationMs` |
| `system` of subtype `stop_hook_summary` | named `Stop`, status `ok` (or `error` when the record lists hook errors), `runray.hookCount` | none: zero duration at the record's timestamp |

What the transcript does not record:

- A hook that succeeds leaves no record. This covers every `PreToolUse` and `PostToolUse` hook that ran clean, which is most hook runs in a healthy setup.
- One exception is deliberately not a span: an `attachment` of type `hook_additional_context`, written when a successful hook hands text back to the model. It has no duration, and only the successful runs that returned text leave one, so counting it would put an arbitrary sample of successes next to the complete set of failures.
- A stop-hook summary names the hooks that ran at the end of a turn and gives no duration for any of them.

So hook durations are partial by construction: they cover failed and cancelled runs only. A hook that always succeeds is invisible, and the time hooks took in total is not derivable from a transcript. The Time view states this above the hook rows.

How a hook span is built:

- **Name.** The record's hook event and matcher (`PostToolUse:Edit`, `SessionStart:startup`, `UserPromptSubmit`). The name survives redaction like a tool span's, so it is taken from the record only when it is shaped like a name; otherwise the span is named by the bare event, and past that `hook`. The matcher is kept only for an event that matches on names (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `Notification`) and only when it has the shape of a tool name or an agent type, which has no dot and no slash. A hook on any other event, such as one that matches on changed files, is named by its event alone, so a file name or a path never becomes a span name.
- **Time.** The record is written when the hook ends. The span ends at the record's timestamp and starts `durationMs` earlier. A container span starts no later than a hook it holds, so a session whose first record is a failed start-up hook opens where that hook began.
- **Parent.** The tool call the record names, when that call is in the same transcript; otherwise the transcript's container (the session, or the subagent whose transcript it is). In 150 sessions from one machine every tool hook lay inside its tool span, which is why hook time is not added to summed tool time.
- **Command.** Classified like a shell command and then dropped: the span carries `runray.tool`, `runray.toolSub` and the other tool-usage keys, never the command or its paths. A summary of several commands names a tool only when every one of them ran the same one.
- **No `tool` object.** That object is for `tool_call` and `mcp_call`. A hook's exit code is in `statusReason`.
- **Id.** The record's `uuid`, so a transcript re-appended after a bridge yields each hook span once.

Hook spans do not count toward `counts.toolCalls` or `counts.toolErrors`, are not triaged as errors and change no finding. They do count as spans: `counts.maxDepth` is one higher where a hook hangs off the deepest call, and a run starts and ends with its first and last hook.

**OTLP imports** carry `claude_code.hook` spans as their exporter wrote them, with their own timings. The **OpenCode** adapter emits no hook spans.

### RunTotals (derived)
```jsonc
{
  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0, "total": 0 },
  "costUSD": { "total": 0, "wastedEstimate": 0, "byModel": { "<model>": 0 } },
  "counts": { "llmCalls": 0, "toolCalls": 0, "toolErrors": 0, "subagents": 0, "maxDepth": 0 },
  "cache": { "hitRate": 0.0 },  // cacheRead / (cacheRead + input), 0..1
  "codeChanges": { "linesAdded": 0, "linesRemoved": 0 }   // sum of tool.linesAdded/linesRemoved; omitted when no span reports code changes
}
```

Semantics: `wastedEstimate` sums only **waste-class** findings (money already burned: `retry-loop`, `dead-end-run`). **Efficiency-opportunity** findings (e.g. `low-cache-hit`) carry their own `estimatedWasteUSD` but do not inflate the run's wasted total — otherwise hypothetical savings would be reported as losses.

### Insight (derived)
| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique per run. |
| `ruleId` | string | Open registry; v0 set: `retry-loop` \| `low-cache-hit` \| `context-bloat` \| `expensive-subagent` \| `dead-end-run`. New rules land in minor schema versions. |
| `severity` | enum | `info` \| `warning` \| `critical` — graded by the engine from `estimatedWasteUSD` as a share of the run's `costUSD.total` (defaults: warning ≥ 2% and ≥ $0.05, critical ≥ 10% and ≥ $1; no estimate or unpriced run ⇒ `info`). Independent of the rule's waste/opportunity class. |
| `title` / `detail` | string | Human-readable; `detail` must cite concrete numbers. |
| `spanIds[]` | string | Evidence — UI highlights these in the waterfall. |
| `estimatedWasteUSD?` | number | Where computable. |
| `suggestion?` | string | One actionable sentence. |

### PricingTable (bundled asset, not part of TraceFile)
`{ modelPattern, inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok }[]` + `snapshotDate`, `source: "litellm-snapshot"`. Shipped inside the package for offline use; `runray pricing --refresh` is explicit and opt-in.

## Source → schema mapping cheatsheet

| Concept | Claude Code JSONL | OpenCode | OTLP (Claude Code traces beta) |
|---|---|---|---|
| Run | `<session>.jsonl` + sibling `<session-uuid>/subagents/**/agent-*.jsonl` transcripts (CC ≥ 2.1) | `session/…/ses_*.json` or `session` table row | spans sharing `session.id` |
| Turn / LLM call | assistant message + `usage` | assistant `message` (+`parts`) with token fields incl. `reasoning` | `llm_request` span |
| Tool call | `tool_use` content block + paired `tool_result` | `part` of tool type with state | `claude_code.tool` span |
| Hook | `attachment` records `hook_non_blocking_error` and `hook_cancelled`, `system` record `stop_hook_summary`; a successful hook leaves none (see "Hook spans") | no hook spans | `claude_code.hook` span |
| Subagent | CC ≥ 2.1: `Agent` tool_use (`input: {subagent_type, description, prompt}`); child transcript is a **separate** `agent-<agentId>.jsonl` under `<session-uuid>/subagents/` (workflow agents under `subagents/workflows/wf_*/`). Joins, in precedence order (CC ≥ 2.2): (1) `toolUseResult.agentId` on ANY tool's result — sync `Agent` calls and forked skills (`Skill` result with `status:'forked'`, name from `commandName`); (2) the `agent-<agentId>.meta.json` sidecar (`{agentType, name?, description?, toolUseId?, parentAgentId?, spawnDepth}`) — background agents leave no agentId on any result, `toolUseId` names the spawning tool_use, `parentAgentId` the enclosing agent for nested spawns. Mapping: `subagent_type`/`commandName`/sidecar `name`→`agentType` → `agent.name`, `description` → `content.delegationReason`. Legacy: inline records with `isSidechain: true` in the MAIN transcript linked to a `Task` tool_use (agent transcripts carry `isSidechain: true` routinely in CC ≥ 2.2 — NOT a legacy marker) | child session with `parentID` | spans nested under parent's tool span |
| Provenance | file + line offset | file path or `(db, table, rowid)` | span id |

Adapter interface (Track A): `SourceAdapter { id; detect(paths): Candidate[]; parse(candidate): RawRun; }` → shared `normalize(RawRun): Run`. Golden tests: every fixture in `fixtures/<source>/<variant>` must produce a byte-stable normalized output in `fixtures/normalized/`.

## Open questions (resolve during week 1–2)

1. Claude Code subagents — the original assumption (`Task` tool + inline `isSidechain: true`) is **outdated**. Verified 2026-07 on real logs (CC 2.1.138–2.1.197, 46 sessions / ~75k records): the spawning tool is `Agent`, `isSidechain` is present but always `false`, `Task` never occurs, and the child transcript lives in a separate `agent-<agentId>.jsonl` under `<session-uuid>/subagents/` (workflow-spawned agents under `subagents/workflows/wf_*/`). The join is `toolUseResult.agentId`/`outputFile` on the tool-result record. Beware red herrings: `logicalParentUuid` marks context-compaction boundaries (`system/compact_boundary`), and `sourceToolUseID` on user records does not reference `Agent` calls. **Resolved (task 1.4, 2026-07):** join confirmed on the subagents fixture (11/11 `agentId`s resolve to child files); child transcripts carry full `usage` on every assistant record, so parent-run token rollup needs no heuristics. Decision: **v0.1 parses the current era only** — legacy sessions (`Task` + `isSidechain: true`) parse flat with a run warning; full legacy support only if beta users surface pre-2.x logs. `journal.jsonl` files under `subagents/workflows/wf_*/` are workflow metadata — handling decided in task 2.2 (default: skip). **Amended (task 11.5, 2026-08, CC 2.2.x):** two new join shapes verified on real sessions — forked skills carry `toolUseResult.agentId` on a NON-`Agent` tool result (`Skill`, `status: 'forked'`, `commandName`), and background agents carry NO agentId anywhere: their join lives in an `agent-<agentId>.meta.json` sidecar (`toolUseId` → spawning tool_use, `parentAgentId` → enclosing agent, plus `agentType`/`name`/`description`/`spawnDepth`). Sidecars count as provenance (candidate files/freshness). `isSidechain: true` appears on every record of modern AGENT transcripts and is a legacy marker only in the main transcript. The scrub allowlist preserves `toolUseId`/`parentAgentId`/`spawnDepth`/`agentType` so scrubbed fixtures keep their joins.
2. OpenCode SQLite schema stability during their migration — pin supported `opencode` versions per adapter release; contract tests will catch drift.
3. Token counts for streaming-interrupted messages — decide whether partial usage is summed or flagged `in_progress`.
