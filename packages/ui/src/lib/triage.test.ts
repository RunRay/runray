import type { Run, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { errorPill, formatOffset, runTriage } from './triage';

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
  });
function run(spans: Span[]): Run {
  return {
    id: 'run1',
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
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
      costUSD: { total: 0, wastedEstimate: 0, byModel: {} },
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

describe('errorPill', () => {
  it('is null for a clean run', () => {
    expect(errorPill(run([llm('l1', 0, 0.1)]))).toBeNull();
  });

  it('reads quiet when the agent handled its own slips', () => {
    const r = run([
      llm('l1', 0, 0.1),
      tool('e1', 1, 'Bash', 'error', 'l1', 'cd: x: No such file or directory'),
      llm('l2', 2, 0.2),
      tool('t1', 3, 'Bash', 'ok', 'l2'),
    ]);
    const pill = errorPill(r);
    expect(pill?.label).toBe('1 errors');
    expect(pill?.tone).toBe('quiet');
    expect(pill?.title).toContain('agent slips');
    expect(pill?.title).toContain('the agent handled them');
  });

  it('alarms and names the reason when a cluster needs the person', () => {
    const r = run([
      llm('l1', 0, 0.1),
      tool(
        'e1',
        1,
        'Bash',
        'error',
        'l1',
        "unexpected EOF while looking for matching `''",
      ),
      llm('l2', 2, 0.2),
      tool('t1', 3, 'Bash', 'ok', 'l2'),
      tool('e2', 4, 'Read', 'error', 'l2', 'File does not exist.'),
      tool('t2', 5, 'Read', 'ok', 'l2'),
    ]);
    const pill = errorPill(r);
    expect(pill?.label).toBe('2 errors · 1 yours to fix');
    expect(pill?.count).toBe('2 errors');
    expect(pill?.tone).toBe('alarm');
  });

  it('counts model-call failures when no tool failed', () => {
    const r = run([
      span({
        id: 'l1',
        kind: 'llm_call',
        name: 'llm',
        status: 'error',
        startedAt: at(0),
        llm: {
          provider: 'anthropic',
          model: 'm',
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          costSource: 'unknown',
        },
        content: { outputPreview: 'Not logged in · Please run /login' },
      }),
    ]);
    const pill = errorPill(r);
    expect(pill?.label).toBe('1 model error · 1 yours to fix');
    expect(pill?.tone).toBe('alarm');
  });

  it('caches the triage per run object', () => {
    const r = run([llm('l1', 0, 0.1)]);
    expect(runTriage(r)).toBe(runTriage(r));
  });
});

describe('formatOffset', () => {
  it('renders hours and zero-padded minutes', () => {
    expect(formatOffset(0)).toBe('0h00');
    expect(formatOffset(6 * 60000)).toBe('0h06');
    expect(formatOffset(98 * 60000 + 20000)).toBe('1h38');
    expect(formatOffset(-5)).toBe('0h00');
  });
});
