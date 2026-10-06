/**
 * @vitest-environment jsdom
 *
 * Top branches drill-down (add-branch-attribution 2.2): activating a row
 * sets the filters through the store. Static markup can't click, so this
 * file drives React through `createRoot` + `act`.
 */
import type { Run } from '@runray/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Overview } from './components/Overview';
import { EMPTY_FILTER, NO_BRANCH } from './lib/filter-runs';
import { useAppStore } from './store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function stubRun(
  id: string,
  project: { name?: string; gitBranch?: string },
  costUSD: number,
): Run {
  return {
    id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    project,
    startedAt: '2026-08-10T10:00:00.000Z',
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

const runs = [
  stubRun('a', { name: 'api', gitBranch: 'main' }, 3),
  stubRun('b', { name: 'web', gitBranch: 'main' }, 1),
  stubRun('c', { name: 'api' }, 0.5),
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

function click(label: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(button, label).not.toBeNull();
  act(() => button?.click());
}

describe('Top branches rows', () => {
  it('a branch row filters to its project and branch', () => {
    click('Filter to branch main in web');
    expect(useAppStore.getState().filter).toMatchObject({
      project: 'web',
      branch: 'main',
    });
  });

  it('the shared row filters to runs without a branch, leaving the project', () => {
    useAppStore.setState({ filter: { ...EMPTY_FILTER, project: 'api' } });
    click('Filter to sessions without a recorded branch');
    expect(useAppStore.getState().filter).toMatchObject({
      project: 'api',
      branch: NO_BRANCH,
    });
  });
});
