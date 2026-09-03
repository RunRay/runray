# Tasks: add-profiler-depth

Track **A** = data (`packages/core`, `packages/cli`), Track **B** =
experience (`packages/ui`). Every task: `pnpm lint && pnpm typecheck &&
pnpm test` green. Goldens are touched **only** in phases 5 and 8 (dedicated
commits); every other task asserts goldens byte-identical. UI tasks run
under the `/frontend-design` skill per CLAUDE.md. Design references (A1…,
B1…, C1…, D1…, E1…, X1…) point at `design.md`.

The persistent run index ships as the separate companion change
**add-persistent-index** (it revises the MVP's "no database" non-goal); it
depends on this change's phases 2, 5, and 6.1 and hooks the same rebuild
path — nothing here depends on it.

Phase ordering is binding where noted; "∥" marks tasks parallelizable within
their phase. Hard chains: 1.1→1.3→(phase 4)→5.1; 3.1→3.2→4.5→4.6;
2.1→4.4→4.12; 6.2→6.4→6.5; 7.9→7.10→7.11.

## 1. Behavior-neutral foundations (all goldens asserted byte-identical)

- [x] 1.1 A Browser-safe core subpath family (X1, C1): split
      `packages/core/src/pricing/` into pure `engine.ts` (match/compute;
      type-only imports, no snapshot, no node builtins) + re-exporting
      `index.ts`; add `"./pricing"` and `"./insights-meta"` subpath exports
      to core package.json; UI adds `@runray/core: workspace:*`; ONE
      import-graph purity test covering every browser-safe entrypoint.
      Dependency note for the PR: workspace dep only, no new external deps. ∥
- [x] 1.2 A `RULE_META` registry in `packages/core/src/insights/meta.ts`
      (label · explain · class for the v0 five); derive `WASTE_CLASS` from
      `meta.class` in `insights/index.ts` (behavior-identical); unit test:
      every registered rule id has a meta entry (B1). ∥
- [x] 1.3 A RuleContext (C3): `evaluate(run, ctx {thresholds, pricing})`,
      `applyInsights(…, pricing = bundledPricing())`, migrate the five v0
      rules, thread `options.pricing` through `discover.ts`; test proving an
      override table changes low-cache-hit dollars; goldens byte-identical
      under the default. Depends on 1.1.
- [x] 1.4 A `defaultRoots()` on `SourceAdapter` (A1): extract the existing
      literals from claude-code/opencode `detect()`; otlp returns `[]`;
      unit tests per adapter. ∥
- [x] 1.5 A Zero-config `--watch` fix in `program.ts` (A1): watch targets =
      explicit roots, else union of `defaultRoots()` honoring `--source`,
      filtered to existing dirs; e2e test — a change under a default root
      fires the SSE `changed` event. (Rebuilds re-parse from disk as today;
      incrementality arrives with add-persistent-index.) Depends on 1.4.
- [x] 1.6 A Bare `runray` defaults to `view` (`isDefault`, D7): tests for
      bare invocation with data (serves) and without (exit 3 + hints);
      `--help`/`--version` unaffected. ∥
- [x] 1.7 A Engine cap invariant `wastedEstimate = min(round6(sum), total)`
      + shared pure helpers module (`scopeOf`, `detectRetryClusters`,
      chronological llm-pair iterator) with unit tests (B2, B6). Depends on
      1.2, 1.3.

## 2. Parse-output substrate (adapters; goldens change but regen deferred to 5.1)

- [x] 2.1 A Tool target identity capture (B7, X2): shared extractor
      `packages/core/src/adapters/target.ts` (doubled-FNV hash of the
      normalized target; kind map file-read/file-write/command) emitting
      `runray.targetKey`/`targetKind` in both redact modes and
      `runray.target` only unredacted; wired into claude-code + opencode
      tool emit sites + OTLP passthrough; unit tests incl. redact parity
      and unrecognized tools.
- [x] 2.2 A OpenCode MCP classification (E4): `OPENCODE_BUILTIN_TOOLS`
      allowlist + underscore-prefix heuristic at the single tool-part emit
      site → `mcp_call`, `tool.mcpServer`,
      `runray.mcpDetection: 'name-heuristic'`; unit tests for
      `apply_patch`-style builtins, MCP-shaped names, era parity; **assert
      existing OpenCode goldens byte-identical** (no MCP-shaped names in
      committed fixtures). After 2.1 (same emit site).

## 3. Repricing primitives (blocks phase-4 quantification)

- [x] 3.1 A `MODEL_TIERS` ladder + `suggestedDowngrade(model, table)` with
      zero-rate guard (C4); `scripts/build-pricing-snapshot.ts` warns on
      vanished ladder targets; unit tests incl. no-suggestion fallthrough.
- [x] 3.2 A `repriceSpans`/`repriceRun` + **canonical innermost-attribution
      subtree cells in core** + risk flags (`errors`/`tool-fanout`/
      `long-context`/`unpriced`) + `downgradeMap` (C5, X — single
      attribution implementation); unit tests: reported-cost spans,
      unknown-source taint, self-mapped models, ordering stability, round6.
      Depends on 3.1.
- [x] 3.3 A `unpricedCoverage(run)` in core (C7): calls/tokens/sorted
      models/`complete`; unit tests. ∥ with 3.1–3.2.

## 4. Rules (all on RuleContext; every rule registers RULE_META; NO regen yet)

- [x] 4.1 A dead-end-run failed-tail attribution (B3): productive-marker
      scan, retry-cluster subtraction via shared helper, no-marker
      fallback; tests for "worked then died" vs "produced nothing". ∥
- [x] 4.2 A low-cache-hit `targetHitRate` config key (default 0.6, clamped
      ≥ firing threshold) replacing the hardcoded constant — golden-neutral
      by construction (B4). ∥
- [x] 4.3 A context-bloat cumulative-excess quantification, detection
      predicate untouched (B5). ∥
- [x] 4.4 A retry-loop windowed clustering (name+targetKey identity,
      `maxGapToolCalls`, per-scope) + per-scope waste attribution +
      deprecated `minConsecutiveFailures` alias (B6). Depends on 2.1.
- [x] 4.5 A expensive-subagent quantification via `suggestedDowngrade` +
      `repriceSpans` (no internal downgrade map — X resolution), numbered
      suggestion, graceful no-tier fallback; hoist the byId map (B, C5).
      Depends on 3.1, 3.2.
- [x] 4.6 A `model-mismatch` rule, sixth in registration order, WITH the
      expensive-subagent-subtree exclusion predicate (C6); thresholds
      `modelMismatch {minSavingsUSD: 0.5, riskToolCalls: 25,
      riskContextTokens: 150000}`; tests: fires on safe savings, silent when
      only risky subtrees would save, silent with no downgrade,
      opportunity-class (wastedEstimate untouched), exclusion of
      expensive-subagent subtrees. Depends on 3.1, 3.2, 4.5.
- [x] 4.7 A cache-prefix-break rule + thresholds + idle-precedence check
      (B4). ∥
- [x] 4.8 A idle-cache-expiry rule + thresholds (B4). ∥
- [x] 4.9 A fixed-context-overhead rule + thresholds (B5). ∥
- [x] 4.10 A oversized-output rule (opportunity-class, top offenders) +
      thresholds (B7). ∥
- [x] 4.11 A duplicate-read rule + thresholds (B7). Depends on 2.1.
- [x] 4.12 A scattered-tool-failures rule + thresholds (B7). Depends on 4.4
      (cluster exclusion).

## 5. THE golden regen — Batch 1, one dedicated commit

- [x] 5.1 A Single `pnpm goldens` regeneration covering: tool-span
      `attributes` (2.1), all new/changed insight findings and ids
      (4.1–4.12), `wastedEstimate` values + cap, demo dataset (X3).
      Verification in the commit: only `attributes` and
      `insights`/`wastedEstimate` changed; span structure, token totals,
      ordering byte-stable; `wastedEstimate ≤ costUSD.total` across all
      goldens. Adjacent commit in the same PR: demo/CLI test-expectation
      updates to what the regenerated data actually shows.

## 6. CLI plumbing (serialized through program.ts/server.ts/export.ts — X4)

- [x] 6.1 A Capture-once effective pricing in `program.ts` (re-capture tied
      to watch cache invalidation — the single rebuild path
      add-persistent-index later hooks), pass into `applyInsights` via
      `discover.ts`; stderr coverage warning at build; `list --json` gains
      `unpricedLlmCalls`/`unpricedTokens` with clean stdout (C2, C7). Tests
      for warning text and JSON shape.
- [x] 6.2 A `GET /api/pricing` (origin, path?, table) in `server.ts`; one
      shared `injectGlobal(name, payload)` helper in `export.ts` (same `<`
      sanitization) used for `__RUNRAY_PRICING__`; `demo` serves the
      bundled table; server + injection + network-guard tests (C2). After
      6.1.
- [x] 6.3 A Core transcript reader `packages/core/src/transcript.ts` (D4):
      `readTranscriptSlice(provenance, sourceTool, {redact})` — redact
      short-circuits before any file I/O; claude-code JSONL line reader,
      OpenCode JSON/sqlite readers (readonly, fileMustExist, SQLITE_BUSY →
      unavailable), otlp → unsupported; 1 MB cap + `truncated`; structured
      `unavailable` on missing/deleted source files; unit tests against
      existing scrubbed fixtures only. ∥ with 6.1–6.2.
- [x] 6.4 A `GET /api/transcript?run=&span=` endpoint (D4): new
      `getTranscript(runId, spanId)` server option wired in `program.ts`
      against the TraceFile cache with the view's redact flag; id-only
      lookup, no client paths; tests incl. redact refusal, unknown ids,
      missing-file unavailable. Depends on 6.3; after 6.2 (server
      serialization).
- [x] 6.5 A `limitWindow` config block + validation in `config.ts`;
      `GET /api/viewconfig`; `__RUNRAY_VIEW_CONFIG__` export injection via
      `injectGlobal` (E1); unit + server tests incl. absent-block no-op.
      After 6.4.

## 7. UI (libs first ∥, then composition on the inverted layout — X4)

Libs (each after its data dependency):
- [x] 7.1 B Pricing payload load: `load.ts` reads `__RUNRAY_PRICING__`,
      else fetches `/api/pricing` (absent → undefined); store slice;
      `PricingProvenance` line component (C2). After 6.2 for the live path;
      testable against the embedded global alone. ∥
- [x] 7.2 B `ui/lib/coverage.ts` mirroring core `unpricedCoverage` over
      `Run[]` + run-level and dashboard banner components + caveat marker
      primitives (C7). After 3.3. ∥
- [x] 7.3 B `savingsSummary(runs, meta)` in `lib/overview.ts` (D1):
      burned = Σ `wastedEstimate`; opportunity = Σ opportunity-class
      `estimatedWasteUSD` via RULE_META (class-summed, NOT
      remainder-arithmetic); top-3 ranking reusing `wasteByRule`; unknown
      ids → opportunity under literal slug; unit tests incl. empty and
      unknown-rule cases. After 1.2, 7.2. ∥
- [x] 7.4 B `subtreeRollups(spans)` in `lib/waterfall.ts` — O(n) reverse
      pass, priced-only cost + `unpricedCalls`; unit tests incl. nested
      subagents (D3). ∥
- [x] 7.5 B `agentSubtreeTree(spans, mode)` in `lib/cost-breakdown.ts` —
      nested by nearest subagent ancestor; node `own` = the core attribution
      cell (3.2); test pinning Σ own = Σ core cells; cost and token modes
      (D3). After 3.2. ∥
- [x] 7.6 B `lib/csv.ts`: sessions + day-aggregates builders — fixed
      columns, canonical sort (startedAt, id), `String(n)` numbers, RFC
      4180 + CRLF + BOM; byte-determinism tests (D5). ∥
- [x] 7.7 B `lib/limit-window.ts` (E1): `windowBounds` anchored to newest
      run (never Date.now), `windowSpend`, budget-vs-spend-to-date
      denominator; `loadViewConfig()` embedded-first; store slice +
      localStorage toggle persistence; tests incl. export determinism and
      reset-boundary cases. After 6.5 for transport shape (stub allowed). ∥
- [x] 7.8 B `lib/time-breakdown.ts` (E2, E3): interval sweep (model-wait >
      tool-exec precedence, idle ≥ `DEFAULT_IDLE_GAP_MS` = 60_000 — its own
      constant, deliberately distinct from `idleCacheExpiry`, cross-ref
      comment), segments sum to wall-clock under parallelism, parallelism
      factor, `toolDurationStats` per-run + cross-run (nearest-rank
      p50/p95); tests incl. the parallel no-double-count case. ∥
- [x] 7.9 B `ToolCost.mcpServer` + orchestration marker in
      `cost-breakdown.ts`; `topTools(runs)` cross-run merger in
      `overview.ts` (excludes orchestration, attaches p95 from 7.8); new
      `tool` dimension on `RunFilter` (`filterRuns`/`reconcileFilter`/chip)
      (E5). After 5.1 (mcp data in goldens); p95 column after 7.8.

Router (serialized — X5):
- [x] 7.10 B Router: filter-param parse/format matrix in canonical order
      `project, source, period, model, day, tool` + `#/run/:id/time` route
      + fix the stale "timeline default" doc comment (D6, E2); full-matrix
      unit tests; old hashes parse unchanged. After 7.9.
- [x] 7.11 B Filter↔hash sync: store→hash via `history.replaceState` with
      loop guard, hash→store on load/hashchange + `reconcileFilter`;
      central `navigateTo(route)` adopted at every `window.location.hash =`
      call site; tests for no-history-spam and stale-filter reconciliation
      (D6 — supersedes add-dashboard-extensions D2). Depends on 7.10.

Composition (all [UI → /frontend-design]; savings panel first, rest on top):
- [x] 7.12 B [UI → /frontend-design] `SavingsPanel` above the fold +
      dashboard reorder (statement/burn-line demoted): honest
      burned/opportunity split, coverage caveat chip (7.2 — no fallback),
      pricing provenance beside the headline, top-3 changes with per-change
      $, honest empty state (D1). Depends on 7.3.
- [x] 7.13 B [UI → /frontend-design] Humanized rule labels (WasteBoard,
      wasteDriver KPI, Inspector) with slug as secondary mono text +
      in-place evidence expansion on dashboard rows, timeline deep link
      demoted to secondary (D2). Depends on 7.12.
- [x] 7.14 B [UI → /frontend-design] What-if panel in CostView (C5, C6):
      target selector (suggested downgrade preselected), per-subtree delta
      table with risk badges, full + risk-free totals, "estimated at
      <target> rates" copy, provenance line, no-payload notice; math from
      `@runray/core/pricing`, never reimplemented. Depends on 3.2, 7.1.
- [x] 7.15 B [UI → /frontend-design] Waterfall rollup badges on container
      rows (`Σ $ · tok · calls · time`, visible collapsed, unpriced-count
      annotation) (D3). Depends on 7.4.
- [x] 7.16 B [UI → /frontend-design] Hierarchical treemap in CostView:
      recursive squarify with parent header strips, size-floor "+n nested",
      cost|tokens toggle, click-through preserved (D3). Depends on 7.5.
- [x] 7.17 B [UI → /frontend-design] Dashboard "By tool" card (E5): ranked
      rows (name, server badge, attributed-USD label, calls, p95),
      MCP-share callout, click-to-filter with clearable chip; placed below
      the savings panel. Depends on 7.9, 7.12.
- [x] 7.18 B [UI → /frontend-design] Limit-mode UI (E1): TopBar toggle +
      settings popover; "est." % lines in exactly three slots (overview
      statement, Wasted KPI suffix, Cost hero); budget-aware statement copy;
      suppressed when the window has no runs. Depends on 7.7, 7.12; TopBar
      edit lands after 7.21/7.22 (X4 serialization).
- [x] 7.19 B [UI → /frontend-design] Time tab in RunView
      (`Cost | Timeline | Time`): stacked wall-clock strip + legend +
      segment table, parallelism chip, slowest-tools table; renders the
      idle-cache-expiry finding with evidence links when present
      (reference only — detection lives in core) (E2). Depends on 7.8,
      7.10.
- [x] 7.20 B [UI → /frontend-design] Inspector "Transcript" section: lazy
      load button, virtualized read-only segments
      (existing @tanstack/react-virtual), per-`run:span` cache in
      `lib/transcript.ts`; distinct states for redacted / unavailable /
      unsupported / truncated / not-live (D4). Depends on 6.4.
- [x] 7.21 B [UI → /frontend-design] Wire the TopBar help button:
      `ui.helpOpen` + `toggleHelp()` in the store, `?` key and button share
      one path; accessible name, aria-pressed, hover/focus-visible/active
      states (D7).
- [x] 7.22 B [UI → /frontend-design] TopBar freshness stamp (A2): "as of
      HH:MM" from `generatedAt`, re-rendered on SSE refetch; live dot from
      the EventSource open state; static/export modes show the frozen
      stamp. After 7.21 (TopBar serialization).
- [x] 7.23 B Command palette: add `go:dashboard` as first "Go to" entry;
      remove the misleading `dashboard` keyword from `go:sessions` (D7). ∥
- [x] 7.24 B [UI → /frontend-design] Finding markers in the waterfall
      (severity notch + count chip per evidence row, `insightsBySpan`) and
      the Inspector Activity | Finding switch (`selection.focus`,
      `showInsight`, `focusInspector`); spec: visualizer "Finding markers
      and the Inspector detail switch". Added 2026-09-03.

## 8. Human-gated fixtures — Batch 2 (additive golden commits, one per capture)

Each: captured by a human, scrubbed via `scripts/scrub-fixture.ts`, SCRUBBED
marker, dedicated commit, additive-only — existing goldens untouched
(verified in each commit). Once add-persistent-index lands, each capture
automatically extends its fixture-parameterized equivalence matrix.

- [ ] 8.1 A OpenCode session using ≥1 real MCP server → fixture + golden;
      verify/correct the allowlist and separator against captured reality
      BEFORE the golden lands (E4). Depends on 2.2.
- [ ] 8.2 A Session exhibiting a mid-session cache-prefix break AND one
      with a ≥5-min idle gap → fixtures + goldens (B4). Depends on 4.7,
      4.8.
- [ ] 8.3 A Session with repeated reads of an unchanged file → fixture +
      golden (exercises 2.1 target capture end-to-end) (B7). Depends on
      4.11.

## 9. Verification & docs

- [x] 9.1 A+B One merged E2E suite: offline export (file://, network
      disabled) — what-if reprices, provenance + coverage caveats render,
      CSV byte-stable, shareable-filter round-trip, no diff view; live
      view — transcript load + `--redact` refusal, freshness stamp + live
      dot under `--watch`, limit toggle + three % slots, Time tab on a
      parallel-subagent run, By-tool filter round-trip; bundle greps (no
      pricing snapshot, no better-sqlite3, no node builtins in `dist/` and
      `dist-export/`); a11y pass on all new controls; bare-`runray` CLI
      e2e.
- [x] 9.2 A `docs/05-ARCHITECTURE.md`: CLI surface (watch semantics,
      `/api/pricing`, `/api/transcript`, `/api/viewconfig`, bare default),
      module map (pricing engine, transcript reader, insights meta),
      12-rule table (classes, formulas, config keys, deprecated alias).

## 11. TTL-aware cache-write pricing (post-audit addition, spec: cost-engine "TTL-aware cache-write pricing")

- [x] 11.1 A claude-code adapter: emit `tracepulse.cacheWrite1hTokens` from
      `usage.cache_creation` (clamped; cacheWrite = max(flat, 5m+1h));
      OTLP redact allowlist passthrough; opencode/OTLP asymmetry documented
      at the point of failure.
- [x] 11.2 A pricing engine: `cacheWrite1hPerMTok` (LiteLLM `above_1hr`,
      [1×, 4×] sanity band), claude-substring 2×-input derivation,
      NaN-safe/string-coercing attribute read, single blend definition
      shared by span cost, effective rate, and what-if reprice.
- [x] 11.3 A insight rules: cache waste formulas use the effective
      cache-write rate; idle-cache-expiry derives the live cache's TTL from
      the last writing span per scope/model stream.
- [x] 11.4 A UI: transcript lower-bound note in the Cost view hero (gated
      on transcript sources + pricing payload); snapshot regenerated with
      published 1h rates; goldens regenerated (X3 amendment).
- [x] 11.5 A claude-code adapter: sidecar subagent adoption — join via
      `toolUseResult.agentId` on ANY tool result (forked skills incl.
      `commandName` naming), then `agent-<id>.meta.json` (`toolUseId`,
      `parentAgentId`, fixpoint adoption for nested background agents);
      unlinked transcripts keep the counting warning (spec:
      trace-ingestion "Sidecar-linked subagent transcripts").
- [x] 11.6 A sidecar-adoption hardening (post-audit): visited/agentIds
      dedupe (no transcript ever adopted or emitted twice), placeholder
      claim (no phantom delegation beside an adopted span), transcript-
      derived outcome for adopted/forked spans (error + endedAt),
      isSidechain legacy gate scoped to the MAIN transcript, sidecars in
      candidate provenance, scrub allowlist keeps sidecar join keys,
      O(spans+agents) adoption index, parallel sidecar reads.
- [x] 11.7 A Severity graded by the engine, not the rules (spec: cost-engine
      "Severity grading"): `gradeSeverity` from estimatedWasteUSD as a share
      of run cost with per-tier floors (`insights.thresholds.severity`),
      `deadEndRun.criticalCostUSD` retired, rules no longer emit severity;
      UI insights strip and run tour rank findings by estimated waste
      (`rankInsights`). Goldens regenerated (severity values only) in a
      dedicated commit. Added 2026-09-03.
- [x] 11.8 A Suggestions and playbooks (spec: cost-engine "Suggestions address
      the person running the agent", visualizer "Finding playbook in the
      Inspector"): every rule's suggestion rewritten for the person running
      the agent, source-aware via `run.source.tool`, carrying the finding's
      numbers (goldens regenerated, text only, dedicated commit); `RULE_META`
      playbooks (causes · actions per source · limits) rendered into
      docs/08-FINDINGS.md by `pnpm docs:playbooks` with a drift test;
      Inspector "How to fix" section; dashboard groups describe the rule,
      not one finding. Added 2026-09-03.
- [x] 11.9 A Error text on failed tool spans (spec: trace-ingestion "Tool
      error text capture", cost-engine "Findings quote the failure"): the
      claude-code and opencode adapters keep the first 200 chars of a failed
      result as `content.outputPreview` (null under `--redact`); retry-loop,
      dead-end-run and scattered-tool-failures quote it; `PowerShell` joins
      the claude-code target map (command identity). Goldens regenerated in a
      dedicated commit. Added 2026-09-03.
- [x] 11.10 A Rule semantics after the suggestions audit (spec: cost-engine
      "Cache lifecycle insights" and "Context overhead insights" amended):
      context-bloat measures the full input-class context of the main
      session and prices each call's excess at what that call actually paid
      per token (it never fired on cached sessions before); cache-prefix-break
      classifies the break by what survived (front · history · compaction,
      `cachePrefixBreak.baseRetainedTokens` / `shrinkRatio`) and words the
      finding per shape; the 1h-TTL attribution of idle-cache-expiry was
      checked against real sessions (1h caches survive 5–60 min gaps in
      ~90% of pairs) and kept. Goldens regenerated in a dedicated commit.
      Added 2026-09-03.
