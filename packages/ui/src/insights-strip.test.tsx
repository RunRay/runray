import type { Insight, Run } from '@runray/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InsightsStrip } from './components/InsightsStrip';

/**
 * The findings strip hands over to the Waste tab (visualizer "Findings
 * strip hands over to the Waste tab"): the five largest pills, then
 * "+N more in Waste"; nothing to hand over below five.
 */

function finding(id: string, usd: number): Insight {
  return {
    id,
    ruleId: 'cache-prefix-break',
    severity: 'info',
    title: `finding ${id}`,
    detail: 'd',
    spanIds: [],
    estimatedWasteUSD: usd,
  };
}
function run(insights: Insight[]): Run {
  return {
    id: 'run1',
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: '2026-09-04T08:00:00.000Z',
    spans: [],
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
    insights,
  } as unknown as Run;
}

describe('InsightsStrip', () => {
  it('shows the five largest findings and hands the rest to the Waste tab', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      finding(`i${i + 1}`, i + 1),
    );
    const html = renderToStaticMarkup(
      <InsightsStrip run={run(many)} view="timeline" />,
    );
    expect((html.match(/aria-pressed=/g) ?? []).length).toBe(5);
    expect(html).toContain('finding i8'); // the largest
    expect(html).toContain('finding i4'); // the fifth
    expect(html).not.toContain('finding i3');
    expect(html).toContain('+3 more in Waste');
    expect(html).toContain('href="#/run/run1/waste"');
  });

  it('hands nothing over below five findings', () => {
    const html = renderToStaticMarkup(
      <InsightsStrip
        run={run([finding('a', 3), finding('b', 2), finding('c', 1)])}
        view="timeline"
      />,
    );
    expect((html.match(/aria-pressed=/g) ?? []).length).toBe(3);
    expect(html).not.toContain('more in Waste');
  });
});
