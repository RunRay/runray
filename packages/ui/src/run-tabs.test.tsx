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
  href: string;
  current: boolean;
}> {
  const html = renderToStaticMarkup(
    <RunView run={stubRun('r1')} view={view} />,
  );
  const nav = /<nav aria-label="Run views"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1];
  if (nav === undefined) throw new Error('no tab bar');
  return [...nav.matchAll(/<a ([^>]*)>(.*?)<\/a>/gs)].map((m) => ({
    label: (m[2] ?? '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .trim(),
    href: /href="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '',
    current: (m[1] ?? '').includes('aria-current="page"'),
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
