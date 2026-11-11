# Delta for visualizer

## MODIFIED Requirements

### Requirement: Run time breakdown
The system SHALL provide a Time view for each run, as a sibling tab of Cost
and Timeline, decomposing the run's wall-clock into model-wait,
tool-execution, waiting-on-person (time in tool calls whose activity is
`human`), idle (gaps at or above a display threshold, deliberately distinct
from the cache-expiry insight's TTL threshold and cross-referenced in the
view's hint copy), and coordination segments via an interval sweep in which
concurrent spans never double-count wall-clock; where several kinds of span
are active at once, model-wait SHALL take precedence over tool-execution and
tool-execution over waiting-on-person; parallel compression SHALL be reported
as a separate parallelism factor; and the view SHALL list the run's tools by
resolved tool identity, per the "Tool usage table" requirement, in place of a
list keyed by harness tool name.

#### Scenario: Segments sum to wall-clock
- GIVEN a run with overlapping parallel subagent spans
- WHEN the Time view renders
- THEN the segment durations sum exactly to the run's wall-clock and no
  instant is counted twice

#### Scenario: Idle gap surfaced
- GIVEN a run containing a 5-minute stretch with no active llm or tool span
- WHEN the Time view renders
- THEN an idle segment covering that stretch is shown

#### Scenario: Waiting on the person is its own segment
- GIVEN a run in which a question to the person stayed unanswered for ten
  minutes while nothing else ran
- WHEN the Time view renders
- THEN those ten minutes are shown as waiting-on-person and are absent from
  tool-execution

#### Scenario: A tool running during a pending question
- GIVEN a pending question to the person and a shell call running at the same
  time
- WHEN the Time view renders
- THEN the overlapping stretch is shown as tool-execution

#### Scenario: Tools listed by identity
- GIVEN a run whose shell calls ran `docker` and `vitest` with widely varying
  durations
- WHEN the Time view renders
- THEN the tool table lists `docker` and `vitest` as separate rows with
  deterministic p50 and p95 values, rather than one row for the shell tool

## ADDED Requirements

### Requirement: Tool time by activity
The Time view SHALL show how the run's summed tool time divides across
activities, as one stacked bar with a legend giving each activity's time and
share. The figure SHALL be labelled as summed tool time, distinct from
wall-clock. Unresolved time SHALL be its own visually distinct part and SHALL
never be folded into another activity.

#### Scenario: Parts add up to the sum
- GIVEN any run with tool calls
- WHEN the activity bar renders
- THEN the legend's times add up to the summed tool time shown in its heading

#### Scenario: Summed time is not presented as wall-clock
- GIVEN a run whose parallel tool calls sum to more than their wall-clock
- WHEN the activity bar renders
- THEN its heading names the figure as summed and states that parallel calls
  overlap

#### Scenario: Few colors, the rest grouped
- GIVEN a run whose tool time spans ten activities
- WHEN the activity bar renders
- THEN the six largest have their own color, the remainder is one neutral
  part named in the legend, and unresolved time has a pattern of its own

#### Scenario: Selecting an activity filters the table
- GIVEN the activity bar and the tool table
- WHEN the person selects the `test` part
- THEN the tool table shows only rows with test activity, and the selection
  can be cleared

### Requirement: Tool usage table
The Time view SHALL list tools by resolved identity, ranked by total time by
default and re-sortable by p95 and by call count. Each row SHALL show the
tool's family, calls, total time, share of summed tool time, p50, p95,
maximum and errors. A row with subcommands SHALL expand to them, and the
table SHALL be filterable by family.

#### Scenario: Programs behind the shell are visible
- GIVEN a run whose shell calls ran `docker exec` four times and `docker ps`
  once
- WHEN the tool table renders
- THEN a `docker` row of the shell family shows five calls and expands to the
  two subcommands

#### Scenario: MCP tools roll up to their server
- GIVEN a run with twelve calls to three tools of one MCP server
- WHEN the tool table renders
- THEN one row for the server shows twelve calls and expands to the three
  tools

#### Scenario: Family filter
- GIVEN a table with shell, harness and MCP rows
- WHEN the person selects the MCP family
- THEN only MCP rows are shown, and the selected filter is exposed as pressed

#### Scenario: Operable by keyboard
- GIVEN keyboard focus on a row's expand control
- WHEN the person activates it
- THEN the subcommands are revealed and the control reports its expanded
  state to assistive technology

### Requirement: Shared, background and partial figures are marked
The tool table SHALL show time a tool shared with other tools in one command
separately from its total, SHALL mark calls that were sent to the background,
and SHALL label any figure the source records only partially. A figure the
source cannot provide SHALL be shown as unavailable, never as zero.

#### Scenario: Shared time
- GIVEN a `git` tool with 85 seconds of its own calls and 50 seconds as an
  also-ran tool in a command led by `pnpm`
- WHEN the tool table renders
- THEN the `git` row shows 85 seconds as its total and 50 seconds, labelled
  shared, beside it

#### Scenario: Background call
- GIVEN a `docker compose up` call sent to the background
- WHEN its row renders
- THEN the row carries a background marker explaining that the time shown is
  the launch, not the run

#### Scenario: Hook durations are partial
- GIVEN a run with hook spans from a Claude Code transcript
- WHEN the hook rows render
- THEN their time is labelled as covering failed and cancelled runs only

#### Scenario: Source that records every hook run
- GIVEN an imported run whose hook spans come from its exporter
- WHEN the hook rows render
- THEN they carry no claim that only failed and cancelled runs are listed

#### Scenario: Cancelled runs are marked apart from errors
- GIVEN a `UserPromptSubmit` hook that was cancelled on its timeout twice and
  failed once
- WHEN its row renders
- THEN the row is marked with two cancelled runs and its error count is one

#### Scenario: Stop hooks reported together
- GIVEN a run with two stop-hook summaries of three hooks each
- WHEN the hook rows render
- THEN the `Stop` row shows two calls and six hook runs, and its time
  figures are shown as unavailable, not as zero

### Requirement: Shell utilities are grouped
The tool table SHALL present the shell tools the registry marks as utilities
(`grep`, `sed`, `cat`, `ls` and the like) as one collapsed group row that
expands to its members, so short-lived calls do not crowd out the tools that
took the time.

#### Scenario: Utilities collapse into one row
- GIVEN a run with thirty-eight calls to `grep`, `sed`, `cat` and `ls`
- WHEN the tool table renders
- THEN one group row shows thirty-eight calls and their combined time, and
  expands to one row per utility

### Requirement: Delegations and hooks are listed apart
The tool table SHALL list tool calls that contain a subagent and hook spans
in a group separate from the ranked rows, stating that their time is not part
of summed tool time.

#### Scenario: A delegation next to its own tools
- GIVEN a run in which an `Explore` agent ran for three minutes and made
  tool calls of its own
- WHEN the tool table renders
- THEN the agent appears in the separate group with its three minutes, and
  its tool calls appear among the ranked rows

#### Scenario: A hook expands to the tools it ran
- GIVEN a `PostToolUse:Edit` hook that failed twice running `prettier` and
  once running a `node` script
- WHEN the person expands its row
- THEN one sub-row per tool is revealed, with the script's name only in an
  unredacted trace

### Requirement: Tool usage degraded states
The Time view SHALL render a truthful tool breakdown for payloads that carry
less than a freshly parsed local trace. Spans without tool identity SHALL be
listed under their harness tool name, free-form names removed by redaction
SHALL be shown as one "other command" row, and a payload without leaf spans
SHALL show an explanatory empty state.

#### Scenario: Trace produced before tool identification
- GIVEN an exported report whose shell spans carry no tool-usage attributes
- WHEN the Time view renders
- THEN shell calls are listed under `Bash`, and the view states once that the
  trace was recorded before tool identification

#### Scenario: Imported trace without commands
- GIVEN an OTLP run whose shell tool spans carry a tool name and no command
- WHEN the Time view renders
- THEN shell calls are listed under the harness tool name, and the view
  states once that the source records no command to identify, not that the
  trace is old

#### Scenario: Redacted report
- GIVEN a redacted report whose shell calls ran `docker` and a program
  outside the registry
- WHEN the tool table renders
- THEN `docker` is listed by name and the other program appears in an "other
  command" row with no name

#### Scenario: Metadata-only report
- GIVEN a metadata-only report
- WHEN the Time view renders
- THEN the activity bar and the tool table are replaced by an empty state
  naming the metadata-only profile as the reason

### Requirement: Limits of tool time are stated
The Time view SHALL state, next to the tool breakdown, the limits of the
figures: that a call's time includes any wait for the person's permission
where the source does not record that wait separately, and that a command
running several tools has one duration that cannot be divided between them.

#### Scenario: Limits are visible without leaving the view
- GIVEN the Time view of a Claude Code run
- WHEN the tool breakdown renders
- THEN an explanation of permission-wait and of shared time is reachable from
  the breakdown itself
