/**
 * @vitest-environment jsdom
 *
 * Display unit (visualizer "Display unit"): the TopBar switch flips which
 * unit the headline figures lead with, the choice persists, dollar figures
 * in token mode say "at API prices", and limit mode sets its percentages in
 * the active unit. jsdom + createRoot + act, because a static render reads
 * the store's initial snapshot and never a switched one.
 */
import type { Insight, Run, Span, TraceFile } from '@runray/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandPalette } from './components/CommandPalette';
import { CostView } from './components/CostView';
import { LimitStatementLine, LimitSuffix } from './components/LimitMode';
import { Overview } from './components/Overview';
import { RunTeaser } from './components/RunTeaser';
import { RunView } from './components/RunView';
import { SessionsPane } from './components/SessionsPane';
import { ToolRankCard } from './components/ToolRankCard';
import { UnitSwitch } from './components/UnitSwitch';
import { WasteView } from './components/WasteView';
import { EMPTY_FILTER } from './lib/filter-runs';
import { assignModelColorVars } from './lib/model-colors';
import { storedUnit, UNIT_STORAGE_KEY } from './lib/unit';
import { useAppStore } from './store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const run = (id: string, costUSD: number, tokens: number): Run => ({
  id,
  title: `session ${id}`,
  project: { name: id === 'a' ? 'alpha' : 'beta' },
  source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
  startedAt: '2026-08-10T10:00:00.000Z',
  endedAt: '2026-08-10T11:00:00.000Z',
  spans: [],
  totals: {
    tokens: {
      input: 0,
      output: 0,
      cacheRead: tokens,
      cacheWrite: 0,
      total: tokens,
    },
    costUSD: { total: costUSD, wastedEstimate: costUSD / 4, byModel: {} },
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
});

// alpha is the dearer session, beta the heavier one
const RUNS = [run('a', 12, 100_000), run('b', 2, 382_000_000)];

const llm = (
  id: string,
  model: string,
  tokens: { input: number; cacheRead: number },
  costUSD: number,
): Span => ({
  id,
  parentId: null,
  kind: 'llm_call',
  name: model,
  status: 'ok',
  startedAt: '2026-08-10T10:00:00.000Z',
  durationMs: 1000,
  depth: 0,
  llm: {
    provider: 'anthropic',
    model,
    tokens: { output: 0, cacheWrite: 0, ...tokens },
    costUSD,
    costSource: 'computed',
  },
  attributes: {},
  provenance: { file: 'x' },
});

const tool = (
  id: string,
  parentId: string,
  name: string,
  mcpServer?: string,
): Span => ({
  id,
  parentId,
  kind: mcpServer === undefined ? 'tool_call' : 'mcp_call',
  name,
  status: 'ok',
  startedAt: '2026-08-10T10:00:01.000Z',
  durationMs: 500,
  depth: 1,
  tool: {
    name,
    isError: false,
    ...(mcpServer === undefined ? {} : { mcpServer }),
  },
  attributes: {},
  provenance: { file: 'x' },
});

const deadEnd: Insight = {
  id: 'i1',
  ruleId: 'dead-end-run',
  severity: 'warning',
  title: 'Run ended in an error',
  detail: 'detail',
  spanIds: ['lb'],
  estimatedWasteUSD: 2.5,
};

// opus is the pricey, light call under bash; haiku the cheap one that read a
// large cached context under an MCP tool — so the two units rank them apart
const SPAN_RUN: Run = {
  ...run('s', 10, 1000),
  spans: [
    llm('la', 'opus', { input: 100, cacheRead: 0 }, 9),
    tool('a1', 'la', 'bash'),
    llm('lb', 'haiku', { input: 0, cacheRead: 900 }, 1),
    tool('b1', 'lb', 'ctx7_query', 'ctx7'),
  ],
  totals: {
    ...run('s', 10, 1000).totals,
    tokens: {
      input: 100,
      output: 0,
      cacheRead: 900,
      cacheWrite: 0,
      total: 1000,
    },
    costUSD: { total: 10, wastedEstimate: 2.5, byModel: { opus: 9, haiku: 1 } },
  },
  insights: [deadEnd],
};

const initialStore = useAppStore.getInitialState();
let container: HTMLDivElement;
let root: Root;

function mount(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

function setUnit(unit: 'usd' | 'tokens'): void {
  act(() => {
    useAppStore.getState().setUnit(unit);
  });
}

function loadRuns(): void {
  useAppStore.setState({
    data: {
      status: 'ready',
      traceFile: {
        schemaVersion: '0.1.0',
        generatedAt: '2026-08-10T12:00:00.000Z',
        runs: RUNS,
      } as TraceFile,
      live: false,
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState(initialStore, true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('unit preference', () => {
  it('persists the choice and reads it back; anything else means dollars', () => {
    expect(storedUnit()).toBe('usd');
    useAppStore.getState().setUnit('tokens');
    expect(useAppStore.getState().unit).toBe('tokens');
    expect(localStorage.getItem(UNIT_STORAGE_KEY)).toBe('tokens');
    expect(storedUnit()).toBe('tokens');
    localStorage.setItem(UNIT_STORAGE_KEY, 'euros');
    expect(storedUnit()).toBe('usd');
  });
});

describe('UnitSwitch', () => {
  it('marks the active unit and switches on click', () => {
    mount(<UnitSwitch />);
    const group = container.querySelector('fieldset');
    expect(group?.getAttribute('aria-label')).toBe('Unit for figures');
    const [usd, tokens] = [...container.querySelectorAll('button')];
    expect(usd?.textContent).toBe('USD');
    expect(usd?.getAttribute('aria-pressed')).toBe('true');
    expect(tokens?.getAttribute('aria-pressed')).toBe('false');
    act(() => {
      tokens?.click();
    });
    expect(useAppStore.getState().unit).toBe('tokens');
    expect(tokens?.getAttribute('aria-pressed')).toBe('true');
    expect(usd?.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Overview in each unit', () => {
  const hero = () =>
    container.querySelector('section[aria-label="Executive Overview"]');
  const leadFigure = () =>
    hero()?.querySelector('.text-hero')?.textContent ?? '';

  it('leads with dollars, then with tokens and dollars at API prices', () => {
    mount(<Overview runs={RUNS} allRuns={RUNS} filter={EMPTY_FILTER} />);
    expect(leadFigure()).toBe('$14.00');
    expect(hero()?.textContent).toContain('382.1M tokens');
    expect(hero()?.textContent).not.toContain('at API prices');

    setUnit('tokens');
    expect(leadFigure()).toBe('382.1M tokens');
    expect(hero()?.textContent).toContain('$14.00 at API prices');
    // waste has no token count: its share leads, the dollars are labelled
    expect(hero()?.textContent).toContain('Wasted share');
    expect(hero()?.textContent).toContain('$3.50 at API prices');
  });

  it('ranks the breakdown in the active unit, with no local toggle left', () => {
    mount(<Overview runs={RUNS} allRuns={RUNS} filter={EMPTY_FILTER} />);
    expect(container.querySelector('[aria-label="Metric view"]')).toBeNull();
    const projects = () =>
      [
        ...container.querySelectorAll(
          'button[aria-label^="Filter to project"]',
        ),
      ].map((b) => b.getAttribute('aria-label'));
    expect(projects()).toEqual([
      'Filter to project alpha',
      'Filter to project beta',
    ]);
    setUnit('tokens');
    expect(projects()).toEqual([
      'Filter to project beta',
      'Filter to project alpha',
    ]);
    expect(container.textContent).toContain('Tokens by day');
  });
});

describe('limit mode follows the unit', () => {
  const enable = (budget: { budgetUSD?: number; budgetTokens?: number }) =>
    useAppStore.setState({
      limit: { enabled: true, config: { days: 7, ...budget } },
    });

  it('states the window against the token budget in token mode', () => {
    loadRuns();
    enable({ budgetUSD: 28, budgetTokens: 764_200_000 });
    mount(<LimitStatementLine />);
    expect(container.textContent).toContain('$14.00 of $28.00');
    expect(container.textContent).toContain('(≈50% used, est.)');
    setUnit('tokens');
    expect(container.textContent).toContain('382.1M of 764.2M tokens');
    expect(container.textContent).toContain('(≈50% used, est.)');
  });

  it('never frames the window against itself without a budget in the unit', () => {
    loadRuns();
    enable({ budgetTokens: 1_000_000_000 });
    mount(<LimitStatementLine />);
    // dollars, no dollar budget: the window's own spend, no percentage
    expect(container.textContent).toContain('$14.00 spent this window');
    expect(container.textContent).not.toContain('%');
  });

  it('sets the figure suffix in the active unit', () => {
    loadRuns();
    enable({ budgetUSD: 100, budgetTokens: 1_000_000_000 });
    mount(<LimitSuffix valueUSD={25} tokens={500_000_000} />);
    expect(container.textContent).toBe('≈25% of window, est.');
    setUnit('tokens');
    expect(container.textContent).toBe('≈50% of window, est.');
  });
});

describe('every surface the unit drives', () => {
  const text = () => container.textContent ?? '';

  it('palette: the units command flips the unit and the run hints follow', () => {
    useAppStore.setState({
      data: {
        status: 'ready',
        traceFile: {
          schemaVersion: '0.1.0',
          generatedAt: '2026-08-10T12:00:00.000Z',
          runs: [SPAN_RUN],
        } as TraceFile,
        live: false,
      },
    });
    // jsdom has no scrollIntoView; the palette keeps its active row in view
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => {};
    try {
      mount(<CommandPalette onClose={() => {}} />);
      expect(text()).toContain('$10.00');
      const option = [
        ...container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      ].find((b) => b.textContent?.includes('Lead with tokens'));
      act(() => {
        option?.click();
      });
      expect(useAppStore.getState().unit).toBe('tokens');
      expect(text()).toContain('1k tokens');
      expect(text()).toContain('Lead with dollars');
    } finally {
      Element.prototype.scrollIntoView = scroll;
    }
  });

  it('Explorer list: one figure per session, its unit named', () => {
    mount(<SessionsPane runs={[SPAN_RUN]} />);
    expect(text()).toContain('$10.00');
    setUnit('tokens');
    expect(text()).toContain('1k tokens');
    expect(text()).not.toContain('$10.00');
  });

  it('Cost view: hero, tool leaderboard and subtree map follow the unit', () => {
    mount(<CostView run={SPAN_RUN} />);
    const leaderboard = () =>
      [...container.querySelectorAll('tbody tr td:first-child')].map(
        (td) => td.textContent,
      );
    const mapMode = () =>
      container.querySelector(
        'fieldset[aria-label="Subtree map value mode"] button[aria-pressed="true"]',
      )?.textContent;
    expect(text()).toContain('total cost');
    expect(text()).toContain('Tool spend leaderboard');
    expect(leaderboard()).toEqual(['bash', 'ctx7_query']);
    expect(mapMode()).toBe('cost');

    setUnit('tokens');
    expect(text()).toContain('total tokens');
    expect(text()).toContain('cost at API prices');
    expect(text()).toContain('Tool token leaderboard');
    expect(leaderboard()).toEqual(['ctx7_query', 'bash']);
    expect(mapMode()).toBe('tokens');

    // the map's own toggle still works until the next unit flip
    const costButton = [
      ...container.querySelectorAll<HTMLButtonElement>(
        'fieldset[aria-label="Subtree map value mode"] button',
      ),
    ].find((b) => b.textContent === 'cost');
    act(() => {
      costButton?.click();
    });
    expect(mapMode()).toBe('cost');
    setUnit('usd');
    setUnit('tokens');
    expect(mapMode()).toBe('tokens');
  });

  it('By-tool card: ranks and shares attributed tokens in token mode', () => {
    mount(<ToolRankCard runs={[SPAN_RUN]} activeTool={null} />);
    const first = () =>
      container.querySelector('li button span.truncate')?.textContent;
    expect(first()).toBe('bash');
    expect(text()).toContain('10% of attributed spend');
    setUnit('tokens');
    expect(first()).toBe('ctx7_query');
    expect(text()).toContain('900 tokens');
    expect(text()).toContain('90% of attributed tokens');
  });

  it('run preview: heaviest run split by tokens, dollars at API prices', () => {
    mount(<RunTeaser runs={[SPAN_RUN]} />);
    const firstModel = () =>
      container.querySelectorAll('ul li span.truncate')[1]?.textContent;
    expect(text()).toContain('Where the money went in this run');
    expect(firstModel()).toBe('opus');
    setUnit('tokens');
    expect(text()).toContain('Where the tokens went in this run');
    expect(firstModel()).toBe('haiku');
    expect(text()).toContain('$1.00 at API prices');
  });

  it('day chart: stacks each model by its tokens in token mode', () => {
    mount(
      <Overview runs={[SPAN_RUN]} allRuns={[SPAN_RUN]} filter={EMPTY_FILTER} />,
    );
    const vars = assignModelColorVars(['opus', 'haiku']);
    const chart = () =>
      container.querySelector(
        'section[data-tour="overview-trend"], section[aria-label$="by day"]',
      );
    const heightOf = (model: string) =>
      Number(
        chart()
          ?.querySelector(`rect[fill="${vars.get(model)}"]`)
          ?.getAttribute('height'),
      );
    const byModel = () =>
      [...(chart()?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === 'By model',
      );
    act(() => {
      byModel()?.click();
    });
    // dollars: opus $9 towers over haiku $1
    expect(heightOf('opus')).toBeGreaterThan(heightOf('haiku') * 5);
    setUnit('tokens');
    // tokens: haiku's 900 towers over opus's 100
    expect(heightOf('haiku')).toBeGreaterThan(heightOf('opus') * 5);
  });

  it('Wasted card: nothing priced reads as unknown, not 0.0%', () => {
    const unpriced = run('u', 0, 5000);
    mount(
      <Overview runs={[unpriced]} allRuns={[unpriced]} filter={EMPTY_FILTER} />,
    );
    const wastedCard = () =>
      [...container.querySelectorAll('section')].find((sec) =>
        sec.querySelector('.micro-label')?.textContent?.startsWith('Wasted'),
      )?.textContent ?? '';
    for (const unit of ['usd', 'tokens'] as const) {
      setUnit(unit);
      expect(wastedCard()).toContain('—no priced calls');
      expect(wastedCard()).not.toContain('%');
    }
  });

  it('run header and Waste tab: headline estimates say "at API prices"', () => {
    mount(<RunView run={SPAN_RUN} view="cost" />);
    expect(text()).toContain('Cost (USD)');
    expect(text()).not.toContain('at API prices');
    setUnit('tokens');
    expect(text()).toContain('Burned / Opportunities · at API prices');

    act(() => {
      root.render(<WasteView run={SPAN_RUN} />);
    });
    expect(text()).toContain('$2.50 at API prices');
    setUnit('usd');
    expect(text()).not.toContain('at API prices');
  });
});
