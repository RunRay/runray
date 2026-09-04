import type { Insight, Run, Span } from '@runray/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LeakRail } from './components/LeakRail';
import { runWaste } from './lib/waste';

/**
 * The leak rail (visualizer "Waste tab" — leaks on the clock): a bar per
 * burned finding sized by amount, idle bands, compaction marks, the
 * context curve with its hole across the idle gap, the 200k guide, and
 * folded cents left off. Static markup — the click is a store action.
 */

const T0 = Date.parse('2026-09-04T08:00:00Z');
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
const llm = (
  id: string,
  s: number,
  tokens: { input?: number; cacheRead?: number; cacheWrite?: number },
) =>
  span({
    id,
    kind: 'llm_call',
    name: 'llm',
    startedAt: at(s),
    endedAt: at(s + 1),
    llm: {
      provider: 'anthropic',
      model: 'claude-fable-5-1',
      tokens: {
        input: tokens.input ?? 0,
        output: 1,
        cacheRead: tokens.cacheRead ?? 0,
        cacheWrite: tokens.cacheWrite ?? 0,
      },
      costUSD: 0.1,
      costSource: 'computed',
    },
  });
const tool = (id: string, s: number, name: string, status: Span['status']) =>
  span({
    id,
    name,
    status,
    startedAt: at(s),
    endedAt: at(s + 0.5),
    tool: { name, isError: status === 'error' },
  });
function finding(
  id: string,
  ruleId: string,
  spanIds: string[],
  estimatedWasteUSD: number,
): Insight {
  return {
    id,
    ruleId,
    severity: 'info',
    title: `${ruleId} ${id}`,
    detail: 'd',
    spanIds,
    estimatedWasteUSD,
  };
}
const RUN = {
  id: 'run1',
  source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
  startedAt: at(0),
  durationMs: 3600_000,
  spans: [
    span({ id: 'sess', parentId: null, kind: 'session', name: 's', depth: 0 }),
    llm('L1', 0, { input: 50_000 }),
    llm('L2', 100, { cacheRead: 277_000 }),
    llm('L3', 200, { input: 13_000, cacheRead: 34_000, cacheWrite: 13_600 }),
    llm('L4', 300, { cacheRead: 790_000 }),
    llm('L5', 400, { input: 1_000, cacheRead: 34_000, cacheWrite: 759_000 }),
    llm('L6', 3000, { cacheWrite: 150_000 }),
    tool('B1', 500, 'Bash', 'error'),
    tool('B2', 510, 'Bash', 'error'),
    tool('B3', 520, 'Bash', 'error'),
    tool('R1', 600, 'Read', 'ok'),
    tool('R2', 610, 'Read', 'ok'),
  ],
  totals: {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUSD: { total: 100, wastedEstimate: 20.95, byModel: {} },
    counts: {
      llmCalls: 6,
      toolCalls: 5,
      toolErrors: 3,
      subagents: 0,
      maxDepth: 0,
    },
    cache: { hitRate: 0 },
  },
  insights: [
    finding('i1', 'cache-prefix-break', ['L2', 'L3'], 0.26),
    finding('i2', 'cache-prefix-break', ['L4', 'L5'], 14.43),
    finding('i3', 'idle-cache-expiry', ['L5', 'L6'], 2.87),
    finding('i4', 'retry-loop', ['B1', 'B2', 'B3'], 3.36),
    finding('i5', 'duplicate-read', ['R1', 'R2'], 0.01),
    finding('i6', 'duplicate-read', ['R1', 'R2'], 0.01),
    finding('i7', 'context-bloat', ['L6', 'R1'], 59.26),
  ],
  warnings: [],
} as unknown as Run;

describe('LeakRail', () => {
  const html = renderToStaticMarkup(
    <LeakRail run={RUN} waste={runWaste(RUN)} />,
  );

  it('draws a bar per burned finding, sized by amount, and leaves cents off', () => {
    expect(html).toContain(
      '3 burned findings on the session&#x27;s time axis, 1 idle gap, 1 compaction, over the context size of 6 model calls',
    );
    // the $14.43 re-write is the tallest bar (full height); the $2.87 resume is a fraction
    expect(html).toContain('role="button"');
    expect((html.match(/role="button"/g) ?? []).length).toBe(3);
    expect(html).toContain(
      'aria-label="0h07 · cache-prefix-break i2 · $14.43"',
    );
    expect(html).not.toContain('duplicate-read');
    expect(html).not.toContain('context-bloat');
  });

  it('shades the idle gap and marks the compaction apart', () => {
    expect(html).toContain('the cache expired');
    expect(html).toContain('0h03 · compaction · $0.2600');
  });

  it('draws the context curve with a hole across the gap and the 200k guide', () => {
    // two segments: before the gap and the resumed call
    expect((html.match(/fill-opacity="0.16"/g) ?? []).length).toBe(2);
    expect(html).toContain('>200k<');
    expect(html).toContain('>794k<'); // the largest context on the axis
  });

  it('labels the axis on a clock-friendly step', () => {
    expect(html).toContain('>0h00<');
    expect(html).toContain('>0h15<');
    expect(html).toContain('>1h00<');
  });
});
