# Delta for visualizer

## ADDED Requirements

### Requirement: Sessions overview aggregates
The system SHALL open on an overview that aggregates all loaded runs — total cost, tokens, wasted estimate, session count, code changes, spend per day, top projects and models by cost, and a cross-run waste leaderboard — so where the money went is visible without opening any run; activating a leaderboard finding SHALL open that run's timeline with the finding's evidence highlighted.

#### Scenario: Aggregates without opening a run
- GIVEN a trace file with multiple runs
- WHEN the sessions view renders
- THEN total cost, wasted estimate, and per-day spend across all runs are visible above the sessions table

#### Scenario: Cross-run waste navigation
- GIVEN runs from different days each carrying insights
- WHEN the user activates a finding on the waste leaderboard
- THEN that run's timeline opens with the finding's evidence spans highlighted

### Requirement: Timeline waterfall
The system SHALL render each run as a virtualized waterfall of spans showing delegation nesting, concurrent sibling spans on separate lanes so parallel and sequential execution are visually distinct, duration bars colored by span kind, per-span cost, error marking, and subtree collapse/expand, remaining responsive at 10,000 spans.

#### Scenario: Parallel siblings
- GIVEN two sibling tool_call spans whose time ranges overlap
- WHEN the waterfall renders
- THEN both spans occupy separate lanes at the same depth so their concurrency is visible

#### Scenario: Large run responsiveness
- GIVEN a run with 10,000 spans
- WHEN the user scrolls the waterfall
- THEN rendering remains smooth via row virtualization

#### Scenario: Insight evidence highlighting
- GIVEN a run with insights
- WHEN the user activates an insight in the strip
- THEN its evidence spans are highlighted and scrolled into view

### Requirement: Cumulative spend visualization
The system SHALL display a cumulative-cost gutter (Spend Spine) alongside the waterfall, heat-colored by spend rate, where activating a point navigates to the corresponding moment.

#### Scenario: Spine navigation
- GIVEN a rendered run
- WHEN the user clicks a point on the Spend Spine
- THEN the waterfall scrolls to the spans active at that timestamp

### Requirement: Cost breakdown view
The system SHALL provide a cost view with run totals, cost stacked by model over time, a treemap by tool/agent subtree, and a wasted-spend table naming failed work with estimated USD amounts.

#### Scenario: Waste attribution
- GIVEN a run containing a retry-loop finding
- WHEN the cost view is shown
- THEN the waste table lists the finding with its estimated USD and links to evidence

### Requirement: Local serving and single-file export
The system SHALL serve the dashboard only on 127.0.0.1 and SHALL export any run as one self-contained HTML file that renders offline from `file://`; exporting unredacted content SHALL require explicit confirmation.

#### Scenario: Offline export
- GIVEN an exported report.html
- WHEN it is opened from disk with networking disabled
- THEN all views render fully

#### Scenario: Redaction guard
- GIVEN an export command without `--redact`
- WHEN run non-interactively without `--yes`
- THEN the export aborts with a warning that the file would contain prompt text
