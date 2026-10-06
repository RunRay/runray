# Tasks: add-branch-attribution

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` byte-identical.

## 1. Core and CLI

- [x] 1.1 Branch capture: the OTLP adapter reads the run's branch from resource and span attributes (`vcs.ref.head.name`, the deprecated `vcs.repository.ref.name`, then `git.branch`; a `vcs.*` value typed `tag` is skipped). Both the OTLP and Claude Code adapters treat an empty branch as none. The OpenCode adapter documents why it leaves the branch unset. Tests: each attribute, precedence, the tag skip, span-level fallback, an empty value, and a run without any. `scrubIdentity` no longer invents a project name for a run that carries only a branch.
- [x] 1.2 `runray list --json` summaries carry `gitBranch` when the run has one. Test in the list summary suite. `docs/05-ARCHITECTURE.md` names the field.

## 2. Visualizer

- [x] 2.1 Branch filter [UI → /frontend-design]: `branch` joins `RunFilter` as a drill-down dimension (`branchKey`, `reconcileFilter`, `filterRuns`), rides the hash after `tool`, shows as a clearable chip, appears in the palette's "Clear all filters" check and in the export dialog's list of in-browser filters. One `isFilterActive` helper replaces the two copies of the "any filter active" check. The chip shows the branch in mono after a shared `BranchMark` glyph, and "none recorded" for the no-branch key. Tests: filtering, reconcile, `isFilterActive`, hash round trip and order, old links, the export note.
- [ ] 2.2 Top branches card [UI → /frontend-design]: `topBranches` in `packages/ui/src/lib/overview.ts` ranks project and branch pairs, with one shared row for runs without a branch. Resource Breakdown shows the card when any visible run has a branch, and a row sets the project and branch filters. Tests: ranking, the shared row, two projects with the same branch.
- [ ] 2.3 Branch on the session [UI → /frontend-design]: the run header shows the project and branch, and the sessions table shows the branch with the project. Tests: static render of both.
- [ ] 2.4 `patch` changeset for `runray`; `docs/02-DATA-MODEL.md` names the sources of `project.gitBranch`. Browser check in ink and paper on the demo.
