/**
 * @vitest-environment jsdom
 *
 * Since-reset period (visualizer "Since-reset period and budget meter", E7):
 * the period filter and the palette offer the window from `limitWindow`,
 * labelled by its real start, and the overview measures that window against
 * a budget in the display unit, or names the key that sets one. jsdom + createRoot + act, because a static
 * render reads the store's initial snapshot and never a changed one.
 */
import type { Run, TraceFile } from '@runray/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandPalette } from './components/CommandPalette';
import { FilterBar } from './components/FilterBar';
import { Overview } from './components/Overview';
import { EMPTY_FILTER, filterRuns, type RunFilter } from './lib/filter-runs';
import type { LimitWindowConfig } from './lib/limit-window';
import { useAppStore } from './store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// local wall-clock times: 2026-07-18 is a Saturday, 07-16 a Thursday
const run = (
  id: string,
  startedAt: string,
  costUSD: number,
  tokens: number,
): Run => ({
  id,
  title: `session ${id}`,
  project: { name: 'shop' },
  source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
  startedAt,
  spans: [],
  totals: {
    tokens: {
      input: 0,
      output: 0,
      cacheRead: tokens,
      cacheWrite: 0,
      total: tokens,
    },
    costUSD: { total: costUSD, wastedEstimate: 0, byModel: {} },
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
});

const RUNS: Run[] = [
  run('sat', '2026-07-18T09:30:00', 200, 300_000_000),
  run('thu', '2026-07-16T15:00:00', 100, 82_000_000),
  run('wed', '2026-07-15T10:00:00', 50, 40_000_000),
];

const initialStore = useAppStore.getInitialState();
let container: HTMLDivElement;
let root: Root;

function mount(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

function load(limitWindow?: LimitWindowConfig, live = true): void {
  useAppStore.setState({
    data: {
      status: 'ready',
      traceFile: {
        schemaVersion: '0.1.0',
        generatedAt: '2026-07-18T12:00:00.000Z',
        runs: RUNS,
      } as TraceFile,
      live,
    },
    viewConfig: limitWindow === undefined ? {} : { limitWindow },
  });
}

const text = () => container.textContent ?? '';
const buttons = () => [
  ...container.querySelectorAll<HTMLButtonElement>('button'),
];
const click = (el: HTMLElement | undefined) => {
  act(() => {
    el?.click();
  });
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState(initialStore, true);
  window.history.replaceState(null, '', '#/dashboard');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('the period filter', () => {
  it('offers the configured window by its start and filters to it', () => {
    load({ resetDay: 'thu', resetHour: 14 });
    mount(<FilterBar />);
    click(buttons().find((b) => b.textContent?.startsWith('Period')));
    const option = buttons().find((b) => b.textContent === 'Since Thu 14:00');
    expect(option?.getAttribute('role')).toBe('option');
    click(option);
    expect(useAppStore.getState().filter.period).toBe('reset');
    expect(window.location.hash).toBe('#/dashboard?period=reset');
    // the trigger names the active period
    expect(text()).toContain('PeriodSince Thu 14:00');
  });

  it('falls back to 7 days from Monday 00:00 without a config', () => {
    load();
    mount(<FilterBar />);
    click(buttons().find((b) => b.textContent?.startsWith('Period')));
    expect(buttons().map((b) => b.textContent)).toContain('Since Mon 00:00');
  });
});

describe('the palette', () => {
  it('lists the since-reset period beside the rolling ones', () => {
    load({ resetDay: 'thu', resetHour: 14 });
    // jsdom has no scrollIntoView; the palette keeps its active row in view
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => {};
    try {
      mount(<CommandPalette onClose={() => {}} />);
      const option = [
        ...container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      ].find((b) => b.textContent?.includes('Period: Since Thu 14:00'));
      expect(option).toBeDefined();
      click(option);
      expect(useAppStore.getState().filter.period).toBe('reset');
    } finally {
      Element.prototype.scrollIntoView = scroll;
    }
  });
});

describe('the budget meter', () => {
  const thu14 = { resetDay: 'thu' as const, resetHour: 14 };
  const reset: RunFilter = { ...EMPTY_FILTER, period: 'reset' };
  // since Thu 14:00: sat + thu = 382M tokens, $300
  const overview = (filter: RunFilter, cfg: LimitWindowConfig) => {
    act(() => {
      useAppStore.getState().setFilter(filter);
    });
    mount(
      <Overview
        runs={filterRuns(RUNS, filter, cfg)}
        allRuns={RUNS}
        filter={filter}
      />,
    );
  };
  const setUnit = (unit: 'usd' | 'tokens') => {
    act(() => {
      useAppStore.getState().setUnit(unit);
    });
  };

  it('measures the window against the budget in the display unit', () => {
    const cfg = { ...thu14, budgetTokens: 500_000_000 };
    load(cfg);
    setUnit('tokens');
    overview(reset, cfg);
    expect(text()).toContain('382.0M of 500.0M tokens');
    expect(text()).toContain('≈76% used (est.)');
    // dollars have no budget: no percentage, the key that would set one
    setUnit('usd');
    expect(text()).not.toContain('% used');
    expect(text()).toContain('limitWindow.budgetUSD');
  });

  it('reads as over budget past 100%', () => {
    const cfg = { ...thu14, budgetUSD: 250 };
    load(cfg);
    overview(reset, cfg);
    expect(text()).toContain('$300.00 of $250.00');
    expect(text()).toContain('≈120% used (est.), over budget');
  });

  it('stays out of the rolling periods and a pinned day', () => {
    const cfg = { ...thu14, budgetUSD: 250 };
    load(cfg);
    overview({ ...EMPTY_FILTER, period: 7 }, cfg);
    expect(text()).not.toContain('% used');
    expect(text()).not.toContain('limitWindow.');
    overview({ ...reset, day: '2026-07-18' }, cfg);
    expect(text()).not.toContain('% used');
  });

  it('an export without a budget names no config key', () => {
    load(thu14, false);
    overview(reset, thu14);
    expect(text()).not.toContain('limitWindow.');
    expect(text()).not.toContain('% used');
  });

  it('the since-reset hint names its setting and no amount', () => {
    load(thu14);
    useAppStore.setState({
      onboarding: {
        enabled: true,
        loaded: true,
        welcomeDismissedAt: null,
        tours: {},
        hints: [],
        checklist: {},
        checklistDismissed: false,
      },
    });
    overview(reset, thu14);
    const hint = container.querySelector('[role="status"]');
    expect(hint?.textContent).toContain(
      'Counts from the last reset of your usage limit',
    );
    expect(hint?.textContent).toContain('limitWindow in runray.config.json');
    expect(hint?.textContent).not.toMatch(/\$\d/);
  });
});
