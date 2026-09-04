import type { Run, Span } from '@runray/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NestedTreemap } from './components/NestedTreemap';

/**
 * A delegate worth a percent of the run lays out as a sliver the map cannot
 * label. The map keeps its proportions; the strip under it names every
 * such cell with its value, so nothing priced is invisible.
 */

function span(over: Partial<Span>): Span {
  return {
    id: 'x',
    parentId: 'sess',
    kind: 'llm_call',
    name: 'llm',
    status: 'ok',
    startedAt: '2026-09-03T10:00:00Z',
    depth: 1,
    attributes: {},
    provenance: { file: 'f' },
    ...over,
  } as Span;
}
const llm = (id: string, parent: string, cost: number) =>
  span({
    id,
    parentId: parent,
    llm: {
      provider: 'anthropic',
      model: 'm',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      costUSD: cost,
      costSource: 'computed',
    },
  });
function run(spans: Span[]): Run {
  return {
    id: 'run1',
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: '2026-09-03T10:00:00Z',
    spans: [
      span({
        id: 'sess',
        parentId: null,
        kind: 'session',
        name: 's',
        depth: 0,
      }),
      ...spans,
    ],
    totals: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUSD: { total: 100, wastedEstimate: 0, byModel: {} },
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
    warnings: [],
  } as unknown as Run;
}

describe('NestedTreemap', () => {
  it('names the delegates too small to label under the map', () => {
    const fixture = run([
      llm('l1', 'sess', 200),
      span({
        id: 't1',
        parentId: 'l1',
        kind: 'tool_call',
        name: 'Agent',
        depth: 2,
      }),
      span({
        id: 'sub1',
        parentId: 't1',
        kind: 'subagent',
        name: 'subagent:reviewer',
        depth: 3,
        agent: { name: 'reviewer' },
      }),
      llm('s1', 'sub1', 1.25),
      span({
        id: 'sub2',
        parentId: 't1',
        kind: 'subagent',
        name: 'subagent:guide',
        depth: 3,
        agent: { name: 'guide' },
      }),
      llm('s2', 'sub2', 0.14),
    ]);
    const html = renderToStaticMarkup(<NestedTreemap run={fixture} />);
    expect(html).toContain('too small to label');
    expect(html).toContain('reviewer');
    expect(html).toContain('$1.25');
    expect(html).toContain('guide');
    expect(html).toContain('$0.14');
    // the map itself still draws the big cell with its label
    expect(html).toContain('main session');
    expect(html).toContain('$200.00');
  });

  it('shows no strip when every cell carries its own label', () => {
    const fixture = run([
      llm('l1', 'sess', 60),
      span({
        id: 't1',
        parentId: 'l1',
        kind: 'tool_call',
        name: 'Agent',
        depth: 2,
      }),
      span({
        id: 'sub1',
        parentId: 't1',
        kind: 'subagent',
        name: 'subagent:reviewer',
        depth: 3,
        agent: { name: 'reviewer' },
      }),
      llm('s1', 'sub1', 40),
    ]);
    const html = renderToStaticMarkup(<NestedTreemap run={fixture} />);
    expect(html).not.toContain('too small to label');
  });
});
