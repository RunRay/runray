# Delta for ci-gate

## ADDED Requirements

### Requirement: Budget gate
The system SHALL fail with exit code 2 when a run's computed cost exceeds a configured USD budget, printing the overage and the top cost contributors.

#### Scenario: Budget exceeded
- GIVEN `runray ci --budget 5.00` and a run costing $7.10
- WHEN the gate evaluates
- THEN the process exits 2 and reports the $2.10 overage with the three most expensive subtrees

### Requirement: Regression gate with variance handling
The system SHALL compare a run against a baseline (ref or file) and fail when cost regression exceeds the configured percentage, using stored baseline statistics rather than a single prior run so natural run-to-run variance does not cause false failures.

#### Scenario: Within variance band
- GIVEN a baseline whose historical runs vary ±15%
- WHEN a new run is 10% more expensive with a 20% threshold
- THEN the gate passes and records the run into the baseline store

#### Scenario: True regression
- GIVEN the same baseline
- WHEN a new run is 40% more expensive
- THEN the process exits 2 naming the regressed subtrees

### Requirement: Policy gate
The system SHALL fail when configured behavior rules trigger, including invocation of unauthorized tools, network egress by tool commands, or delegation depth beyond a limit.

#### Scenario: Unauthorized tool
- GIVEN a policy allowing only Read, Edit, and Bash
- WHEN the run invoked an MCP tool outside the allowlist
- THEN the process exits 2 citing the span and the violated policy

### Requirement: PR-ready reporting
The system SHALL emit a machine-readable verdict (`--json`) and an optional self-contained HTML report; the GitHub Action SHALL post a PR comment containing the verdict, cost delta versus baseline, and top insights.

#### Scenario: Action comment
- GIVEN the Action wraps a headless agent run on a pull request
- WHEN the gate completes
- THEN the PR receives one updated comment with verdict, delta, and a link to the report artifact
