# Delta for waste-grouping

New capability. A session's findings are listed flat everywhere in the
visualizer — one pill per finding in the strip, one row per finding in the
Overview's waste table — and on real sessions that means eighteen near-
identical cache-break rows, thirteen re-reads worth cents, and burned
money next to upper-bound estimates in one column. This capability arranges
a run's findings the way the dashboard already arranges them across runs:
by rule, split by class, graded as groups, folded when they are cents, and
placed on the session's clock. It detects nothing new; the engine's
findings are its input.

## ADDED Requirements

### Requirement: Findings grouped by rule and class
The system SHALL provide a pure function of a run that groups the run's
findings by rule id, assigns each group the rule's class from the rule
metadata registry (`waste` = already burned, `opportunity` = achievable
saving), and returns burned groups and opportunity groups separately, each
list ordered by summed estimate descending (ties by count, then rule id). A
group SHALL carry its count, its summed estimate (unpriced findings add
nothing), that sum as a share of the run's priced cost, whether any of its
findings is unpriced, its label and explanation from the registry (the rule
id when unregistered), and its occurrences ordered largest first, then
earliest, then id. The run-level figures SHALL be the engine's capped
wasted estimate as the burned amount and the sum of opportunity-class
estimates as the opportunity amount, and the two SHALL never be combined
into one number. The function SHALL live in `packages/core` under a
browser-safe subpath so the visualizer never carries a copy.

#### Scenario: Two classes, two figures
- GIVEN a run with two cache-prefix-break findings ($14.43, $0.26), a
  retry-loop finding ($3.36) and a context-bloat finding ($659.26)
- WHEN the run is grouped
- THEN the burned groups are cache-prefix-break ($14.69, 2) then retry-loop
  ($3.36, 1), the opportunity groups are context-bloat ($659.26), and the
  opportunity amount is $659.26 while the burned amount is the run's
  wasted estimate

#### Scenario: Order of findings does not matter
- GIVEN the same run with its findings in reverse order
- WHEN it is grouped
- THEN the result is identical

### Requirement: Group severity
Each group SHALL be graded by the engine's severity tiers (cost-engine
"Severity grading") applied to the group's summed estimate against the
run's priced cost — the same function, thresholds and floors that grade a
single finding — so that many small findings of one rule read as the size
they add up to. A group with no priced finding, or on a run with no priced
cost, SHALL be `info`.

#### Scenario: Eighteen small breaks make a critical group
- GIVEN a $808 run with eighteen cache-prefix-break findings each graded
  `info`, summing to $99.15
- WHEN the run is grouped
- THEN the cache-prefix-break group is `critical` with a 12.3% share

#### Scenario: Unpriced stays unsized
- GIVEN a group whose only finding has no estimate
- WHEN it is graded
- THEN it is `info`, its sum is 0 and it is marked unpriced

### Requirement: Cent-level groups fold
A group whose findings are all priced and each under the warning floor
(`insights.thresholds.severity.warningFloorUSD`, default $0.05) SHALL be
marked folded, and the run SHALL report how many findings sit in folded
groups, so a renderer can show such a group as one line instead of one row
per finding. A group with an unpriced finding SHALL never fold.

#### Scenario: Thirteen re-reads fold
- GIVEN thirteen duplicate-read findings between $0.00 and $0.04
- WHEN the run is grouped
- THEN the duplicate-read group is folded and the run counts 13 folded
  findings

#### Scenario: One real finding keeps the group open
- GIVEN a group with findings of $0.01 and $0.40
- WHEN the run is grouped
- THEN the group is not folded

### Requirement: Leak events on the session's clock
For every waste-class finding whose evidence spans resolve, the system SHALL
emit one or two events with offsets from the run's start: a cache-prefix
break at its breaking call, of kind `compaction` when the break's shape is
a compaction and `burn` otherwise; an idle expiry as an `idle` event from
the end of the call before the gap to the start of the resumed call (worth
nothing itself) followed by a `burn` at the resumed call; any other
waste-class finding as a `burn` from its first to its last evidence span.
Every event SHALL name the span to open, its finding and its amount.
Opportunity-class findings SHALL emit no events. Events SHALL be ordered
chronologically. The system SHALL also report every model call as a
context point — offset, input-class tokens (input + cache read + cache
write), model — in chronological order, so a renderer can draw the context
the leaks happened in.

#### Scenario: A compaction and a re-write
- GIVEN two cache-prefix-break findings, one whose breaking call's context
  shrank to a fifth and one whose 34k front stayed cached while 759k
  tokens were written again
- WHEN events are emitted
- THEN the first is a `compaction` and the second a `burn`, each at its
  breaking call

#### Scenario: An idle gap
- GIVEN an idle-cache-expiry finding whose call before the gap ended at
  6h57 and whose resumed call started at 16h13
- WHEN events are emitted
- THEN an `idle` event spans 6h57–16h13 worth $0 and a `burn` sits at
  16h13 worth the finding's estimate

### Requirement: One shape for a cache break
The shape of a cache-prefix break — `compaction`, `front` or `history` —
SHALL be computed by one shared, pure function from the two calls' token
quads, used both by the cache-prefix-break rule for its wording and by the
grouping for its per-shape split, with the rule's thresholds
(`baseRetainedTokens`, `shrinkRatio`) as the defaults. A cache-prefix-break
occurrence SHALL carry its shape, the cached tokens before and after the
break, the tokens re-written and the breaking call's model; an idle
occurrence SHALL carry the gap length and the same token figures.

#### Scenario: Rule and grouping agree
- GIVEN a finding the rule worded as a compaction
- WHEN the grouping reads the same two spans
- THEN its occurrence has shape `compaction` and the group's shape split
  counts it there
