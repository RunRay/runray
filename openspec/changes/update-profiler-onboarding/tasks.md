# Tasks: update-profiler-onboarding

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` byte-identical, export bundle under 1.5 MB with zero onboarding code included.

## 1. Documentation and Copy Updates

- [x] 1.1 Update `docs/11-ONBOARDING-PLAN.md` to reframe the onboarding thesis around agent profiling (latency, error triage, delegation hierarchy, and structural optimization).
- [x] 1.2 Update `docs/12-ONBOARDING-COPY.md` with profiler-aligned copy for Welcome Dialog, Dashboard Tour, Run Profiler Tour, First Profile Checklist, and CLI banners.

## 2. CLI State and Guidance Updates

- [x] 2.1 Extend `OnboardingBlock` in `packages/cli/src/onboarding-state.ts` to support `checklist?: Record<string, boolean>`. Update `filterOnboardingPatch` and `mergeOnboardingBlocks`.
- [x] 2.2 Update unit tests in `packages/cli/src/onboarding-state.test.ts` for checklist persistence and filtering.
- [x] 2.3 Update CLI first-run banner, setup guides, and next-step hints in `packages/cli/src/onboarding.ts` to feature agent profiling capabilities.
- [x] 2.4 Update CLI tests in `packages/cli/src/onboarding.test.ts`.

## 3. UI Store and API Integration

- [x] 3.1 Update `OnboardingBlock` and `OnboardingState` in `packages/ui/src/store.ts` to include `checklist: Record<string, boolean>`. Add actions `setChecklistStep(stepKey, completed)` and `dismissChecklist()`.
- [x] 3.2 Update `loadOnboarding` and `postOnboardingPatch` in `packages/ui/src/lib/load.ts` if needed for checklist payload handling.
- [x] 3.3 Add unit tests in `packages/ui/src/onboarding.test.ts` for store checklist actions and state syncing.

## 4. UI Welcome Dialog and Dashboard Tour

- [x] 4.1 Update `packages/ui/src/components/WelcomeDialog.tsx` copy to present RunRay as a local agent profiler (evaluating latency, errors, tool calls, and token efficiency).
- [x] 4.2 Update `packages/ui/src/components/DashboardTour.tsx` steps and anchors:
  - Step 1: Profiling summary (`savings`).
  - Step 2: Workload & Tool distribution (`overview-trend`, `tool-rank`).
  - Step 3: Session Explorer (`sessions-table`).
  - Step 4: Keyboard navigation & Palette (`help-button`).
  - Completion CTA: `[ Profile latest session → ]`.
- [x] 4.3 Update tests in `packages/ui/src/onboarding.test.ts` to verify updated dashboard tour copy and navigation.

## 5. UI Run Profiler Tour and First Profile Checklist

- [x] 5.1 Redesign `packages/ui/src/components/RunTour.tsx` to cover the four profiler dimensions:
  - Step 1: Delegation & Concurrency (`waterfall`).
  - Step 2: Latency Decomposition (`time` tab).
  - Step 3: Error Triage (`errors` tab).
  - Step 4: Optimization & Repricing (`insights-strip` / `what-if`).
- [x] 5.2 Build `packages/ui/src/components/OnboardingChecklist.tsx` with endowed progress:
  - Step 1: `Agent traces discovered and indexed` (pre-checked, 25%).
  - Step 2: `Inspect delegation tree & concurrency in Timeline`.
  - Step 3: `Diagnose latency breakdown in Time view`.
  - Step 4: `Review error triage or simulate What-If repricing`.
  - Non-modal, collapsible, dismissible, keyboard accessible.
- [x] 5.3 Wire `OnboardingChecklist` into `App.tsx` behind the live mode and onboarding enabled guards.
- [x] 5.4 Update tests in `packages/ui/src/onboarding.test.ts` to assert run tour steps and checklist interactions.

## 6. Empty State and Contextual Hints

- [x] 6.1 Update `packages/ui/src/components/StatusScreens.tsx` (`EmptyScreen`) to showcase profiler value and provide a prominent sample profiling session trigger.
- [x] 6.2 Update contextual hint copy in `packages/ui/src/components/ContextualHint.tsx` for Time, Errors, and Waste views.

## 7. Verification and Quality Checks

- [ ] 7.1 Verify export purity in `packages/ui/src/bundle-guard.test.ts`: ensure `dist-export/index.html` remains < 1.5 MB with zero onboarding code or markers.
- [ ] 7.2 Run full test suite: `pnpm test`.
- [ ] 7.3 Run linter and typecheck: `pnpm lint && pnpm typecheck`.
- [ ] 7.4 Confirm goldens in `fixtures/normalized/` remain 100% byte-identical.
