# Proposal: update-profiler-onboarding

## Why

The initial onboarding implementation (`add-onboarding-experience`) was authored when RunRay was primarily a token cost tracking and waste audit tool. Its narrative, tours, and activation gates are fixated almost exclusively on financial metrics:
- The Welcome dialog and dashboard tour lead with *"Two numbers, not one: burned spend from retries or cache breaks"*.
- The tour completion CTA explicitly directs: *"That's the map. The money is inside the sessions. [ Open the priciest session → ]"*.
- The Run tour visits only 3 timeline elements (`waterfall`, `spend-spine`, `insights-strip`) and completely ignores the richer profiling views introduced since then: **Time** (wall-clock duration decomposition, thinking vs tool latency, parallelism factor), **Errors** (actor-based error triage and failure loops), **Waste** (comprehensive burned vs opportunity analysis), and **What-If** (interactive model repricing and simulation).
- The historical activation gate ("User clicks an insight on their own run and highlights evidence spans") alienates subscription developers (Priya, Claude Max plan) who have no direct dollar visibility and manage weekly message quotas and latency rather than API invoices.

RunRay is now an **Agent Profiler**, providing deep behavioral, latency, error, and economic profiling for coding agents.

This change updates the onboarding experience across CLI, Dashboard, and Run views to realign with the profiler positioning, adopting proven **Onboarding CRO** principles:
1. **Minimum Path to Value (MPTV)**: Accelerate time-to-value by guiding the user directly to diagnose their first agent run's primary bottleneck.
2. **Interactive Progress & Endowed Progress Effect**: Introduce a non-modal, dismissible **First Profile Checklist** (opening at 25% completed with "Agent traces indexed") that rewards real exploration across the profiler dimensions.
3. **Multi-Dimensional Profiler Tour**: Expand the session tour across the four core profiling pillars: Delegation & Structure (Waterfall), Execution Time & Latency (Time), Error Triage (Errors), and Structural Optimization (Waste / What-If).
4. **Subscription / Quota Awareness**: Acknowledge token limit workflows alongside cost tracking.

## What Changes

### 1. Re-anchored Product Positioning & Copy
- Update `docs/11-ONBOARDING-PLAN.md` and `docs/12-ONBOARDING-COPY.md` to reflect RunRay's identity as a local-first agent profiler.
- Frame the product around four profiling questions:
  - *Where did the time go?* (Time tab: agent inference vs tool/network latency)
  - *Where did the agent get stuck?* (Errors tab: error triage by actor, failure loops)
  - *How did the agent delegate?* (Waterfall & Treemap: subagent hierarchy, parallelism lanes)
  - *How can it run better or cheaper?* (Waste & What-If: 12 insight rules, model tier simulation)

### 2. Dashboard First Run (`packages/ui`)
- **Welcome Dialog**: Highlights that RunRay profiles execution time, errors, tool calls, and token efficiency from logs already on disk. Clarifies the local-only privacy promise.
- **Dashboard Tour (4 steps)**:
  1. `savings`: Profiling Summary (burned spend, potential savings, cache efficiency).
  2. `overview-trend` / `tool-rank`: Workload & Tool Distribution (models and MCP tools carrying execution).
  3. `sessions-table`: Session Explorer (duration, error indicators, cost, gateway to deep profiling).
  4. `help-button`: Command Palette & Keyboard Navigation (⌘K and ? shortcuts).
- **Completion CTA**: Replaces "Open the priciest session" with an action to profile the most critical session (highest latency, errors, or cost).

### 3. Run Profiler Tour & Interactive Checklist (`packages/ui`)
- **First Profile Checklist**: A lightweight, floating, collapsible checklist component:
  - `[x]` Agent logs discovered and indexed (Pre-completed at 25% via the Endowed Progress Effect).
  - `[ ]` Inspect delegation tree & concurrency in Timeline.
  - `[ ]` Diagnose latency breakdown in Time view.
  - `[ ]` Review error triage or test What-If repricing.
  - Auto-checks as user interacts; dismissible; state persisted.
- **Run Profiler Tour**: 4-step guided tour across the Profiler Dimensions:
  1. `waterfall`: Delegation & Concurrency (subagents, parallelism lanes).
  2. `time-tab`: Latency Decomposition (thinking vs tool wait time).
  3. `errors-tab`: Error Triage (categorized by actor).
  4. `insights-strip` / `what-if`: Actionable Optimization & Repricing.

### 4. CLI First Run (`packages/cli`)
- Update first-run banner: *"RunRay — local agent profiler. Nothing leaves this machine."*
- Update setup guides and wizard descriptions to emphasize latency and error profiling alongside cost.
- Next-step hints promote profiling commands: `diff`, `--watch`, `--limit-window`, and `export --redact`.

### 5. Onboarding State Persistence
- Extend `OnboardingBlock` in `onboarding-state.ts` and UI store to persist checklist completion (`checklist?: Record<string, boolean>`).
- Preserve all existing contracts: `state.json`, atomic writes, `0600` permissions, degrade-never-block semantics.
- Export bundles (`live === false`) continue to exclude 100% of onboarding code and dependencies.

## Capabilities

### Modified Capabilities
- **`visualizer`**: Update Welcome Dialog, Dashboard Tour, and Run Tour copy and anchor targets; introduce the First Profile Checklist; refine contextual hints for Time, Errors, and Waste views; ensure zero bundle leakage into `dist-export/index.html`.
- **`cli`**: Update first-run banner, wizard descriptions, and next-step hint copy to feature agent profiling capabilities.
- **`onboarding-state`**: Update state document and API filter to support checklist progress persistence.

## Impact

- **Affected Specs**: `specs/visualizer/spec.md`, `specs/cli/spec.md`, `specs/onboarding-state/spec.md`.
- **Affected Packages**:
  - `packages/ui`: `WelcomeDialog.tsx`, `DashboardTour.tsx`, `RunTour.tsx`, `OnboardingChecklist.tsx`, `ContextualHint.tsx`, `StatusScreens.tsx`, `store.ts`, tests.
  - `packages/cli`: `onboarding.ts`, `onboarding-state.ts`, tests.
  - `docs`: `11-ONBOARDING-PLAN.md`, `12-ONBOARDING-COPY.md`.
- **Dependencies**: No new npm dependencies. Uses existing `@floating-ui/react` and `@clack/prompts`.
- **Bundle Budgets**: Export template stays strictly under 1.5 MB with zero onboarding code included.
- **Data & Goldens**: Zero schema changes; `fixtures/normalized/` goldens remain 100% byte-stable.
