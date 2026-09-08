/**
 * App shell (task 3.1): hash routing + zustand store + data loader.
 * Layout per 03-design.md §3: top bar 44px / sessions 280px / run view /
 * inspector 360px. View internals land with tasks 3.2–3.7.
 */

import type { Run } from '@runray/schema';
import { useEffect, useRef, useState } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { DashboardTourContainer } from './components/DashboardTourContainer';
import { DiffView } from './components/DiffView';
import { ExportDialog } from './components/ExportDialog';
import { HelpSheet } from './components/HelpSheet';
import { Inspector } from './components/Inspector';
import { Overview } from './components/Overview';
import { ProvenanceStrip } from './components/ProvenanceStrip';
import { RunTeaser } from './components/RunTeaser';
import { OnboardingChecklistContainer } from './components/OnboardingChecklistContainer';
import { RunTourContainer } from './components/RunTourContainer';
import { RunView } from './components/RunView';
import { SessionsPane } from './components/SessionsPane';
import { SessionsTable } from './components/SessionsTable';
import { SideNavBar } from './components/SideNavBar';
import {
  EmptyScreen,
  ErrorScreen,
  LoadingScreen,
  NoMatchScreen,
} from './components/StatusScreens';
import { TopBar } from './components/TopBar';
import { WelcomeDialogContainer } from './components/WelcomeDialogContainer';
import {
  loadOnboarding,
  loadPricing,
  loadTraceFile,
  loadViewConfig,
  subscribeToChanges,
} from './lib/load';
import { DASHBOARD_ROUTE, parseFilterParams, parseHash } from './lib/router';
import { selectActiveRun, useAppStore, useVisibleRuns } from './store';

/** True when the event targets a text field — keys belong to typing then. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable)
  );
}

export function App() {
  const data = useAppStore((s) => s.data);
  const route = useAppStore((s) => s.route);
  const inspectorOpen = useAppStore((s) => s.ui.inspectorOpen);
  const activeRun = useAppStore(selectActiveRun);
  const visibleRuns = useVisibleRuns();
  const filter = useAppStore((s) => s.filter);
  const clearFilter = useAppStore((s) => s.clearFilter);
  const helpOpen = useAppStore((s) => s.ui.helpOpen);
  const exportOpen = useAppStore((s) => s.ui.exportOpen);
  const onboarding = useAppStore((s) => s.onboarding);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const gPressedAt = useRef(0);

  // Hash → store. The hash is the source of truth for run + view; filter
  // params ride a query suffix (D6). Filter-less hashes (plain <a> links)
  // keep the active filter — it re-attaches to the new location.
  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash;
      const state = useAppStore.getState();
      state.routeChanged(parseHash(hash));
      if (hash.includes('?')) {
        state.filterFromHash(parseFilterParams(hash));
      } else {
        state.reattachFilterToHash();
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  // Embedded data → fetch fallback; refetch on --watch SSE events.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const load = () =>
      loadTraceFile()
        .then(({ traceFile, live }) => {
          if (!cancelled) useAppStore.getState().dataLoaded(traceFile, live);
          // capture-once per build (C2): the payload follows every refetch
          return Promise.all([
            loadPricing(),
            loadViewConfig(),
            loadOnboarding(),
          ]).then(([pricing, viewConfig, onboarding]) => {
            if (cancelled) return;
            useAppStore.getState().pricingLoaded(pricing);
            useAppStore.getState().viewConfigLoaded(viewConfig);
            useAppStore.getState().onboardingLoaded(onboarding);
          });
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            useAppStore
              .getState()
              .dataFailed(err instanceof Error ? err.message : String(err));
          }
        });
    void load().then(() => {
      const state = useAppStore.getState().data;
      if (!cancelled && state.status === 'ready' && state.live) {
        unsubscribe = subscribeToChanges(
          () => void load(),
          (connected) => useAppStore.getState().setStreamConnected(connected),
        );
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      useAppStore.getState().setStreamConnected(false);
    };
  }, []);

  // Global keys (03-design.md §3): ⌘K/Ctrl-K palette · `?` help ·
  // `g t`/`g c` view switch · `[` the navigation rail.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K / Ctrl-K toggles the palette from anywhere — a modifier chord can't
      // be confused with typing, so it runs ahead of the typing-target guard
      // (the palette owns its own keys once open). The plain-key shortcuts
      // below stay guarded.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (e.key === '?') {
        e.preventDefault();
        useAppStore.getState().toggleHelp();
        return;
      }
      if (e.key === '[') {
        e.preventDefault();
        useAppStore.getState().toggleNav();
        return;
      }
      if (e.key === 'Escape') {
        useAppStore.getState().toggleHelp(false);
        return;
      }
      if (e.key === 'g') {
        gPressedAt.current = Date.now();
        return;
      }
      if (
        (e.key === 't' || e.key === 'c') &&
        Date.now() - gPressedAt.current < 600
      ) {
        gPressedAt.current = 0;
        const { route: current } = useAppStore.getState();
        // any run-scoped view is a valid switch source, incl. the Time tab
        // (was limited to timeline/cost, leaving g t / g c dead on #/…/time)
        if ('runId' in current) {
          useAppStore.getState().navigateTo({
            view: e.key === 't' ? 'timeline' : 'cost',
            runId: current.runId,
          });
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // the shell follows the rail's width: icons only, or names beside them
  const navCollapsed = useAppStore((s) => s.ui.navCollapsed);

  return (
    // The shell is viewport-bound (h-screen, not min-h-screen): every pane
    // scrolls internally, which is what the virtualized waterfall's
    // scrollToIndex, the sessions rail, and the sticky run header rely on.
    // An unbounded shell grew to content height, rendered every span, and
    // left deep links parked at the top of the document.
    <div className="flex h-screen overflow-hidden bg-bg text-text font-sans antialiased">
      <SideNavBar />
      <div
        className={`${navCollapsed ? 'ml-14' : 'ml-60'} flex-1 flex flex-col min-h-0 relative overflow-hidden bg-bg`}
      >
        {data.status === 'ready' && !data.live && (
          <ProvenanceStrip traceFile={data.traceFile} />
        )}
        <TopBar />
        <div className="flex-1 flex min-h-0 relative overflow-hidden">
          {data.status === 'loading' && (
            <main className="flex-1 h-full min-h-0">
              <LoadingScreen />
            </main>
          )}
          {data.status === 'error' && (
            <main className="flex-1 h-full min-h-0">
              <ErrorScreen message={data.message} />
            </main>
          )}
          {data.status === 'ready' &&
            (data.traceFile.runs.length === 0 ? (
              <main className="flex-1 h-full min-h-0">
                <EmptyScreen />
              </main>
            ) : route.view === 'dashboard' ? (
              // Entry screen: overview aggregates, then the sessions table —
              // both over the filtered runs (global filters, dash-ext 1.2).
              <main className="min-w-0 flex-1 overflow-y-auto">
                {visibleRuns.length === 0 ? (
                  <NoMatchScreen onClear={clearFilter} />
                ) : (
                  <div className="mx-auto flex max-w-[1180px] flex-col gap-6 p-5">
                    <Overview
                      runs={visibleRuns}
                      allRuns={data.traceFile.runs}
                      filter={filter}
                    />
                    <SessionsTable
                      runs={visibleRuns}
                      generatedAt={data.traceFile.generatedAt}
                      limit={10}
                    />
                    <RunTeaser runs={visibleRuns} />
                  </div>
                )}
              </main>
            ) : route.view === 'sessions' ? (
              // Dedicated sessions list view
              <main className="min-w-0 flex-1 overflow-y-auto">
                {visibleRuns.length === 0 ? (
                  <NoMatchScreen onClear={clearFilter} />
                ) : (
                  <div className="mx-auto flex max-w-[1180px] flex-col gap-6 p-5">
                    <SessionsTable
                      runs={visibleRuns}
                      generatedAt={data.traceFile.generatedAt}
                    />
                  </div>
                )}
              </main>
            ) : route.view === 'diff' ? (
              <DiffRoute
                runA={data.traceFile.runs.find((r) => r.id === route.runA)}
                runB={data.traceFile.runs.find((r) => r.id === route.runB)}
              />
            ) : (
              <>
                <SessionsPane runs={visibleRuns} />
                <main className="min-w-0 flex-1 flex flex-col min-h-0 overflow-hidden">
                  {activeRun !== undefined ? (
                    <RunView run={activeRun} view={route.view} />
                  ) : (
                    <RunNotFound runId={route.runId} />
                  )}
                </main>
                {activeRun !== undefined && inspectorOpen && <Inspector />}
              </>
            ))}
        </div>
      </div>
      {helpOpen && (
        <HelpSheet onClose={() => useAppStore.getState().toggleHelp(false)} />
      )}
      {exportOpen && data.status === 'ready' && data.live && (
        <ExportDialog
          onClose={() => useAppStore.getState().toggleExport(false)}
        />
      )}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {data.status === 'ready' &&
        data.traceFile.runs.length > 0 &&
        onboarding.enabled &&
        onboarding.loaded &&
        !onboarding.welcomeDismissedAt && <WelcomeDialogContainer />}
      <DashboardTourContainer />
      <RunTourContainer />
      <OnboardingChecklistContainer />
    </div>
  );
}

/**
 * Diff route guard (run-diff 3.1): an unknown run id in either slot falls
 * back to the dashboard — never a broken view.
 */
function DiffRoute({
  runA,
  runB,
}: {
  runA: Run | undefined;
  runB: Run | undefined;
}) {
  const resolved = runA !== undefined && runB !== undefined;
  useEffect(() => {
    if (!resolved) useAppStore.getState().navigateTo(DASHBOARD_ROUTE);
  }, [resolved]);
  if (runA === undefined || runB === undefined) return null;
  return <DiffView runA={runA} runB={runB} />;
}

function RunNotFound({ runId }: { runId: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="text-center">
        <p className="text-body text-text-dim">
          No run <span className="font-mono">{runId}</span> in this trace file.
        </p>
        <a
          href="#/sessions"
          className="mt-2 inline-block rounded-control border border-border bg-surface px-3 py-1 text-label text-text-dim transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text active:bg-bg"
        >
          Back to sessions
        </a>
      </div>
    </div>
  );
}
