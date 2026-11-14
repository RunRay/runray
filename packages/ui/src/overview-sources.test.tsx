/**
 * @vitest-environment jsdom
 *
 * Codex as a named source on the dashboard (add-codex-adapter, "Codex is
 * presented as a named source"): its own segment and legend entry in the By
 * source chart, a row in the By source ranking that filters to it, and a
 * filter that lives in the URL. Colour distances are held by
 * source-palette.test.ts; this file is about what the dashboard draws.
 */
import type { Run } from '@runray/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Overview } from './components/Overview';
import { EMPTY_FILTER, filterRuns } from './lib/filter-runs';
import { formatHash, parseFilterParams } from './lib/router';
import { useAppStore } from './store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function stubRun(
  id: string,
  source: Run['source'],
  costUSD: number,
  day: string,
): Run {
  return {
    id,
    source,
    project: { name: 'api' },
    startedAt: `${day}T10:00:00.000Z`,
    spans: [],
    totals: {
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
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

// by cost: claude-code, opencode, codex. All on one day, so the day's bar
// stacks the three sources.
const runs = [
  stubRun(
    'claude',
    { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    3,
    '2026-08-10',
  ),
  stubRun(
    'open',
    { tool: 'opencode', format: 'opencode-storage', files: [] },
    2,
    '2026-08-10',
  ),
  stubRun(
    'codex',
    { tool: 'codex', format: 'codex-jsonl', files: [] },
    1,
    '2026-08-10',
  ),
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useAppStore.setState({ filter: EMPTY_FILTER });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(<Overview runs={runs} allRuns={runs} filter={EMPTY_FILTER} />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAppStore.setState({ filter: EMPTY_FILTER });
});

function press(text: string) {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  expect(button, text).toBeDefined();
  act(() => button?.click());
}

/** Legend entries of the spend chart as [label, swatch colour]. */
function legend(): [string, string][] {
  return [...container.querySelectorAll('span')]
    .filter((s) => s.querySelector(':scope > i[aria-hidden]') !== null)
    .map((s): [string, string] => [
      s.textContent?.trim() ?? '',
      s.querySelector<HTMLElement>(':scope > i')?.style.background ?? '',
    ]);
}

describe('Codex in the By source chart', () => {
  beforeEach(() => press('By source'));

  it('the legend names the three sources, codex third, each in its own colour', () => {
    const sources = legend().filter(([label]) =>
      ['claude-code', 'opencode', 'codex'].includes(label),
    );
    expect(sources.map(([label]) => label)).toEqual([
      'claude-code',
      'opencode',
      'codex',
    ]);
    expect(sources[2]?.[1]).toBe('var(--color-source-codex)');
    expect(new Set(sources.map(([, colour]) => colour)).size).toBe(3);
  });

  it('the day bar has a Codex segment, and none in the unrecognised grey', () => {
    expect(
      container.querySelectorAll('rect[fill="var(--color-source-codex)"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('rect[fill="var(--color-span-hook)"]'),
    ).toHaveLength(0);
  });
});

describe('Codex in the source filter', () => {
  it('the By source ranking has a codex row that filters to Codex runs', () => {
    const row = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Filter to source codex"]',
    );
    expect(row, 'a codex row in the ranking').not.toBeNull();
    act(() => row?.click());
    const { filter } = useAppStore.getState();
    expect(filter.source).toBe('codex');
    expect(filterRuns(runs, filter).map((r) => r.id)).toEqual(['codex']);
  });

  it('the filter survives a reload through the URL', () => {
    const hash = formatHash(
      { view: 'dashboard' },
      { ...EMPTY_FILTER, source: 'codex' },
    );
    expect(hash).toBe('#/dashboard?source=codex');
    expect(parseFilterParams(hash).source).toBe('codex');
  });
});
