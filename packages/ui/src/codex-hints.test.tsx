/**
 * @vitest-environment jsdom
 *
 * Hints worded per source, on a Codex run (add-codex-adapter, "Per-source
 * hints cover Codex"): the Waste lead names Codex levers and never the
 * custom-agent ones, the transcript cost note shows, the welcome dialog
 * names the agents the sessions came from, and the unpriced banner advises
 * a price refresh only where one can help. The hook-note scenario lives
 * with the other tool-table cases in time-view.test.tsx. Components are
 * mounted, not rendered to a string: a static render reads the store's
 * initial state and would never see the loaded runs or prices.
 */
import type { RunWaste, WasteGroup } from '@runray/core/waste';
import type { Run, Span } from '@runray/schema';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { CoverageBanner } from './components/CoverageNotices';
import { TranscriptCostNote } from './components/PricingProvenance';
import { logsRead, WelcomeDialog } from './components/WelcomeDialog';
import { unpricedAdvice } from './lib/coverage';
import { agentNames, agentSource } from './lib/sources';
import { instructionsFile, leadSentence } from './lib/waste';
import { useAppStore } from './store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The markup a component settles on with the store as it is now. */
function markup(node: ReactNode): string {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(node));
  const html = container.innerHTML;
  act(() => root.unmount());
  return html;
}

const initialStore = useAppStore.getInitialState();
beforeEach(() => {
  useAppStore.setState(initialStore, true);
});

type Tool = Run['source']['tool'];

const FORMAT: Record<string, Run['source']['format']> = {
  'claude-code': 'claude-jsonl',
  opencode: 'opencode-storage',
  codex: 'codex-jsonl',
  otlp: 'otlp-json',
};

function llm(id: string, model: string, priced: boolean): Span {
  return {
    id,
    parentId: null,
    kind: 'llm_call',
    name: model,
    status: 'ok',
    startedAt: '2026-11-14T10:00:00Z',
    depth: 0,
    attributes: {},
    provenance: { file: 'x' },
    llm: {
      provider: 'openai',
      model,
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      ...(priced ? { costUSD: 0.1 } : {}),
      costSource: priced ? 'computed' : 'unknown',
    },
  };
}

function run(tool: Tool, spans: Span[] = [], id = `run-${tool}`): Run {
  return {
    id,
    source: { tool, format: FORMAT[tool] ?? 'otlp-json', files: [] },
    startedAt: '2026-11-14T10:00:00Z',
    spans,
    totals: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUSD: { total: 1, wastedEstimate: 0, byModel: {} },
      counts: {
        llmCalls: spans.length,
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

/** A grouping whose largest burned group is the given one. */
function burned(group: Partial<WasteGroup> & { ruleId: string }): RunWaste {
  return {
    burned: [
      {
        label: group.ruleId,
        count: 2,
        usd: 3,
        occurrences: [],
        ...group,
      } as WasteGroup,
    ],
  } as unknown as RunWaste;
}

const SHAPES = {
  history: { history: { count: 1, usd: 3 } },
  front: { front: { count: 1, usd: 3 } },
  compaction: { compaction: { count: 1, usd: 3 } },
};
/** Every lead the Waste tab words by source. */
const WORDED: [string, RunWaste][] = [
  [
    'cache-prefix-break, history',
    burned({ ruleId: 'cache-prefix-break', shapes: SHAPES.history }),
  ],
  [
    'cache-prefix-break, front',
    burned({ ruleId: 'cache-prefix-break', shapes: SHAPES.front }),
  ],
  [
    'cache-prefix-break, compaction',
    burned({ ruleId: 'cache-prefix-break', shapes: SHAPES.compaction }),
  ],
  ['idle-cache-expiry', burned({ ruleId: 'idle-cache-expiry' })],
  ['retry-loop', burned({ ruleId: 'retry-loop' })],
  ['scattered-tool-failures', burned({ ruleId: 'scattered-tool-failures' })],
  ['dead-end-run', burned({ ruleId: 'dead-end-run' })],
];
const lever = (w: RunWaste, source: string) =>
  leadSentence(w, source)?.lever ?? '';

describe('the sources RunRay reads as agents', () => {
  it('counts Codex among them and leaves an import out', () => {
    expect(agentSource('codex')).toBe('codex');
    expect(agentSource('claude-code')).toBe('claude-code');
    expect(agentSource('otlp')).toBeUndefined();
    expect(agentSource('something-else')).toBeUndefined();
  });
});

describe('Waste lead on a Codex run', () => {
  it('continues the Codex thread after a dead end (spec scenario)', () => {
    const text = lever(burned({ ruleId: 'dead-end-run' }), 'codex');
    expect(text).toContain('`codex resume --last`');
    expect(text).not.toMatch(/caller/i);
    // the other agents keep their own command
    expect(lever(burned({ ruleId: 'dead-end-run' }), 'claude-code')).toContain(
      '`claude --continue`',
    );
    expect(lever(burned({ ruleId: 'dead-end-run' }), 'opencode')).toContain(
      '`opencode -c`',
    );
  });

  it('records facts in AGENTS.md, not in a system prompt', () => {
    expect(instructionsFile('codex')).toBe('AGENTS.md');
    for (const ruleId of ['retry-loop', 'scattered-tool-failures']) {
      const text = lever(burned({ ruleId }), 'codex');
      expect(text, ruleId).toContain('AGENTS.md');
      expect(text, ruleId).not.toContain('system prompt');
    }
  });

  it.each(WORDED)('%s: never the custom-agent wording', (_, w) => {
    const codex = lever(w, 'codex');
    expect(codex).not.toBe('');
    expect(codex).not.toMatch(/system prompt|caller|cache TTL|you re-send/);
    expect(codex).not.toMatch(/claude|opencode|CLAUDE\.md/i);
  });

  it.each(WORDED.filter(([name]) => name !== 'cache-prefix-break, compaction'))(
    '%s: an import still gets the custom-agent wording',
    (_, w) => {
      expect(lever(w, 'otlp')).not.toBe(lever(w, 'codex'));
    },
  );
});

describe('transcript cost note', () => {
  const note = (tool: Tool) => markup(<TranscriptCostNote run={run(tool)} />);
  const withPricing = () =>
    useAppStore.getState().pricingLoaded({
      origin: 'bundled',
      table: { snapshotDate: '2026-11-01', entries: [] },
    } as unknown as Parameters<
      ReturnType<typeof useAppStore.getState>['pricingLoaded']
    >[0]);

  it('shows on a Codex run with a pricing payload (spec scenario)', () => {
    withPricing();
    expect(note('codex')).toContain(
      'Computed from the recorded transcript — a lower bound.',
    );
    expect(note('claude-code')).toBe(note('codex'));
  });

  it('stays off an imported trace and off a page without prices', () => {
    expect(note('codex')).toBe('');
    withPricing();
    expect(note('otlp')).toBe('');
  });
});

describe('welcome dialog names the agents read', () => {
  it('lists the agents of the loaded runs, in a fixed order', () => {
    expect(logsRead([run('codex')])).toBe(
      'RunRay read the logs Codex already wrote.',
    );
    expect(logsRead([run('codex'), run('claude-code')])).toBe(
      'RunRay read the logs Claude Code and Codex already wrote.',
    );
    expect(logsRead([run('codex'), run('opencode'), run('claude-code')])).toBe(
      'RunRay read the logs Claude Code, OpenCode, and Codex already wrote.',
    );
    expect(agentNames([run('codex'), run('codex', [], 'b')])).toEqual([
      'Codex',
    ]);
  });

  it('names no agent for runs that came from none of them', () => {
    expect(logsRead([run('otlp')])).toBe(
      'RunRay read the traces your agents already wrote.',
    );
    // an import beside native sessions does not hide them
    expect(logsRead([run('otlp'), run('codex')])).toBe(
      'RunRay read the logs Codex already wrote.',
    );
  });

  it('a trace of Codex runs is not credited to Claude Code and OpenCode (spec scenario)', () => {
    useAppStore.getState().dataLoaded(
      {
        schemaVersion: '0.2.0',
        generator: { name: 'test', version: '0.0.0' },
        generatedAt: '2026-11-14T12:00:00.000Z',
        runs: [run('codex'), run('codex', [], 'second')],
      },
      true,
    );
    const html = markup(<WelcomeDialog />);
    expect(html).toContain('2 sessions were already on this machine.');
    expect(html).toContain('RunRay read the logs Codex already wrote.');
    expect(html).not.toContain('Claude Code');
    expect(html).not.toContain('OpenCode');
  });
});

describe('unpriced banner', () => {
  const banner = (...models: string[]) =>
    markup(
      <CoverageBanner
        runs={[
          run(
            'codex',
            models.map((m, i) => llm(`l${i}`, m, false)),
          ),
        ]}
      />,
    )
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ');

  it('advises a refresh for a model a newer price list could hold', () => {
    expect(unpricedAdvice(['gpt-9-nova'])).toEqual({
      listed: 'gpt-9-nova',
      refresh: 'refresh',
    });
    expect(banner('gpt-9-nova')).toContain(
      '1 llm call carry no price (gpt-9-nova), so totals are understated. Try runray pricing --refresh.',
    );
  });

  it('does not advise a refresh when no price is published for any of them', () => {
    expect(unpricedAdvice(['codex-auto-review'])).toEqual({
      listed: 'codex-auto-review',
      refresh: 'none',
      what: 'the model of the Codex approval reviewer',
    });
    const text = banner('codex-auto-review', 'codex-auto-review');
    expect(text).toContain(
      '2 llm calls carry no price (codex-auto-review), so totals are understated. This is the model of the Codex approval reviewer; no price is published for it, so refreshing prices changes nothing.',
    );
    expect(text).not.toContain('pricing --refresh');
  });

  it('marks the model a refresh cannot price when another one may be', () => {
    expect(unpricedAdvice(['codex-auto-review', 'gpt-9-nova'])).toEqual({
      listed: 'codex-auto-review, no published price; gpt-9-nova',
      refresh: 'refresh-others',
    });
    expect(banner('gpt-9-nova', 'codex-auto-review')).toContain(
      '(codex-auto-review, no published price; gpt-9-nova), so totals are understated. Try runray pricing --refresh for the others.',
    );
  });
});
