import type { Run, Span } from '@runray/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorsView } from './components/ErrorsView';

/**
 * The Errors tab renders from the core triage (visualizer "Errors tab"):
 * groups by owner in triage order, the summary line, the time rail, the
 * expected-feedback group collapsed, the empty state. Static markup is
 * enough — interactions are store actions covered elsewhere.
 */

const T0 = Date.parse('2026-09-03T10:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function span(over: Partial<Span>): Span {
  return {
    id: 'x',
    parentId: 'sess',
    kind: 'tool_call',
    name: 'Bash',
    status: 'ok',
    startedAt: at(0),
    depth: 2,
    attributes: {},
    provenance: { file: 'f' },
    ...over,
  } as Span;
}
const llm = (id: string, s: number, cost: number) =>
  span({
    id,
    kind: 'llm_call',
    name: 'llm',
    startedAt: at(s),
    endedAt: at(s + 1),
    llm: {
      provider: 'anthropic',
      model: 'claude-fable-5-1',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      costUSD: cost,
      costSource: 'computed',
    },
  });
const tool = (
  id: string,
  s: number,
  name: string,
  status: Span['status'],
  parent: string,
  text?: string,
) =>
  span({
    id,
    parentId: parent,
    name,
    status,
    startedAt: at(s),
    endedAt: at(s + 0.5),
    durationMs: 500,
    tool: { name, isError: status === 'error' },
    ...(text === undefined ? {} : { content: { outputPreview: text } }),
  });
function run(spans: Span[]): Run {
  return {
    id: 'run1',
    title: 'Errors tab fixture',
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: at(0),
    durationMs: 3600_000,
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
      costUSD: { total: 1, wastedEstimate: 0, byModel: {} },
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

describe('ErrorsView', () => {
  const fixture = run([
    llm('l1', 0, 0.1),
    tool(
      'e1',
      60,
      'Bash',
      'error',
      'l1',
      "/usr/bin/bash: -c: line 1: unexpected EOF while looking for matching `''",
    ),
    llm('l2', 61, 1.11),
    tool('t1', 62, 'Bash', 'ok', 'l2'),
    tool(
      'e2',
      120,
      'PowerShell',
      'error',
      'l2',
      'Failing tests: test/a_test.dart',
    ),
    llm('l3', 121, 0.67),
    tool('e3', 200, 'Read', 'error', 'l3', 'File does not exist.'),
    llm('l4', 201, 0.28),
    tool('t2', 202, 'Read', 'ok', 'l4'),
  ]);

  it('groups failures by owner, most actionable first, with the summary line', () => {
    const html = renderToStaticMarkup(<ErrorsView run={fixture} />);
    const needsYou = html.indexOf('aria-label="Yours to fix"');
    const agent = html.indexOf('aria-label="Agent slips"');
    const work = html.indexOf('aria-label="Expected feedback"');
    expect(needsYou).toBeGreaterThan(-1);
    expect(agent).toBeGreaterThan(needsYou);
    expect(work).toBeGreaterThan(agent);
    expect(html).toContain('3</span> tool errors');
    expect(html).toContain('yours to fix');
    expect(html).toContain('$2.06'); // 1.11 + 0.67 + 0.28 reacting
    expect(html).toContain('Shell syntax');
    expect(html).toContain('Path not found');
  });

  it('opens the first needs-you cluster with its text and the Claude Code playbook', () => {
    const html = renderToStaticMarkup(<ErrorsView run={fixture} />);
    expect(html).toContain('unexpected EOF while looking');
    expect(html).toContain('What you can do · Claude Code');
    expect(html).toContain('CLAUDE.md');
    expect(html).toContain('Out of your hands');
  });

  it('collapses expected feedback and offers to show it', () => {
    const html = renderToStaticMarkup(<ErrorsView run={fixture} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('>show<');
    expect(html).not.toContain('Failing tests: test/a_test.dart');
  });

  it('places every failure on the time rail', () => {
    const html = renderToStaticMarkup(<ErrorsView run={fixture} />);
    expect(html).toContain('3 failures placed on the session');
    expect(html).toContain('left:1.667%'); // e1 at 60 s of 3600 s
  });

  it('renders the empty state for a clean run', () => {
    const html = renderToStaticMarkup(
      <ErrorsView run={run([llm('l1', 0, 0.1)])} />,
    );
    expect(html).toContain('No failed calls in this session.');
    expect(html).toContain('#/run/run1');
  });
});
