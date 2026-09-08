# Design: update-profiler-onboarding

## Context

RunRay has transitioned from an MVP token audit tool into a deep **Agent Profiler**. The application now features:
- **Time View**: Wall-clock decomposition of agent thinking vs tool/MCP latency, concurrency metrics, and tool execution distribution.
- **Errors View**: Structured triage of tool and environment failures by actor (exploratory, environment, terminal).
- **Waste & Opportunity View**: 12 insight rules differentiating burned money from structural optimization opportunities.
- **What-If Simulation**: Interactive client-side model repricing and tier ladder evaluation.
- **Subtree Economics & Nested Treemap**: Concurrency lanes and token density analysis across nested delegation trees.
- **Run Diff**: Comparative profiling across multiple runs of the same task.

However, the existing onboarding experience was authored prior to these additions. Its copy, guided tours, and completion actions are exclusively focused on token costs, missing the core profiler value proposition.

This design updates the three onboarding surfaces to reflect end-to-end agent profiling while respecting all project architectural invariants.

```
terminal            SURFACE A — CLI first run
`runray view` ─▶ profiler banner · no-data wizard · profiling setup guides
                                    │ starts server, opens browser
                                    ▼
browser (live)      SURFACE B — dashboard & profiler first run
127.0.0.1:41xx    ─▶ welcome dialog · dashboard tour · run profiler tour
                     first profile checklist · contextual hints
                                    │ GET/POST /api/onboarding
                                    ▼
                    SURFACE C — state
                    ~/.config/runray/state.json  (port-independent, local, 0600)

file:// report.html ─▶ static report. Zero onboarding code or dependencies emitted.
```

---

## Goals / Non-Goals

### Goals
- Re-align all user-facing onboarding surfaces to emphasize **Agent Profiling** (latency, errors, delegation, efficiency).
- Update the **Run Tour** to guide users through the multi-tab profiler layout: Timeline Waterfall, Time view, Errors view, and Optimization (Waste/What-If).
- Introduce a lightweight, non-modal **First Profile Checklist** widget leveraging the **Endowed Progress Effect** (starting at 25% completed).
- Support subscription developers (Priya, Claude Max plan) by highlighting token and limit workflows alongside dollar figures.
- Retain complete export purity: zero onboarding markup, state calls, or bundle weight in `dist-export/index.html`.
- Maintain strict backward compatibility for `~/.config/runray/state.json`.

### Non-Goals
- Adding telemetry or remote analytics (strictly forbidden by `AGENTS.md`).
- Altering the frozen `TraceFile` schema.
- Forcing modal takeovers that block user interaction with the dashboard or profiler panes.

---

## Decisions

### D1: Profiler-First Copy and Activation Criteria
- **Decision**: Update user-visible strings in `docs/12-ONBOARDING-COPY.md` and UI components to describe RunRay as an agent profiler.
- **Aha Moment Definition**: Re-anchor the primary activation milestone to *uncovering an actionable execution bottleneck* (identifying slow tools in Time view, an error loop in Errors view, or an optimization in What-If/Insights).
- **Rationale**: Profiling resonates with both API-paying developers and subscription plan users.

### D2: Four-Step Profiler Dimensions Tour
- **Decision**: Expand the Run Tour from a timeline-only focus to introduce the four profiler dimensions:
  1. `waterfall`: Delegation & Concurrency (subagent nesting and parallel lanes).
  2. `time`: Execution Latency (wall-clock time split between model generation and tool/MCP wait).
  3. `errors`: Error Triage (categorized by actor).
  4. `insights-strip` / `what-if`: Structural Optimization & Repricing.
- **Rationale**: Ensures users discover the core profiling views immediately upon inspecting their first session.

### D3: Endowed Progress First Profile Checklist
- **Decision**: Provide an unobtrusive, collapsible checklist in the UI tracking:
  - `[x]` Step 1: Agent traces discovered and indexed (Pre-completed at 25% progress).
  - `[ ]` Step 2: Inspect delegation tree & concurrency in Timeline.
  - `[ ]` Step 3: Diagnose latency breakdown in Time view.
  - `[ ]` Step 4: Review error triage or simulate What-If repricing.
- **Rationale**: Research in onboarding CRO shows that starting users with endowed progress increases task completion by ~40%.

### D4: Export Bundle Exclusion
- **Decision**: All onboarding components (`WelcomeDialog`, `DashboardTour`, `RunTour`, `OnboardingChecklist`) continue to be gated behind `__RUNRAY_ONBOARDING__` build constants.
- **Rationale**: `dist-export/index.html` has a strict budget (< 1.5 MB). Onboarding code is tree-shaken from single-file exports.

---

## Surface Designs

### Surface A: CLI First Run
- Banner text:
  ```
  RunRay 0.1.0 — local agent profiler. Nothing leaves this machine.
  Read N session(s) from M location(s).
  ```
- Setup guides: Highlight where Claude Code and OpenCode write trace logs and explain how custom agents export OTLP/JSON.
- Completion hints: Suggest `runray view`, `runray diff`, `--limit-window`, and `--watch`.

### Surface B: Dashboard & Run Profiler UI
- **Welcome Dialog**: Native `<dialog>`, focus trap, `Esc` dismissible. Presents real session counts and date span. Frames capabilities: latency profiling, error triage, subagent hierarchy, and token efficiency.
- **Dashboard Tour**: 4 anchored steps:
  1. `savings`: Burned spend, potential savings, cache efficiency.
  2. `overview-trend`: Model and tool/MCP distribution.
  3. `sessions-table`: Session Explorer with duration, errors, and cost.
  4. `help-button`: Command Palette (⌘K) and shortcuts.
  Completion CTA: `[ Profile latest session → ]` navigating to the newest or highest-impact run.
- **Run Profiler Tour**: Offered non-modally upon first viewing an agent session. Guides through Delegation, Latency, Errors, and Optimization.
- **First Profile Checklist**: Docked in the viewport corner. Dismissible permanently via `✕`.

### Surface C: Onboarding State Contract
- Schema extended:
  ```ts
  export interface OnboardingBlock {
    welcomeDismissedAt?: string | null;
    tours?: Record<string, string>;
    hints?: string[];
    checklist?: Record<string, boolean>;
  }
  ```
- `POST /api/onboarding` handles shallow merging of `checklist`.
- File writes remain atomic, mode `0600`, degrade-never-block.
