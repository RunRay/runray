# Design: add-profiler-depth

Decisions that shape the implementation; the spec deltas state the *what*,
this records the *why*, the rejected alternatives, and the cross-area
resolutions made at integration. Decision ids carry their area prefix
(A = watch/freshness, B = insight rules, C = pricing/repricing,
D = UI/IA/drill-down, E = new views/modes, X = cross-area integration).

## Watch and freshness (A)

The persistent run index originally designed alongside these decisions was
split out into the companion change **add-persistent-index** — it revises
add-local-trace-viewer's "no database" non-goal, and that revision deserves
its own separately reviewable change. Everything below stands on its own
without the index.

### A1 — Watch fix: adapters own their default roots

`SourceAdapter.defaultRoots()` extracts the literals `detect()` already uses
(claude-code, opencode; otlp returns `[]` — import-only). Zero-config watch
targets = union of `defaultRoots()` (honoring `--source`), filtered to
existing directories. A change event still just clears the memoized
TraceFile; the next rebuild re-parses from disk as today. Incremental
re-parse (only dirty candidates) ships with add-persistent-index, which
hooks this same invalidation path.

### A2 — Freshness rides on `generatedAt`; no new endpoint

The frozen schema already requires `generatedAt`; the UI already refetches on
SSE `changed`. The TopBar stamp ("as of HH:MM" + live dot when the event
stream is open) is pure visualizer work. Exports show their frozen snapshot
time — consistent with the "relative to generatedAt, never wall-clock"
convention.

## Insight engine (B)

### B1 — One rule-metadata registry classifies and labels every rule

`packages/core/src/insights/meta.ts`: `RULE_META[ruleId] = { label, explain,
class: 'waste' | 'opportunity' }`, exported browser-safe as
`@runray/core/insights-meta`. The hardcoded `WASTE_CLASS` set is deleted;
`applyInsights` derives rollup membership from `meta.class`; the UI renders
labels/explanations from the same registry (unknown ids fall back to the
literal slug, class opportunity — the open-set guarantee from
add-dashboard-extensions D4 holds). A core unit test enforces: every
registered rule has a meta entry. Integration resolution: this registry
replaces the earlier per-rule `wasteClass` field idea — one classification
source for engine and UI, and rule objects are not browser-safe.

### B2 — Engine cap: `wastedEstimate = min(round6(Σ waste-class), costUSD.total)`

Waste-class rules overlap only partially deduped (dead-end-run subtracts
retry clusters; prefix-break yields to idle-expiry; scattered excludes retry
clusters); the cap guarantees the flagship number can never exceed the run's
spend regardless of residual overlap. Perfect span-level accounting is
deliberately deferred.

### B3 — dead-end-run attributes waste to the failed tail

Productive marker = last successful `tool_call`/`mcp_call` carrying
code-change counts (the schema's only outcome signal — the same one
`deriveTotals` uses). Waste = llm cost after the marker, minus cost already
claimed by retry clusters in the tail (shared pure helper). No marker
anywhere → the run produced nothing → 100% stays correct. Known limit:
successful read-only sessions that end on an error still hit the 100%
branch — accepted for v0.1, revisit on beta feedback.

### B4 — Cache lifecycle rules price the re-write premium

`cache-prefix-break`: consecutive same-model llm pairs where cacheRead
collapses and cacheWrite spikes; waste = `min(b.cacheWrite, a.cacheRead) ×
(writeRate − readRate)`. `idle-cache-expiry`: same spike after an idle gap ≥
TTL (default 5 min, Anthropic-specific, configurable); when both predicates
match, idle-expiry claims the pair (cause-specific attribution,
order-independent). `low-cache-hit` keeps its aggregate role; its savings
target becomes `lowCacheHit.targetHitRate` (default 0.6, clamped ≥ the firing
threshold).

### B5 — Context rules: growth and fixed overhead are two different diseases

`context-bloat` keeps its growth predicate but prices the **cumulative**
excess over the baseline median (the old `(last−first)×3` understated by
~`llmCalls/3`×). New `fixed-context-overhead` catches the born-bloated
session (first-call footprint ≥ floor), priced honestly as one cache write
plus a cache read per subsequent call — the pattern growth detection is
structurally blind to (a high baseline *suppresses* the growth rule).

### B6 — retry-loop: windowed clustering, per-scope attribution

Failure identity = `(name, runray.targetKey ?? '')`; clusters tolerate ≤
`maxGapToolCalls` same-scope interleaved calls; clusters never span scopes
(nearest subagent/session ancestor). Wasted llm calls = parents of cluster
members ∪ same-scope llm calls in the failure window — parallel sibling
subtrees are no longer billed for a loop they didn't run. Old threshold key
`minConsecutiveFailures` survives as a deprecated alias.

### B7 — Tool-usage rules and their price basis

`duplicate-read`: same `targetKey` re-read with no intervening write to that
key; priced as `outputBytes/4` tokens at the dominant model's input rate
(documented heuristic, "≈" in copy). `scattered-tool-failures`: failures not
claimed by any retry cluster, ≥ share threshold; priced as the distinct
reaction llm calls. `oversized-output`: top offenders by `outputBytes`;
opportunity-class — output utility is unknowable, so it never touches the
waste rollup.

### B8 — Registration order is pinned; ids stay stable

`V0_RULES` order: the v0 five (unchanged) → `model-mismatch` →
`cache-prefix-break`, `idle-cache-expiry`, `fixed-context-overhead`,
`duplicate-read`, `scattered-tool-failures`, `oversized-output`. Twelve
rules. Insight ids derive from evaluation order, so this list is frozen here
and regenerating goldens happens exactly once after it is final. New rule ids
ship under schemaVersion 0.1.0 — `Insight.ruleId` is an open string set by
construction; no schema bump (decided, not to be relitigated).

## Pricing trust and repricing (C)

### C1 — Repricing math lives once, browser-safe, in core

`packages/core/src/pricing/engine.ts` (pure: match/compute/reprice/tiers/
risk; type-only imports) re-exported via subpath `@runray/core/pricing`.
Insight dollars and the interactive what-if panel must be byte-identical or
the trust story collapses. Rejected: duplicating the math in `ui/lib` (drift
between "insight says −$31" and "panel says −$29"); a server repricing
endpoint (breaks offline `file://` exports).

### C2 — The UI never bundles a pricing snapshot; the CLI delivers the effective table

`GET /api/pricing` returns `{ origin, path?, table }`; exports embed
`window.__RUNRAY_PRICING__` beside the trace data (same sanitization, via
one shared `injectGlobal` helper); `demo` serves the bundled table. The
program captures `effectivePricing()` **once per trace build** — re-captured
exactly when the watch cache invalidates — so panel dollars and insight
dollars can never disagree within one page load. A page with no pricing
payload hides the what-if panel behind a notice; the UI never falls back to
a snapshot of its own. Provenance ("prices: LiteLLM snapshot <date>
(bundled|refreshed)") renders wherever repriced money is shown. This
resolves add-dashboard-extensions D6 at the layer that owns pricing.

### C3 — Rules evaluate against a RuleContext

`evaluate(run, ctx: { thresholds, pricing })`;
`applyInsights(run, overrides, rules, pricing = bundledPricing())` — fixes
the verified bug where insight waste was priced from the bundled snapshot
even after `pricing --refresh`. Default stays the bundled table, so this
wiring alone is golden-neutral. Pre-1.0 breaking change to the exported rule
type, accepted; all twelve rules are written against the final signature
(the context lands before any rule work).

### C4 — Cheaper-tier mapping is a hardcoded, versioned ladder

`MODEL_TIERS` per family, expensive→cheap, resolved against the *effective*
table with a zero-rate guard; unresolvable → no suggestion, never a bad one.
The snapshot build script warns when a ladder target vanishes. Rejected:
config-driven ladder (sprawl; the panel's free target picker covers custom
wishes), price-sorted "cheapest in family" (would suggest opus→haiku),
name-sorting (breaks at `sonnet-10` vs `sonnet-5`).

### C5 — Risk annotation makes what-if honest

Repricing units are innermost subagent subtrees + main session — computed
**once, in core** (the same cells the treemap and the rules consume;
integration resolution: core owns innermost-owner attribution, the UI builds
display nesting on top and a test asserts Σ own values = Σ cells). Flags:
`errors`, `tool-fanout`, `long-context`, `unpriced`; `safeDeltaUSD` sums
flag-free subtrees only. Thresholds live in the existing `Thresholds`
registry. Copy always says "estimated at <target> rates" — token counts are
assumed model-invariant, never claimed exact.

### C6 — model-mismatch quantifies the flagship gap without double counting

Per model with a resolvable downgrade: fire when the risk-free repricing
saving ≥ `minSavingsUSD`. Opportunity-class — never inflates
`wastedEstimate`. Integration resolution: spans inside subtrees that qualify
for `expensive-subagent` are **excluded** (shared pure predicate), so the
savings panel cannot claim the same dollars twice; the finding's detail
counts the excluded subtrees.

### C7 — Unpriced coverage is derived, never persisted

`unpricedCoverage(run)` (calls, tokens, sorted offending models, `complete`)
computed in core, mirrored in `ui/lib/coverage.ts` (the `cacheAggregate`
mirroring pattern). Surfaced as: one stderr warning per build, `list --json`
fields, a run-level banner, a dashboard banner, and a caveat marker on every
waste/savings figure derived from incomplete runs. The frozen `RunTotals`
cannot carry it — recomputed everywhere instead, by design.

## UI information architecture and drill-down (D)

### D1 — The dashboard leads with the answer

Order: potential-savings panel → spend statement + burn line (demoted) →
KPIs → spend by day → rankings (incl. the new By-tool card) → waste board.
The headline is split honestly: "already burned" = Σ
`totals.costUSD.wastedEstimate` (waste-class, capped); "if you change setup"
= Σ opportunity-class `estimatedWasteUSD` via `RULE_META` — integration
resolution: class-summed, **not** "total minus wastedEstimate" (the remainder
arithmetic silently reclassifies capped-off waste as opportunity the moment
the B2 cap binds). Never one undifferentiated "save $X". Coverage caveat
chip consumes C7's aggregate from day one (no fallback code). Empty state
says "N rules found nothing to save in this period" — the panel never hides.

### D2 — Evidence expands in place; the timeline deep link is secondary

Dashboard findings expand inline to their worst ≤3 evidence spans (name,
kind chip, cost, existing ≤200-char preview; null renders "redacted").
"Open in timeline" stays as the secondary action reusing `stageInsight`. No
teleport-by-default — the audit's "context switch to raw internals"
complaint.

### D3 — Subtree rollups are UI-derived; the treemap goes hierarchical on core cells

`subtreeRollups(spans)` — one O(n) reverse pass in `ui/lib/waterfall.ts`
(normalizer order guarantees parents precede children); cost excludes
unpriced spans with the excluded count carried for honest badges
("Σ $4.12 · +2 unpriced"), always visible on container rows, collapsed or
not. Why not core: `RunTotals` is frozen and per-span rollups are derived
data. The treemap replaces innermost-only flattening with nesting by nearest
subagent ancestor; each node's `own` value **is** the core attribution cell
(C5) — display nesting is a UI transform, and a unit test pins Σ own = Σ
cells so the treemap and the what-if panel can never disagree. Cost and
token modes; recursive squarify with a size floor ("+n nested").

### D4 — Transcript drill-down: ids in, redaction enforced in core

`GET /api/transcript?run=<id>&span=<id>` — the client sends only ids; the
server resolves `span.provenance` from its own trusted TraceFile (no path
traversal surface). `readTranscriptSlice(provenance, sourceTool, {redact})`
lives in core and, under redact, returns `{status:'redacted'}` **before
opening any file** — the endpoint cannot leak even if the handler is buggy.
Readers: claude-code JSONL line, OpenCode JSON/sqlite (readonly,
fileMustExist, SQLITE_BUSY → unavailable), OTLP → unsupported. Missing files
(a source log deleted between parse and request) → structured
`unavailable` — tested explicitly; this same handling is what keeps
add-persistent-index's rotated history safe later. 1 MB cap + `truncated`. Exports/file:// degrade to a notice
(keyed off the existing `live` flag); the Inspector loads lazily
(button, virtualized, per-`run:span` cache).

### D5 — CSV is a client-side blob with canonical bytes

Sessions CSV + day-aggregates CSV as pure functions over the visible runs:
fixed column order, rows sorted (startedAt, id) regardless of screen sort,
`String(n)` numbers, RFC 4180, CRLF, UTF-8 BOM — the same filtered data
always produces byte-identical files, offline included. Redacted traces
have no title/preview content to leak by construction.

### D6 — Filter state moves into the URL hash (supersedes add-dashboard-extensions D2)

D2 said "revisit if beta users ask" — the audit is that ask. Query-style
suffix on existing routes, canonical param order
`project, source, period, model, day, tool` (integration resolution: the
`tool` dimension from the By-tool card is part of the matrix from day one).
Old hashes parse unchanged. Store→hash via `history.replaceState` with a
loop guard (no history spam); hash→store on load/hashchange, then
`reconcileFilter`. One `navigateTo(route)` helper adopted at **every** hash
call site, or shared links silently drop filters. Export determinism holds
because period anchoring is already newest-run-based, not wall-clock.

### D7 — Chrome: help via the store, ⌘K Dashboard, bare `runray` = `view`

`helpOpen` moves to the store so the `?` key and the TopBar button share one
path (plus accessible name and interaction states). Palette gains
`go:dashboard` first in "Go to". `view` becomes commander's default
subcommand; the typo tradeoff (`runray viwe` → view of `./viwe` → exit 3
with hints) is flagged for sign-off.

## New views and modes (E)

### E1 — Limit mode is an opt-in display layer, not a quota tracker

Config `limitWindow { days, resetDay, resetHour, budgetUSD?, budgetTokens? }`
in `runray.config.json`, served via `/api/viewconfig`, embedded in exports;
UI toggle off by default, persisted like the theme. Window bounds anchor to
the **newest run**, never `Date.now()` — exports render identical forever.
Denominator: budget when configured, else spend-to-date (and the statement
slot then phrases "$X spent in this window", never total-as-%-of-itself).
Exactly three % slots (statement line, Wasted KPI suffix, run Cost hero) so
the framing never doubles every number's weight; every % carries "est.".
Explicitly out of scope: prediction, OAuth/quota APIs, any network.

### E2 — Time view is an interval sweep; parallel work can never double-count

Sweep the merged span boundaries; classify each elementary interval:
any-llm-active → model wait (wins over tool), else any-tool-active → tool
exec, else gap (≥ threshold → idle, else coordination). Segments sum exactly
to wall-clock; parallel compression is a separate "×N parallel" chip, never
bar inflation. Nearest-rank p50/p95 per tool, per run and cross-run. Rendered
as a third sibling tab (`Cost | Timeline | Time`, route `#/run/:id/time`) —
burying time in Cost would repeat the below-the-fold mistake.

### E3 — Two idle thresholds, deliberately distinct (integration resolution)

The Time view's `DEFAULT_IDLE_GAP_MS = 60_000` is a display segmentation
default; `idleCacheExpiry.minIdleMinutes = 5` is a provider cache-TTL
economics constant. Forcing either value on the other mislabels coordination
gaps or fires expiry where nothing expired. The Time view's hint copy states
the insight uses its own threshold; a cross-referencing comment names both
constants.

### E4 — OpenCode MCP classification is a flagged heuristic

The OpenCode on-disk formats carry no MCP marker (verified across all three
eras). Allowlist of built-in tools + underscore-prefix heuristic →
`mcp_call` + `tool.mcpServer` + `attributes['runray.mcpDetection'] =
'name-heuristic'` (honest uncertainty, Inspector-visible). Built-in
underscore names (`apply_patch`) never classify as MCP. Existing goldens
contain no MCP-shaped names and must stay byte-identical; the captured
fixture (human-gated) is ground truth for the separator and may force a
heuristic correction before its golden lands.

### E5 — Tool attribution stays in `cost-breakdown.ts`; the dashboard merges

`toolSpendLeaderboard`'s per-run attribution (equal split among a turn's
unique tools, orchestration remainder) is the single source; `ToolCost`
gains `mcpServer?` and an orchestration marker; `topTools(runs)` merges
cross-run and attaches p95. The By-tool card labels figures "attributed"
(the split is a heuristic and says so), shows the MCP-share callout, and
filters via the new `tool` dimension. Placement: rankings band, below the
savings panel — D1's layout owns final ordering.

## Cross-area integration (X)

### X1 — One browser-safe subpath family, one decision

Core gains `./pricing` and `./insights-meta` (later `./diff` in
add-run-diff); the UI adds `@runray/core: workspace:*` once. ONE
import-graph purity test covers every browser-safe entrypoint; ONE bundle
grep (no better-sqlite3, no bundled snapshot, no node builtins) in E2E. This
is the single human sign-off item for the track-boundary question, not
three.

### X2 — Reserved attribute keys carry the `runray.` prefix

`runray.targetKey`, `runray.targetKind`, `runray.target`,
`runray.mcpDetection`, `tracepulse.cacheWrite1hTokens` (1h-TTL share of
an llm_call's cache write; token count, redact-safe) — collision-proof
against OTLP passthrough attributes, which can carry arbitrary foreign keys.

### X3 — Golden regeneration happens exactly twice, batched

> Amendment (2026-08-18): a third deliberate regeneration accompanies the
> TTL-aware cache-write pricing task (§11) — it is non-additive by nature
> (every claude-code llm span gains `tracepulse.cacheWrite1hTokens` and its
> `costUSD`/waste figures move to the 1h rates) and lands as its own
> dedicated goldens commit with this justification.

Batch 1 (one dedicated commit): after the 12-rule registration order and the
attribute capture are final — covers tool-span `attributes`, all
new/changed findings and ids, `wastedEstimate` + cap, demo data; the commit
verifies span structure/token totals/ordering byte-stable and
`wastedEstimate ≤ total` everywhere. Batch 2: additive-only commits per
human-gated fixture capture. The A and D areas are contractually
zero-golden (A touches no parse output; D is UI-derived); nothing else may
regen. Demo test
expectations update adjacent to Batch 1 to whatever the regenerated data
actually shows (model-mismatch is expected to fire on the demo's
expensive-tier runs — the "Wasted $0.05" first impression becomes a real
savings figure).

### X4 — Server/program/export contention is serialized

One `injectGlobal(name, payload)` helper in `export.ts` for
`__RUNRAY_PRICING__` and `__RUNRAY_VIEW_CONFIG__`; `startServer` options
grow in one fixed order (watch fix → pricing capture/endpoint → transcript →
viewconfig); TopBar edits serialize (help wiring → freshness stamp → limit
toggle). Under `--watch`, the rebuild that clears the memoized TraceFile is
the same place pricing is re-captured — a single invalidation path that
add-persistent-index later hooks (parse artifacts cached there, pricing
still recomputed every build, which is what keeps C2 capture-once coherent).

### X5 — Companion-change coordination

**add-persistent-index** carries the durable run index and the revision of
add-local-trace-viewer's "no database" non-goal. It lands after this change:
its fixture-parameterized equivalence test needs the final adapter parse
output and the Batch-1 goldens, its integration point is the same
program-rebuild path as C2's capture-once pricing, and its rotated-history
feature relies on D4's structured `unavailable` transcript handling.

**add-run-diff** ships as its own change (tasks.md + missing visualizer
delta supplied by this effort). It lands after add-profiler-depth's router
work and rebases its `#/diff/:a/:b` route onto the final parse/format
matrix (which by then includes filter params and the time route); its
`@runray/core/diff` subpath rides X1. Note: the diff stylebook section is
§4.6 of the archived `docs/03-design.md` (deleted at dc5873a) — the
add-run-diff proposal's "§4.5" is stale; restoring/relocating a live design
reference is flagged in its tasks.

### X6 — Known-duplicate run ids stay untouched

Nothing here derives uniqueness from run ids: the UI keeps its
`dedupeRunIds` load boundary (and the companion index keys on
`(adapterId, runRef, redactMode)`, not run id). The intentional
duplicate-id behavior in `demo` is unaffected.
