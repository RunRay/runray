# Delta for visualizer

## MODIFIED Requirements

### Requirement: Sessions overview aggregates
The system SHALL open on an overview that aggregates the visible (filtered)
runs — total cost, tokens, wasted estimate with its share of spend, session
count, code changes, cumulative burn line, spend per day with per-day waste
share, aggregate cache hit-rate and tokens served from cache, tool-error
rate, average and median session cost, top projects, models, and sources by
cost, and a cross-run waste leaderboard grouped by rule — so where the money
went is visible without opening any run; activating a leaderboard finding
SHALL open that run's timeline with the finding's evidence highlighted; and
when a bounded period filter is active the system SHALL show the spend trend
versus the previous equal-length period, suppressing the trend when no
meaningful baseline exists.

#### Scenario: Aggregates without opening a run
- GIVEN a trace file with multiple runs
- WHEN the sessions view renders
- THEN total cost, wasted estimate, cache hit-rate, error rate, and per-day
  spend across all runs are visible above the sessions table

#### Scenario: Cross-run waste navigation
- GIVEN runs from different days each carrying insights
- WHEN the user activates a finding on the waste leaderboard
- THEN that run's timeline opens with the finding's evidence spans highlighted

#### Scenario: Waste grouped by rule
- GIVEN three retry-loop findings and one low-cache-hit finding across runs
- WHEN the waste leaderboard renders
- THEN it shows a retry-loop group with count 3 and the summed estimate,
  expandable to the three findings, ordered by group total descending

#### Scenario: Trend against the previous period
- GIVEN a 7-day period filter and runs in both the visible and preceding 7 days
- WHEN the overview renders
- THEN the total-spend statement carries the percentage delta versus the
  preceding 7 days

#### Scenario: No fabricated baseline
- GIVEN the period filter is "all time"
- WHEN the overview renders
- THEN no trend delta is shown

## ADDED Requirements

### Requirement: Global run filters
The system SHALL provide project, source, and period filters that narrow the
visible runs client-side across the overview, sessions table, and sessions
rail, without re-fetching or re-parsing; active filters SHALL be visible and
individually clearable; and a period filter SHALL anchor to the newest loaded
run so an exported file renders the same slice on every open.

#### Scenario: Filter narrows every view
- GIVEN runs from two projects
- WHEN the user filters to one project
- THEN the overview aggregates, sessions table, and sessions rail all reflect
  only that project's runs

#### Scenario: Filters work offline
- GIVEN an exported report.html opened from file:// with networking disabled
- WHEN the user applies a source filter
- THEN the visible runs narrow identically to the live viewer

### Requirement: Overview drill-down
The system SHALL make overview aggregates interactive: activating a day bar,
project, model, or source entry applies the corresponding filter to the
sessions table, and the applied filter is announced as an active, clearable
chip.

#### Scenario: Rank row filters the table
- GIVEN the overview shows a project ranking
- WHEN the user activates a project entry
- THEN the sessions table shows only that project's runs and an active-filter
  chip names the project

### Requirement: Command palette
The system SHALL provide a keyboard-first command palette (⌘K / Ctrl-K)
offering run search over title, project, and source, view switching, theme
toggling, and filter actions; it SHALL be fully keyboard operable and respect
the existing typing-target guards.

#### Scenario: Jump to a run by name
- GIVEN several loaded runs
- WHEN the user opens the palette and types part of a run title
- THEN matching runs are listed and Enter opens the selected run's timeline

### Requirement: Theme selection
The system SHALL let the user switch between the ink (default) and paper
themes, persist the choice locally, apply it in single-file exports, and keep
both themes at the stylebook's contrast floor.

#### Scenario: Choice survives reload
- GIVEN the user switched to the paper theme
- WHEN the dashboard is reopened
- THEN it renders in the paper theme without a flash of the ink theme
