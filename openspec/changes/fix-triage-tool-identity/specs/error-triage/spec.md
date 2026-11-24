# error-triage — delta

## MODIFIED Requirements

### Requirement: Error clusters, reaction cost and recovery
The system SHALL group a run's failures into clusters keyed by class and
tool, each carrying its occurrences in chronological order. The tool is the
tool name (the model name for model-call failures), except for a shell call
that carries tool-usage attributes: its tool is the harness tool name
together with the program it ran as `toolIdentity` resolves it — registry
tool, subcommand and activity. Free-form text (a script or program name)
SHALL NOT be part of the tool, so redaction never changes which calls are
the same tool; programs outside the registry share one tool per activity. A cluster of such calls SHALL carry
the program (its key, a label made of the tool and subcommand, the
subcommand and the activity) beside the harness tool name.
For every occurrence the system SHALL
record (a) the reaction cost — the cost of the first model call in the same
scope (subagent or session) that starts at or after the failure ends, with
each model call claimed by at most one failure so two failures answered by
one call bill it once; and (b) the recovery — whether the next call of the
same tool in the same scope succeeded, failed, or never happened, with the
delay. Each cluster SHALL carry an outcome: `recovered` when the last
occurrence's tool came back, `looping` when three or more of its occurrences
failed consecutively or a retry-loop finding cites one of them, else
`unrecovered`; and the ids of the findings whose evidence includes one of its
occurrences. Clusters SHALL be ordered by owner (you, tooling, agent, model,
work, unknown), then first occurrence, then key, and the whole triage SHALL
be a pure function of the run independent of span input order.

#### Scenario: One reaction, two failures
- GIVEN an Edit failure and a Bash failure in the same turn followed by one
  model call costing $0.50
- WHEN the run is triaged
- THEN the chronologically first failure's cluster carries $0.50 and the
  other carries $0.00, and the run's reaction total is $0.50

#### Scenario: A subagent's failure reacts inside the subagent
- GIVEN a Read failure inside a subagent, followed by a main-session model
  call and then a subagent model call
- WHEN the run is triaged
- THEN the reaction cost is the subagent call's, not the main session's

#### Scenario: Recovery is the same tool's next call
- GIVEN a Bash failure followed 2 s later by a successful Bash call, neither
  carrying tool-usage attributes
- WHEN the run is triaged
- THEN the occurrence's recovery is `ok` after 2000 ms and the cluster's
  outcome is `recovered`

#### Scenario: Another program does not recover a shell failure
- GIVEN a failed `pnpm test` followed by a successful `ls`, both classified
- WHEN the run is triaged
- THEN the occurrence's recovery is `none` and the cluster is `unrecovered`
- AND when a successful `pnpm run test` follows as well, the recovery is
  `ok` and names that call

#### Scenario: One cluster per program
- GIVEN a failed `pnpm test` and a failed `git push` of the same class
- WHEN the run is triaged
- THEN they are two clusters, labelled `pnpm run` and `git push`, both with
  the harness tool `Bash`

#### Scenario: Redaction does not change the triage's shape
- GIVEN the same shell calls stamped once with redaction off and once with
  it on, with the same failure text
- WHEN both runs are triaged
- THEN the two triages are equal
