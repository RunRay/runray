import type { Insight, Span } from '@runray/schema';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SpanRow } from './components/Waterfall';

/**
 * A waterfall row inside a delegation tree: rails under the enclosing
 * subagents' carets, and a collapsed row that keeps the findings it hides
 * in sight (chip, notch, accessible name).
 */

const agent: Span = {
  id: 'agent',
  parentId: 'session',
  kind: 'subagent',
  name: 'subagent:Explore',
  status: 'ok',
  startedAt: '2026-07-07T10:00:00.000Z',
  durationMs: 60_000,
  depth: 3,
  attributes: {},
  provenance: { file: 'stub.jsonl' },
};

const finding = (
  id: string,
  severity: Insight['severity'],
  spanIds: string[],
): Insight => ({
  id,
  ruleId: 'retry-loop',
  severity,
  title: `${id} title`,
  detail: '',
  spanIds,
});

function render(over: Partial<ComponentProps<typeof SpanRow>>): string {
  const noop = () => {};
  return renderToStaticMarkup(
    <SpanRow
      row={{
        span: agent,
        hasChildren: true,
        collapsed: false,
        hiddenDescendants: 0,
        lane: null,
      }}
      rails={[]}
      opensRail={false}
      range={{
        start: Date.parse(agent.startedAt),
        end: Date.parse(agent.startedAt) + 120_000,
      }}
      selected={false}
      highlighted={false}
      flash={false}
      findings={undefined}
      onOpenFinding={noop}
      hidden={undefined}
      onOpenHidden={noop}
      animate={false}
      animationDelayMs={0}
      style={{}}
      onSelect={noop}
      onToggle={noop}
      onHover={noop}
      {...over}
    />,
  );
}

const collapsedRow = {
  span: agent,
  hasChildren: true,
  collapsed: true,
  hiddenDescendants: 12,
  lane: null,
};

describe('waterfall row in a delegation tree', () => {
  it('draws a rail under each enclosing subagent’s caret', () => {
    const html = render({ rails: [1, 3] });
    // depth × 16 px indent + 13 px to the caret's centre line
    expect(html).toContain('left:29px');
    expect(html).toContain('left:61px');
    expect(html.match(/bg-span-subagent\/35/g)).toHaveLength(2);
  });

  it('starts an expanded subagent’s own rail below its caret', () => {
    const html = render({ opensRail: true });
    expect(html).toMatch(/left:61px;top:calc\(50% \+ 6px\)/);
  });

  it('keeps the findings a collapsed row hides in sight', () => {
    const html = render({
      row: collapsedRow,
      hidden: [
        finding('loop', 'critical', ['i1']),
        finding('retry', 'warning', ['a1']),
      ],
    });
    expect(html).toContain('⚠ 2 inside');
    expect(html).toContain('bg-heat-3/15'); // tinted by the worst
    expect(html).toMatch(/border border-heat-3/); // hollow notch
    expect(html).toContain(
      'aria-label="subagent subagent:Explore, hides 2 findings: loop title; retry title"',
    );
  });

  it('puts the inside chip ahead of the long rollup, where a narrow view keeps it', () => {
    const html = render({
      row: collapsedRow,
      rollup: {
        costUSD: 3.4,
        unpricedCalls: 0,
        tokens: 2_947_885,
        llmCalls: 25,
      },
      hidden: [finding('retry', 'warning', ['a1'])],
    });
    expect(html.indexOf('inside')).toBeGreaterThan(-1);
    expect(html.indexOf('inside')).toBeLessThan(html.indexOf('Σ'));
  });

  it('gives the notch to the row’s own finding when it is at least as bad', () => {
    const html = render({
      row: collapsedRow,
      findings: [finding('costly', 'warning', ['agent'])],
      hidden: [finding('retry', 'info', ['a1'])],
    });
    expect(html).toMatch(/-translate-y-1\/2 bg-heat-2/);
    expect(html).not.toMatch(/border border-outline/);
    expect(html).toContain(
      'evidence of 1 finding: costly title, hides 1 finding: retry title',
    );
  });

  it('gives the notch to a hidden finding that is worse than the row’s own', () => {
    const html = render({
      row: collapsedRow,
      findings: [finding('costly', 'info', ['agent'])],
      hidden: [finding('loop', 'critical', ['i1'])],
    });
    expect(html).toMatch(/border border-heat-3/);
    expect(html).not.toMatch(/-translate-y-1\/2 bg-outline/);
  });
});

describe('waterfall row label', () => {
  const failed: Span = {
    ...agent,
    id: 'bash',
    kind: 'tool_call',
    name: 'Bash',
    status: 'error',
    durationMs: 50,
  };
  const leaf = {
    span: failed,
    hasChildren: false,
    collapsed: false,
    hiddenDescendants: 0,
    lane: 'start' as const,
  };

  it('never starts inside the tree gutter, where rails and brackets run', () => {
    // a tiny bar at the run's start would put the label at ~6 px, across
    // the depth-3 bracket (50 px) and the enclosing rails
    const html = render({ row: leaf, rails: [1] });
    // depth × 16 px indent + 26 px clears the caret column
    expect(html).toMatch(/left:max\(calc\([\d.e-]+% \+ 6px\), 74px\)/);
  });

  it('keeps the error mark in the label, not hanging off a thin bar', () => {
    const html = render({ row: leaf });
    const bar = html.match(
      /<span aria-hidden="true" class="absolute top-1\/2 h-3\.5[^>]*>(.*?)<\/span>/,
    );
    expect(bar?.[1]).toBe('');
    expect(html).toMatch(/✕<\/span><span class="text-span-error">Bash/);
  });
});
