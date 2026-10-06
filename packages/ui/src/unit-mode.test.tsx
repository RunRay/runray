/**
 * @vitest-environment jsdom
 *
 * Display unit (visualizer "Display unit"): the TopBar switch flips which
 * unit the headline figures lead with, the choice persists, dollar figures
 * in token mode say "at API prices", and limit mode sets its percentages in
 * the active unit. jsdom + createRoot + act, because a static render reads
 * the store's initial snapshot and never a switched one.
 */
import type { Run, TraceFile } from '@runray/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LimitStatementLine, LimitSuffix } from './components/LimitMode';
import { Overview } from './components/Overview';
import { UnitSwitch } from './components/UnitSwitch';
import { EMPTY_FILTER } from './lib/filter-runs';
import { storedUnit, UNIT_STORAGE_KEY } from './lib/unit';
import { useAppStore } from './store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const run = (id: string, costUSD: number, tokens: number): Run => ({
  id,
  title: `session ${id}`,
  project: { name: id === 'a' ? 'alpha' : 'beta' },
  source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
  startedAt: '2026-08-10T10:00:00.000Z',
  endedAt: '2026-08-10T11:00:00.000Z',
  spans: [],
  totals: {
    tokens: {
      input: 0,
      output: 0,
      cacheRead: tokens,
      cacheWrite: 0,
      total: tokens,
    },
    costUSD: { total: costUSD, wastedEstimate: costUSD / 4, byModel: {} },
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

// alpha is the dearer session, beta the heavier one
const RUNS = [run('a', 12, 100_000), run('b', 2, 382_000_000)];

const initialStore = useAppStore.getInitialState();
let container: HTMLDivElement;
let root: Root;

function mount(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

function setUnit(unit: 'usd' | 'tokens'): void {
  act(() => {
    useAppStore.getState().setUnit(unit);
  });
}

function loadRuns(): void {
  useAppStore.setState({
    data: {
      status: 'ready',
      traceFile: {
        schemaVersion: '0.1.0',
        generatedAt: '2026-08-10T12:00:00.000Z',
        runs: RUNS,
      } as TraceFile,
      live: false,
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState(initialStore, true);
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

describe('unit preference', () => {
  it('persists the choice and reads it back; anything else means dollars', () => {
    expect(storedUnit()).toBe('usd');
    useAppStore.getState().setUnit('tokens');
    expect(useAppStore.getState().unit).toBe('tokens');
    expect(localStorage.getItem(UNIT_STORAGE_KEY)).toBe('tokens');
    expect(storedUnit()).toBe('tokens');
    localStorage.setItem(UNIT_STORAGE_KEY, 'euros');
    expect(storedUnit()).toBe('usd');
  });
});

describe('UnitSwitch', () => {
  it('marks the active unit and switches on click', () => {
    mount(<UnitSwitch />);
    const group = container.querySelector('fieldset');
    expect(group?.getAttribute('aria-label')).toBe('Unit for figures');
    const [usd, tokens] = [...container.querySelectorAll('button')];
    expect(usd?.textContent).toBe('USD');
    expect(usd?.getAttribute('aria-pressed')).toBe('true');
    expect(tokens?.getAttribute('aria-pressed')).toBe('false');
    act(() => {
      tokens?.click();
    });
    expect(useAppStore.getState().unit).toBe('tokens');
    expect(tokens?.getAttribute('aria-pressed')).toBe('true');
    expect(usd?.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Overview in each unit', () => {
  const hero = () =>
    container.querySelector('section[aria-label="Executive Overview"]');
  const leadFigure = () =>
    hero()?.querySelector('.text-hero')?.textContent ?? '';

  it('leads with dollars, then with tokens and dollars at API prices', () => {
    mount(<Overview runs={RUNS} allRuns={RUNS} filter={EMPTY_FILTER} />);
    expect(leadFigure()).toBe('$14.00');
    expect(hero()?.textContent).toContain('382.1M tokens');
    expect(hero()?.textContent).not.toContain('at API prices');

    setUnit('tokens');
    expect(leadFigure()).toBe('382.1M tokens');
    expect(hero()?.textContent).toContain('$14.00 at API prices');
    // waste has no token count: its share leads, the dollars are labelled
    expect(hero()?.textContent).toContain('Wasted share');
    expect(hero()?.textContent).toContain('$3.50 at API prices');
  });

  it('ranks the breakdown in the active unit, with no local toggle left', () => {
    mount(<Overview runs={RUNS} allRuns={RUNS} filter={EMPTY_FILTER} />);
    expect(container.querySelector('[aria-label="Metric view"]')).toBeNull();
    const projects = () =>
      [
        ...container.querySelectorAll(
          'button[aria-label^="Filter to project"]',
        ),
      ].map((b) => b.getAttribute('aria-label'));
    expect(projects()).toEqual([
      'Filter to project alpha',
      'Filter to project beta',
    ]);
    setUnit('tokens');
    expect(projects()).toEqual([
      'Filter to project beta',
      'Filter to project alpha',
    ]);
    expect(container.textContent).toContain('Tokens by day');
  });
});

describe('limit mode follows the unit', () => {
  const enable = (budget: { budgetUSD?: number; budgetTokens?: number }) =>
    useAppStore.setState({
      limit: { enabled: true, config: { days: 7, ...budget } },
    });

  it('states the window against the token budget in token mode', () => {
    loadRuns();
    enable({ budgetUSD: 28, budgetTokens: 764_200_000 });
    mount(<LimitStatementLine />);
    expect(container.textContent).toContain('$14.00 of $28.00');
    expect(container.textContent).toContain('(≈50% used, est.)');
    setUnit('tokens');
    expect(container.textContent).toContain('382.1M of 764.2M tokens');
    expect(container.textContent).toContain('(≈50% used, est.)');
  });

  it('never frames the window against itself without a budget in the unit', () => {
    loadRuns();
    enable({ budgetTokens: 1_000_000_000 });
    mount(<LimitStatementLine />);
    // dollars, no dollar budget: the window's own spend, no percentage
    expect(container.textContent).toContain('$14.00 spent this window');
    expect(container.textContent).not.toContain('%');
  });

  it('sets the figure suffix in the active unit', () => {
    loadRuns();
    enable({ budgetUSD: 100, budgetTokens: 1_000_000_000 });
    mount(<LimitSuffix valueUSD={25} tokens={500_000_000} />);
    expect(container.textContent).toBe('≈25% of window, est.');
    setUnit('tokens');
    expect(container.textContent).toBe('≈50% of window, est.');
  });
});
