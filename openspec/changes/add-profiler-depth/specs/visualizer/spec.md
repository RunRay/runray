# Delta for visualizer

## MODIFIED Requirements

### Requirement: Sessions overview aggregates
The system SHALL open on an overview that leads with actionable economics: a
potential-savings panel SHALL render above all spend counters, followed by
the total-spend statement, key indicators, spend per day, rankings
(including the cross-run tool ranking), and the cross-run waste leaderboard;
all aggregates SHALL derive from the visible (filtered) runs. Insight rules
SHALL be presented with human-readable labels and one-line explanations
wherever a rule is named, with the rule id retained as secondary text;
unknown rule ids SHALL fall back to their literal id. Activating a
leaderboard finding SHALL expand its evidence in place; opening the run's
timeline with evidence highlighted SHALL remain available as a secondary
action.

#### Scenario: Savings lead the page
- GIVEN a trace file whose runs carry insights with waste estimates
- WHEN the dashboard renders
- THEN the potential-savings panel appears before the total-spend statement,
  and the spend statement renders below it

#### Scenario: Humanized rule labels
- GIVEN a run with a `retry-loop` finding
- WHEN the waste leaderboard renders
- THEN the group header shows the rule's human label and one-line
  explanation, with `retry-loop` visible as secondary text

#### Scenario: Unknown rule stays safe
- GIVEN an insight whose ruleId has no registered metadata
- WHEN the leaderboard renders
- THEN the group renders under the literal rule id without error

#### Scenario: Evidence expands in place
- GIVEN a finding on the dashboard waste leaderboard
- WHEN the user activates it
- THEN the evidence spans (name, kind, cost, preview excerpt) expand inline
  on the dashboard without navigating away, and an "open in timeline"
  action is offered

### Requirement: Global run filters
The system SHALL provide project, source, period, model, day, and tool
filters that narrow the visible runs client-side across every view; active
filters SHALL be visible and individually clearable; a period filter SHALL
anchor to the newest loaded run. The active filter state SHALL be encoded in
the URL hash in the canonical parameter order
`project, source, period, model, day, tool` so a copied link restores the
same filtered view, in the live viewer and in exported files; filter-only
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

### Requirement: Command palette
The system SHALL provide a keyboard-first command palette (⌘K / Ctrl-K)
offering navigation to the dashboard and the sessions list, run search over
title, project, and source, view switching, theme toggling, and filter
actions; it SHALL be fully keyboard operable.

#### Scenario: Jump to the dashboard
- GIVEN any view is open
- WHEN the user opens the palette and selects the Dashboard entry
- THEN the dashboard route opens

### Requirement: Timeline waterfall
The system SHALL render each run as a virtualized waterfall over the
delegation tree, and container rows (subagent, session) SHALL carry a
subtree economics badge — rolled-up cost, tokens, llm-call count, and wall
time of the subtree — computed from priced spans only, with unpriced calls
counted separately; the badge SHALL remain visible when the subtree is
collapsed.

#### Scenario: Collapsed subagent shows its economics
- GIVEN a run with a subagent whose subtree contains priced llm calls
- WHEN the subagent row is collapsed
- THEN the row shows the subtree's total cost, tokens, and llm-call count
  alongside the hidden-descendant count

#### Scenario: Unpriced calls are not silently folded in
- GIVEN a subtree containing llm calls with `costSource: unknown`
- WHEN the rollup badge renders
- THEN those calls are excluded from the dollar figure and surfaced as an
  unpriced count

### Requirement: Cost breakdown view
The system SHALL provide a per-run cost view with totals, cost-over-time by
model, a hierarchical agent-subtree map, and the waste table. The subtree
map SHALL nest delegated subagents inside their delegating subagent (never
flattening nested delegation into innermost-only attribution), SHALL derive
each node's own value from the cost-engine's canonical attribution cells so
the map can never disagree with repricing figures, SHALL support a cost mode
and a token mode, and activating a cell SHALL open the timeline with that
subtree selected.

#### Scenario: Nested delegation is visible
- GIVEN a run where subagent A delegates to subagent B
- WHEN the subtree map renders
- THEN B's cell renders inside A's cell, and A's value includes B's

#### Scenario: Token mode
- GIVEN the subtree map is in cost mode
- WHEN the user switches to token mode
- THEN cell sizes re-derive from attributed token totals with the same
  nesting

## ADDED Requirements

### Requirement: Potential savings panel
The system SHALL render a potential-savings panel aggregating insight
estimates across the visible runs, splitting the total into already-burned
waste (the sum of run-level wasted estimates, which are waste-class only and
capped) and efficiency opportunities (the sum of opportunity-class
findings' estimates, classified via the rule metadata registry), each
labeled as such and never presented as one undifferentiated savings claim;
it SHALL show the top three recommended changes ranked by estimated
dollars, each with its per-change amount, human label, suggestion, and
in-place expandable evidence; it SHALL display a coverage caveat when
estimates are known to be incomplete (unpriced calls present); and when no
rule fired it SHALL state that explicitly rather than hiding.

#### Scenario: Honest split
- GIVEN runs with one dead-end-run finding ($3) and one low-cache-hit
  finding ($5)
- WHEN the panel renders
- THEN it presents $3 as already-burned waste and $5 as an efficiency
  opportunity, never a single undifferentiated $8 "savings" claim

#### Scenario: Top changes are ranked
- GIVEN findings from four different rules
- WHEN the panel renders
- THEN the three rules with the largest summed estimates appear, each with
  its dollar amount

#### Scenario: Nothing found is said out loud
- GIVEN visible runs with no insight findings
- WHEN the panel renders
- THEN it states that the rules found nothing to save in this period

### Requirement: What-if repricing panel
The run Cost view SHALL provide a what-if panel: a target-tier selector (the
suggested downgrade preselected, any model from the delivered pricing table
selectable), a per-subtree table of current cost, repriced cost, and delta
with risk flags rendered as named badges, and a total line showing both the
full and the risk-free estimated saving with the wording "estimated at
<target> rates"; the panel SHALL work identically in the live viewer and in
offline exports, and SHALL render an explanatory notice instead of numbers
when no pricing payload is available. The repricing math SHALL be the
cost-engine primitive, never a UI reimplementation.

#### Scenario: Sonnet instead of Opus
- GIVEN an open run that spent $82 on an opus-tier model with one error-free
  subagent subtree and one subtree containing failures
- WHEN the user selects the suggested sonnet-tier target
- THEN both subtrees show their deltas, the failing subtree carries an
  `errors` badge, and the totals show the full saving and the smaller
  risk-free saving

#### Scenario: No pricing payload
- GIVEN an exported report produced without an embedded pricing payload
- WHEN the Cost view renders
- THEN the panel shows a notice explaining repricing is unavailable and no
  fabricated rates are used

### Requirement: Unpriced-coverage honesty
The system SHALL surface unpriced-cost coverage wherever money is
aggregated: a run-level banner ("N llm calls unpriced (models …) — this
run's totals are understated"), a dashboard-level banner when any visible
run is affected, and a caveat marker on every waste or savings figure
(wasted KPI, waste leaderboard totals, what-if deltas, model-mismatch
amounts) derived from runs whose coverage is below 100%; redaction mode
SHALL not affect coverage reporting.

#### Scenario: Confident-looking number gets its asterisk
- GIVEN a visible run with two unpriced llm calls
- WHEN the dashboard renders
- THEN the coverage banner appears and the Wasted KPI carries an
  understatement caveat, both naming the unpriced count

### Requirement: Pricing provenance display
The system SHALL display the pricing table's provenance — source, snapshot
date, and origin (bundled or refreshed) — alongside the what-if panel, the
run Cost view totals, and the dashboard savings aggregate, sourced from the
delivered pricing payload.

#### Scenario: Refreshed table is credited
- GIVEN the user ran `pricing --refresh` on 2026-07-18
- WHEN the Cost view renders
- THEN money figures are accompanied by "prices: LiteLLM snapshot
  2026-07-18 (refreshed)"

### Requirement: Data freshness indicator
The system SHALL display the snapshot time of the loaded trace file (its
`generatedAt`) in the top bar, SHALL update it whenever the data is
refetched after a change event, and SHALL distinguish a live-updating
session (watch active, event stream connected) from a static snapshot;
exported files SHALL show their frozen snapshot time.

#### Scenario: Stamp updates on watch refresh
- GIVEN `runray view --watch` is serving the UI
- WHEN a source log changes and the UI refetches
- THEN the top-bar stamp shows the new snapshot time and a live indicator

#### Scenario: Static snapshot is honest
- GIVEN `runray view` without `--watch`
- WHEN the UI renders
- THEN the stamp shows the snapshot time without a live indicator

#### Scenario: Export freshness
- GIVEN an exported report.html opened days later
- WHEN the top bar renders
- THEN the stamp shows the export-time `generatedAt`, not wall-clock now

### Requirement: Transcript drill-down
The system SHALL let the user load the full source-log content behind a span
from the Inspector, resolved via the span's provenance by the local server;
the pane SHALL be read-only and virtualized; when the trace was produced
with `--redact` the system SHALL show a redaction notice and SHALL NOT
display raw text; when no live server is available (exported file, file://)
the feature SHALL degrade to an explanatory notice; when the source log is
missing or the source is unsupported the pane SHALL say so without error.

#### Scenario: Full text behind a preview
- GIVEN `runray view` without `--redact` and a span whose preview is
  truncated at 200 characters
- WHEN the user loads the transcript in the Inspector
- THEN the full text of the span's source record is shown read-only

#### Scenario: Redact mode never leaks
- GIVEN the viewer was started with `--redact`
- WHEN the user requests a span's transcript
- THEN a redaction notice is shown and no raw log text reaches the browser

#### Scenario: Exported file degrades gracefully
- GIVEN an exported report.html opened from file://
- WHEN the user inspects a span
- THEN the transcript section explains it is available only in the live
  viewer

### Requirement: Aggregate CSV export
The system SHALL provide client-side CSV downloads of the visible sessions
and of the per-day spend aggregates, with a fixed documented column order,
rows in a canonical sort (startedAt, then id), and locale-independent number
formatting, such that the same filtered data always produces byte-identical
files; export SHALL work offline in exported single files.

#### Scenario: Deterministic bytes
- GIVEN the same filter applied twice to the same trace file
- WHEN the sessions CSV is downloaded both times
- THEN the two files are byte-identical

#### Scenario: Redacted data exports safely
- GIVEN a trace produced with `--redact`
- WHEN the sessions CSV is downloaded
- THEN no prompt-derived text appears in any column

### Requirement: Limit-window display mode
The system SHALL provide an opt-in display mode that additionally expresses
selected cost figures as a percentage of a user-configured reference window
(window length, reset day and hour, optional USD or token budget); the mode
SHALL be off by default, its window SHALL anchor to the newest loaded run
rather than the current clock so exports render stably, every percentage
SHALL be labelled as an estimate, and the percentage framing SHALL appear
only on the overview spend statement, the wasted KPI, and the run cost
hero — never on every figure.

#### Scenario: Percentage of window spend
- GIVEN a configured 7-day window with runs inside it and limit mode toggled
  on
- WHEN the overview renders
- THEN the spend statement carries a secondary line stating the estimated
  share of the window's spend-to-date

#### Scenario: Budget as denominator
- GIVEN a configured window with `budgetUSD` set
- WHEN limit mode is on
- THEN percentages are computed against the budget instead of spend-to-date

#### Scenario: Off by default
- GIVEN a limit window is configured but the toggle has never been used
- WHEN any view renders
- THEN no percentage-of-window figures appear

#### Scenario: Deterministic in exports
- GIVEN an exported file opened on two different days
- WHEN the overview renders with limit mode on
- THEN the window bounds and percentages are identical on both opens

### Requirement: Run time breakdown
The system SHALL provide a Time view for each run, as a sibling tab of Cost
and Timeline, decomposing the run's wall-clock into model-wait,
tool-execution, idle (gaps at or above a display threshold, deliberately
distinct from the cache-expiry insight's TTL threshold and cross-referenced
in the view's hint copy), and coordination segments via an interval sweep in
which concurrent spans never double-count wall-clock; parallel compression
SHALL be reported as a separate parallelism factor; and the view SHALL list
the run's slowest tools by p50/p95 duration.

#### Scenario: Segments sum to wall-clock
- GIVEN a run with overlapping parallel subagent spans
- WHEN the Time view renders
- THEN the segment durations sum exactly to the run's wall-clock and no
  instant is counted twice

#### Scenario: Idle gap surfaced
- GIVEN a run containing a 5-minute stretch with no active llm or tool span
- WHEN the Time view renders
- THEN an idle segment covering that stretch is shown

#### Scenario: Slowest tools
- GIVEN a run whose bash calls have widely varying durations
- WHEN the Time view renders
- THEN bash appears in the slowest-tools table with deterministic p50 and
  p95 values

### Requirement: Cross-run tool ranking
The system SHALL show a dashboard ranking of tools and MCP servers by
attributed LLM cost across the visible runs, placed in the rankings band
below the potential-savings panel, reusing the per-run attribution logic,
labelled as attributed (heuristic) figures and excluding the orchestration
remainder; MCP entries SHALL be identifiable by server; the card SHALL
include a callout stating the MCP share of attributed spend and the top
server; and activating a row SHALL filter the visible runs to those using
that tool, announced as a clearable chip.

#### Scenario: MCP share callout
- GIVEN runs where mcp_call-attributed cost is 30% of attributed spend
- WHEN the dashboard renders
- THEN the By-tool card states the 30% MCP share and names the top server

#### Scenario: Tool row filters runs
- GIVEN the By-tool card lists `webfetch`
- WHEN the user activates that row
- THEN the sessions table shows only runs containing a webfetch call and a
  clearable chip names the tool

### Requirement: Help access
The system SHALL make the top-bar help control open the keyboard-shortcut
help sheet, equivalent to pressing `?`, with an accessible name and visible
hover, focus-visible, and active states.

#### Scenario: Help button works
- GIVEN any view
- WHEN the user activates the top-bar help button
- THEN the help sheet opens, and Escape or the button closes it

### Requirement: Finding markers and the Inspector detail switch
The system SHALL mark every waterfall row that is evidence of a finding — a
severity-tinted notch in the row gutter and a chip after the label carrying
the finding count when the span sits under several findings — independent
of which finding is active; the marker SHALL never be color-alone (the
row's accessible name and tooltip list the findings). Activating a row's
marker SHALL select that span and open its worst finding in the Inspector.
When the selected span is evidence of at least one finding, the Inspector
SHALL offer an Activity | Finding switch between the span detail and the
finding detail without losing either selection; a span under several
findings SHALL let the user pick which one to show.

#### Scenario: Evidence rows are marked while no finding is active
- GIVEN a run with a retry-loop finding over three tool calls
- WHEN the timeline renders with no finding activated
- THEN those three rows carry the finding marker and the other rows do not

#### Scenario: Marker opens the finding
- GIVEN a marked row
- WHEN the user activates its marker
- THEN the span is selected, the finding's evidence is highlighted, and the
  Inspector shows the finding

#### Scenario: Switching between activity and finding
- GIVEN a finding is active and one of its evidence spans is selected
- WHEN the user switches the Inspector to Activity and back to Finding
- THEN the span detail and the finding detail alternate, the span stays
  selected, and the evidence highlight stays

#### Scenario: A span under several findings
- GIVEN a span that is evidence of two findings
- WHEN its finding detail is shown
- THEN both findings are offered and picking the other one shows it with its
  own evidence highlighted

### Requirement: Finding playbook in the Inspector
When the Inspector shows a finding, it SHALL render, after the finding's
suggestion, the rule's playbook actions for the run's own source (Claude
Code, OpenCode, or the custom-agent playbook for other sources) as a
numbered list in the order the registry gives them, with commands, keys and
file names set apart from prose; the causes and the limits SHALL be
available behind one disclosure that is keyboard-operable and announces its
state. The dashboard's savings groups SHALL describe a rule with the rule's
own explanation, never with one finding's suggestion.

#### Scenario: Levers for the session's source
- GIVEN a Claude Code run with a fixed-context-overhead finding shown in the
  Inspector
- WHEN the finding view renders
- THEN a "How to fix · Claude Code" section lists that rule's Claude Code
  actions, numbered, and the disclosure reveals "Why it happens" and "Out
  of your hands"

#### Scenario: Custom-agent fallback
- GIVEN a run whose source is OTLP
- WHEN a finding is shown
- THEN the section is labelled for a custom agent and lists the
  custom-agent actions

### Requirement: Errors tab
The run view SHALL offer an Errors tab (`#/run/:id/errors`) beside
Overview, Timeline Explorer and Time, rendered from the core error triage
(error-triage capability) and never from a UI-side classification. The tab
SHALL open with a summary — failed tool calls, failed model calls, how many
need the person, how many recovered on the next call, the reaction cost —
a strip of failures by owner, and the failures placed on the session's time
axis; then the clusters grouped by owner in triage order (needs you,
tooling, agent slips, model calls, expected feedback, unclassified), each
group carrying its meaning, count and reaction cost. A cluster row SHALL
show the tool, the class, the first line of its latest failure text, its
count and time span, its outcome and its reaction cost, and SHALL open to
the failure text, one control per occurrence that selects the span and
opens the Timeline Explorer on it, the findings that cite the cluster (each
opening the finding), and the class playbook for the run's own source. The
playbook's actions SHALL show for owners you, tooling, model and
unclassified, and for agent slips only when the cluster repeated or never
recovered; expected feedback SHALL show only its explanation, and its group
SHALL start collapsed and dimmed. Filter controls SHALL narrow the groups to
one owner. The tab's label in the tab bar SHALL carry the failure count in
the triage's tone. Hue SHALL encode the owner, never severity; a run with
no failures SHALL render an empty state that points to the Overview. Under
redaction the tab SHALL say that classes are read from the tool alone.

#### Scenario: Owner groups in triage order
- GIVEN a Claude Code run with a shell-syntax failure, a path-not-found
  slip that recovered and a failed test run
- WHEN the Errors tab renders
- THEN "Needs you" comes first with the shell failure open, showing its
  text and the Claude Code playbook; "Agent slips" follows; "Expected
  feedback" is last, collapsed, with a control to show it

#### Scenario: Occurrence opens the timeline
- GIVEN an open cluster with two occurrences
- WHEN the person activates the second occurrence
- THEN that span is selected and the Timeline Explorer opens scrolled to it

#### Scenario: No failures
- GIVEN a run whose calls all succeeded
- WHEN the Errors tab renders
- THEN it says there were no failed calls and links to the Overview

### Requirement: Error triage in the sessions lists
The sessions table, the sessions rail and the run header's tab bar SHALL
keep showing a run's failure count, but SHALL tint it by the triage's
attention signal — alarm when the run needs the person or never got past a
failure, neutral otherwise — and SHALL append "· N need(s) you" when
clusters owned by the person exist. A run whose only failures are
model-call failures SHALL show a model-error count instead of nothing. The
tooltip SHALL name the owner breakdown.

#### Scenario: Recovered slips read neutral
- GIVEN a run with three path-not-found slips each followed by a
  successful call of the same tool
- WHEN the sessions table renders
- THEN the pill reads "3 errors" in the neutral tone and its tooltip says
  the agent handled them

#### Scenario: A shell failure reads as the person's
- GIVEN a run with one shell-syntax failure
- WHEN the sessions rail renders
- THEN the pill reads "1 errors · 1 needs you" in the alarm tone

### Requirement: Inspector error sections
When the Inspector shows a failed span, it SHALL render after the Output
section a "What this is" section — the owner and class from the run's
triage, the class explanation, and what happened to this occurrence
(whether the next call of the same tool succeeded and after how long, what
the reacting model call cost) — and a "What you can do" section with the
class playbook's actions for the run's own source, under the same
visibility rule as the Errors tab (always for owners you, tooling, model
and unclassified; for agent slips only when the cluster repeated or never
recovered; otherwise the explanation only). Both SHALL read from the same
triage the Errors tab renders, and a control SHALL open the Errors tab.
A cancelled span SHALL get one sentence saying the person declined the
call and it is not counted as an error. The "tool errors" count in the
run summary SHALL take the triage's tone.

#### Scenario: A failed shell call in the Inspector
- GIVEN a selected Bash span whose failure is classified shell-syntax
- WHEN the Inspector renders it
- THEN "What this is" says "Needs you · Shell syntax", reports that the
  next Bash call succeeded and what the reaction cost, and "What you can
  do · Claude Code" lists the class's Claude Code actions

#### Scenario: A declined call
- GIVEN a selected span with status cancelled
- WHEN the Inspector renders it
- THEN it says the person declined the call and shows no playbook
