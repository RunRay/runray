# Proposal: add-profiler-depth

## Why

The post-MVP audit (2026-07-19) found that the
shipped MVP has the right skeleton but fails its own "profiler, not counter"
positioning in five ways:

1. **The "why" engine is too shallow.** Five rules detect pathologies
   (retry streaks, terminal errors), not the structural drivers of a normally
   expensive week — model-tier misallocation and cache economics. A successful
   Opus-heavy, MCP-heavy session fires zero findings; the flagship demo shows
   "Wasted $0.05 of $410".
2. **Numbers cannot always be trusted.** Unpriced spans are silently excluded
   from every total; `dead-end-run` claims 100% of a run's cost as waste;
   `expensive-subagent` carries no dollar figure; insight dollars are priced
   from the bundled snapshot even after `pricing --refresh`.
3. **Analysis is ephemeral.** Every invocation re-parses all history; history
   dies with source-log rotation; zero-config `--watch` silently watches
   nothing (`program.ts:108`); the UI never says how fresh its data is.
4. **Drill-down dead-ends.** Every evidence path stops at a 200-char preview;
   subagent rows show no subtree economics; nested delegation is flattened;
   there is no time analysis despite complete timing data.
5. **The IA is inverted.** The default dashboard leads with the commoditized
   spend layer; the differentiator (quantified waste) is the last panel, with
   no aggregate "potential savings" anywhere.

This change implements audit improvement items 3–8 and 10–15, plus the
watch-fix and freshness half of item 2. The persistent-index half of item 2
ships as the companion change **add-persistent-index** — it deliberately
revises the MVP's "no database" non-goal, so that decision gets its own
separately reviewable change. Item 1 (npm publication) is release work, not
a spec change. Item 9 (`runray diff`) ships as the existing companion
change **add-run-diff**, which this effort completes with its missing
`tasks.md` and visualizer delta.

## What Changes

Extends capabilities **cost-engine**, **cli**, **visualizer**, and
**trace-ingestion**. The frozen `TraceFile` schema is untouched — everything
rides existing escape hatches (`span.attributes`, `span.provenance`,
`generatedAt`, CLI config, out-of-band transports).

- **cost-engine — the optimization engine grows up.** Rules evaluate against
  the *effective* pricing table via a `RuleContext` (fixes the
  bundled-snapshot bug). The rule set grows from 5 to 12: fixes to
  `dead-end-run` (failed-tail attribution, not 100% of run),
  `expensive-subagent` (quantified via repricing), `retry-loop` (windowed
  clustering, per-scope attribution), `low-cache-hit` (configurable target),
  `context-bloat` (cumulative pricing); new `model-mismatch`,
  `cache-prefix-break`, `idle-cache-expiry`, `fixed-context-overhead`,
  `duplicate-read`, `scattered-tool-failures`, `oversized-output`. A
  browser-safe **what-if repricing primitive** (per-node deltas, tier ladder,
  risk flags), an **unpriced-coverage** statistic, a single **rule metadata
  registry** (human label, explanation, waste/opportunity class), and a hard
  cap `wastedEstimate ≤ costUSD.total`.
- **cli — honest delivery and a working golden path.** The **zero-config
  `--watch` fix** (adapters expose `defaultRoots()`). New
  127.0.0.1-only endpoints: `/api/pricing` (effective table + provenance),
  `/api/transcript` (provenance-resolved raw-log slices, redaction enforced
  in core), `/api/viewconfig` (limit-window config). Bare `runray` defaults
  to `view`; `list --json` reports unpriced coverage.
- **visualizer — lead with the answer.** Dashboard inversion: a **potential
  savings panel** above the fold (honest burned-vs-opportunity split,
  top-3 changes, in-place evidence), humanized rule labels, coverage banners
  and pricing provenance wherever money renders, a freshness stamp. Inside a
  run: **subtree economics rollups** on waterfall container rows, a
  **hierarchical treemap** (cost/token modes), a **what-if repricing panel**,
  a **Time tab** (wall-clock decomposition, parallelism factor, p50/p95
  tools), and a **transcript pane** in the Inspector. Cross-run: a **By-tool
  / MCP ranking card** with an MCP-share callout and a new `tool` filter
  dimension. Plus: **limit-window display mode** (opt-in % framing for
  subscription users), **CSV export** of sessions and day aggregates,
  **shareable filter state in the URL hash**, and chrome fixes (help button,
  ⌘K Dashboard entry).
- **trace-ingestion — the data the rules need.** Adapters expose
  `defaultRoots()`; capture redaction-safe **tool target identity**
  (`runray.targetKey/targetKind/target`) into `span.attributes`; the
  OpenCode adapter classifies **MCP tools as `mcp_call`** via an
  allowlist + name heuristic, flagged `runray.mcpDetection`.

## Impact

- **Affected specs:** cost-engine (1 MODIFIED, 11 ADDED), cli (1 MODIFIED,
  4 ADDED), visualizer (5 MODIFIED, 11 ADDED), trace-ingestion (1 MODIFIED,
  4 ADDED).
- **Affected code:** `packages/core` (insights, pricing, adapters, new
  `transcript.ts`), `packages/cli` (program, server, export, config),
  `packages/ui` (dashboard, run views, router, store, new libs).
  `packages/schema` untouched; CI schema-diff stays clean.
- **Deliberate revisions of earlier decisions** (recorded in `design.md`):
  - add-dashboard-extensions D2 (filters out of the hash) is superseded —
    the audit is the "beta users ask" trigger D2 named.
  - add-dashboard-extensions D6 (no pricing in the UI) is resolved the other
    way: the CLI delivers the effective table; the UI never bundles a
    snapshot.
- **Dependencies:** no new external dependencies (better-sqlite3 is an
  existing core runtime dep; the UI gains only a workspace dep on
  `@runray/core` browser-safe subpaths, guarded by an import-purity test
  and a bundle grep).
- **Golden discipline:** exactly one regeneration commit (after the 12-rule
  registration order is frozen) plus additive per-capture commits for
  human-gated fixtures. Every other task asserts goldens byte-identical.
- **Companion changes:** **add-persistent-index** (durable local run index;
  carries the revision of add-local-trace-viewer's "no database" non-goal;
  lands after this change — it needs the final adapter parse output, the
  Batch-1 goldens, and the capture-once pricing wiring) and **add-run-diff**
  (tasks.md and visualizer delta added by this effort; it lands after this
  change's router work and rebases).
- **Out of scope (explicit):** npm publication (audit item 1 — release
  work); limit *prediction* / quota APIs / OAuth (SessionWatcher territory);
  OTLP export / team sync; budgets and alerts; project→client tagging
  (needs a schema conversation); statusline.

## Decisions requiring human sign-off before or during implementation

(Index-related sign-off items live in add-persistent-index.)

1. UI importing runtime code from `@runray/core` browser-safe subpaths —
   one decision covering `./pricing`, `./insights-meta`, later `./diff`.
2. `runray.targetKey` is an unsalted hash of file paths under `--redact`
   (strictly less revealing than the already-unredacted `provenance.file`,
   but a conscious call).
3. Transcript endpoint default-on in live unredacted `view` (recommendation:
   default-on, hard-off under `--redact`).
4. OpenCode MCP name-heuristic: ship now vs wait for upstream metadata; the
   captured fixture is ground truth for the separator.
5. Bare `runray` defaulting to `view` changes typo semantics
   (`runray viwe` → view of a `viwe` directory → exit 3 with hints).
6. Human-gated fixture captures (cache-break, idle-gap, duplicate-read,
   OpenCode-MCP) need owners; rules ship on synthetic unit tests until then.
