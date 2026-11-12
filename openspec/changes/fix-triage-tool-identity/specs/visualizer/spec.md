# visualizer — delta

## MODIFIED Requirements

### Requirement: Errors tab
The run view SHALL offer an Errors tab (`#/run/:id/errors`) beside
Overview, Timeline Explorer and Time, rendered from the core error triage
(error-triage capability) and never from a UI-side classification. The tab
SHALL open with a summary — failed tool calls, failed model calls, how many
need the person, how many recovered on the next call, the reaction cost —
a strip of failures by owner, and the failures placed on the session's time
axis; then the clusters grouped by owner in triage order (yours to fix,
tooling, agent slips, model calls, expected feedback, unclassified), each
group carrying its meaning, count and reaction cost. A cluster row SHALL
show the tool, the class, the first line of its latest failure text, its
count and time span, its outcome and its reaction cost, and SHALL open to
the failure text, one control per occurrence that selects the span and
opens the Timeline Explorer on it, the findings that cite the cluster (each
opening the finding), and the class playbook for the run's own source.
For a cluster that carries a program, the tool SHALL read as the program's
label, followed by its activity when the label does not name the work (the
subcommand is `run`, `script` or `inline`, or the program is outside the
registry), with the harness tool name as a tag; the failure ticks on the time axis SHALL name it the same way. The
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
- THEN "Yours to fix" comes first with the shell failure open, showing its
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

#### Scenario: A cluster names the program
- GIVEN a run with a failed `pnpm test` and a failed `git push`, both
  classified
- WHEN the Errors tab renders
- THEN one cluster row reads `pnpm run · test` and the other `git push`,
  each tagged `Bash`

### Requirement: Inspector error sections
When the Inspector shows a failed span, it SHALL render after the Output
section a "What this is" section — the owner and class from the run's
triage, the class explanation, and what happened to this occurrence
(whether the next call of the same tool succeeded and after how long, what
the reacting model call cost; for a cluster that carries a program, the
tool is named as the Errors tab names it) — and a "What you can do" section
with the class playbook's actions for the run's own source, under the same
visibility rule as the Errors tab (always for owners you, tooling, model
and unclassified; for agent slips only when the cluster repeated or never
recovered; otherwise the explanation only). Both SHALL read from the same
triage the Errors tab renders, and a control SHALL open the Errors tab.
A cancelled span SHALL get one sentence saying the person declined the
call and it is not counted as an error. The "tool errors" count in the
run summary SHALL take the triage's tone.

#### Scenario: A failed shell call in the Inspector
- GIVEN a selected Bash span without tool-usage attributes whose failure is
  classified shell-syntax
- WHEN the Inspector renders it
- THEN "What this is" says "Yours to fix · Shell syntax", reports that the
  next Bash call succeeded and what the reaction cost, and "What you can
  do · Claude Code" lists the class's Claude Code actions

#### Scenario: A failed test run in the Inspector
- GIVEN a selected Bash span that ran `pnpm test` and failed, followed only
  by a successful `ls`
- WHEN the Inspector renders it
- THEN "What this is" says there was no later `pnpm run · test` call in
  this scope

#### Scenario: A declined call
- GIVEN a selected span with status cancelled
- WHEN the Inspector renders it
- THEN it says the person declined the call and shows no playbook
