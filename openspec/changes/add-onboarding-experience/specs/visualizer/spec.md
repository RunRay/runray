# Delta for visualizer

## ADDED Requirements

### Requirement: Onboarding is live-mode only
Every onboarding surface — welcome dialog, both tours, and contextual hints — SHALL render only when the dashboard is served live from the local server, detected by the absence of embedded trace data. In export mode the system SHALL render no onboarding surface, SHALL issue no onboarding request, and SHALL NOT include onboarding code or its dependencies in the exported bundle. Exclusion SHALL be achieved at build time so the onboarding module subtree is eliminated from the export build, not merely left unreachable at runtime.

#### Scenario: Export renders no onboarding
- GIVEN an exported report opened from `file://`
- WHEN it loads
- THEN no welcome dialog, tour, or hint appears

#### Scenario: Export bundle excludes onboarding code
- GIVEN a built export template
- WHEN its contents are inspected
- THEN the positioning-library marker, the tour anchor attribute name, and the onboarding endpoint path are all absent

#### Scenario: Live bundle retains onboarding code
- GIVEN a built live bundle
- WHEN its contents are inspected
- THEN the onboarding code is present, and its export-forbidden markers are asserted only against the export template

#### Scenario: Export size budget held
- GIVEN a built export template
- WHEN its size is measured
- THEN it is below 1.5 MB

#### Scenario: Tour is not in the initial chunk
- GIVEN a built live bundle
- WHEN the initial chunk is inspected
- THEN the tour controller is loaded from a separate chunk

### Requirement: Welcome dialog on first live view
On the first live dashboard load where the welcome has not been dismissed and at least one run is present, the system SHALL render a single modal dialog stating how many sessions were read, that they came from logs the agents had already written, and that nothing left the machine — naming the mechanism rather than asserting safety. It SHALL offer a primary action starting the dashboard tour and a secondary action dismissing without a tour. Both actions SHALL record the dismissal; the secondary SHALL additionally record the dashboard tour as skipped. The dialog SHALL render only after onboarding state has resolved, never before.

#### Scenario: Welcome shown once
- GIVEN a live dashboard with runs and no recorded dismissal
- WHEN the dashboard loads
- THEN the welcome dialog is rendered with the real session count

#### Scenario: Welcome not shown again
- GIVEN a recorded welcome dismissal
- WHEN the dashboard loads
- THEN no welcome dialog is rendered

#### Scenario: No flash before state resolves
- GIVEN onboarding state has not yet been fetched
- WHEN the dashboard is rendering
- THEN the loading screen is shown and no welcome dialog appears until the fetch settles

#### Scenario: Onboarding endpoint unavailable
- GIVEN `GET /api/onboarding` fails or returns 404
- WHEN the dashboard loads
- THEN onboarding is silently disabled and the dashboard renders normally

#### Scenario: Zero runs yields the empty state, not a welcome
- GIVEN a live dashboard with no runs
- WHEN it loads
- THEN the empty state owns the screen and no welcome dialog or tour is offered

#### Scenario: Sample-session variant
- GIVEN the dashboard is serving the bundled sample session
- WHEN the welcome dialog renders
- THEN it identifies the data as a scrubbed sample rather than the viewer's own sessions, and retains the privacy statement and both actions

### Requirement: Dashboard tour
The system SHALL provide a four-step anchored tour of the dashboard covering: the distinction between money already burned and money a different setup would have saved; where spend went across runs and that elements act as filters; that one table row is one session and opens the forensic views; and that shortcuts and the command palette exist. Steps SHALL be anchored popovers rather than a full-screen overlay, SHALL show a step counter, and SHALL offer back, next, and skip actions. The tour SHALL NOT navigate the user between routes. Completion SHALL be recorded and SHALL present a single onward action opening the highest-cost visible session, falling back to the newest session when costs are unavailable.

#### Scenario: Tour runs to completion
- GIVEN the welcome dialog's primary action is chosen
- WHEN the user advances through every step
- THEN the tour is recorded as completed and the onward action is offered

#### Scenario: Tour does not navigate
- GIVEN the tour is in progress on the dashboard route
- WHEN the user advances between steps
- THEN the route does not change

#### Scenario: Skip is honoured permanently
- GIVEN the tour is in progress
- WHEN the user skips it
- THEN the tour is recorded as skipped and is not offered on subsequent loads

#### Scenario: Completed tour survives a port change
- GIVEN the dashboard tour was completed while served on one port
- WHEN the dashboard is served on a different port
- THEN the tour is not offered again

#### Scenario: Fallback onward action
- GIVEN a fully unpriced trace where no session has a cost
- WHEN the tour completes
- THEN the onward action opens the newest session

### Requirement: Run tour offered in place
The first time a run view is opened and the run tour has neither been completed nor skipped, the system SHALL offer a three-step tour through a small non-modal prompt rather than starting automatically. The steps SHALL cover: nesting as delegation and separate lanes as genuine parallelism; the cumulative burn line and jumping to a moment from it; and that activating a finding highlights its evidence spans in the waterfall. The final step's advance action SHALL activate the first finding rather than closing silently. Declining SHALL be recorded and SHALL prevent the offer from reappearing.

#### Scenario: Offer is non-modal
- GIVEN a run view is opened for the first time
- WHEN the offer appears
- THEN the run view remains interactive and no modal overlay blocks it

#### Scenario: Declining is permanent
- GIVEN the run tour offer is declined
- WHEN another run view is opened
- THEN no offer appears

#### Scenario: Final step performs the activation
- GIVEN the run tour has reached its final step on a run carrying findings
- WHEN the user advances
- THEN the first finding is activated and its evidence spans are highlighted in the waterfall

### Requirement: Tour anchors tolerate missing targets
Tour steps SHALL be anchored to stable markers on existing components. A step whose anchor is not present in the DOM SHALL be skipped, and the step counter total SHALL reflect the reduced number of steps. When an anchor exists inside a virtualized list but is scrolled out of view, the system SHALL scroll it into view before positioning, or skip the step; it SHALL NOT position a popover against a recycled row.

#### Scenario: Missing anchor skipped
- GIVEN a run with no findings, so the findings anchor is absent
- WHEN the run tour runs
- THEN that step is skipped, the counter total is reduced, and the tour still completes

#### Scenario: Virtualized anchor scrolled into view
- GIVEN a waterfall anchor outside the rendered virtual window
- WHEN its step is reached
- THEN the anchor is scrolled into view before the popover is positioned

### Requirement: Onboarding user interface accessibility
Onboarding dialogs and popovers SHALL trap focus, expose an accessible dialog role and label, place initial focus on a control within the surface, and close on `Escape` with the same effect as the dismissing action. Every step SHALL be reachable and operable by keyboard alone. Animation SHALL use only transform and opacity, and SHALL be suppressed when the user prefers reduced motion, with the surface remaining fully usable.

#### Scenario: Keyboard-only completion
- GIVEN the welcome dialog is open
- WHEN the user operates only the keyboard
- THEN they can start the tour, advance through every step, and reach completion

#### Scenario: Escape dismisses
- GIVEN any onboarding surface is open
- WHEN `Escape` is pressed
- THEN the surface closes with the same recorded outcome as its dismissing action

#### Scenario: Reduced motion honoured
- GIVEN the user prefers reduced motion
- WHEN the tour advances
- THEN step transitions are instantaneous and every step remains operable

### Requirement: Contextual first-time hints
The system SHALL show one-shot dismissible hints, at most one visible at a time, on first encounter with: the time view's wall-clock decomposition, the what-if repricing panel, comparing two runs, limit-based units when a limit window is configured, unpriced-model coverage notices, and redaction before export. Each hint SHALL be dismissible with an accessibly named control and SHALL not reappear once dismissed. Hints for the limit window SHALL express tokens and share of limit rather than a currency amount.

#### Scenario: One hint at a time
- GIVEN two hint triggers fire in the same view
- WHEN the view renders
- THEN only one hint is visible

#### Scenario: Dismissal persists
- GIVEN a hint has been dismissed
- WHEN its trigger condition occurs again in the same browser
- THEN the hint does not reappear

#### Scenario: Limit-mode hint avoids currency
- GIVEN a configured limit window
- WHEN the limit-mode hint renders
- THEN it describes tokens and share of limit and states no currency amount

### Requirement: Empty state reports the roots that were checked
When the dashboard renders with zero runs in live mode, the existing empty state SHALL additionally list the discovery roots the CLI checked with their verdicts, supplied over the view-configuration endpoint. The empty state SHALL be reachable in normal use — reached whenever the user asks for a dashboard despite having no sessions — and not only after runs roll off during a watch session. This list SHALL be live-mode only and SHALL NEVER be present in an exported report. When no checked roots were supplied, the existing empty state SHALL render unchanged rather than showing an empty list.

#### Scenario: Roots listed in the empty state
- GIVEN a live dashboard served with zero runs and checked roots supplied
- WHEN the empty state renders
- THEN each checked root is listed with its verdict

#### Scenario: Reached by explicit request
- GIVEN the user asks for a dashboard on a machine with no sessions
- WHEN the dashboard loads
- THEN the empty state renders with the checked roots and no welcome dialog or tour is offered

#### Scenario: No roots supplied
- GIVEN a live dashboard with zero runs and no checked roots in the view configuration
- WHEN the empty state renders
- THEN it renders its existing content with no roots section

#### Scenario: Roots absent from exports
- GIVEN an exported report
- WHEN its payload is inspected
- THEN it contains no discovery root and no filesystem path

### Requirement: Export provenance strip
When the dashboard renders from embedded data, the system SHALL display a single static line at the top of the shell stating that the file is an exported RunRay report, the number of sessions it covers, the generation date, the generating version, that it is read-only, and whether prompt text was redacted. The strip SHALL carry no dismiss control and no state. When the report contains unredacted prompt text, that fact SHALL be rendered in a visually distinct warning treatment. A second, quieter line SHALL state that the report was generated locally and that nothing in it was uploaded. The strip SHALL contain no filesystem path.

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
