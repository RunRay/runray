import type { TraceFile } from '@runray/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILTER } from './lib/filter-runs';
import { selectActiveRun, selectVisibleRuns, useAppStore } from './store';

const initial = useAppStore.getInitialState();

// Minimal-but-valid run for store-level tests (no parsing involved).
function stubTraceFile(runIds: string[]): TraceFile {
  return {
    schemaVersion: '0.1.0',
    generator: { name: 'test', version: '0.0.0' },
    generatedAt: '2026-07-07T12:00:00.000Z',
    runs: runIds.map((id) => ({
      id,
      source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
      startedAt: '2026-07-07T11:00:00.000Z',
      spans: [],
      totals: {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        costUSD: { total: 0, wastedEstimate: 0, byModel: {} },
        counts: {
          llmCalls: 0,
          toolCalls: 0,
          toolErrors: 0,
          subagents: 0,
          maxDepth: 0,
        },
        cache: { hitRate: 0 },
      },
      insights: [],
    })),
  };
}

beforeEach(() => {
  useAppStore.setState(initial, true);
});

describe('store actions', () => {
  it('routeChanged drops the selection only when the run changes', () => {
    useAppStore.getState().routeChanged({ view: 'timeline', runId: 'r1' });
    useAppStore.getState().selectSpan('s1');
    // view switch within the same run keeps the selection (evidence links)
    useAppStore.getState().routeChanged({ view: 'cost', runId: 'r1' });
    expect(useAppStore.getState().selection.spanId).toBe('s1');
    // switching runs drops it
    useAppStore.getState().routeChanged({ view: 'timeline', runId: 'r2' });
    expect(useAppStore.getState().selection.spanId).toBeNull();
  });

  it('activateInsight toggles highlight and yields the inspector to the insight', () => {
    const insight = {
      id: 'i1',
      ruleId: 'retry-loop',
      severity: 'warning' as const,
      title: 't',
      detail: 'd',
      spanIds: ['s1', 's2'],
    };
    useAppStore.getState().selectSpan('s9');
    useAppStore.getState().activateInsight(insight);
    let state = useAppStore.getState();
    expect(state.selection.insightId).toBe('i1');
    expect(state.selection.spanId).toBeNull(); // insight detail wins
    expect([...state.ui.highlighted].sort()).toEqual(['s1', 's2']);
    expect(state.ui.inspectorOpen).toBe(true);

    // selecting evidence keeps the highlight but shows the span
    useAppStore.getState().selectSpan('s1');
    state = useAppStore.getState();
    expect(state.selection.spanId).toBe('s1');
    expect(state.selection.insightId).toBe('i1');
    expect(state.ui.highlighted.has('s2')).toBe(true);

    // re-activating the same insight deactivates it
    useAppStore.getState().activateInsight(insight);
    state = useAppStore.getState();
    expect(state.selection.insightId).toBeNull();
    expect(state.ui.highlighted.size).toBe(0);
  });

  it('staged insight survives the cross-run navigation and activates on arrival', () => {
    const insight = {
      id: 'i9',
      ruleId: 'retry-loop',
      severity: 'warning' as const,
      title: 't',
      detail: 'd',
      spanIds: ['s7'],
    };
    useAppStore.getState().routeChanged({ view: 'dashboard' });
    useAppStore.getState().stageInsight(insight);
    useAppStore.getState().routeChanged({ view: 'timeline', runId: 'r2' });
    const state = useAppStore.getState();
    expect(state.selection.insightId).toBe('i9');
    expect(state.ui.highlighted.has('s7')).toBe(true);
    expect(state.pendingInsight).toBeNull();
    // a later run change without staging clears as usual
    useAppStore.getState().routeChanged({ view: 'timeline', runId: 'r3' });
    expect(useAppStore.getState().selection.insightId).toBeNull();
  });

  it('run change clears the insight highlight', () => {
    useAppStore.getState().routeChanged({ view: 'timeline', runId: 'r1' });
    useAppStore.getState().activateInsight({
      id: 'i1',
      ruleId: 'retry-loop',
      severity: 'warning',
      title: 't',
      detail: 'd',
      spanIds: ['s1'],
    });
    useAppStore.getState().routeChanged({ view: 'timeline', runId: 'r2' });
    const state = useAppStore.getState();
    expect(state.selection.insightId).toBeNull();
    expect(state.ui.highlighted.size).toBe(0);
  });

  it('selectSpan opens the inspector; deselecting leaves it alone', () => {
    useAppStore.getState().toggleInspector();
    expect(useAppStore.getState().ui.inspectorOpen).toBe(false);
    useAppStore.getState().selectSpan('s1');
    expect(useAppStore.getState().ui.inspectorOpen).toBe(true);
    useAppStore.getState().toggleInspector();
    useAppStore.getState().selectSpan(null);
    expect(useAppStore.getState().ui.inspectorOpen).toBe(false);
  });

  it('toggleCollapsed flips membership without mutating the previous set', () => {
    const before = useAppStore.getState().ui.collapsed;
    useAppStore.getState().toggleCollapsed('s1');
    expect(useAppStore.getState().ui.collapsed.has('s1')).toBe(true);
    expect(before.has('s1')).toBe(false);
    useAppStore.getState().toggleCollapsed('s1');
    expect(useAppStore.getState().ui.collapsed.has('s1')).toBe(false);
  });
});

describe('filter slice', () => {
  it('setFilter merges patches; clearFilter resets wholesale', () => {
    useAppStore.getState().setFilter({ project: 'alpha' });
    useAppStore.getState().setFilter({ periodDays: 7 });
    expect(useAppStore.getState().filter).toEqual({
      ...EMPTY_FILTER,
      project: 'alpha',
      periodDays: 7,
    });
    useAppStore.getState().clearFilter();
    expect(useAppStore.getState().filter).toEqual(EMPTY_FILTER);
  });

  it('selectVisibleRuns narrows loaded runs; the active run stays route-resolved', () => {
    useAppStore.getState().dataLoaded(stubTraceFile(['r1', 'r2']), true);
    useAppStore.getState().routeChanged({ view: 'timeline', runId: 'r1' });
    // stub runs have no project → they group under the '—' placeholder
    useAppStore.getState().setFilter({ project: 'nonexistent' });
    expect(selectVisibleRuns(useAppStore.getState())).toEqual([]);
    // an open run never disappears under the user because a filter changed
    expect(selectActiveRun(useAppStore.getState())?.id).toBe('r1');
    useAppStore.getState().setFilter({ project: '—' });
    expect(selectVisibleRuns(useAppStore.getState()).map((r) => r.id)).toEqual([
      'r1',
      'r2',
    ]);
  });

  it('selectVisibleRuns is empty while data is loading', () => {
    expect(selectVisibleRuns(useAppStore.getState())).toEqual([]);
  });

  it('dataLoaded reconciles a filter whose value rolled off the fresh data', () => {
    // a --watch refresh must not leave a stale active filter pointing at a
    // source (here opencode) absent from the new claude-code-only runs
    useAppStore.getState().setFilter({ source: 'opencode' });
    useAppStore.getState().dataLoaded(stubTraceFile(['r1']), true);
    expect(useAppStore.getState().filter.source).toBeNull();
  });
});

describe('selectActiveRun', () => {
  it('resolves the route runId against loaded runs', () => {
    useAppStore.getState().dataLoaded(stubTraceFile(['r1', 'r2']), true);
    useAppStore.getState().routeChanged({ view: 'cost', runId: 'r2' });
    expect(selectActiveRun(useAppStore.getState())?.id).toBe('r2');
    useAppStore.getState().routeChanged({ view: 'timeline', runId: 'nope' });
    expect(selectActiveRun(useAppStore.getState())).toBeUndefined();
    useAppStore.getState().routeChanged({ view: 'sessions' });
    expect(selectActiveRun(useAppStore.getState())).toBeUndefined();
    useAppStore.getState().routeChanged({ view: 'dashboard' });
    expect(selectActiveRun(useAppStore.getState())).toBeUndefined();
  });
});

describe('inspector focus (Activity | Finding)', () => {
  const i1 = {
    id: 'i1',
    ruleId: 'retry-loop',
    severity: 'warning' as const,
    title: 't1',
    detail: 'd',
    spanIds: ['s1', 's2'],
  };
  const i2 = {
    id: 'i2',
    ruleId: 'duplicate-read',
    severity: 'info' as const,
    title: 't2',
    detail: 'd',
    spanIds: ['s2', 's3'],
  };

  it('activateInsight keeps a selected span that is evidence and focuses the finding', () => {
    useAppStore.getState().selectSpan('s1');
    useAppStore.getState().activateInsight(i1);
    const { selection } = useAppStore.getState();
    expect(selection).toEqual({
      spanId: 's1',
      insightId: 'i1',
      focus: 'insight',
    });
  });

  it('showInsight has no toggle semantics and can select the evidence span in one step', () => {
    useAppStore.getState().showInsight(i1, 's2');
    let state = useAppStore.getState();
    expect(state.selection).toEqual({
      spanId: 's2',
      insightId: 'i1',
      focus: 'insight',
    });
    expect(state.ui.inspectorOpen).toBe(true);
    // opening the same finding again does not deactivate it
    useAppStore.getState().showInsight(i1, 's2');
    expect(useAppStore.getState().selection.insightId).toBe('i1');
    // switching to another finding of the same span keeps the span
    useAppStore.getState().showInsight(i2, 's2');
    state = useAppStore.getState();
    expect(state.selection).toEqual({
      spanId: 's2',
      insightId: 'i2',
      focus: 'insight',
    });
    expect([...state.ui.highlighted].sort()).toEqual(['s2', 's3']);
    // an unrelated span is dropped rather than shown behind the finding
    useAppStore.getState().showInsight(i1, 's9');
    expect(useAppStore.getState().selection.spanId).toBeNull();
  });

  it('focusInspector flips the detail; selecting a span returns to the activity', () => {
    useAppStore.getState().showInsight(i1, 's1');
    useAppStore.getState().focusInspector('span');
    let { selection } = useAppStore.getState();
    expect(selection).toEqual({ spanId: 's1', insightId: 'i1', focus: 'span' });
    useAppStore.getState().focusInspector('insight');
    expect(useAppStore.getState().selection.focus).toBe('insight');
    useAppStore.getState().selectSpan('s2');
    ({ selection } = useAppStore.getState());
    expect(selection).toEqual({ spanId: 's2', insightId: 'i1', focus: 'span' });
  });

  it('deactivating a finding returns the focus to the activity', () => {
    useAppStore.getState().selectSpan('s1');
    useAppStore.getState().activateInsight(i1);
    useAppStore.getState().activateInsight(i1);
    const { selection, ui } = useAppStore.getState();
    expect(selection).toEqual({ spanId: 's1', insightId: null, focus: 'span' });
    expect(ui.highlighted.size).toBe(0);
  });

  it('a staged insight lands with the finding in focus', () => {
    useAppStore.getState().routeChanged({ view: 'dashboard' });
    useAppStore.getState().stageInsight(i1);
    useAppStore.getState().routeChanged({ view: 'timeline', runId: 'r2' });
    expect(useAppStore.getState().selection.focus).toBe('insight');
    useAppStore.getState().routeChanged({ view: 'timeline', runId: 'r3' });
    expect(useAppStore.getState().selection.focus).toBe('span');
  });
});
