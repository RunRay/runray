# Tasks: add-local-trace-viewer

Owners: **A** = Track A (data: core/cli), **B** = Track B (experience: ui/design), **A+B** = pair.

## 1. Foundation (week 1)
- [x] 1.1 A+B Scaffold pnpm monorepo (schema/core/cli/ui), biome, vitest, tsc strict, CI workflow
- [x] 1.2 A+B Author zod schema in `packages/schema`; generate `runray.schema.json`; **freeze v0.1**
- [ ] 1.3 A+B Collect fixtures per `docs/04-SAMPLE-LOGS.md`; write `scripts/scrub-fixture.ts`; commit scrubbed set
- [x] 1.4 A Verify Claude Code JSONL assumptions against fixtures — done 2026-07 (CC 2.1.138–2.1.197, see `02-DATA-MODEL.md` Open Q1): subagents spawn via the `Agent` tool with child transcripts under `<session-uuid>/subagents/`; join via `toolUseResult.agentId` confirmed 11/11 on the fixture; child files carry full `usage` on every assistant record (rollup verified). Decision: v0.1 parses the current era only — legacy (`Task` + `isSidechain: true`) parses flat + run warning. `journal.jsonl` handling → task 2.2
- [x] 1.5 B Implement design tokens from `docs/03-design.md` (Tailwind config, fonts, span palette)
- [x] 1.6 A+B Verify npm/GitHub name availability; reserve — **done 2026-08-21: the name is `runray` and it is claimed.** History: the original `tracellm` was taken on npm and collided with tracellm.in, an actively marketed LLM-observability product (Product Hunt, Aug 2026); `tracepulse` was taken too; npm's punctuation-similarity rule blocks the hyphenated variants of both. Renamed to **RunRay**: `runray` was free on npm, org `@runray` created, GitHub repo renamed to `apitome-app/runray`, and `runray@0.1.0-alpha.1` published, which reserves the name. Schema `$id` embeds `runray.dev` — a further rename would touch the frozen schema, so this name is now load-bearing. *(The previous text here claimed `runray` was taken on npm; that was the old TraceLLM finding left behind by a mechanical rename, not a fact about `runray`.)*

## 2. Core data pipeline (week 2, Track A)
- [x] 2.1 A `SourceAdapter` interface + registry
- [x] 2.2 A Claude Code adapter: streaming JSONL reader, tree reconstruction, tool_use/result pairing, subagent linking, code-change counts (`linesAdded`/`linesRemoved`) from file-modifying tool records
- [x] 2.3 A OpenCode adapter: file storage + SQLite (read-only, WAL) + `opencode export` JSON — one SessionBundle + one emitter behind three era loaders (observed OpenCode 1.1.56–1.2.14); detect() dedupes db-vs-file-storage dual-writes; subagents join via `task` part `state.metadata.sessionId`; cross-era equivalence tested on one session captured in all three formats (storage ↔ sqlite identical modulo provenance; export differs in re-rendered free text only). New dep: better-sqlite3 (read-only local file access, no runtime network)
- [x] 2.4 A Normalizer pipeline (deterministic ordering, depth derivation, provenance, totals rollups incl. `codeChanges`, Flat Trace Fallback)
- [x] 2.5 A Cost engine: pricing snapshot build step, model matching (exact→prefix→alias), `costSource` handling
- [x] 2.6 A Golden tests: every fixture → byte-stable normalized output; schema validation in CI
- [x] 2.7 A Bench harness (tinybench) on the `large` fixture; budgets per `05-ARCHITECTURE §5` reported in CI (informational) — `pnpm bench`; CI synthesizes its large fixture via `pnpm synth-large` (id-rewriting multiply promised in the fixture README). Local baseline 2026-07-07: parse 153 MB/s, peak RSS 355 MB, all budgets green
- [x] 2.8 A OTLP adapter (best-effort): OTLP/JSON import, `resourceSpans` mapping, `gen_ai.*` passthrough, beta span names pinned via fixture, unknown shapes → `kind: other` — pinned CC 2.1.81 names (interaction→turn, llm_request→llm_call, tool→tool_call, tool.blocked_on_user/.execution→other, hook→hook); tokens read from bespoke input_tokens/… attrs with gen_ai.usage.* preferred when present; runs grouped by session.id under a synthetic session root; subagent nesting via parentSpanId links (no synthesis); identity attrs dropped, user_prompt → redactable content. Explicit-path import only (no zero-config location, ADR-3)

## 3. Visualizer (week 2–3, Track B)
- [x] 3.1 B App shell: hash routing, zustand store, data loader (`__RUNRAY_DATA__` → `/api/tracefile` fallback)
- [x] 3.2 B Sessions list table (sortable, badges)
- [x] 3.3 B Timeline waterfall: virtualized rows, nesting, span bars, collapse/expand, tooltip
- [x] 3.4 B Spend Spine gutter component (cumulative cost, heat coloring, click-to-scroll)
- [x] 3.5 B Inspector panel (tokens table, cost + costSource badge, previews, provenance / show raw, delegation reason)
- [x] 3.6 B Cost Breakdown view (hero totals + code changes metrics, stacked-by-model, treemap, waste table)
- [x] 3.7 B Insights strip with evidence highlighting
- [x] 3.8 B Empty/parsing/error states + keyboard map + a11y pass — keyboard: j/k · ←/→ · g t/g c · `/` filter · `?` help (with Spend Spine data-table fallback per 03-design §6). Parsing state stays a labeled text state: per-file determinate progress needs a streaming endpoint (server work, revisit with 5.1); "point me at a folder" ships as the `runray view <path>` hint. Known gap: `text-faint` (#5C636E) is ~3:1 on surface — tertiary labels only, per frozen tokens
- [x] 3.9 B Sessions overview dashboard: aggregate hero, spend-by-day, top projects/models, cross-run waste leaderboard [UI → /frontend-design] — added 2026-07-07 (design review); spec delta: visualizer "Sessions overview aggregates". Includes design fixes: dedicated model color ramp (span palette stays kind-only), Inspector default run summary, run-header metric dedup

## 4. Insights + CLI surface (week 3, Track A)
- [x] 4.1 A Rule engine interface + thresholds config
- [x] 4.2 A Rules: retry-loop, low-cache-hit, context-bloat, expensive-subagent, dead-end-run (synthetic-run tests each)
- [x] 4.3 A `runray view` (discovery, server 127.0.0.1, port fallback, --no-open, --watch SSE)
- [x] 4.4 A `runray list` / `--json`; `runray pricing --show|--refresh`

## 5. Integration & release (week 4, A+B)
- [x] 5.1 A+B Embed UI dist in CLI package; E2E: `view` on subagents fixture renders waterfall
- [x] 5.2 B Singlefile export template; A `runray export` with data injection + redact guard (`--yes`)
- [x] 5.3 A+B `runray demo` on bundled scrubbed fixture — bundles the normalized goldens (scrubbed, insight-annotated) via prepack into `cli/assets/demo`
- [x] 5.4 A `--redact` in core; offline network-guard test — redaction landed in core with 2.2 (adapter `contentField` nulls prompt-derived fields, tested); this task adds the guard: `net`/`tls` connect factories throw for non-loopback while `view`/`list`/`export`/`demo` run (undici's fetch calls `net.connect`, not `Socket.prototype.connect` — verified empirically)
- [x] 5.5 A+B Windows path pass; README with GIF; publish `0.1.0` to npm (`next` tag) — **Windows pass done** (audited the path surface with adversarial verification, 9 defects fixed in `fix: Windows path pass [5.5]`; verified on Windows 11 that goldens regenerate byte-identically and that spaces, forward slashes, trailing separators and non-ASCII segments all work). **Published 2026-08-21** as `runray@0.1.0-alpha.1`; note npm forces a `latest` tag on a first publish, so plain `npx runray` resolves to the alpha and `latest` cannot be moved off it until a second version exists. **The GIF is deliberately deferred, not dropped:** the roadmap scopes it to GTM preparation for the **0.2.0 public launch**, and this release is the 0.1.0 PoC whose exit gate is 5 beta users (task 5.6). Tracked there; the README ships without images for now.
- [ ] 5.6 A+B Distribute to 5 beta users; instrument validation questions (internal validation checklist)
