# RunRay — Data Model (v0.1.0)

The internal schema is **the contract** between Track A (CLI/parsers) and Track B (UI). It is authored as zod types in `packages/schema`, from which `schema/runray.schema.json` is generated. The UI never sees raw agent logs — only this format.

## Design principles

1. **Superset-normalize.** Every source (Claude Code JSONL, OpenCode storage/SQLite, OTLP JSON) maps into one span tree. Source-specific extras go into `attributes` (using OTel GenAI `gen_ai.*` attribute names where a match exists) — we align with the emerging standard without hard-depending on it (GenAI semconv is still Development-stability).
2. **Derived data is computed, never trusted.** `totals` and `insights` are outputs of the normalizer/insight engine, recomputed from spans. OpenCode stores `cost: 0` in message files, so cost always flows through our pricing engine; `costSource` records whether a number was reported by the source or computed by us.
3. **Provenance everywhere.** Each span points back to its source file/record. The UI's "show raw" affordance and all debugging depend on it.
4. **Forward compatibility.** Unknown attributes pass through; `schemaVersion` is SemVer'd independently of the app. Breaking schema changes require a major bump + migration note.
5. **Privacy-aware.** Prompt/output text lives only in optional `content` fields that `--redact` nulls out while preserving counts and structure.

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
| `tool?` | object | Only for `tool_call`/`mcp_call`: `name`, `mcpServer?`, `isError`, `exitCode?`, `outputBytes?`. |
| `agent?` | object | For `subagent`/`session`: `{ name?, sessionId?, delegationReason? }`. |
| `content?` | object | `{ promptPreview?, outputPreview? }` — first N chars only; nulled by `--redact`. |
| `attributes` | object | Passthrough bag; prefer `gen_ai.*` keys where applicable. |
| `provenance` | object | `{ file, line?, recordId? }`. |

### RunTotals (derived)
```jsonc
{
  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0, "total": 0 },
  "costUSD": { "total": 0, "wastedEstimate": 0, "byModel": { "<model>": 0 } },
  "counts": { "llmCalls": 0, "toolCalls": 0, "toolErrors": 0, "subagents": 0, "maxDepth": 0 },
  "cache": { "hitRate": 0.0 },  // cacheRead / (cacheRead + input), 0..1
  "codeChanges": { "linesAdded": 0, "linesRemoved": 0 }
}
```

Semantics: `wastedEstimate` sums only **waste-class** findings (money already burned: `retry-loop`, `dead-end-run`). **Efficiency-opportunity** findings (e.g. `low-cache-hit`) carry their own `estimatedWasteUSD` but do not inflate the run's wasted total — otherwise hypothetical savings would be reported as losses.

### Insight (derived)
| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique per run. |
| `ruleId` | string | Open registry; v0 set: `retry-loop` \| `low-cache-hit` \| `context-bloat` \| `expensive-subagent` \| `dead-end-run`. New rules land in minor schema versions. |
| `severity` | enum | `info` \| `warning` \| `critical` |
| `title` / `detail` | string | Human-readable; `detail` must cite concrete numbers. |
| `spanIds[]` | string | Evidence — UI highlights these in the waterfall. |
| `estimatedWasteUSD?` | number | Where computable. |
| `suggestion?` | string | One actionable sentence. |

### PricingTable (bundled asset, not part of TraceFile)
`{ modelPattern, inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok }[]` + `snapshotDate`, `source: "litellm-snapshot"`. Shipped inside the package for offline use; `runray pricing --refresh` is explicit and opt-in.

## Source → schema mapping cheatsheet

| Concept | Claude Code JSONL | OpenCode | OTLP (Claude Code traces beta) |
|---|---|---|---|
| Run | one `<session>.jsonl` file | `session/…/ses_*.json` or `session` table row | spans sharing `session.id` |
| Turn / LLM call | assistant message + `usage` | assistant `message` (+`parts`) with token fields incl. `reasoning` | `llm_request` span |
| Tool call | `tool_use` content block + paired `tool_result` | `part` of tool type with state | `claude_code.tool` span |
| Subagent | records with `isSidechain: true`, linked to spawning Task tool_use | child session with `parentID` | spans nested under parent's tool span |
| Provenance | file + line offset | file path or `(db, table, rowid)` | span id |

Adapter interface (Track A): `SourceAdapter { id; detect(paths): Candidate[]; parse(candidate): RawRun; }` → shared `normalize(RawRun): Run`. Golden tests: every fixture in `fixtures/<source>/<variant>` must produce a byte-stable normalized output in `fixtures/normalized/`.

## Open questions (resolve during week 1–2)

1. Claude Code `isSidechain` linkage to the exact spawning `Task` tool_use — verify against real fixtures; fall back to time-window heuristic if the explicit link is missing.
2. OpenCode SQLite schema stability during their migration — pin supported `opencode` versions per adapter release; contract tests will catch drift.
3. Token counts for streaming-interrupted messages — decide whether partial usage is summed or flagged `in_progress`.
