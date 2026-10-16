# Delta for cli

## ADDED Requirements

### Requirement: Branch in run summaries
Each `runray list --json` summary SHALL include `gitBranch` when the run records one and SHALL omit the key otherwise. The summary shape SHALL stay additive.

#### Scenario: Scripting by branch
- GIVEN a Claude Code run started on `feat/export`
- WHEN `runray list --json` runs
- THEN that run's summary has `"gitBranch": "feat/export"`, and a run without a branch has no `gitBranch` key
