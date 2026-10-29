/**
 * @vitest-environment jsdom
 *
 * Since-reset period (visualizer "Since-reset period and budget meter", E7):
 * the period filter and the palette offer the window from `limitWindow`,
 * labelled by its real start. jsdom + createRoot + act, because a static
 * render reads the store's initial snapshot and never a changed one.
 */
import type { Run, TraceFile } from '@runray/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandPalette } from './components/CommandPalette';
import { FilterBar } from './components/FilterBar';
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
