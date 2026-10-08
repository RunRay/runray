import type { Run } from '@runray/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunView } from './components/RunView';
import { SessionsTable } from './components/SessionsTable';

/**
 * Branch on the session (add-branch-attribution 2.3): the run header names
 * the project and branch, and the sessions table shows the branch with the
 * project.
 */

function stubRun(id: string, extra: Pick<Run, 'title' | 'project'> = {}): Run {
  return {
    id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    ...extra,
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

/** The header's meta line: from the start time to the KPI bar. */
function headerMeta(run: Run): string {
  const html = renderToStaticMarkup(<RunView run={run} view="cost" />);
  return html.slice(html.indexOf('</h1>'), html.indexOf('Total Tokens'));
}

describe('run header', () => {
  it('names the project and the branch the run started on', () => {
    const meta = headerMeta(
      stubRun('r1', {
        title: 'Fix checkout',
        project: { name: 'shop', gitBranch: 'feat/export' },
      }),
    );
    expect(meta).toContain('>shop</span>');
    expect(meta).toContain('<span class="sr-only">branch </span>');
    expect(meta).toContain('>feat/export</span>');
  });

  it('leaves the project out when it is already the heading', () => {
    const meta = headerMeta(
      stubRun('r2', { project: { name: 'shop', gitBranch: 'main' } }),
    );
    expect(meta).not.toContain('>shop</span>');
    expect(meta).toContain('>main</span>');
  });

  it('adds nothing for a run without a project or branch', () => {
    const meta = headerMeta(stubRun('r3', { title: 'Untitled' }));
    expect(meta).not.toContain('sr-only');
    expect(meta).not.toContain('aria-hidden="true">·</span>');
  });
});

describe('sessions table', () => {
  const table = renderToStaticMarkup(
    <SessionsTable
      generatedAt="2026-08-10T12:00:00.000Z"
      runs={[
        stubRun('on-branch', {
          title: 'On a branch',
          project: { name: 'shop', gitBranch: 'feat/export' },
        }),
        stubRun('no-branch', { title: 'No branch', project: { name: 'docs' } }),
      ]}
    />,
  );
  const row = (title: string) => {
    const start = table.lastIndexOf('<tr', table.indexOf(`Open run ${title}`));
    return table.slice(start, table.indexOf('</tr>', start));
  };

  it('shows the branch after the project, with both in the tooltip', () => {
    const html = row('On a branch');
    expect(html).toContain('title="shop · feat/export"');
    expect(html.indexOf('>shop</span>')).toBeLessThan(
      html.indexOf('>feat/export</span>'),
    );
  });

  it('shows only the project when the run records no branch', () => {
    const html = row('No branch');
    expect(html).toContain('>docs</span>');
    expect(html).not.toContain('sr-only');
  });

  it('clips the branch, glyph included, when the project leaves no room', () => {
    const html = row('On a branch');
    const wrapper = html.slice(
      html.lastIndexOf('<span', html.indexOf('title="feat/export"')),
      html.indexOf('title="feat/export"'),
    );
    expect(wrapper).toContain('overflow-hidden');
  });

  it('moves 48px from the title to the project only when a run has a branch', () => {
    // with a branch: project 176px, title 240px
    expect(row('No branch')).toContain('max-w-44');
    expect(row('No branch')).toContain('max-w-60');
    const plain = renderToStaticMarkup(
      <SessionsTable
        generatedAt="2026-08-10T12:00:00.000Z"
        runs={[
          stubRun('opencode-only', {
            title: 'Plain',
            project: { name: 'docs' },
          }),
        ]}
      />,
    );
    // without: the widths develop had
    expect(plain).toContain('max-w-32');
    expect(plain).toContain('max-w-72');
    expect(plain).not.toContain('max-w-44');
  });
});
