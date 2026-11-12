/**
 * @vitest-environment jsdom
 */
import type { Run } from '@runray/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunView } from './components/RunView';

/**
 * The run's tab bar. The tab that holds the wall-clock breakdown and the
 * tool table is called "Time & Tools"; its route stayed `time`, so a link
 * saved under the old name still opens it.
 */

function stubRun(id: string): Run {
  return {
    id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: '2026-08-10T10:00:00.000Z',
    durationMs: 60_000,
    spans: [],
    totals: {
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      costUSD: { total: 0.01, wastedEstimate: 0, byModel: {} },
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

/** Each tab of the bar: its label, where it leads, whether it is current. */
function tabs(view: 'cost' | 'time'): Array<{
  label: string;
  href: string | null;
  current: boolean;
}> {
  // read the markup as a document: the label is the link's own text, apart
  // from the badge element some tabs carry after it
  const page = new DOMParser().parseFromString(
    renderToStaticMarkup(<RunView run={stubRun('r1')} view={view} />),
    'text/html',
  );
  const nav = page.querySelector('nav[aria-label="Run views"]');
  if (nav === null) throw new Error('no tab bar');
  return [...nav.querySelectorAll('a')].map((link) => ({
    label: (link.firstChild?.textContent ?? '').trim(),
    href: link.getAttribute('href'),
    current: link.getAttribute('aria-current') === 'page',
  }));
}

describe('run tab bar', () => {
  it('names the tabs in order', () => {
    expect(tabs('cost').map((t) => t.label)).toEqual([
      'Overview',
      'Timeline Explorer',
      'Time & Tools',
      'Waste',
      'Errors',
    ]);
  });

  it('keeps the Time & Tools tab on the `time` route', () => {
    const tab = tabs('time').find((t) => t.label === 'Time & Tools');
    expect(tab?.href).toBe('#/run/r1/time');
    expect(tab?.current).toBe(true);
    expect(tabs('cost').find((t) => t.label === 'Time & Tools')?.current).toBe(
      false,
    );
  });
});
