import type { Run, Span } from '@runray/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorTriageSections } from './components/ErrorTriageSections';

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
      model: 'm',
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
  extra: Partial<Span> = {},
) =>
  span({
    id,
    parentId: parent,
    name,
    status,
    startedAt: at(s),
    endedAt: at(s + 0.5),
    tool: { name, isError: status === 'error' },
    ...(text === undefined ? {} : { content: { outputPreview: text } }),
    ...extra,
  });
function run(spans: Span[]): Run {
  return {
    id: 'run1',
    source: { tool: 'opencode', format: 'opencode-storage', files: [] },
    startedAt: at(0),
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

describe('ErrorTriageSections', () => {
  const e1 = tool(
    'e1',
    1,
    'bash',
    'error',
    'l1',
    'bash: pnpm: command not found',
  );
  const slip = tool('e2', 4, 'read', 'error', 'l2', 'Error: File not found: x');
  const declined = tool(
    'c1',
    6,
    'edit',
    'cancelled',
    'l3',
    'Error: The user rejected permission to use this specific tool call.',
    { statusReason: 'user-rejected' },
  );
  const fixture = run([
    llm('l1', 0, 0.1),
    e1,
    llm('l2', 2, 0.4),
    tool('t1', 3, 'bash', 'ok', 'l2'),
    slip,
    llm('l3', 5, 0.2),
    tool('t2', 5.5, 'read', 'ok', 'l3'),
    declined,
  ]);

  it('names the owner and class, what happened next, and the source playbook', () => {
    const html = renderToStaticMarkup(
      <ErrorTriageSections span={e1} run={fixture} />,
    );
    expect(html).toContain('Needs you');
    expect(html).toContain('Missing program, module or permission');
    expect(html).toContain('The next bash call succeeded 2.0s later.');
    expect(html).toContain('cost $0.40');
    expect(html).toContain('What you can do · OpenCode');
    expect(html).toContain('AGENTS.md');
    expect(html).toContain('The only one in this session → Errors');
  });

  it('shows only the explanation for a single recovered agent slip', () => {
    const html = renderToStaticMarkup(
      <ErrorTriageSections span={slip} run={fixture} />,
    );
    expect(html).toContain('Agent slips');
    expect(html).toContain('Path not found');
    expect(html).toContain('Nothing to do');
    expect(html).not.toContain('What you can do');
  });

  it('tells the person a declined call is theirs, not an error', () => {
    const html = renderToStaticMarkup(
      <ErrorTriageSections span={declined} run={fixture} />,
    );
    expect(html).toContain('You declined this call');
    expect(html).not.toContain('What you can do');
  });

  it('renders nothing for a successful span', () => {
    const html = renderToStaticMarkup(
      <ErrorTriageSections span={fixture.spans[3] as Span} run={fixture} />,
    );
    expect(html).toBe('');
  });
});
