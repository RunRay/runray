# Delta for visualizer

## ADDED Requirements

### Requirement: Subagent subtrees stand apart in the waterfall
The timeline waterfall SHALL make delegated work distinguishable from the orchestrator's own spans, at any nesting depth and when collapsed.

- **Colour.** In both themes, the subagent bar colour SHALL be at least 12 OKLab ΔE (×100) from every other bar colour and from the warning colour of finding markers. This SHALL hold for normal vision and for simulated protanopia and deuteranopia. The colour SHALL reach 4.5:1 against the row ground.
- **Rails.** Every row inside a subagent's subtree SHALL carry a rail in the subagent colour for each enclosing subagent, aligned under that subagent's caret.
- **Hidden findings.** A collapsed row SHALL show the findings whose evidence lies entirely among its hidden descendants. It SHALL show their count, tinted by the worst severity, ahead of the subtree economics badge. It SHALL name them in the row's accessible name and tooltip. Activating the count SHALL open the worst of them, expanding what hides its evidence.
- **Keyboard path.** When a collapsed row is selected, the Inspector SHALL list its hidden findings as keyboard-operable controls that open them the same way.

#### Scenario: Subagent bar unlike an llm bar
- GIVEN the ink theme and a run with a subagent
- WHEN the waterfall renders the subagent's row and its first llm call
- THEN the two bars are chartreuse and violet, not two violets

#### Scenario: Nested delegation reads as stacked rails
- GIVEN a subagent at depth 1 that delegates to a subagent at depth 3
- WHEN both are expanded
- THEN each row inside the inner subagent carries two rails, one under each subagent's caret, and the rows between the two subagents carry one

#### Scenario: Collapsing keeps a nested finding visible
- GIVEN a subagent whose subtree holds the evidence of a retry-loop finding
- WHEN the user collapses the subagents
- THEN the subagent's row shows `⚠ 1 inside` tinted for the finding's severity, and its accessible name names the finding

#### Scenario: Opening a hidden finding reveals its evidence
- GIVEN a collapsed subagent showing `⚠ 2 inside`
- WHEN the user clicks the chip
- THEN the worse finding opens, the subtree expands, and the view scrolls to its first evidence span

#### Scenario: A finding with evidence outside is not pinned on the subagent
- GIVEN a context-bloat finding with five evidence calls in the main agent and one inside a subagent
- WHEN the subagent is collapsed
- THEN the subagent's row does not count the finding, and the five calls outside keep their own markers

#### Scenario: Keyboard users open a hidden finding
- GIVEN a collapsed subagent that hides a duplicate-read finding
- WHEN the user selects the row with the keyboard
- THEN the Inspector lists the finding under "Hidden inside", and activating it opens the finding and expands the subtree onto its evidence

#### Scenario: A finding on the row itself is not counted twice
- GIVEN an `expensive-subagent` finding whose evidence includes the subagent's own span
- WHEN the subagent is collapsed
- THEN the finding shows on the row's own chip and is not counted in `inside`
