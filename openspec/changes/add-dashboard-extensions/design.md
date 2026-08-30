# Design: add-dashboard-extensions

Decisions that shape the implementation; the spec deltas state the *what*,
this records the *why* and the rejected alternatives.

## D1 — Filtering is client-side, over the loaded runs

The trace file is already fully loaded (embedded in exports, one fetch in
`view`). Filters are pure functions over `Run[]` — no server round-trip, and
identical behavior in `runray view`, `demo`, and exported single files.
CLI `--source`/`--since` remain the coarse *pre*-filter that limits what gets
parsed at all; the top bar refines what is *shown*. The period filter's
"last 7/30 days" anchors to the newest run's start day, not wall-clock now —
exported files must render the same slice forever (determinism over freshness).

## D2 — Filter state lives in the store, not the hash

The hash stays what it is today: run + view routing. Filters reset on reload.
Rationale: a filter-in-hash scheme would leak into export links and the
router's parse/format matrix for marginal benefit; revisit only if beta users
ask for shareable filtered views. The command palette and dropdowns are two
front-ends to the same store slice.

## D3 — Trend needs a bounded window

"↑ 23% vs previous 30 days" is only meaningful when a period filter is
active: the comparison window is the equal-length period immediately before
the visible one, from the same loaded runs. Under "all time" there is no
previous period, so no chip renders — never fabricate a baseline. Fewer than
2 runs in the previous window also suppresses the chip (a delta against
near-nothing reads as noise).

## D4 — Waste groups by `ruleId`, verbatim

Grouping is presentation over existing insights: key = `ruleId` as emitted by
core (the v0 registry names are already imperative slugs). Unknown/future
rule ids group under their own literal id — the UI never maintains a rule
registry of its own. Group order: total estimated waste, descending;
individual findings inside keep the existing worst-first order.

## D5 — Theme toggles `data-theme` on the root element

Stylebook v2 already ships the complete paper palette behind
`:root[data-theme="light"]`. The toggle stamps/removes that attribute and
persists the choice in `localStorage` (`runray.theme`); absent a stored
choice the app stays ink — we do not follow `prefers-color-scheme` in v1
(the audience default is dark; paper is an opt-in, and following the OS would
flash-bang terminal users at noon). The export template inlines the same
mechanism so a mailed report honors its reader's stored preference.

## D6 — Cache savings stay token-denominated

The overview cache KPI shows hit-rate and `cacheRead` tokens ("served from
cache"). A USD savings figure needs per-model price deltas the UI does not
have (pricing lives in the CLI; the schema is frozen and carries no rate
data). Shipping the pricing table to the UI is a real option but a
core/schema decision — explicitly out of scope here.

## D7 — Command palette is internal, not a dependency

Scope: fuzzy run search (title/project/source), view switching, theme toggle,
filter application/clearing. A dependency like `cmdk` would need
justification per AGENTS.md and brings more surface than this needs; a ~150
line internal component over the existing store suffices. Keyboard: ⌘K /
Ctrl-K opens, `Esc` closes, arrows + Enter select — same focus-trap pattern
as the help sheet.

## D8 — Overview stays derivable

Every new number (cache aggregate, error rate, avg/median cost, per-source
totals, trend) is a pure function in `packages/ui/src/lib/overview.ts` over
`Run[]`, unit-tested like the existing aggregates. No new fields, no new
requests, no memoized cross-view state beyond the store's filter slice.
