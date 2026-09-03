# Delta for cli

## MODIFIED Requirements

### Requirement: Privacy-preserving defaults
The system SHALL make no network requests during `view`, `list`, `export`, or `demo`; the only permitted network operation SHALL be an explicit `pricing --refresh`. A `--redact` option SHALL strip prompt and output text in the core pipeline while preserving structure and token counts. A `--scrub-paths` option SHALL replace local identifiers — project paths and names, git branch names, transcript file paths, and tool target basenames — with stable pseudonyms in the core pipeline while preserving structure, token counts, and insight findings. Both options SHALL be applied in `packages/core`; neither SHALL be implemented as a filter in `packages/ui` or in the server layer.

#### Scenario: Offline operation
- GIVEN networking is unavailable
- WHEN any command except `pricing --refresh` runs
- THEN it completes successfully using bundled pricing data

#### Scenario: Redaction and scrubbing are independent
- GIVEN a run with prompt text and a real project path
- WHEN `runray export --scrub-paths` runs without `--redact`
- THEN identifiers are pseudonymized while prompt text remains, and the unredacted-export confirmation still applies

## ADDED Requirements

### Requirement: Export sanitization flags
`runray export` SHALL accept `--redact`, `--scrub-paths`, `--anonymize`, and `--metadata-only`, and SHALL accept `--redact-prompts` as a documented alias of `--redact`. `--anonymize` SHALL be equivalent to `--redact --scrub-paths`. `--metadata-only` SHALL imply both and SHALL additionally prune the span tree. The flags SHALL be composable in any combination and SHALL resolve to a core profile (`full` when neither text nor identifier stripping is requested or when standalone flags are used, `sanitized` when both are, `metadata-only` when pruning is requested), while the manifest independently records the three boolean states (`textRedacted`, `pathsScrubbed`, `spansPruned`). Passing a flag twice or passing an implied flag redundantly SHALL NOT be an error. `--redact` SHALL retain its exact current meaning, and the existing `redact` key in `runray.config.json` SHALL continue to work unchanged.

#### Scenario: Anonymize is the composite preset
- GIVEN a discovered run
- WHEN `runray export --anonymize -o report.html` runs
- THEN the output is identical to `runray export --redact --scrub-paths -o report.html`

#### Scenario: Alias is exactly the existing flag
- GIVEN a discovered run
- WHEN `runray export --redact-prompts -o report.html` runs
- THEN the output is identical to `runray export --redact -o report.html`

#### Scenario: Metadata-only implies the rest
- GIVEN a discovered run
- WHEN `runray export --metadata-only -o report.html` runs
- THEN the exported trace carries no prompt text, no local identifier, and no leaf spans

#### Scenario: Existing config key is honoured
- GIVEN a `runray.config.json` with `redact: true`
- WHEN `runray export -o report.html` runs with no privacy flag
- THEN prompt text is stripped exactly as it is today

### Requirement: Consent guard responds to text redaction only
The unredacted-export confirmation SHALL be satisfied by text redaction, by `--yes`, or by an interactive confirmation, and SHALL NOT be satisfied by `--scrub-paths` alone — the guard exists to protect prompt text. An export whose resolved profile strips text SHALL never prompt. A non-interactive export that would contain prompt text and carries no `--yes` SHALL abort with the existing warning and exit code.

#### Scenario: Sanitized export never prompts
- GIVEN a non-interactive shell
- WHEN `runray export --anonymize -o report.html` runs without `--yes`
- THEN the export completes with no prompt and exit code 0

#### Scenario: Scrubbing paths does not waive the prompt-text guard
- GIVEN a non-interactive shell
- WHEN `runray export --scrub-paths -o report.html` runs without `--yes`
- THEN the export aborts with the unredacted-export warning

### Requirement: Export reports the applied profile
On success, `runray export` SHALL name the applied profile on stderr alongside the existing summary, so a scripted export leaves an auditable record of what was stripped. `--json` stdout output SHALL remain clean.

#### Scenario: Profile named on success
- GIVEN a successful `runray export --metadata-only`
- WHEN the command finishes
- THEN stderr states the applied profile and stdout carries no additional output

### Requirement: Flag vocabulary is stable enough to be quoted back to the user
The dashboard renders `runray export` invocations for the user to run, so the flag names, the `[target] -o <file>` argument shape, and the run-id prefix resolution SHALL remain the contract the dashboard generates against. A rendered command SHALL be executable as shown, and the system SHALL resolve a run-id prefix in `export` exactly as it does today: exact id first, then unique prefix, otherwise exit 3 with a `runray list` hint.

#### Scenario: A quoted command runs as shown
- GIVEN a command rendered by the dashboard for a run it is displaying
- WHEN the user runs it verbatim in a terminal
- THEN it exports that run with the named profile and exits 0

#### Scenario: Ambiguous prefix still fails loudly
- GIVEN a rendered command carrying a run-id prefix that has since become ambiguous
- WHEN it runs
- THEN it exits 3 and points at `runray list`

### Requirement: No export endpoint is added to the local server
The local server SHALL NOT gain an export endpoint. Report generation SHALL happen only in a `runray export` process, and no HTTP surface SHALL accept a sanitization profile, return a generated report, or write a report file.

#### Scenario: No route generates a report
- GIVEN the local server
- WHEN any request is made to it
- THEN no response body is a generated report and no report file is written
