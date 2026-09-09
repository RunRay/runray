import { useEffect, useState } from 'react';
import { useAppStore, useVisibleRuns } from '../store';

export interface ChecklistItem {
  id: string;
  label: string;
  completed: boolean;
  onClick: () => void;
}

export interface ChecklistCardProps {
  navCollapsed?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onDismiss?: () => void;
  items?: ChecklistItem[];
  pct?: number;
  allComplete?: boolean;
}

/**
 * Presentational card for the first-run checklist.
 * Pure component rendered from props so positioning and interaction can be tested.
 * Anchored to the viewport bottom and offset clear of the side navigation rail.
 */
export function ChecklistCard({
  navCollapsed = false,
  collapsed = false,
  onToggleCollapse,
  onDismiss,
  items = [],
  pct = 0,
  allComplete = false,
}: ChecklistCardProps) {
  const leftPosition = navCollapsed ? 'left-[4.5rem]' : 'left-64';

  if (collapsed) {
    return (
      <div className={`fixed bottom-4 ${leftPosition} z-40`}>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex items-center gap-2 rounded-panel border border-border-slate bg-surface-container-low px-3 py-2 text-label font-medium text-text shadow-popover hover:bg-surface-variant transition-colors"
          aria-label="Expand first run checklist"
        >
          <span className="flex h-2 w-2 rounded-full bg-brand" />
          <span>Checklist ({pct}%)</span>
        </button>
      </div>
    );
  }

  return (
    <section
      aria-label="First run checklist"
      className={`fixed bottom-4 ${leftPosition} z-40 w-80 rounded-panel border border-border-slate bg-surface-container-low p-4 shadow-popover text-text`}
    >
      <div className="flex items-center justify-between pb-2 border-b border-border-slate">
        <div className="flex items-center gap-2">
          <span className="font-display text-label font-semibold text-text">
            First run checklist
          </span>
          <span className="font-mono text-label text-brand font-medium">
            {pct}%
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleCollapse}
            className="rounded p-1 text-text-faint hover:text-text hover:bg-surface transition-colors"
            title="Minimize checklist"
            aria-label="Minimize checklist"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <title>Minimize</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded p-1 text-text-faint hover:text-text hover:bg-surface transition-colors"
            title="Dismiss checklist"
            aria-label="Dismiss checklist"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <title>Dismiss</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Progress track */}
      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full bg-brand transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Items list */}
      <div className="mt-3 flex flex-col gap-2">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={item.onClick}
            className="flex items-start gap-2.5 text-left group p-1 -mx-1 rounded hover:bg-surface transition-colors"
          >
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                item.completed
                  ? 'border-brand bg-brand text-white'
                  : 'border-border-slate bg-surface group-hover:border-text-faint'
              }`}
            >
              {item.completed && (
                <svg
                  className="w-3 h-3 stroke-current stroke-2 fill-none"
                  viewBox="0 0 24 24"
                >
                  <title>Completed</title>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
            <span
              className={`text-label leading-tight transition-colors ${
                item.completed
                  ? 'text-text-faint line-through'
                  : 'text-text-dim group-hover:text-text'
              }`}
            >
              {item.label}
            </span>
          </button>
        ))}
      </div>

      {allComplete && (
        <div className="mt-3 pt-2 border-t border-border-slate flex items-center justify-between">
          <span className="text-[11px] text-text-faint font-mono">
            You explored all four views.
          </span>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded bg-brand px-2 py-0.5 text-label text-white hover:bg-brand-secondary transition-colors"
          >
            Done
          </button>
        </div>
      )}
    </section>
  );
}

export default function OnboardingChecklist() {
  const onboarding = useAppStore((s) => s.onboarding);
  const route = useAppStore((s) => s.route);
  const navCollapsed = useAppStore((s) => s.ui.navCollapsed);
  const visibleRuns = useVisibleRuns();
  const setChecklistStep = useAppStore((s) => s.setChecklistStep);
  const dismissChecklist = useAppStore((s) => s.dismissChecklist);
  const navigateTo = useAppStore((s) => s.navigateTo);

  const [collapsed, setCollapsed] = useState(false);

  const checklist = onboarding.checklist ?? {};

  // Auto-complete steps on navigation
  useEffect(() => {
    if (!onboarding.enabled || onboarding.checklistDismissed) return;

    // Step 1: traces always discovered if onboarding is active with runs
    if (visibleRuns.length > 0 && checklist.tracesIndexed !== true) {
      setChecklistStep('tracesIndexed', true);
    }

    if (route.view === 'timeline' && checklist.timelineInspected !== true) {
      setChecklistStep('timelineInspected', true);
    } else if (route.view === 'time' && checklist.timeDiagnosed !== true) {
      setChecklistStep('timeDiagnosed', true);
    } else if (
      (route.view === 'errors' || route.view === 'waste') &&
      checklist.optimizationReviewed !== true
    ) {
      setChecklistStep('optimizationReviewed', true);
    }
  }, [
    route.view,
    visibleRuns.length,
    checklist,
    onboarding.enabled,
    onboarding.checklistDismissed,
    setChecklistStep,
  ]);

  if (
    !onboarding.enabled ||
    !onboarding.loaded ||
    onboarding.checklistDismissed ||
    visibleRuns.length === 0
  ) {
    return null;
  }

  const items: ChecklistItem[] = [
    {
      id: 'tracesIndexed',
      label: 'Found agent logs on disk',
      completed: checklist.tracesIndexed ?? true,
      onClick: () => navigateTo({ view: 'dashboard' }),
    },
    {
      id: 'timelineInspected',
      label: 'Inspect subagents and lanes in Timeline',
      completed: checklist.timelineInspected === true,
      onClick: () => {
        const runId = 'runId' in route ? route.runId : visibleRuns[0]?.id;
        if (runId) navigateTo({ view: 'timeline', runId });
      },
    },
    {
      id: 'timeDiagnosed',
      label: 'Trace clock time in Time view',
      completed: checklist.timeDiagnosed === true,
      onClick: () => {
        const runId = 'runId' in route ? route.runId : visibleRuns[0]?.id;
        if (runId) navigateTo({ view: 'time', runId });
      },
    },
    {
      id: 'optimizationReviewed',
      label: 'Review tool errors or test What-If repricing',
      completed: checklist.optimizationReviewed === true,
      onClick: () => {
        const runId = 'runId' in route ? route.runId : visibleRuns[0]?.id;
        if (runId) navigateTo({ view: 'errors', runId });
      },
    },
  ];

  const completedCount = items.filter((i) => i.completed).length;
  const pct = Math.round((completedCount / items.length) * 100);
  const allComplete = completedCount === items.length;

  return (
    <ChecklistCard
      navCollapsed={navCollapsed}
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed((c) => !c)}
      onDismiss={dismissChecklist}
      items={items}
      pct={pct}
      allComplete={allComplete}
    />
  );
}
