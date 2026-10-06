# Proposal: add-branch-attribution

## Why

"What did this feature branch cost?" is a question RunRay can almost answer already, but doesn't show.

- **Claude Code records the branch.** Every transcript record carries `gitBranch`, and the adapter keeps the first one in `run.project.gitBranch` (`packages/core/src/adapters/claude-code.ts`). The schema has had the field since v0.1, and `--scrub-paths` pseudonymizes it.
- **Nothing reads it.** `runray list --json` leaves it out, the run header doesn't show it, and the dashboard can rank spend by project, model, source and tool, but not by branch.
- **OTLP drops it.** An emitter can describe the checkout in OpenTelemetry's `vcs.*` resource attributes, but the OTLP adapter never reads resource attributes.

## What Changes

- **Ingestion.**
  - The OTLP adapter takes the run's branch from the first span, in document order, whose resource or span attributes name one. It reads `vcs.ref.head.name`, then the deprecated `vcs.repository.ref.name`, then `git.branch`. It skips a `vcs.*` value whose matching `….type` attribute says `tag`.
  - An empty branch value counts as no branch, in both the OTLP and Claude Code adapters.
  - **OpenCode stays without a branch.** Its session and project records name the directory but no branch. Reading `.git/HEAD` at scan time would report the branch checked out today, not the one the session ran on, and would make parse output depend on the state of a repository outside the trace. The adapter keeps leaving the field unset.
- **CLI.** Each `runray list --json` summary gains `gitBranch` when the run has one. The shape stays additive. The human table is unchanged.
- **Dashboard.**
  - A **Top branches** card joins Resource Breakdown when any visible run has a branch. It ranks project and branch pairs by cost or tokens, so `main` in two repositories stays two rows. Runs without a branch share one "no branch" row.
  - Activating a row filters to that project and branch. `branch` is a new drill-down filter: a clearable chip, the last parameter of the canonical hash order, and an in-browser filter that `runray export` can't reproduce (the export dialog says so).
- **Session.** The run header shows the project and branch next to the date and source, and the sessions table shows the branch under the project name.

## Non-goals

- **Per-call branches.** A session that switches branches is attributed to the branch it started on, the same first-seen rule the adapter already uses. Following switches would need a branch on each span, which the frozen schema doesn't carry.
- **`stats --by branch`.** Branch aggregation in the terminal belongs with the planned `stats` command.

## Impact

- Affected specs: trace-ingestion (ADDED "Git branch capture"), cli (ADDED "Branch in run summaries"), visualizer (MODIFIED "Global run filters", ADDED "Cost by branch").
- Affected code:
  - `packages/core/src/adapters/otlp.ts`, `packages/core/src/adapters/claude-code.ts`, `packages/core/src/adapters/opencode.ts` (comment only)
  - `packages/cli/src/list.ts`
  - `packages/ui/src/lib/filter-runs.ts`, `packages/ui/src/lib/router.ts`, `packages/ui/src/lib/overview.ts`, `packages/ui/src/lib/export-command.ts`
  - `packages/ui/src/components/Overview.tsx`, `FilterBar.tsx`, `CommandPalette.tsx`, `RunView.tsx`, `SessionsTable.tsx`
  - their tests
- No schema change, no new dependency. Goldens are unchanged: no OTLP fixture carries `vcs.*` attributes, and no Claude Code fixture has an empty branch.
