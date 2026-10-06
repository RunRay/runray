# Tasks: add-branch-attribution

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` byte-identical.

## 1. Core and CLI

- [x] 1.1 Branch capture: the OTLP adapter reads the run's branch from resource and span attributes (`vcs.ref.head.name`, the deprecated `vcs.repository.ref.name`, then `git.branch`; a `vcs.*` value typed `tag` is skipped). Both the OTLP and Claude Code adapters treat an empty branch as none. The OpenCode adapter documents why it leaves the branch unset. Tests: each attribute, precedence, the tag skip, span-level fallback, an empty value, and a run without any. `scrubIdentity` no longer invents a project name for a run that carries only a branch.
- [x] 1.2 `runray list --json` summaries carry `gitBranch` when the run has one. Test in the list summary suite. `docs/05-ARCHITECTURE.md` names the field.

## 2. Visualizer

- [x] 2.1 Branch filter [UI → /frontend-design]: `branch` joins `RunFilter` as a drill-down dimension (`branchKey`, `reconcileFilter`, `filterRuns`), rides the hash after `tool`, shows as a clearable chip, appears in the palette's "Clear all filters" check and in the export dialog's list of in-browser filters. One `isFilterActive` helper replaces the two copies of the "any filter active" check. The chip shows the branch in mono after a shared `BranchMark` glyph, and "none recorded" for the no-branch key. Tests: filtering, reconcile, `isFilterActive`, hash round trip and order, old links, the export note.
- [x] 2.2 Top branches card [UI → /frontend-design]: `topBranches` in `packages/ui/src/lib/overview.ts` ranks project and branch pairs, with one shared row for runs without a branch. Resource Breakdown shows the card when any visible run has a branch, or while a branch filter is on so the chosen row stays lit, and a row sets the project and branch filters. With the card, the breakdown becomes a 2×2 grid with branches beside projects. A row shows the branch in mono after the branch mark and its project faint beside it; the project only takes the room the branch leaves, and drops out while a project filter is on. Tests: ranking, the shared row, two projects with the same branch, the card gate, and a static render of the card (`overview-branches.test.tsx`).
- [x] 2.3 Branch on the session [UI → /frontend-design]: the run header's meta line shows the project (left out when it is already the heading) and the branch, and the sessions table shows the branch after the project, which takes the room first; the project column gains the 48px the title column gives up, so the table is no wider. The sessions CSV appends a `gitBranch` column, after the existing ones so their positions hold. Tests: static render of both (`session-branch.test.tsx`), the CSV column.
- [ ] 2.4 `patch` changeset for `runray`; `docs/02-DATA-MODEL.md` names the sources of `project.gitBranch`. Browser check in ink and paper on the demo.
