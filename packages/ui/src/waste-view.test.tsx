import type { Insight, Run, Span } from '@runray/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WasteView } from './components/WasteView';
import { leadSentence, runWaste, wasteBadge } from './lib/waste';

/**
 * The Waste tab renders from the core grouping (visualizer "Waste tab"):
 * two figures kept apart, the lead sentence, burned before opportunities,
 * group grades, occurrences with tokens, the shape split, cents folded,
 * the playbook for the run's source, the empty state. Static markup is
 * enough — interactions are store actions covered elsewhere.
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
    durationMs: 500,
    tool: { name, isError: status === 'error' },
  });
function finding(
  id: string,
  ruleId: string,
  spanIds: string[],
  estimatedWasteUSD?: number,
  severity: Insight['severity'] = 'info',
): Insight {
  return {
    id,
    ruleId,
    severity,
    title: `${ruleId} ${id}`,
    detail: 'd',
    spanIds,
    ...(estimatedWasteUSD === undefined ? {} : { estimatedWasteUSD }),
  };
}
function run(insights: Insight[], wastedEstimate = 20.95): Run {
  return {
    id: 'run1',
    title: 'Waste tab fixture',
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
      llm('L1', 0, { input: 50_000 }),
      llm('L2', 100, { cacheRead: 277_000 }),
      llm('L3', 200, { input: 13_000, cacheRead: 34_000, cacheWrite: 13_600 }),
      llm('L4', 300, { cacheRead: 790_000 }),
      llm('L5', 400, { input: 1_000, cacheRead: 34_000, cacheWrite: 759_000 }),
      llm('L6', 1000, { cacheWrite: 150_000 }),
      tool('B1', 500, 'Bash', 'error'),
      tool('B2', 510, 'Bash', 'error'),
      tool('B3', 520, 'Bash', 'error'),
      tool('R1', 600, 'Read', 'ok'),
      tool('R2', 610, 'Read', 'ok'),
    ],
    totals: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUSD: { total: 100, wastedEstimate, byModel: {} },
      counts: {
        llmCalls: 6,
        toolCalls: 5,
        toolErrors: 3,
        subagents: 0,
        maxDepth: 0,
      },
      cache: { hitRate: 0 },
    },
    insights,
    warnings: [],
  } as unknown as Run;
}

const FINDINGS = [
  finding('i1', 'cache-prefix-break', ['L2', 'L3'], 0.26),
  finding('i2', 'cache-prefix-break', ['L4', 'L5'], 14.43),
  finding('i3', 'idle-cache-expiry', ['L5', 'L6'], 2.87),
  finding('i4', 'retry-loop', ['B1', 'B2', 'B3'], 3.36),
  finding('i5', 'duplicate-read', ['R1', 'R2'], 0.01),
  finding('i6', 'duplicate-read', ['R1', 'R2'], 0.01),
  finding('i7', 'context-bloat', ['L6', 'R1'], 59.26, 'critical'),
  finding('i8', 'fixed-context-overhead', ['L1'], 8.31, 'warning'),
];

describe('WasteView', () => {
  const fixture = run(FINDINGS);

  it('keeps the two figures apart and leads with the largest burn', () => {
    const html = renderToStaticMarkup(<WasteView run={fixture} />);
    expect(html).toContain('$20.95'); // the engine's capped burned total
    expect(html).toContain('up to $67.57'); // 59.26 + 8.31, never added to burned
    expect(html).toContain('21%</span> of this session');
    expect(html).toContain('Most of the burn is one pattern:');
    expect(html).toContain('1 time the conversation was re-written');
    expect(html).toContain('/compact');
  });

  it('lists burned groups before opportunities, largest first, graded as groups', () => {
    const html = renderToStaticMarkup(<WasteView run={fixture} />);
    const burned = html.indexOf('aria-label="Burned"');
    const opp = html.indexOf('aria-label="Opportunities"');
    expect(burned).toBeGreaterThan(-1);
    expect(opp).toBeGreaterThan(burned);
    const cpb = html.indexOf('Cache prefix broken mid-session');
    const retry = html.indexOf('Repeated failing tool calls');
    const idle = html.indexOf('Cache expired while idle');
    expect(cpb).toBeLessThan(retry);
    expect(retry).toBeLessThan(idle);
    // 14.69% of a $100 run: critical as a group although each finding is info
    expect(html).toContain('>15%<');
    expect(html).toContain('>critical<');
    expect(html).toContain('$14.69');
  });

  it('opens the largest burned group to its shape split, occurrences and playbook', () => {
    const html = renderToStaticMarkup(<WasteView run={fixture} />);
    expect(html).toContain(
      '1 re-write of the conversation, the front stayed cached',
    );
    expect(html).toContain('1 compaction');
    expect(html).toContain('790k → 34k cached · 759k re-written');
    expect(html).toContain('0h07'); // L5 at 400 s
    expect(html).toContain('What you can do · Claude Code');
    expect(html).toContain('Out of your hands');
  });

  it('explains how the Growing context estimate is counted, with ceilings', () => {
    const html = renderToStaticMarkup(<WasteView run={fixture} />);
    expect(html).toContain('How this is counted');
    // median of the first three main-scope calls: 50k · 277k · 60.6k
    expect(html).toContain('>61k</span> tokens');
    expect(html).toContain('>3</span> later calls');
    expect(html).toContain('Had the context never passed');
    expect(html).toContain('>784k<'); // excess above a 400k ceiling
    expect(html).toContain('>1.2M<'); // above 200k
    expect(html).toContain('Amounts need the pricing payload');
  });

  it('folds cent-level groups into one line', () => {
    const html = renderToStaticMarkup(<WasteView run={fixture} />);
    expect(html).toContain('2 findings, each under $0.05');
  });

  it('renders the empty state for a run without findings', () => {
    const html = renderToStaticMarkup(<WasteView run={run([], 0)} />);
    expect(html).toContain('Nothing leaked that the rules can see.');
    expect(html).toContain('#/run/run1');
    expect(html).toContain('What if — cheaper tier');
  });

  it('closes with the what-if repricing panel', () => {
    const html = renderToStaticMarkup(<WasteView run={fixture} />);
    const opp = html.indexOf('aria-label="Opportunities"');
    const whatIf = html.indexOf('aria-label="What if"');
    expect(whatIf).toBeGreaterThan(opp);
    expect(html).toContain('What if — cheaper tier');
  });
});

describe('lib/waste', () => {
  it('badges the tab with the burned amount in the engine tone', () => {
    expect(wasteBadge(run(FINDINGS))).toEqual({
      text: '$21',
      tone: 'alarm',
      title:
        '$20.95 burned · 21% of this session · up to $67.57 in opportunities',
    });
    expect(wasteBadge(run(FINDINGS, 0.5))?.tone).toBe('quiet');
    expect(wasteBadge(run(FINDINGS, 0.27))?.text).toBe('<$1');
    expect(wasteBadge(run([], 0))).toBeNull();
  });

  it('words the lead by the dominant shape and the source', () => {
    const w = runWaste(run(FINDINGS));
    expect(leadSentence(w, 'claude-code')).toEqual({
      opening: 'Most of the burn is one pattern:',
      what: '1 time the conversation was re-written at the write premium while the context sat at 790k tokens — $14.43.',
      lever:
        '`/compact` before the context passes ~200k, or a new session per task, would have kept it.',
    });
    expect(leadSentence(w, 'otlp')?.lever).toContain('~200k tokens');
    expect(leadSentence(runWaste(run([], 0)), 'claude-code')).toBeNull();
    // evidence that does not resolve: no shape to word, still a sentence
    const shapeless = runWaste(
      run([finding('i1', 'cache-prefix-break', ['nope', 'nope2'], 4)], 4),
    );
    expect(leadSentence(shapeless, 'claude-code')?.what).toBe(
      '1 cache break re-wrote already-cached content at the write premium — $4.00.',
    );
  });
});
