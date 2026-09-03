import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import { useCallback, useEffect, useState } from 'react';
import { rankInsights } from '../lib/insight-order';
import { useTourAnchors } from '../lib/use-tour-anchors';
import { selectActiveRun, useAppStore } from '../store';

export interface TourStep {
  id: string;
  anchorKeys: readonly string[];
  title: string;
  body: string;
}

const RUN_STEPS: readonly TourStep[] = [
  {
    id: 'waterfall',
    anchorKeys: ['waterfall'],
    title: 'Nesting is delegation',
    body: "Indentation shows who called whom. Rows on separate lanes ran at the same time — that's real parallelism, not layout.",
  },
  {
    id: 'spend-spine',
    anchorKeys: ['spend-spine'],
    title: 'The burn line',
    body: 'Cost accumulating as the session ran. A steep stretch is where the money went; click it to jump to that moment.',
  },
  {
    id: 'insights-strip',
    anchorKeys: ['insights-strip'],
    title: 'Findings point at evidence',
    body: 'Click a finding — the spans that caused it highlight in the waterfall. That\'s the answer to "why did this cost that".',
  },
];

export default function RunTour() {
  const onboarding = useAppStore((s) => s.onboarding);
  const route = useAppStore((s) => s.route);
  const activeRun = useAppStore(selectActiveRun);
  const setTourStatus = useAppStore((s) => s.setTourStatus);
  const activateInsight = useAppStore((s) => s.activateInsight);
  const navigateTo = useAppStore((s) => s.navigateTo);

  const [inTour, setInTour] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const isRunRoute =
    route.view === 'timeline' ||
    route.view === 'cost' ||
    route.view === 'time' ||
    route.view === 'errors';

  const isOfferable =
    onboarding.enabled &&
    onboarding.loaded &&
    onboarding.tours.run !== 'completed' &&
    onboarding.tours.run !== 'skipped' &&
    isRunRoute;

  const { validSteps, anchorEl } = useTourAnchors(
    RUN_STEPS,
    stepIndex,
    isOfferable && inTour,
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
    if (inTour && anchorEl && stepIndex >= 0) {
      anchorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [inTour, stepIndex, anchorEl]);

  useEffect(() => {
    if (inTour) {
      updateRect();
      window.addEventListener('resize', updateRect);
      window.addEventListener('scroll', updateRect, true);
      return () => {
        window.removeEventListener('resize', updateRect);
        window.removeEventListener('scroll', updateRect, true);
      };
    }
  }, [inTour, updateRect]);

  // Accepting the offer on a run whose anchors never resolve (no insights, a
  // view that renders none of them) must not strand the user in a tour with no
  // steps and no recorded status: close it out instead. The grace period lets
  // the anchor scan settle after the route change started by handleStartTour.
  useEffect(() => {
    if (!inTour || validSteps.length > 0) return;
    const timer = setTimeout(() => {
      setInTour(false);
      setTourStatus('run', 'completed');
    }, 400);
    return () => clearTimeout(timer);
  }, [inTour, validSteps.length, setTourStatus]);

  const handleSkip = () => {
    setInTour(false);
    setTourStatus('run', 'skipped');
  };

  const handleStartTour = () => {
    if (activeRun && route.view !== 'timeline') {
      navigateTo({ view: 'timeline', runId: activeRun.id });
    }
    setInTour(true);
    setStepIndex(0);
  };

  const isLastStep = stepIndex >= validSteps.length - 1;

  const handleNext = () => {
    if (isLastStep) {
      // Step 3 (or last available step) advance
      // the same first pill the strip shows (ranked by waste), not rule order
      const first = activeRun ? rankInsights(activeRun.insights)[0] : undefined;
      if (currentStep?.id === 'insights-strip' && first !== undefined) {
        activateInsight(first);
      }
      setInTour(false);
      setTourStatus('run', 'completed');
    } else {
      setStepIndex((i) => Math.min(i + 1, validSteps.length - 1));
    }
  };

  const handleBack = () => {
    setStepIndex((i) => Math.max(i - 1, 0));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleSkip();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      handleNext();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      handleBack();
    }
  };

  if (!isOfferable) {
    return null;
  }

  // Non-modal Offer
  if (!inTour) {
    return (
      <FloatingPortal>
        <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-panel border border-border-slate bg-surface-container-low p-4 shadow-popover text-text">
          <p className="text-body font-medium text-text">
            First time in a session view — want the 30-second tour of what's on
            screen?
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleSkip}
              className="rounded-control border border-border-slate bg-surface px-3 py-1 text-label text-text-dim hover:bg-surface-variant transition-colors"
            >
              No thanks
            </button>
            <button
              type="button"
              onClick={handleStartTour}
              className="rounded-control bg-brand px-3 py-1 text-label font-medium text-white hover:bg-brand-secondary transition-colors"
            >
              Show me
            </button>
          </div>
        </div>
      </FloatingPortal>
    );
  }

  if (validSteps.length === 0) {
    return null;
  }

  const isTryItStep = currentStep?.id === 'insights-strip';

  return (
    <FloatingPortal>
      {/* Spotlight overlay */}
      {targetRect && (
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

      {/* Anchored Popover */}
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
              {isTryItStep ? 'Try it' : isLastStep ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
