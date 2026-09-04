# Delta for visualizer

## MODIFIED Requirements

### Requirement: Local serving and single-file export
The system SHALL serve the dashboard only on 127.0.0.1 and SHALL export any run as one self-contained HTML file that renders offline from `file://`; exporting unredacted content SHALL require explicit confirmation. Export SHALL be discoverable from the dashboard, which SHALL present the same three sanitization profiles the CLI offers and hand the user the `runray export` command that produces the chosen one. The dashboard SHALL NOT generate a report, request one over HTTP, or remove, mask, or filter any content itself: report generation happens only in a `runray export` process, and sanitization happens only in `packages/core`.

#### Scenario: Offline export
- GIVEN an exported report.html
- WHEN it is opened from disk with networking disabled
- THEN all views render fully

#### Scenario: Redaction guard
- GIVEN an export command without `--redact`
- WHEN run non-interactively without `--yes`
- THEN the export aborts with a warning that the file would contain prompt text

#### Scenario: The dashboard produces a command, not a file
- GIVEN a user exporting from the dashboard
- WHEN a profile is chosen
- THEN the dashboard presents the command that produces it, issues no network request, and writes no file

### Requirement: Export provenance strip
When the dashboard renders from embedded data, the system SHALL display a single static line at the top of the shell stating that the file is an exported RunRay report, the number of sessions it covers, the generation date, the generating version, that it is read-only, and which sanitization profile was applied — naming, independently, whether prompt text was redacted, whether identifiers were scrubbed, and whether spans were pruned. The strip SHALL carry no dismiss control and no state. The strip SHALL read the applied profile from the export manifest but SHALL retain its own inspection of the embedded trace as a cross-check: when the manifest claims prompt text was redacted and prompt text is nonetheless present, the strip SHALL report that the file contains prompt text. The strip SHALL therefore be able to under-promise but never over-promise. When the report contains unredacted prompt text, that fact SHALL be rendered in a visually distinct warning treatment. A second, quieter line SHALL state that the report was generated locally and that nothing in it was uploaded. The strip SHALL contain no filesystem path.

#### Scenario: Strip present in exports only
- GIVEN an exported report
- WHEN it renders
- THEN the provenance strip is shown; and when the dashboard is served live, it is not

#### Scenario: Unredacted export is marked distinctly
- GIVEN a report exported without redaction
- WHEN the provenance strip renders
- THEN it states that the file contains prompt text using a warning treatment distinct from the redacted variant

#### Scenario: No filesystem path in the strip
- GIVEN any exported report
- WHEN the provenance strip renders
- THEN it contains no filesystem path

#### Scenario: Sanitized export states what was stripped
- GIVEN a report exported under the `sanitized` profile
- WHEN the provenance strip renders
- THEN it names the profile and states that prompt text was redacted and identifiers were scrubbed

#### Scenario: A manifest that over-claims is overridden
- GIVEN a manifest claiming prompt text was redacted while the embedded trace contains prompt text
- WHEN the provenance strip renders
- THEN it reports that the file contains prompt text, in the warning treatment

## ADDED Requirements

### Requirement: Export trigger and profile dialog
The system SHALL offer an export trigger in the top bar and as a command-palette action, both opening one dialog that presents the three profiles with the consequence of each stated in plain language: what is stripped and what is preserved. The dialog SHALL default to the sanitized profile, SHALL make the full-trace profile selectable with a visible caution that the file will contain prompt text, and SHALL state that generation happens locally with no upload. Selecting a profile SHALL update the rendered command in place, so the mapping between a choice and the flag that expresses it is visible. The trigger and dialog SHALL be live-mode only and SHALL NOT appear in an exported report.

#### Scenario: Reachable from both surfaces
- GIVEN a dashboard served live
- WHEN the user activates the top-bar export control, or the export action in the command palette
- THEN the same profile dialog opens

#### Scenario: Sanitized is the default selection
- GIVEN the export dialog has just opened
- WHEN no selection has been made
- THEN the sanitized profile is preselected

#### Scenario: Full trace is marked as containing prompt text
- GIVEN the export dialog
- WHEN the full-trace profile is selected
- THEN a caution states that the file will contain prompt text and local paths

#### Scenario: Absent from exported reports
- GIVEN an exported report opened from `file://`
- WHEN it renders
- THEN no export trigger and no export dialog is present

### Requirement: The rendered command is exact and never overstates its scope
The dialog SHALL render an executable `runray export` invocation for the current selection: the run id when a single run is in view (`state.route.runId`), the profile flag for the chosen profile, and an output path. The command SHALL express only what the CLI can express. When viewing a single run, the command SHALL narrow to that run id. When on a multi-run view, the dialog SHALL express all applicable CLI-supported filters (`--since`, `--source`), state the exact scope the CLI command covers, and never quietly export runs without stating the command's true scope. The system SHALL NOT render a command whose flags it does not support.

#### Scenario: Single run in view
- GIVEN a run view
- WHEN the export dialog opens with the sanitized profile selected
- THEN the command names that run's id and the flag for that profile

#### Scenario: A filter the CLI cannot express
- GIVEN a multi-run view with a store-only filter (e.g. project filter)
- WHEN the export dialog opens
- THEN the dialog clearly states the scope the CLI command will export (matching CLI flags) without misrepresenting it as an in-browser filter export

#### Scenario: Command scope is stated
- GIVEN any rendered command
- WHEN the dialog renders it
- THEN the dialog states how many runs the command will export

### Requirement: Export dialog interaction contract
The export dialog SHALL be hand-rolled against the existing design tokens, matching the accessibility patterns of the help sheet and command palette: focus moves into the dialog on open and is trapped while it is open, `Esc` closes it and returns focus to the trigger, every option is reachable and selectable by keyboard, and the dialog is labelled for assistive technology. Every interactive element SHALL have distinct hover, `focus-visible`, and active states. The rendered command SHALL be copyable with one control, SHALL confirm a successful copy, and SHALL remain selectable as text so a denied or unavailable clipboard permission leaves a manual path. The command SHALL be readable without horizontal scrolling at the dialog's width.

#### Scenario: Keyboard-only handoff
- GIVEN the export dialog is open
- WHEN the user selects a profile and copies the command using only the keyboard
- THEN the command for that profile is on the clipboard

#### Scenario: Escape restores focus
- GIVEN the export dialog is open
- WHEN `Esc` is pressed
- THEN the dialog closes and focus returns to the control that opened it

#### Scenario: Copy is confirmed
- GIVEN the export dialog is open
- WHEN the copy control is activated
- THEN the interface confirms that the command was copied

#### Scenario: Clipboard unavailable
- GIVEN clipboard access is denied
- WHEN the user activates the copy control
- THEN the command remains selectable as text and the failure is stated rather than silent

### Requirement: Views render correctly against a metadata-only payload
Every view SHALL render without error when the embedded trace carries only container spans. Overview cards, the per-model cost breakdown, counts, cache hit-rate, and insight badges SHALL render from run totals and findings. Views that require leaf spans — the waterfall's turn detail, the transcript pane, and the inspector — SHALL render an explanatory empty state naming the metadata-only profile as the reason, rather than an error, a blank panel, or a zero. The waterfall SHALL still render its session bars. Selecting a finding whose evidence was re-anchored SHALL highlight the surviving container span rather than failing to resolve.

#### Scenario: Overview renders from totals alone
- GIVEN a metadata-only report
- WHEN the overview renders
- THEN cost, token, count, and cache figures are shown, and the per-model breakdown is populated

#### Scenario: Leaf-dependent views explain themselves
- GIVEN a metadata-only report
- WHEN the inspector or transcript pane is opened
- THEN it states that the profile omits span detail, and shows no error and no misleading zero

#### Scenario: Waterfall keeps session bars
- GIVEN a metadata-only report
- WHEN the waterfall renders
- THEN one bar per session is shown

#### Scenario: Re-anchored evidence still highlights
- GIVEN a finding in a metadata-only report whose evidence was re-anchored to its session
- WHEN the finding is selected
- THEN the session span is highlighted and no unresolved-reference error occurs
