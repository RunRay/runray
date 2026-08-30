# Delta for run-diff

## ADDED Requirements

### Requirement: Run comparison
The system SHALL compare two normalized runs and report deltas for total cost, tokens by class, tool errors, llm call count, and max delegation depth, plus a span alignment classifying spans as matched, added, or removed.

#### Scenario: Cost delta
- GIVEN two runs of the same task where the second costs more
- WHEN `runray diff` runs
- THEN the output states the absolute and percentage cost increase

#### Scenario: Machine-readable diff
- GIVEN any two runs
- WHEN `runray diff --json` runs
- THEN a stable JSON structure suitable for CI consumption is printed

### Requirement: Alignment robustness
The system SHALL align spans by kind and name sequence such that reordering of independent siblings does not produce spurious added/removed pairs.

#### Scenario: Reordered tools
- GIVEN two runs identical except for the order of two independent tool calls
- WHEN the diff is computed
- THEN both tool calls are reported as matched with zero delta
