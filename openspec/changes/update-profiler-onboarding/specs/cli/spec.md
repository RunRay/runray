# Delta for cli

## MODIFIED Requirements

### Requirement: First-run banner and guidance
The CLI SHALL print a concise first-run banner to `stderr` on the initial interactive execution (`state.json.firstSeenAt` unset), identifying RunRay as a local agent profiler and confirming that no data leaves the local machine. The banner SHALL be suppressed under `--json`, non-TTY outputs, and repeated runs.

#### Scenario: Interactive first run
- GIVEN a machine running `runray` for the first time on a TTY
- WHEN `runray view` runs
- THEN the first-run banner is emitted to `stderr` describing the local agent profiler

### Requirement: Interactive no-data wizard
When `runray view` discovers zero sessions in standard locations on an interactive terminal (`stdin.isTTY && stderr.isTTY`), the CLI SHALL present an interactive menu via `@clack/prompts`:
1. Open the sample session (bundled demo).
2. Show setup guides (Claude Code, OpenCode, OTLP pipelines).
3. Point at a folder (custom log path).
4. Open the dashboard anyway (`--serve-empty`).
5. Exit.
The wizard copy SHALL emphasize agent profiling capabilities and how each agent writes logs locally. Non-TTY invocations SHALL preserve exit code 3 and machine-readable output.

#### Scenario: Wizard explains profiling
- GIVEN zero agent runs found on a TTY
- WHEN the wizard prompts the user
- THEN options and setup guides highlight agent trace discovery and profiling
