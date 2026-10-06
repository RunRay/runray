import type { Run } from '@runray/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Overview } from './components/Overview';
import { EMPTY_FILTER, NO_BRANCH, type RunFilter } from './lib/filter-runs';

/**
 * Top branches card (add-branch-attribution 2.2): shown when a visible run
 * records a branch or a branch filter is on, ranked by project and branch
 * pair, and set beside Top projects in a two-column grid.
 */

function stubRun(
  id: string,
  project: { name?: string; gitBranch?: string } | undefined,
  costUSD: number,
): Run {
  return {
    id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    ...(project === undefined ? {} : { project }),
    startedAt: '2026-08-10T10:00:00.000Z',
    spans: [],
    totals: {
      tokens: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        total: 110,
      },
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

function render(runs: Run[], filter: RunFilter = EMPTY_FILTER) {
  return renderToStaticMarkup(
    <Overview runs={runs} allRuns={runs} filter={filter} />,
  );
}

/** The markup of the card whose heading is `title`, or undefined. */
function card(html: string, title: string): string | undefined {
  const start = html.indexOf(`>${title}</h3>`);
  if (start < 0) return undefined;
  return html.slice(start, html.indexOf('</section>', start));
}

describe('Top branches card', () => {
  const branched = [
    stubRun('a', { name: 'api', gitBranch: 'main' }, 3),
    stubRun('b', { name: 'web', gitBranch: 'main' }, 1),
    stubRun('c', { name: 'api' }, 0.5),
  ];

  it('ranks a branch once per project, with the project beside it', () => {
    const html = card(render(branched), 'Top branches') ?? '';
    expect(html).toContain('aria-label="Filter to branch main in api"');
    expect(html).toContain('aria-label="Filter to branch main in web"');
    expect(html).toContain('No branch recorded');
    expect(html.indexOf('in api"')).toBeLessThan(html.indexOf('in web"'));
    expect(html).toMatch(/>api<\/span>/);
  });

  it('sits beside Top projects in a two-column grid', () => {
    const html = render(branched);
    expect(html).toContain('md:grid-cols-2');
    expect(html.indexOf('>Top projects</h3>')).toBeLessThan(
      html.indexOf('>Top branches</h3>'),
    );
    expect(html.indexOf('>Top branches</h3>')).toBeLessThan(
      html.indexOf('>Top models</h3>'),
    );
  });

  it('drops the project beside each branch while a project filter is on', () => {
    const html =
      card(
        render(branched.slice(0, 1), { ...EMPTY_FILTER, project: 'api' }),
        'Top branches',
      ) ?? '';
    expect(html).toContain('aria-label="Filter to branch main in api"');
    expect(html).not.toMatch(/>api<\/span>/);
  });

  it('is absent when no visible run records a branch', () => {
    const html = render([stubRun('c', { name: 'api' }, 0.5)]);
    expect(card(html, 'Top branches')).toBeUndefined();
    expect(html).toContain('md:grid-cols-3');
  });

  it('stays, with its row active, while filtered to runs without a branch', () => {
    const html =
      card(
        render([stubRun('c', { name: 'api' }, 0.5)], {
          ...EMPTY_FILTER,
          branch: NO_BRANCH,
        }),
        'Top branches',
      ) ?? '';
    expect(html).toContain(
      'aria-pressed="true" aria-label="Filter to sessions without a recorded branch"',
    );
  });
});
