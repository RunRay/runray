# Delta for visualizer

## ADDED Requirements

### Requirement: Diff view
The system SHALL provide a Diff view at `#/diff/:a/:b` showing two-column
run headers with cost/token/error delta chips, an aligned span pairing in
which added spans, removed spans, and cost-regressed matched pairs are
visually distinct, and a summary table mirroring the CLI's `--json`
figures; the CLI output and the Diff view SHALL be produced by the same
comparison implementation so their figures never disagree; runs SHALL be
selectable for comparison from the sessions table and the command palette;
an unknown run id in either position SHALL fall back to the dashboard,
never a broken view.

#### Scenario: Regressed pair highlighted
- GIVEN two runs where one matched llm_call costs more in run B
- WHEN the Diff view renders
- THEN that pair is marked as cost-regressed and its delta is shown

#### Scenario: CLI and UI agree
- GIVEN the same two runs opened in `runray diff` and in the Diff view
- WHEN both render their summary
- THEN every delta figure is identical

#### Scenario: Diff works in an export
- GIVEN an exported report.html containing both runs, opened from file://
- WHEN the user navigates to `#/diff/:a/:b`
- THEN the Diff view renders identically to the live viewer
