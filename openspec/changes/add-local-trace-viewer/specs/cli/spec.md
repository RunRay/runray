# Delta for cli

## ADDED Requirements

### Requirement: Command surface
The system SHALL expose `view`, `list`, `export`, `demo`, and `pricing` commands with documented flags, and SHALL use exit codes: 0 success, 1 execution error, 3 no data found.

#### Scenario: No data
- GIVEN a machine with no supported agent logs
- WHEN `runray view` runs
- THEN the process exits with code 3 and prints the commands that would generate data

#### Scenario: Scripting output
- GIVEN discovered runs
- WHEN `runray list --json` runs
- THEN a machine-readable summary (id, source, timing, tokens, cost) is printed to stdout

### Requirement: Privacy-preserving defaults
The system SHALL make no network requests during `view`, `list`, `export`, or `demo`; the only permitted network operation SHALL be an explicit `pricing --refresh`. A `--redact` option SHALL strip prompt and output text in the core pipeline while preserving structure and token counts.

#### Scenario: Offline operation
- GIVEN networking is unavailable
- WHEN any command except `pricing --refresh` runs
- THEN it completes successfully using bundled pricing data

### Requirement: Instant demo
The system SHALL provide `runray demo`, opening the visualizer on a bundled, scrubbed sample run with no local agent data required.

#### Scenario: First contact
- GIVEN a machine that has never run a coding agent
- WHEN the user runs `npx runray demo`
- THEN a populated dashboard opens within seconds
