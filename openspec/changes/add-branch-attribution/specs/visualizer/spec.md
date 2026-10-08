# Delta for visualizer

## MODIFIED Requirements

### Requirement: Global run filters
The system SHALL provide project, source, period, model, day, tool, and branch
filters that narrow the visible runs client-side across every view; active
filters SHALL be visible and individually clearable; a period filter SHALL
anchor to the newest loaded run. The active filter state SHALL be encoded in
the URL hash in the canonical parameter order
`project, source, period, model, day, tool, branch` so a copied link restores
the same filtered view, in the live viewer and in exported files; filter-only
changes SHALL NOT create history entries; hashes without filter parameters
SHALL parse exactly as before.

#### Scenario: Filtered view is shareable
- GIVEN a project and 7-day period filter are active
- WHEN the user copies the URL and opens it in a new tab
- THEN the same filters are active and the same runs are visible

#### Scenario: Old links keep working
- GIVEN a bookmark to `#/run/<id>/timeline` created before this change
- WHEN it is opened
- THEN the run's timeline opens with no filters applied

#### Scenario: Filters survive navigation
- GIVEN a source filter is active on the dashboard
- WHEN the user opens a run and returns to the dashboard
- THEN the source filter is still active and present in the URL

## ADDED Requirements

### Requirement: Cost by branch
The system SHALL show the git branch a run started on wherever the run is identified, and SHALL rank spend by branch when the visible runs record any.

- **Run.** The run header SHALL show the run's project and branch, the sessions table SHALL show the branch with the project, and the sessions CSV SHALL carry the branch as its last column, so the existing columns keep their positions.
- **Ranking.** Resource Breakdown SHALL include a branch ranking, by cost or tokens with the shared metric switch, when at least one visible run has a branch or a branch filter is active. Entries SHALL be project and branch pairs, so one branch name in two projects ranks twice. Runs without a branch SHALL share one entry.
- **Drill-down.** Activating an entry SHALL filter the visible runs to that project and branch, announced as clearable chips. The shared entry SHALL filter to runs without a branch.

#### Scenario: Same branch name in two projects
- GIVEN runs on `main` in projects `api` and `web`
- WHEN the dashboard renders
- THEN the branch ranking lists `main` twice, once per project, each with its own cost

#### Scenario: Branch row filters runs
- GIVEN the branch ranking lists `feat/export` in project `api`
- WHEN the user activates that row
- THEN the sessions table shows only `api` runs on `feat/export`, and chips name the project and the branch

#### Scenario: No branches, no ranking
- GIVEN visible runs that all come from OpenCode
- WHEN the dashboard renders
- THEN Resource Breakdown shows no branch ranking
