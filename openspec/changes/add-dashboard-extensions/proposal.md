# Proposal: add-dashboard-extensions

## Why
The MVP overview answers "how much" but not "why", and it is read-only: rank
lists and charts are dead ends, the top bar has no filters (the §3 layout has
specced them since v1), and the data the new adapters produce (multi-source
runs, cache totals, error counts, insight rule ids) never reaches the screen.
Beta users will judge the product on the dashboard — it must let them *ask*
the next question, not just read the first answer.

## What Changes
Extends capability **visualizer** (UI only — no schema, core, or CLI changes):

- **Global filters** (project · source · period) in the top bar, applied
  client-side to the loaded runs across every view, plus a **command palette**
  (⌘K / Ctrl-K) for run search and view/theme/filter actions.
- **Overview drill-down**: day bars, project/model/source rank rows filter the
  sessions table; active filters render as clearable chips.
- **Overview KPI extensions**, all derived from already-loaded runs: aggregate
  cache hit-rate + tokens served from cache, tool-error rate, average/median
  session cost, spend trend vs the previous equal-length period (when a
  bounded period filter is active).
- **Waste grouped by rule**: the cross-run leaderboard groups findings by
  `ruleId` with per-rule totals, expandable to the individual findings.
- **Spend by source** ranking panel (claude-code · opencode · otlp).
- **Theme toggle**: ink (default) ↔ paper, persisted locally, honoring the
  paper palette shipped with stylebook v2; works in single-file exports.

## Impact
- Affected specs: visualizer (extended — one MODIFIED, four ADDED requirements).
- Affected code: `packages/ui` only (`lib/` aggregates + components + store).
- Depends on: `docs/03-design.md` v2 "Ink & Brass" (paper palette, micro-label
  and severity-pill conventions); add-local-trace-viewer (shipped).
- Out of scope (explicit): new insight rules; server-side filtering (CLI
  `--source`/`--since` stay the coarse pre-filter); cache savings in USD
  (needs pricing data the UI doesn't have — a schema/core question, frozen);
  paper as default theme; new runtime dependencies.
