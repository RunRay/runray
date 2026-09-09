import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import type { Run } from '@runray/schema';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTourAnchors } from '../lib/use-tour-anchors';
import { useAppStore, useVisibleRuns } from '../store';

export interface TourStep {
  id: string;
  anchorKeys: readonly string[];
  title: string;
  body: string;
}

export const DASHBOARD_STEPS: readonly TourStep[] = [
  {
    id: 'savings',
    anchorKeys: ['savings'],
    title: 'Two numbers, not one',
    body: 'The left number is spend burned on retries and broken caches. The right number shows what cleaner runs would have saved. You can still fix that right number.',
  },
  {
    id: 'overview-trend',
    anchorKeys: ['overview-trend', 'tool-rank'],
    title: 'Where it went',
    body: 'Charts show daily spend by model, followed by the tools and MCP servers behind it. Click any item to filter every view to that slice.',
  },
  {
    id: 'sessions-table',
    anchorKeys: ['sessions-table'],
    title: 'One row is one session',
    body: 'Open any row to see the delegation tree, slow tool calls, and tool errors.',
  },
  {
    id: 'help-button',
    anchorKeys: ['help-button'],
    title: 'The rest is keyboard',
    body: 'Press ? to view keyboard shortcuts. Press ⌘K to open the command palette and jump to a session or switch views.',
  },
];

export default function DashboardTour() {
  const onboarding = useAppStore((s) => s.onboarding);
  const route = useAppStore((s) => s.route);
  const visibleRuns = useVisibleRuns();
  const setTourStatus = useAppStore((s) => s.setTourStatus);
  const navigateTo = useAppStore((s) => s.navigateTo);

  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const isActive =
    onboarding.enabled &&
    onboarding.loaded &&
    Boolean(onboarding.welcomeDismissedAt) &&
    onboarding.tours.dashboard !== 'completed' &&
    onboarding.tours.dashboard !== 'skipped' &&
    route.view === 'dashboard';

  const { validSteps, anchorEl } = useTourAnchors(
    DASHBOARD_STEPS,
    stepIndex,
    isActive,
  );

  const currentStep = validSteps[stepIndex];

  const { refs, floatingStyles, context } = useFloating({
    elements: {
      reference: anchorEl,
    },
    open: true,
    placement: 'bottom-start',
    middleware: [
      offset(12),
      flip({
        fallbackPlacements: [
          'top-start',
          'right-start',
          'left-start',
          'bottom-end',
          'top-end',
        ],
      }),
      shift({ padding: 12 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // Re-measure bounding box of active anchor
  const updateRect = useCallback(() => {
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      setTargetRect((prev) => {
        if (
          prev &&
          prev.top === rect.top &&
          prev.left === rect.left &&
          prev.width === rect.width &&
          prev.height === rect.height
        ) {
          return prev;
        }
        return rect;
      });
    } else {
      setTargetRect((prev) => (prev === null ? prev : null));
    }
  }, [anchorEl]);

  useEffect(() => {
    if (anchorEl && stepIndex >= 0) {
      anchorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [stepIndex, anchorEl]);

  useEffect(() => {
    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [updateRect]);

  // Onward action calculation
  const priciestRun = useMemo(() => {
    if (visibleRuns.length === 0) return undefined;
    let max = visibleRuns[0];
    if (!max) return undefined;
    for (const r of visibleRuns) {
      if (r.totals.costUSD.total > max.totals.costUSD.total) {
        max = r;
      }
    }
    return max.totals.costUSD.total > 0 ? max : undefined;
  }, [visibleRuns]);

  const isLastStep = stepIndex >= validSteps.length - 1;
  const isCompletionStep = stepIndex >= validSteps.length;

  const handleSkip = () => {
    setTourStatus('dashboard', 'skipped');
  };

  const handleNext = () => {
    if (isLastStep) {
      setStepIndex(validSteps.length); // Completion step
    } else {
      setStepIndex((i) => Math.min(i + 1, validSteps.length - 1));
    }
  };

  const handleBack = () => {
    setStepIndex((i) => Math.max(i - 1, 0));
  };

  const handleFinish = (runToOpen?: Run) => {
    setTourStatus('dashboard', 'completed');
    if (runToOpen) {
      navigateTo({ view: 'cost', runId: runToOpen.id });
    }
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleSkip();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isCompletionStep) handleNext();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isCompletionStep) handleBack();
    }
  };

  if (!isActive || validSteps.length === 0) {
    return null;
  }

  const targetRun = priciestRun ?? visibleRuns[0];
  const onwardLabel = 'Open latest session →';

  return (
    <FloatingPortal>
      {/* Spotlight overlay */}
      {targetRect && !isCompletionStep && (
        <div
          className="fixed pointer-events-none transition-all duration-200 ease-out z-40 rounded"
          style={{
            top: targetRect.top - 4,
            left: targetRect.left - 4,
            width: targetRect.width + 8,
            height: targetRect.height + 8,
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.65)',
          }}
        />
      )}

      {/* Completion Modal */}
      {isCompletionStep ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-bg/70 backdrop-blur-xs">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Tour completion"
            onKeyDown={handleKeyDown}
            className="w-[420px] rounded-panel border border-border-slate bg-surface-container-low p-6 shadow-popover text-text"
          >
            <h2 className="font-display text-header font-semibold text-text">
              The overview is complete. Traces and evidence live inside
              individual sessions.
            </h2>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => handleFinish(targetRun)}
                className="rounded-control bg-brand px-4 py-2 text-label font-medium text-white transition-colors duration-150 ease-out hover:bg-brand-secondary active:bg-brand-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass"
              >
                {onwardLabel}
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Anchored Popover */
        <FloatingFocusManager context={context} modal={false}>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            role="dialog"
            aria-label={currentStep ? currentStep.title : 'Tour step'}
            onKeyDown={handleKeyDown}
            className="z-50 w-80 rounded-panel border border-border-slate bg-surface-container-low p-4 shadow-popover text-text outline-none"
          >
            <div className="flex items-center justify-between text-label text-text-faint">
              <span className="font-mono">
                {stepIndex + 1} / {validSteps.length}
              </span>
              <button
                type="button"
                onClick={handleSkip}
                className="text-label text-text-dim hover:text-text transition-colors"
              >
                Skip tour
              </button>
            </div>

            <h3 className="mt-2 font-display text-body font-semibold text-text">
              {currentStep?.title}
            </h3>
            <p className="mt-1 text-label text-text-dim leading-normal">
              {currentStep?.body}
            </p>

            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                disabled={stepIndex === 0}
                onClick={handleBack}
                className="rounded-control border border-border-slate bg-surface px-3 py-1 text-label text-text-dim transition-colors duration-150 hover:bg-surface-variant disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleNext}
                className="rounded-control bg-brand px-3 py-1 text-label font-medium text-white transition-colors duration-150 hover:bg-brand-secondary"
              >
                {isLastStep ? 'Done' : 'Next'}
              </button>
            </div>
          </div>
        </FloatingFocusManager>
      )}
    </FloatingPortal>
  );
}
