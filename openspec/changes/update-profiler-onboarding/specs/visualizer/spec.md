# Delta for visualizer

## MODIFIED Requirements

### Requirement: Welcome dialog
The visualizer SHALL display an accessible, focus-trapped welcome dialog on initial load when onboarding is enabled and uncompleted, presenting the total session count and date span from discovered agent traces, stating the 100% local privacy guarantee, and framing RunRay as an agent profiler (evaluating latency, tool/MCP execution, subagents, and cost efficiency). The dialog SHALL offer a primary action to begin the guided tour and a secondary action to explore directly. When serving bundled sample data (`runray demo`), the dialog SHALL display the sample variant clarifying that data is scrubbed. In single-file export mode (`live === false`), the welcome dialog SHALL NEVER be rendered.

#### Scenario: Real session first run
- GIVEN valid onboarding state with `welcomeDismissedAt` unset
- WHEN the dashboard loads with one or more discovered runs
- THEN the welcome dialog is presented with session counts, profiling capabilities description, and local privacy assurance

#### Scenario: Sample demo session first run
- GIVEN `runray demo` serves bundled sample data
- WHEN the dashboard loads
- THEN the welcome dialog displays the sample variant indicating scrubbed agent structure

### Requirement: Guided tours
The visualizer SHALL provide an anchored, multi-step tour for the main dashboard and an interactive tour for individual session profiling.
- The **Dashboard Tour** SHALL cover:
  1. Profiling summary KPIs (burned spend, potential savings, cache efficiency).
  2. Workload & Tool distribution (models and MCP tools).
  3. Session Explorer table (duration, error indicators, cost).
  4. Command Palette and keyboard navigation.
  Upon completion, it SHALL provide a direct call-to-action navigating to profile the most critical session.
- The **Run Profiler Tour** SHALL be offered non-modally upon first viewing an agent session and SHALL cover:
  1. Delegation hierarchy & concurrency lanes (`waterfall`).
  2. Wall-clock latency decomposition (`time` tab).
  3. Actor-based error triage (`errors` tab).
  4. Targeted findings and What-If simulation (`insights-strip` / `what-if`).
- Both tours SHALL support keyboard navigation (`Esc` to skip, arrow keys to navigate), respect `prefers-reduced-motion`, handle missing anchors gracefully without freezing, and NEVER render in exported reports.

#### Scenario: Dashboard tour completion navigates to profiling
- GIVEN the user completes the final step of the dashboard tour
- WHEN the completion button is clicked
- THEN the visualizer navigates to the highest-impact session for profiling

#### Scenario: Run tour covers profiler tabs
- GIVEN the user accepts the run tour offer
- WHEN advancing through the tour
- THEN the tour introduces the Waterfall delegation tree, Time view latency decomposition, and Errors view triage

## ADDED Requirements

### Requirement: First profile checklist
The visualizer SHALL render a collapsible, non-modal **First Profile Checklist** widget when onboarding is enabled. To capitalize on the Endowed Progress Effect, step 1 (*"Agent traces discovered and parsed"*) SHALL be pre-completed (25% progress). Subsequent steps SHALL track real user interaction across profiling dimensions:
1. Inspect delegation tree and concurrency in Timeline.
2. Diagnose execution latency in Time view.
3. Review error triage or simulate What-If repricing.
The checklist SHALL allow permanent dismissal at any time, SHALL update progress reactively, and SHALL NOT render in export mode.

#### Scenario: Endowed progress initial state
- GIVEN a new user opens the dashboard with discovered runs
- WHEN the checklist renders
- THEN step 1 is checked and progress displays 25% complete

#### Scenario: Interactive milestone completion
- GIVEN an active onboarding checklist
- WHEN the user navigates to the Time view tab of a session
- THEN the latency milestone is marked complete and progress updates
