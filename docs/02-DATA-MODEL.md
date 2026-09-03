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
| `project` | object | `{ name?, path?, gitBranch? }` — from cwd/session metadata when available. |
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
| `name` | string | e.g. `"Bash"`, `"claude-sonnet-4-6"`, `"subagent:code-reviewer"`. |
| `status` | enum | `ok` \| `error` \| `cancelled` \| `in_progress` \| `unknown` |
| `statusReason?` | string | Short machine-ish reason (exit code, stop reason). |
| `startedAt` / `endedAt?` / `durationMs?` | | `endedAt` may be absent for in-progress spans (watch mode). |
| `depth` | int | Delegation depth (root session = 0). Derived. |
| `llm?` | object | Only for `llm_call`: `provider`, `model`, `tokens {input, output, cacheRead, cacheWrite, reasoning?}`, `costUSD?`, `costSource: reported\|computed\|unknown`, `stopReason?`. |
| `tool?` | object | Only for `tool_call`/`mcp_call`: `name`, `mcpServer?`, `isError`, `exitCode?`, `outputBytes?`, `linesAdded?`, `linesRemoved?` (file-modifying tools only, when derivable from the source record). |
| `agent?` | object | For `subagent`/`session`: `{ name?, sessionId? }`. |
| `content?` | object | `{ promptPreview?, outputPreview?, delegationReason? }` — all prompt-derived text lives here and is nulled by `--redact`; previews are first N chars; `delegationReason` (subagent spans) is the Task description. |
| `attributes` | object | Passthrough bag; prefer `gen_ai.*` keys where applicable. |
| `provenance` | object | `{ file, line?, recordId? }`. |

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
| Subagent | CC ≥ 2.1: `Agent` tool_use (`input: {subagent_type, description, prompt}`); child transcript is a **separate** `agent-<agentId>.jsonl` under `<session-uuid>/subagents/` (workflow agents under `subagents/workflows/wf_*/`). Joins, in precedence order (CC ≥ 2.2): (1) `toolUseResult.agentId` on ANY tool's result — sync `Agent` calls and forked skills (`Skill` result with `status:'forked'`, name from `commandName`); (2) the `agent-<agentId>.meta.json` sidecar (`{agentType, name?, description?, toolUseId?, parentAgentId?, spawnDepth}`) — background agents leave no agentId on any result, `toolUseId` names the spawning tool_use, `parentAgentId` the enclosing agent for nested spawns. Mapping: `subagent_type`/`commandName`/sidecar `name`→`agentType` → `agent.name`, `description` → `content.delegationReason`. Legacy: inline records with `isSidechain: true` in the MAIN transcript linked to a `Task` tool_use (agent transcripts carry `isSidechain: true` routinely in CC ≥ 2.2 — NOT a legacy marker) | child session with `parentID` | spans nested under parent's tool span |
| Provenance | file + line offset | file path or `(db, table, rowid)` | span id |

Adapter interface (Track A): `SourceAdapter { id; detect(paths): Candidate[]; parse(candidate): RawRun; }` → shared `normalize(RawRun): Run`. Golden tests: every fixture in `fixtures/<source>/<variant>` must produce a byte-stable normalized output in `fixtures/normalized/`.

## Open questions (resolve during week 1–2)

1. Claude Code subagents — the original assumption (`Task` tool + inline `isSidechain: true`) is **outdated**. Verified 2026-07 on real logs (CC 2.1.138–2.1.197, 46 sessions / ~75k records): the spawning tool is `Agent`, `isSidechain` is present but always `false`, `Task` never occurs, and the child transcript lives in a separate `agent-<agentId>.jsonl` under `<session-uuid>/subagents/` (workflow-spawned agents under `subagents/workflows/wf_*/`). The join is `toolUseResult.agentId`/`outputFile` on the tool-result record. Beware red herrings: `logicalParentUuid` marks context-compaction boundaries (`system/compact_boundary`), and `sourceToolUseID` on user records does not reference `Agent` calls. **Resolved (task 1.4, 2026-07):** join confirmed on the subagents fixture (11/11 `agentId`s resolve to child files); child transcripts carry full `usage` on every assistant record, so parent-run token rollup needs no heuristics. Decision: **v0.1 parses the current era only** — legacy sessions (`Task` + `isSidechain: true`) parse flat with a run warning; full legacy support only if beta users surface pre-2.x logs. `journal.jsonl` files under `subagents/workflows/wf_*/` are workflow metadata — handling decided in task 2.2 (default: skip). **Amended (task 11.5, 2026-08, CC 2.2.x):** two new join shapes verified on real sessions — forked skills carry `toolUseResult.agentId` on a NON-`Agent` tool result (`Skill`, `status: 'forked'`, `commandName`), and background agents carry NO agentId anywhere: their join lives in an `agent-<agentId>.meta.json` sidecar (`toolUseId` → spawning tool_use, `parentAgentId` → enclosing agent, plus `agentType`/`name`/`description`/`spawnDepth`). Sidecars count as provenance (candidate files/freshness). `isSidechain: true` appears on every record of modern AGENT transcripts and is a legacy marker only in the main transcript. The scrub allowlist preserves `toolUseId`/`parentAgentId`/`spawnDepth`/`agentType` so scrubbed fixtures keep their joins.
2. OpenCode SQLite schema stability during their migration — pin supported `opencode` versions per adapter release; contract tests will catch drift.
3. Token counts for streaming-interrupted messages — decide whether partial usage is summed or flagged `in_progress`.
