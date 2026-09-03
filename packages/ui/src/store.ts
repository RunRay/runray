/**
 * The one zustand store (05-ARCHITECTURE §4): trace data + selection + UI
 * state. `selection.runId` and the active view are NOT duplicated here —
 * they live in the hash route (single source of truth for deep links);
 * `route` mirrors the parsed hash.
 */

import type { Insight, Run, TraceFile } from '@runray/schema';
import { useMemo } from 'react';
import { create } from 'zustand';
import {
  EMPTY_FILTER,
  filterRuns,
  type RunFilter,
  reconcileFilter,
} from './lib/filter-runs';
import type { LimitWindowConfig } from './lib/limit-window';
import {
  type OnboardingBlock,
  type PricingPayload,
  postOnboardingPatch,
  type ViewConfigPayload,
} from './lib/load';
import { DASHBOARD_ROUTE, formatHash, type Route, toHash } from './lib/router';
import { setTheme as commitTheme, currentTheme, type Theme } from './lib/theme';

export type DataState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; traceFile: TraceFile; live: boolean };

/**
 * Store→hash leg of the filter sync (D6): `history.replaceState` — filter
 * clicks never spam history AND never fire `hashchange`, so no feedback
 * loop exists by construction (the hash→store leg runs only on real
 * hashchange/load events).
 */
function writeFilterToHash(route: Route, filter: RunFilter): void {
  if (typeof window === 'undefined' || typeof history === 'undefined') return;
  const next = formatHash(route, filter);
  if (
    window.location.hash === next ||
    (window.location.hash === '' && next === toHash(DASHBOARD_ROUTE))
  )
    return;
  history.replaceState(null, '', next);
}

/**
 * Limit display mode (E1): doubly opt-in — a window config (from the CLI's
 * viewconfig or a local in-UI override) makes the toggle AVAILABLE; the
 * toggle itself defaults off and persists like the theme. localStorage
 * overrides the CLI config, mirroring the theme precedent.
 */
export interface LimitState {
  /** Effective window config (override ?? viewconfig); undefined = no mode. */
  config: LimitWindowConfig | undefined;
  enabled: boolean;
}

const LIMIT_MODE_KEY = 'runray.limitMode';
const LIMIT_OVERRIDE_KEY = 'runray.limitWindow';

function storedLimitEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return (
    localStorage.getItem(LIMIT_MODE_KEY) === 'on' ||
    localStorage.getItem('tracepulse.limitMode') === 'on'
  );
}

function storedLimitOverride(): LimitWindowConfig | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  const raw =
    localStorage.getItem(LIMIT_OVERRIDE_KEY) ??
    localStorage.getItem('tracepulse.limitWindow');
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as LimitWindowConfig)
      : undefined;
  } catch {
    return undefined;
  }
}

function persistLimit(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

export interface OnboardingState {
  enabled: boolean;
  loaded: boolean;
  welcomeDismissedAt: string | null | undefined;
  tours: Record<string, string>;
  hints: string[];
}

export interface AppState {
  data: DataState;
  route: Route;
  /**
   * The /api/events stream is actually open (i.e. `--watch` is serving it).
   * Distinct from `data.live` (merely "served by a server") — the live
   * indicator keys on this so a plain `runray view` reads as a snapshot.
   */
  streamConnected: boolean;
  setStreamConnected(connected: boolean): void;
  /**
   * Effective pricing delivered by the CLI (C2); undefined until loaded or
   * when the page has no payload (old export, older CLI) — repricing
   * surfaces then show a notice, never a fabricated table.
   */
  pricing: PricingPayload | undefined;
  viewConfig: ViewConfigPayload | undefined;
  limit: LimitState;
  onboarding: OnboardingState;
  /**
   * Global run filters (add-dashboard-extensions D2): store-only — the hash
   * stays run/view routing; filters reset on reload by design.
   */
  filter: RunFilter;
  /**
   * Active theme (add-dashboard-extensions D5). Initialized from what the
   * no-flash boot script already stamped on the root; changes flow through
   * `setTheme`/`toggleTheme`, which also persist to localStorage.
   */
  theme: Theme;
  selection: {
    spanId: string | null;
    /** Insight activated from the strip; drives evidence highlighting. */
    insightId: string | null;
    /**
     * Which detail the Inspector shows when BOTH a span and an insight are
     * set: the selected activity, or the finding it is evidence of. The
     * Inspector's Activity | Finding switch flips it; selecting a span
     * resets it to the activity, opening a finding sets it to the finding.
     */
    focus: 'span' | 'insight';
  };
  ui: {
    inspectorOpen: boolean;
    /** Keyboard-shortcut help sheet — the ? key and the TopBar button
     * share this one path (D7). */
    helpOpen: boolean;
    /** Collapsed waterfall subtrees, persisted per span id (task 3.3). */
    collapsed: ReadonlySet<string>;
    /** Evidence span ids of the active insight (empty when none). */
    highlighted: ReadonlySet<string>;
  };
  dataLoaded(traceFile: TraceFile, live: boolean): void;
  dataFailed(message: string): void;
  pricingLoaded(payload: PricingPayload | undefined): void;
  viewConfigLoaded(payload: ViewConfigPayload): void;
  onboardingLoaded(payload: OnboardingBlock | undefined): void;
  /**
   * Close the welcome dialog. `startTour` false is the "I'll explore myself"
   * branch and ALSO marks the dashboard tour skipped (plan §7.2) — otherwise
   * declining the tour would be followed immediately by the tour.
   */
  dismissWelcome(startTour: boolean): void;
  setTourStatus(tourKey: string, status: string): void;
  dismissOnboardingHint(hintKey: string): void;
  setLimitEnabled(enabled: boolean): void;
  /** In-UI settings popover: a local override, persisted; null clears it. */
  setLimitOverride(config: LimitWindowConfig | null): void;
  routeChanged(route: Route): void;
  /** Merge a partial filter change (dropdowns, drill-down, palette). */
  setFilter(patch: Partial<RunFilter>): void;
  /** Back to EMPTY_FILTER (the "clear all" chip). */
  clearFilter(): void;
  /** Hash→store leg of the sync (load, hashchange): never writes back. */
  filterFromHash(filter: RunFilter): void;
  /** Filter-less hash navigation: the active filter survives and the hash
   * is rewritten (replaceState) to carry it. */
  reattachFilterToHash(): void;
  /**
   * THE route navigation helper (D6): every programmatic hash write goes
   * through here so the active filter rides along in the URL and shared
   * links restore the same slice.
   */
  navigateTo(route: Route): void;
  /** Set the theme (applies + persists). */
  setTheme(theme: Theme): void;
  /** Flip ink ↔ paper (applies + persists). */
  toggleTheme(): void;
  /** Insight staged for activation after a cross-run navigation. */
  pendingInsight: Insight | null;
  /**
   * First run of a two-step "Compare with…" pick (run-diff 3.4). Set from
   * the sessions table or the palette; the second pick navigates to
   * `#/diff/:anchor/:pick` and clears it.
   */
  diffAnchor: string | null;
  setDiffAnchor(runId: string | null): void;
  selectSpan(spanId: string | null): void;
  /** Toggle an insight: same id deactivates; highlight follows. */
  activateInsight(insight: Insight | null): void;
  /**
   * Open a finding in the Inspector without toggle semantics (row chip,
   * Inspector switch, finding chips). A selected span that is among the
   * finding's evidence stays selected — pass `spanId` to select one in the
   * same step; an unrelated span is dropped.
   */
  showInsight(insight: Insight, spanId?: string): void;
  /** Flip the Inspector between the selected activity and the active finding. */
  focusInspector(focus: 'span' | 'insight'): void;
  /** Stage an insight to activate once the target run's route lands. */
  stageInsight(insight: Insight): void;
  toggleInspector(): void;
  /** Toggle the help sheet; pass a boolean to force a state. */
  toggleHelp(open?: boolean): void;
  toggleCollapsed(spanId: string): void;
  /** Replace the collapsed set wholesale (collapse-all / expand-all). */
  setCollapsed(spanIds: ReadonlySet<string>): void;
}

/**
 * The state that opens `insight` in the Inspector (showInsight, and the
 * activating half of activateInsight): evidence highlighted, the finding in
 * focus, a related selected span kept so the Activity | Finding switch has
 * both sides, an unrelated one dropped so no stale activity hides behind.
 */
function openInsight(
  s: AppState,
  insight: Insight,
  spanId?: string,
): Pick<AppState, 'selection' | 'ui'> {
  const current = spanId ?? s.selection.spanId;
  const keep =
    current !== null && insight.spanIds.includes(current) ? current : null;
  return {
    selection: { spanId: keep, insightId: insight.id, focus: 'insight' },
    ui: {
      ...s.ui,
      highlighted: new Set(insight.spanIds),
      inspectorOpen: true,
    },
  };
}

export const useAppStore = create<AppState>()((set) => ({
  data: { status: 'loading' },
  route: DASHBOARD_ROUTE,
  streamConnected: false,
  pricing: undefined,
  viewConfig: undefined,
  limit: { config: storedLimitOverride(), enabled: storedLimitEnabled() },
  onboarding: {
    enabled: false,
    loaded: false,
    welcomeDismissedAt: undefined,
    tours: {},
    hints: [],
  },
  filter: EMPTY_FILTER,
  // The boot script already stamped the persisted choice on the root; mirror
  // it so React components (TopBar toggle, palette) render the right state.
  theme: currentTheme(),
  selection: { spanId: null, insightId: null, focus: 'span' },
  ui: {
    inspectorOpen: true,
    helpOpen: false,
    collapsed: new Set(),
    highlighted: new Set(),
  },
  pendingInsight: null,
  diffAnchor: null,

  setDiffAnchor: (runId) => set({ diffAnchor: runId }),
  dataLoaded: (traceFile, live) =>
    // Reconcile the filter against fresh data (--watch refreshes in place):
    // a project/source that rolled off must not linger as a stale active chip.
    set((s) => ({
      data: { status: 'ready', traceFile, live },
      filter: reconcileFilter(s.filter, traceFile.runs),
    })),
  dataFailed: (message) => set({ data: { status: 'error', message } }),
  setStreamConnected: (connected) => set({ streamConnected: connected }),
  pricingLoaded: (payload) => set({ pricing: payload }),
  viewConfigLoaded: (payload) =>
    set((s) => ({
      viewConfig: payload,
      limit: {
        ...s.limit,
        // a local override wins over the CLI-delivered block
        config: storedLimitOverride() ?? payload.limitWindow,
      },
    })),
  onboardingLoaded: (payload) =>
    set({
      onboarding:
        payload === undefined
          ? {
              enabled: false,
              loaded: true,
              welcomeDismissedAt: undefined,
              tours: {},
              hints: [],
            }
          : {
              enabled: true,
              loaded: true,
              welcomeDismissedAt: payload.welcomeDismissedAt,
              tours: payload.tours ?? {},
              hints: payload.hints ?? [],
            },
    }),
  dismissWelcome: (startTour) => {
    const now = new Date().toISOString();
    const patch: OnboardingBlock = startTour
      ? { welcomeDismissedAt: now }
      : { welcomeDismissedAt: now, tours: { dashboard: 'skipped' } };
    set((s) => ({
      onboarding: {
        ...s.onboarding,
        welcomeDismissedAt: now,
        tours: startTour
          ? s.onboarding.tours
          : { ...s.onboarding.tours, dashboard: 'skipped' },
      },
    }));
    void postOnboardingPatch(patch);
  },
  setTourStatus: (tourKey, status) => {
    set((s) => {
      const nextTours = { ...s.onboarding.tours, [tourKey]: status };
      void postOnboardingPatch({ tours: { [tourKey]: status } });
      return {
        onboarding: {
          ...s.onboarding,
          tours: nextTours,
        },
      };
    });
  },
  dismissOnboardingHint: (hintKey) => {
    set((s) => {
      const nextHints = Array.from(new Set([...s.onboarding.hints, hintKey]));
      void postOnboardingPatch({ hints: [hintKey] });
      return {
        onboarding: {
          ...s.onboarding,
          hints: nextHints,
        },
      };
    });
  },
  setLimitEnabled: (enabled) => {
    persistLimit(LIMIT_MODE_KEY, enabled ? 'on' : null);
    set((s) => ({ limit: { ...s.limit, enabled } }));
  },
  setLimitOverride: (config) => {
    persistLimit(
      LIMIT_OVERRIDE_KEY,
      config === null ? null : JSON.stringify(config),
    );
    set((s) => ({ limit: { ...s.limit, config: config ?? undefined } }));
  },
  setFilter: (patch) =>
    set((s) => {
      const filter = { ...s.filter, ...patch };
      writeFilterToHash(s.route, filter);
      return { filter };
    }),
  clearFilter: () =>
    set((s) => {
      writeFilterToHash(s.route, EMPTY_FILTER);
      return { filter: EMPTY_FILTER };
    }),
  filterFromHash: (filter) =>
    set((s) => ({
      filter:
        s.data.status === 'ready'
          ? reconcileFilter(filter, s.data.traceFile.runs)
          : filter,
    })),
  reattachFilterToHash: () =>
    set((s) => {
      writeFilterToHash(s.route, s.filter);
      return {};
    }),
  navigateTo: (route) => {
    if (typeof window === 'undefined') return;
    const { filter } = useAppStore.getState();
    window.location.hash = formatHash(route, filter);
  },
  setTheme: (theme) => {
    commitTheme(theme);
    set({ theme });
  },
  toggleTheme: () =>
    set((s) => {
      const next: Theme = s.theme === 'ink' ? 'paper' : 'ink';
      commitTheme(next);
      return { theme: next };
    }),
  // Selection is per-run: switching runs drops it (and the highlight),
  // switching views within the same run keeps it (evidence links select,
  // then navigate).
  routeChanged: (route) =>
    set((s) => {
      const prevRun = 'runId' in s.route ? s.route.runId : null;
      const nextRun = 'runId' in route ? route.runId : null;
      if (prevRun === nextRun) return { route };
      // A staged insight (cross-run waste leaderboard) activates on arrival
      // instead of being wiped by the run switch.
      const pending = s.pendingInsight;
      if (pending !== null && nextRun !== null) {
        return {
          route,
          pendingInsight: null,
          selection: { spanId: null, insightId: pending.id, focus: 'insight' },
          ui: {
            ...s.ui,
            highlighted: new Set(pending.spanIds),
            inspectorOpen: true,
          },
        };
      }
      return {
        route,
        pendingInsight: null,
        selection: { spanId: null, insightId: null, focus: 'span' },
        ui: { ...s.ui, highlighted: new Set<string>() },
      };
    }),
  // Selecting a span puts the activity in front; the insight highlight
  // stays visible so evidence can be walked span by span, and the
  // Inspector switch can bring the finding back.
  selectSpan: (spanId) =>
    set((s) => ({
      selection: {
        ...s.selection,
        spanId,
        focus: spanId === null ? s.selection.focus : 'span',
      },
      ui: {
        ...s.ui,
        inspectorOpen: spanId === null ? s.ui.inspectorOpen : true,
      },
    })),
  stageInsight: (insight) => set({ pendingInsight: insight }),
  activateInsight: (insight) =>
    set((s) => {
      if (insight !== null && s.selection.insightId !== insight.id) {
        return openInsight(s, insight);
      }
      // deactivate: the highlight drops, a selected span stays in front
      return {
        selection: { ...s.selection, insightId: null, focus: 'span' },
        ui: { ...s.ui, highlighted: new Set<string>() },
      };
    }),
  showInsight: (insight, spanId) => set((s) => openInsight(s, insight, spanId)),
  focusInspector: (focus) =>
    set((s) => ({
      selection: { ...s.selection, focus },
      ui: { ...s.ui, inspectorOpen: true },
    })),
  toggleInspector: () =>
    set((s) => ({ ui: { ...s.ui, inspectorOpen: !s.ui.inspectorOpen } })),
  toggleHelp: (open) =>
    set((s) => ({ ui: { ...s.ui, helpOpen: open ?? !s.ui.helpOpen } })),
  toggleCollapsed: (spanId) =>
    set((s) => {
      const collapsed = new Set(s.ui.collapsed);
      if (!collapsed.delete(spanId)) collapsed.add(spanId);
      return { ui: { ...s.ui, collapsed } };
    }),
  setCollapsed: (spanIds) =>
    set((s) => ({ ui: { ...s.ui, collapsed: new Set(spanIds) } })),
}));

/**
 * The runs the global filters leave visible (overview, sessions table, rail).
 * The active run stays route-resolved via `selectActiveRun` — an open run
 * never disappears under the user because a filter changed.
 */
export function selectVisibleRuns(state: AppState): Run[] {
  if (state.data.status !== 'ready') return [];
  return filterRuns(state.data.traceFile.runs, state.filter);
}

/**
 * Memoized React view of `selectVisibleRuns`: subscribes to `data` and
 * `filter` only, so unrelated store churn (span selection, collapse state)
 * neither re-filters nor re-renders the consumers.
 */
export function useVisibleRuns(): Run[] {
  const data = useAppStore((s) => s.data);
  const filter = useAppStore((s) => s.filter);
  return useMemo(
    () =>
      data.status === 'ready' ? filterRuns(data.traceFile.runs, filter) : [],
    [data, filter],
  );
}

/** The run the current route points at, if it exists in the loaded file. */
export function selectActiveRun(state: AppState): Run | undefined {
  if (
    state.data.status !== 'ready' ||
    state.route.view === 'sessions' ||
    state.route.view === 'dashboard' ||
    state.route.view === 'diff'
  ) {
    return undefined;
  }
  const { runId } = state.route;
  return state.data.traceFile.runs.find((run) => run.id === runId);
}
