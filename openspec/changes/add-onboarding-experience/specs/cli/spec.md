# Delta for cli

## MODIFIED Requirements

### Requirement: Command surface
The system SHALL expose `view`, `list`, `export`, `demo`, and `pricing` commands with documented flags, and SHALL use exit codes: 0 success, 1 execution error, 3 no data found. When no data is found, the outcome SHALL depend on whether the user explicitly asked for a dashboard anyway: a wizard branch or flag that ends in a served dashboard SHALL exit 0, and every other no-data outcome SHALL exit 3. The system SHALL NOT convert an unrequested no-data result into a success.

#### Scenario: No data
- GIVEN a machine with no supported agent logs and no interactive terminal
- WHEN `runray view` runs
- THEN the process exits with code 3 and prints the roots that were checked and the commands that would generate data

#### Scenario: No data recovered interactively
- GIVEN a machine with no supported agent logs and an interactive terminal
- WHEN `runray view` runs and the user selects a wizard branch that serves a dashboard
- THEN the process exits with code 0

#### Scenario: Scripting output
- GIVEN discovered runs
- WHEN `runray list --json` runs
- THEN a machine-readable summary (id, source, timing, tokens, cost) is printed to stdout

## ADDED Requirements

### Requirement: Discovery reports the roots it checked
Discovery SHALL report the scan roots it resolved, in scan order, each with a verdict of `missing` (no such directory), `empty` (exists but yielded no sessions), or `unreadable` (exists but could not be read). The reported roots SHALL be exactly those the scan used — the system SHALL NOT list a location it did not check. Reporting SHALL NOT add, remove, or reorder any root relative to current discovery behavior, and SHALL NOT alter adapter, normalizer, or cost-engine output.

#### Scenario: Zero-config scan with no data
- GIVEN a machine where no default agent log root exists
- WHEN `runray view` finds no runs
- THEN each default root is listed with the verdict `missing`

#### Scenario: Existing but empty root
- GIVEN a default root that exists and contains no sessions
- WHEN discovery completes with no runs
- THEN that root is listed with the verdict `empty`

#### Scenario: Permission failure distinguished
- GIVEN a root that exists but cannot be read by the current user
- WHEN discovery completes with no runs
- THEN that root is listed with the verdict `unreadable` and a line advising a permission check or a directly supplied folder

#### Scenario: Source filter disclosed
- GIVEN `--source claude` narrows the scan
- WHEN the checked roots are listed
- THEN the output states that the scan was limited to that source

#### Scenario: Paths abbreviated in terminal output
- GIVEN a root under the user's home directory
- WHEN it is printed
- THEN it is shown `~`-abbreviated

### Requirement: First-run banner
On the first invocation of `view`, `demo`, or `list` on a machine, the system SHALL print a banner of at most three lines to stderr stating that nothing leaves the machine, how many sessions were read from how many locations, and the pricing snapshot in effect. The banner SHALL be printed at most once per machine, SHALL be suppressed under `--json` and when stderr is not a TTY, and SHALL NEVER be written to stdout.

#### Scenario: Printed once
- GIVEN no prior first-run marker
- WHEN `runray view` runs twice in succession
- THEN the banner appears on the first run only

#### Scenario: Never on the data channel
- GIVEN no prior first-run marker
- WHEN `runray list --json` runs
- THEN stdout contains only the machine-readable summary and no banner

#### Scenario: Colour disabled
- GIVEN `NO_COLOR` is set
- WHEN the banner prints
- THEN it prints without colour escape sequences and remains readable

### Requirement: Interactive no-data recovery wizard
When `view` discovers no runs, `stdin` and `stderr` are both TTYs, and no explicit path argument was supplied, the system SHALL present an interactive menu offering: open the bundled sample session, show setup guides, point at a folder, open the dashboard with no sessions, or exit. Cancelling — by `Escape`, `Ctrl-C`, or empty input — SHALL behave as the exit branch. The wizard SHALL NOT run when any of those conditions fails.

#### Scenario: Wizard offered
- GIVEN no runs are discovered on an interactive terminal with no path argument
- WHEN `runray view` runs
- THEN the five-option menu is presented on stderr

#### Scenario: Explicit wrong path is not a discovery failure
- GIVEN the user supplies an explicit path argument that contains no sessions
- WHEN `runray view <path>` runs on an interactive terminal
- THEN no wizard is presented, the checked-roots output is printed, and the process exits 3

#### Scenario: Non-interactive invocation unaffected
- GIVEN no runs are discovered and stderr is not a TTY
- WHEN `runray view` runs
- THEN no prompt is presented, the checked-roots output is written to stderr, and the process exits 3

#### Scenario: Cancellation
- GIVEN the wizard menu is presented
- WHEN the user presses `Ctrl-C`
- THEN the checked-roots output is printed and the process exits 3

### Requirement: Wizard sample-session branch
Selecting the sample-session branch SHALL load the bundled scrubbed sample, serve it, open the browser, record that the sample has been seen, and exit 0. The served dashboard SHALL make it visible that the data is a sample rather than the user's own sessions.

#### Scenario: Sample served
- GIVEN the wizard menu is presented
- WHEN the user selects the sample-session branch
- THEN a dashboard is served on loopback and the process exits 0

#### Scenario: Sample is labelled
- GIVEN the sample session is served through the wizard
- WHEN the dashboard renders
- THEN it identifies the data as a bundled sample

### Requirement: Wizard setup guides
Selecting the setup-guides branch SHALL print per-source guidance covering Claude Code, OpenCode, and OTLP import, SHALL state that all three are read locally with no network calls, and SHALL return to the menu rather than exiting.

#### Scenario: Guides shown then menu returns
- GIVEN the wizard menu is presented
- WHEN the user selects the setup-guides branch
- THEN the guides are printed and the menu is presented again

### Requirement: Wizard custom-path branch
Selecting the custom-path branch SHALL prompt for a folder or session file and re-scan it. When runs are found, the system SHALL serve the dashboard, print the equivalent `runray view <path>` invocation and a `runray.config.json` snippet, and exit 0. When nothing readable is found, the system SHALL explain what was expected and re-prompt, for a maximum of three attempts, after which it SHALL print the checked-roots output and exit 3. The system SHALL NOT write the supplied path to any configuration file.

#### Scenario: Custom path succeeds
- GIVEN the user supplies a folder containing readable sessions
- WHEN the re-scan completes
- THEN a dashboard is served and the process exits 0

#### Scenario: Configuration is printed, not written
- GIVEN a successful custom-path scan
- WHEN the invocation completes
- THEN the configuration snippet is printed to stderr and no configuration file is created or modified

#### Scenario: Attempts exhausted
- GIVEN three consecutive supplied paths contain nothing readable
- WHEN the third attempt fails
- THEN the system stops prompting, prints the checked-roots output, and exits 3

### Requirement: Serving a dashboard with no sessions on request
The system SHALL support serving the dashboard with zero runs when the user explicitly requests it, via a `--serve-empty` flag on `view` and via the wizard's open-the-dashboard branch. In that case the system SHALL start the local server, open the browser, supply the checked discovery roots to the dashboard, and exit 0 when the server is stopped. Without an explicit request, a no-data `view` SHALL NOT start a server, and SHALL exit 3 as specified by the command surface. `--serve-empty` SHALL be honoured on non-interactive invocations, because it is an explicit instruction rather than a recovery guess.

#### Scenario: Flag serves the empty dashboard
- GIVEN a machine where discovery finds no runs
- WHEN `runray view --serve-empty` runs
- THEN the local server starts, the dashboard renders its empty state, and the exit code is 0

#### Scenario: Wizard branch serves the empty dashboard
- GIVEN the wizard menu is presented
- WHEN the user selects the open-the-dashboard branch
- THEN the local server starts with zero runs and the checked roots are available to the dashboard

#### Scenario: Empty serving is opt-in only
- GIVEN a machine where discovery finds no runs and no explicit request was made
- WHEN `runray view` runs non-interactively
- THEN no server is started and the exit code is 3

#### Scenario: Flag honoured without a terminal
- GIVEN stderr is not a TTY and discovery finds no runs
- WHEN `runray view --serve-empty` runs
- THEN the server starts, no wizard is presented, and the exit code is 0

### Requirement: Demo to own-data bridge
After `demo` prints its server line, the system SHALL print exactly one line naming the transition to the user's own sessions, and SHALL record that the demo has been seen. When the demo has already been seen, the line SHALL be suppressed.

#### Scenario: Bridge shown once
- GIVEN the demo has never been run on this machine
- WHEN `runray demo` runs
- THEN the bridge line is printed after the server line

#### Scenario: Bridge suppressed on re-run
- GIVEN the demo has already been seen
- WHEN `runray demo` runs again
- THEN no bridge line is printed

### Requirement: Next-step hints after a first successful view
After the first successful `view` that serves runs, the system SHALL print at most two next-step hints to stderr and SHALL record them so they are never printed again. Eligible hints, in priority order, are: dashboard shortcuts (always eligible); `diff` when at least two runs were discovered; `--watch` when a discovered run is less than ten minutes old; and redacted `export` when at least one insight fired.

Two conditions that are normal rather than broken SHALL additionally receive one line of first-run framing, printed adjacent to the warning they explain; neither line SHALL consume a hint slot. When unpriced models are present, the framing SHALL state that unpriced models are listed rather than guessed. When discovery reported per-candidate errors while still loading other runs, the framing SHALL state that the failure was contained to those candidates and that the remaining sessions loaded, so an expected condition is not read as a broken install.

#### Scenario: Cap enforced
- GIVEN a first successful view where every hint condition holds
- WHEN hints are printed
- THEN exactly two hints are printed

#### Scenario: Hints not repeated
- GIVEN hints were printed on a previous successful view
- WHEN `runray view` runs again
- THEN no hints are printed

#### Scenario: Coverage framing is additive
- GIVEN a trace containing unpriced models and two eligible hints
- WHEN output is written
- THEN two hints and the coverage explanation are all present

#### Scenario: Contained discovery failure is framed
- GIVEN one candidate fails to parse while other runs load successfully
- WHEN the first successful `view` writes its output
- THEN the existing per-candidate error is accompanied by one line stating the failure was contained and the other sessions loaded

#### Scenario: Framing lines consume no hint slots
- GIVEN a first successful view with unpriced models, a contained discovery failure, and two eligible hints
- WHEN output is written
- THEN exactly two hints are printed alongside both framing lines

### Requirement: Onboarding output never contaminates machine-readable output
All onboarding output — banner, wizard, checked roots, bridge line, and hints — SHALL be written to stderr. For any invocation with `--json`, or where stderr is not a TTY, stdout SHALL be byte-identical to the output the same invocation produces without onboarding present.

#### Scenario: JSON listing unchanged
- GIVEN a machine with no discovered runs
- WHEN `runray list --json` runs
- THEN stdout contains an empty JSON array and nothing else

#### Scenario: Diff JSON unchanged
- GIVEN two discovered runs
- WHEN `runray diff <runA> <runB> --json` runs
- THEN stdout contains only the diff document
