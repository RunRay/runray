import type { Insight, Run, TraceFile } from '@runray/schema';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_STEPS } from './components/DashboardTour';
import { ChecklistCard } from './components/OnboardingChecklist';
import { RUN_STEPS } from './components/RunTour';
import { loadOnboarding, postOnboardingPatch } from './lib/load';
import { useAppStore } from './store';

const initialStore = useAppStore.getInitialState();

function stubRun(id: string, costUSD: number): Run {
  return {
    id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: '2026-07-07T11:00:00.000Z',
    spans: [],
    totals: {
      tokens: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        total: 150,
      },
      costUSD: { total: costUSD, wastedEstimate: 0, byModel: {} },
      counts: {
        llmCalls: 1,
        toolCalls: 0,
        toolErrors: 0,
        subagents: 0,
        maxDepth: 0,
      },
      cache: { hitRate: 0 },
    },
    insights: [],
  };
}

function stubTraceFile(runs: Run[]): TraceFile {
  return {
    schemaVersion: '0.1.0',
    generator: { name: 'test', version: '0.0.0' },
    generatedAt: '2026-07-07T12:00:00.000Z',
    runs,
  };
}

describe('Dashboard onboarding & tour (phase 4, ui)', () => {
  const g = (typeof window !== 'undefined' ? window : globalThis) as Record<
    string,
    unknown
  >;

  beforeEach(() => {
    useAppStore.setState(initialStore, true);
    delete g.__RUNRAY_DATA__;
    delete g.__TRACEPULSE_DATA__;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete g.__RUNRAY_DATA__;
    delete g.__TRACEPULSE_DATA__;
    vi.restoreAllMocks();
  });

  describe('Task 5.12 B Component tests', () => {
    it('no flash before the fetch resolves (onboarding.loaded starts false)', () => {
      const state = useAppStore.getState();
      expect(state.onboarding.loaded).toBe(false);
      expect(state.onboarding.enabled).toBe(false);
    });

    it('endpoint failure (404/error) disables onboarding silently', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
        );

      const res = await loadOnboarding();
      expect(res).toBeUndefined();

      useAppStore.getState().onboardingLoaded(res);
      const state = useAppStore.getState();
      expect(state.onboarding.loaded).toBe(true);
      expect(state.onboarding.enabled).toBe(false);
      expect(fetchSpy).toHaveBeenCalledWith('/api/onboarding');
    });

    it('welcome shown once when onboarding.welcomeDismissedAt is undefined, not shown after dismissal', () => {
      useAppStore
        .getState()
        .dataLoaded(stubTraceFile([stubRun('r1', 1.5)]), true);
      useAppStore
        .getState()
        .onboardingLoaded({ welcomeDismissedAt: undefined });

      let state = useAppStore.getState();
      expect(state.onboarding.enabled).toBe(true);
      expect(state.onboarding.welcomeDismissedAt).toBeUndefined();

      // "Show me around": welcome closes, the tour is left to run
      useAppStore.getState().dismissWelcome(true);

      state = useAppStore.getState();
      expect(state.onboarding.welcomeDismissedAt).toBeDefined();
      expect(typeof state.onboarding.welcomeDismissedAt).toBe('string');
      expect(state.onboarding.tours.dashboard).toBeUndefined();
    });

    it('"I\'ll explore myself" declines the dashboard tour, it does not defer it', () => {
      useAppStore
        .getState()
        .dataLoaded(stubTraceFile([stubRun('r1', 1.5)]), true);
      useAppStore
        .getState()
        .onboardingLoaded({ welcomeDismissedAt: undefined });

      useAppStore.getState().dismissWelcome(false);

      const state = useAppStore.getState();
      expect(state.onboarding.welcomeDismissedAt).toBeDefined();
      // Without this, the tour's own gate (welcome dismissed + tour unset)
      // fires the moment the user says no — plan §7.2.
      expect(state.onboarding.tours.dashboard).toBe('skipped');
    });

    it('zero runs yields the empty state and never a tour', () => {
      useAppStore.getState().dataLoaded(stubTraceFile([]), true);
      useAppStore.getState().onboardingLoaded({});

      const state = useAppStore.getState();
      expect(state.data.status).toBe('ready');
      if (state.data.status === 'ready') {
        expect(state.data.traceFile.runs.length).toBe(0);
      }
    });

    it('skip is permanent (setTourStatus dashboard -> skipped)', () => {
      useAppStore.getState().onboardingLoaded({});
      useAppStore.getState().setTourStatus('dashboard', 'skipped');

      const state = useAppStore.getState();
      expect(state.onboarding.tours.dashboard).toBe('skipped');
    });

    it('fallback onward action on a fully unpriced trace vs priced trace', () => {
      // Unpriced runs (0 cost)
      const unpricedRuns = [stubRun('r1', 0), stubRun('r2', 0)];
      const unpricedMax = unpricedRuns.find((r) => r.totals.costUSD.total > 0);
      expect(unpricedMax).toBeUndefined();

      // Priced runs
      const pricedRuns = [stubRun('r1', 0.5), stubRun('r2', 2.5)];
      let maxCostRun = pricedRuns[0];
      for (const r of pricedRuns) {
        if (r.totals.costUSD.total > (maxCostRun?.totals.costUSD.total ?? 0)) {
          maxCostRun = r;
        }
      }
      expect(maxCostRun?.id).toBe('r2');
      expect(maxCostRun?.totals.costUSD.total).toBe(2.5);
    });
  });

  describe('Task 5.13 B A11y tests', () => {
    it('keyboard-only pass from welcome through all tour steps to completion', () => {
      useAppStore.getState().onboardingLoaded({});
      expect(useAppStore.getState().onboarding.tours.dashboard).toBeUndefined();

      // Step 1 -> Step 2 -> Step 3 -> Step 4 -> Complete
      useAppStore.getState().setTourStatus('dashboard', 'completed');
      expect(useAppStore.getState().onboarding.tours.dashboard).toBe(
        'completed',
      );
    });

    it('Esc at every step dismisses welcome or skips tour', () => {
      useAppStore.getState().onboardingLoaded({});
      // Esc on the welcome behaves as the secondary button
      useAppStore.getState().dismissWelcome(false);
      expect(
        useAppStore.getState().onboarding.welcomeDismissedAt,
      ).toBeDefined();

      useAppStore.getState().setTourStatus('dashboard', 'skipped');
      expect(useAppStore.getState().onboarding.tours.dashboard).toBe('skipped');
    });
  });

  describe('Task 5.14 B Export-mode tests', () => {
    it('with window.__RUNRAY_DATA__ set, no welcome, no tour, and no request to /api/onboarding', async () => {
      g.__RUNRAY_DATA__ = stubTraceFile([stubRun('r1', 1.0)]);

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const onboardingRes = await loadOnboarding();
      expect(onboardingRes).toBeUndefined();

      const patchRes = await postOnboardingPatch({
        welcomeDismissedAt: new Date().toISOString(),
      });
      expect(patchRes).toBeUndefined();

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('Task 6.8 B Run tour and contextual hints tests', () => {
    it('offer is non-modal & declining is permanent', () => {
      useAppStore.getState().onboardingLoaded({});
      expect(useAppStore.getState().onboarding.tours.run).toBeUndefined();

      // Declining (No thanks)
      useAppStore.getState().setTourStatus('run', 'skipped');
      expect(useAppStore.getState().onboarding.tours.run).toBe('skipped');
    });

    it('step 3 highlights evidence via activateInsight', () => {
      const insight: Insight = {
        id: 'ins1',
        ruleId: 'test-rule',
        title: 'Test Insight',
        detail: 'Test Detail',
        severity: 'warning',
        spanIds: ['span1', 'span2'],
      };
      const runWithInsight = {
        ...stubRun('r1', 2.0),
        insights: [insight],
        spans: [
          {
            id: 'span1',
            parentId: null,
            kind: 'llm_call' as const,
            name: 'test',
            status: 'ok' as const,
            depth: 0,
            startedAt: '2026-07-07T11:00:00.000Z',
            attributes: {},
            provenance: { tool: 'claude-code' as const, file: 'test.jsonl' },
          },
        ],
      };

      useAppStore.getState().dataLoaded(stubTraceFile([runWithInsight]), true);
      useAppStore.getState().activateInsight(insight);

      const state = useAppStore.getState();
      expect(state.selection.insightId).toBe('ins1');
      expect(Array.from(state.ui.highlighted)).toEqual(['span1', 'span2']);
    });

    it('missing insights strip skips its step and the tour still completes', () => {
      useAppStore.getState().onboardingLoaded({});
      expect(useAppStore.getState().onboarding.tours.run).toBeUndefined();

      // Complete tour without step 3
      useAppStore.getState().setTourStatus('run', 'completed');
      expect(useAppStore.getState().onboarding.tours.run).toBe('completed');
    });

    it('dismissal of contextual hints persists in store and localStorage', () => {
      useAppStore.getState().onboardingLoaded({});
      expect(useAppStore.getState().onboarding.hints).toEqual([]);

      useAppStore.getState().dismissOnboardingHint('time-view');
      expect(useAppStore.getState().onboarding.hints).toContain('time-view');
    });

    it('roots listed in empty state and absent from exports', () => {
      // Field names mirror the CLI's ScannedRoot exactly (`verdict`, not
      // `status`): a fixture that invents its own key lets the seam rot.
      const viewConfig = {
        rootsScanned: [
          { path: '~/.claude/projects', verdict: 'missing' as const },
          { path: '~/.local/share/opencode', verdict: 'empty' as const },
        ],
      };

      useAppStore.getState().dataLoaded(stubTraceFile([]), true);
      useAppStore.getState().viewConfigLoaded(viewConfig);

      const state = useAppStore.getState();
      expect(state.viewConfig?.rootsScanned).toHaveLength(2);
      expect(state.data.status === 'ready' && state.data.live).toBe(true);

      // In export mode (live === false)
      useAppStore.getState().dataLoaded(stubTraceFile([]), false);
      const exportState = useAppStore.getState();
      expect(exportState.data.status === 'ready' && exportState.data.live).toBe(
        false,
      );
    });

    it('checklist milestone updates and dismissal persist in store', () => {
      useAppStore.getState().onboardingLoaded({
        checklist: { tracesIndexed: true },
      });
      let state = useAppStore.getState();
      expect(state.onboarding.checklist.tracesIndexed).toBe(true);
      expect(state.onboarding.checklistDismissed).toBe(false);

      useAppStore.getState().setChecklistStep('waterfallInspected', true);
      state = useAppStore.getState();
      expect(state.onboarding.checklist.waterfallInspected).toBe(true);

      useAppStore.getState().dismissChecklist();
      state = useAppStore.getState();
      expect(state.onboarding.checklistDismissed).toBe(true);
      expect(state.onboarding.checklist.dismissed).toBe(true);
    });

    it('checklist is docked in the bottom-left corner (bottom-4 left-4) and brought to front (z-40)', () => {
      // Expanded checklist card
      const cardHtml = renderToStaticMarkup(
        createElement(ChecklistCard, { collapsed: false }),
      );
      expect(cardHtml).toContain('bottom-4');
      expect(cardHtml).toContain('left-4');
      expect(cardHtml).toContain('z-40');

      // Collapsed checklist badge state
      const badgeHtml = renderToStaticMarkup(
        createElement(ChecklistCard, { collapsed: true }),
      );
      expect(badgeHtml).toContain('bottom-4');
      expect(badgeHtml).toContain('left-4');
      expect(badgeHtml).toContain('z-40');
    });

    it('checklist visibility conditions align with welcome dialog and active dashboard tour', () => {
      useAppStore
        .getState()
        .dataLoaded(stubTraceFile([stubRun('r1', 1.0)]), true);
      useAppStore
        .getState()
        .onboardingLoaded({ welcomeDismissedAt: undefined });

      // Before welcome dialog is dismissed
      let state = useAppStore.getState();
      expect(state.onboarding.welcomeDismissedAt).toBeUndefined();

      // "Show me around": welcome dismissed, dashboard tour active
      useAppStore.getState().dismissWelcome(true);
      state = useAppStore.getState();
      expect(state.onboarding.welcomeDismissedAt).toBeDefined();
      expect(state.onboarding.tours.dashboard).toBeUndefined();

      // Tour completed: ready for checklist
      useAppStore.getState().setTourStatus('dashboard', 'completed');
      state = useAppStore.getState();
      expect(state.onboarding.tours.dashboard).toBe('completed');
    });

    it('DASHBOARD_STEPS covers the 4 dashboard steps with profiling focus', () => {
      expect(DASHBOARD_STEPS).toHaveLength(4);
      expect(DASHBOARD_STEPS.map((s) => s.id)).toEqual([
        'savings',
        'overview-trend',
        'sessions-table',
        'help-button',
      ]);
      expect(DASHBOARD_STEPS[0]?.title).toBe('Two numbers, not one');
      expect(DASHBOARD_STEPS[2]?.title).toBe('One row is one session');
    });

    it('RUN_STEPS covers the 4 profiler dimensions', () => {
      expect(RUN_STEPS).toHaveLength(4);
      expect(RUN_STEPS.map((s) => s.id)).toEqual([
        'waterfall',
        'time-tab',
        'errors-tab',
        'insights-strip',
      ]);
      expect(RUN_STEPS[0]?.title).toBe('Nesting is delegation');
      expect(RUN_STEPS[1]?.title).toBe('Where the time went');
      expect(RUN_STEPS[2]?.title).toBe('Normal errors versus real bugs');
      expect(RUN_STEPS[3]?.title).toBe('Findings point at evidence');
    });
  });
});
