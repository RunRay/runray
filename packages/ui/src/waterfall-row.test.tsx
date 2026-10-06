import type { Insight, Span } from '@runray/schema';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SpanRow } from './components/Waterfall';

/**
 * A waterfall row inside a delegation tree: rails under the enclosing
 * subagents' carets, and a collapsed row that keeps the findings it hides
 * in sight (chip, hollow notch, accessible name).
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

describe('waterfall row in a delegation tree', () => {
  it('draws a rail under each enclosing subagent’s caret', () => {
    const html = render({ rails: [1, 3] });
    // depth × 16 px indent + 13 px to the caret's centre line
    expect(html).toContain('left:29px');
    expect(html).toContain('left:61px');
    expect(html.match(/bg-span-subagent\/50/g)).toHaveLength(2);
  });

  it('starts an expanded subagent’s own rail below its caret', () => {
    const html = render({ opensRail: true });
    expect(html).toMatch(/left:61px;top:calc\(50% \+ 6px\)/);
  });

  it('keeps the findings a collapsed row hides in sight', () => {
    const html = render({
      row: {
        span: agent,
        hasChildren: true,
        collapsed: true,
        hiddenDescendants: 12,
        lane: null,
      },
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

  it('lets the row’s own finding take the notch, and names both kinds', () => {
    const html = render({
      row: {
        span: agent,
        hasChildren: true,
        collapsed: true,
        hiddenDescendants: 12,
        lane: null,
      },
      findings: [finding('costly', 'warning', ['agent'])],
      hidden: [finding('retry', 'info', ['a1'])],
    });
    expect(html).not.toMatch(/border border-outline/);
    expect(html).toContain(
      'evidence of 1 finding: costly title, hides 1 finding: retry title',
    );
  });
});
