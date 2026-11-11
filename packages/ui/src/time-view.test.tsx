/**
 * @vitest-environment jsdom
 *
 * The Time tab (visualizer spec: "Run time breakdown" and the tool-usage
 * requirements that follow it). Runs are built inline with literal
 * commands, classified the way the adapters classify them: committed
 * fixtures hold filler words where commands were. The file runs under jsdom
 * because expanding, filtering and sorting are DOM behaviours.
 */
import { toolUsageAttributes } from '@runray/core/tools';
import type { Run, Span } from '@runray/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HINT_COPY } from './components/ContextualHint';
import { TimeView } from './components/TimeView';
import {
  activityParts,
  formatShare,
  runToolUsage,
  UNRESOLVED_PART,
} from './lib/tool-usage';
import { useAppStore } from './store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const T0 = Date.parse('2026-11-11T10:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
const at = (ms: number) => new Date(T0 + ms).toISOString();
let seq = 0;

interface Over extends Partial<Span> {
  name: string;
  /** Offset of the start from the run's start, in ms. */
  start: number;
  /** Duration in ms; `null` leaves the span in progress. */
  ms: number | null;
}

export function span({ start, ms, ...over }: Over): Span {
  seq++;
  const kind = over.kind ?? 'tool_call';
  return {
    id: `s${seq}`,
    parentId: 'sess',
    kind,
    status: ms === null ? 'in_progress' : 'ok',
    startedAt: at(start),
    ...(ms === null ? {} : { endedAt: at(start + ms), durationMs: ms }),
    depth: 1,
    attributes: {},
    provenance: { file: 'inline.jsonl' },
    ...(kind === 'tool_call' || kind === 'mcp_call'
      ? { tool: { name: over.name, isError: false } }
      : {}),
    ...over,
  };
}

/** A shell call stamped the way the adapters stamp it. */
export function shell(
  command: string,
  start: number,
  ms: number | null,
  redact = false,
): Span {
  return span({
    name: 'Bash',
    start,
    ms,
    attributes: toolUsageAttributes(command, 'posix', redact),
  });
}

export function mkRun(
  spans: Span[],
  endMs: number,
  source = 'claude-code',
): Run {
  return {
    id: 'run_time',
    source: {
      tool: source as Run['source']['tool'],
      format: source === 'otlp' ? 'otlp-json' : 'claude-jsonl',
      files: [],
    },
    startedAt: at(0),
    endedAt: at(endMs),
    durationMs: endMs,
    spans: [
      {
        id: 'sess',
        parentId: null,
        kind: 'session',
        name: 'session',
        status: 'ok',
        startedAt: at(0),
        endedAt: at(endMs),
        durationMs: endMs,
        depth: 0,
        attributes: {},
        provenance: { file: 'inline.jsonl' },
      },
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
        maxDepth: 1,
      },
      cache: { hitRate: 0 },
    },
    insights: [],
  };
}

const initialStore = useAppStore.getInitialState();
let container: HTMLDivElement;
let root: Root;

function mount(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

beforeEach(() => {
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

const q = <T extends Element = HTMLElement>(
  selector: string,
  scope: Element = container,
): T => {
  const found = scope.querySelector<T>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};
const all = (selector: string, scope: Element = container): HTMLElement[] => [
  ...scope.querySelectorAll<HTMLElement>(selector),
];
const text = (el: Element): string =>
  (el.textContent ?? '').replace(/\s+/g, ' ').trim();
/** The text of each cell of a table row. */
const cells = (row: Element): string[] => [...row.children].map(text);

describe('wall-clock strip (visualizer "Run time breakdown")', () => {
  // ten minutes on a question, a model call either side, a tool, a long gap
  const run = () =>
    mkRun(
      [
        span({ kind: 'llm_call', name: 'model', start: 0, ms: 30 * SEC }),
        span({ name: 'AskUserQuestion', start: 30 * SEC, ms: 10 * MIN }),
        span({
          kind: 'llm_call',
          name: 'model',
          start: 10 * MIN + 30 * SEC,
          ms: 30 * SEC,
        }),
        shell('pnpm test', 11 * MIN, 2 * MIN),
      ],
      16 * MIN,
    );

  it('lists five segments in the legend, each with a time and a share', () => {
    mount(<TimeView run={run()} />);
    const rows = all('[data-testid="wall-clock-legend"] tr');
    expect(rows.map((r) => text(r.children[0] as Element))).toEqual([
      'model wait',
      'tool execution',
      'waiting on you',
      'coordination',
      'idle',
    ]);
    expect(cells(rows[2] as HTMLElement)).toEqual([
      'waiting on you',
      '10m 0s',
      '63%',
    ]);
    expect(cells(rows[1] as HTMLElement)).toEqual([
      'tool execution',
      '2m 0s',
      '13%',
    ]);
  });

  it('names all five segments in the strip label', () => {
    mount(<TimeView run={run()} />);
    const label = q('[role="img"]').getAttribute('aria-label') ?? '';
    expect(label).toBe(
      'model wait 1m 0s, tool execution 2m 0s, waiting on you 10m 0s, coordination 0ms, idle 3m 0s',
    );
  });

  it('draws waiting with a pattern of its own, in the strip and the legend', () => {
    mount(<TimeView run={run()} />);
    const hatched = all('.hatch-waiting');
    // one strip segment and one legend swatch
    expect(hatched).toHaveLength(2);
    expect(hatched[0]?.getAttribute('title')).toBe('waiting on you · 10m 0s');
    // idle keeps its solid wash: the two never share a fill
    expect(all('[role="img"] > .bg-heat-1\\/40')).toHaveLength(1);
  });

  it('says in the hint that a session can wait on the person', () => {
    expect(HINT_COPY['time-view']).toContain('on you');
  });
});

/** Ten activities and one unresolved command; 3m 45s of summed tool time. */
function tenActivities(): Run {
  let t = 0;
  const next = (ms: number) => {
    const start = t;
    t += ms + SEC;
    return start;
  };
  const call = (command: string, ms: number) => shell(command, next(ms), ms);
  const tool = (name: string, ms: number) =>
    span({ name, start: next(ms), ms });
  return mkRun(
    [
      call('vitest run', 60 * SEC), // test
      call('cargo build', 50 * SEC), // build
      call('tsc --noEmit', 40 * SEC), // check
      call('pnpm dev', 30 * SEC), // run
      tool('Edit', 20 * SEC), // edit
      tool('Read', 10 * SEC), // explore
      call('git status', 4 * SEC), // vcs
      call('pnpm install', 3 * SEC), // deps
      call('docker ps', 2 * SEC), // infra
      call('curl -sf localhost:3000', 1 * SEC), // web
      call('acme-deploy --prod', 5 * SEC), // no registry tool
    ],
    5 * MIN,
  );
}

describe('activity bar (visualizer "Tool time by activity")', () => {
  const card = () => q('[aria-label="Tool time by activity"]');
  const legend = () => all('[data-testid="activity-legend"] button');
  const entry = (label: string): HTMLElement => {
    const found = legend().find((b) => text(b).startsWith(label));
    if (found === undefined) throw new Error(`no legend entry ${label}`);
    return found;
  };
  const swatch = (button: HTMLElement) => button.querySelector('i')?.className;
  /** Label, time and share of a legend entry (the swatch has no text). */
  const figures = (button: HTMLElement) => cells(button).filter(Boolean);

  it('has parts that add up to the sum in its heading (spec scenario)', () => {
    const run = tenActivities();
    const usage = runToolUsage(run);
    const parts = activityParts(usage);
    expect(parts.reduce((acc, p) => acc + p.totalMs, 0)).toBe(usage.summedMs);
    expect(usage.summedMs).toBe(225 * SEC);

    mount(<TimeView run={run} />);
    expect(text(card())).toContain('summed tool time · 3m 45s');
    expect(legend()).toHaveLength(parts.length);
    // every legend entry carries its time and its share as text
    expect(figures(entry('Test'))).toEqual(['Test', '1m 0s', '27%']);
    expect(figures(entry('Unresolved'))).toEqual(['Unresolved', '5.0s', '2%']);
  });

  it('names the figure as summed and says parallel calls overlap (spec scenario)', () => {
    // three one-minute calls at the same moment: 3m summed in 1m of clock
    const run = mkRun(
      [
        shell('vitest run', 0, MIN),
        shell('cargo build', 0, MIN),
        shell('tsc --noEmit', 0, MIN),
      ],
      MIN,
    );
    mount(<TimeView run={run} />);
    expect(text(card())).toContain('summed tool time · 3m 0s');
    expect(text(card())).toContain('Parallel calls overlap');
    // the clock above it still says one minute
    expect(text(container)).toContain('wall-clock · 1m 0s');
  });

  it('colours the six largest and folds the rest into one neutral part (spec scenario)', () => {
    mount(<TimeView run={tenActivities()} />);
    expect(legend().map((b) => figures(b)[0])).toEqual([
      'Search & read',
      'Edit files',
      'Run scripts',
      'Lint, format, types',
      'Build',
      'Test',
      '4 smaller activities Version control, Dependencies, Containers & infra, Network & web',
      'Unresolved',
    ]);
    // colours follow the fixed activity order, not the size of the part
    expect(legend().map(swatch)).toEqual([
      expect.stringContaining('bg-activity-1'),
      expect.stringContaining('bg-activity-2'),
      expect.stringContaining('bg-activity-3'),
      expect.stringContaining('bg-activity-4'),
      expect.stringContaining('bg-activity-5'),
      expect.stringContaining('bg-activity-6'),
      expect.stringContaining('bg-activity-rest'),
      expect.stringContaining('hatch-unresolved'),
    ]);
    const bar = q('[role="img"]', card());
    expect(bar.children).toHaveLength(8);
    expect(bar.getAttribute('aria-label')).toContain('Test 1m 0s, 27%');
    expect(bar.getAttribute('aria-label')).toContain(
      '4 smaller activities (Version control, Dependencies, Containers & infra, Network & web) 10s, 4%',
    );
    expect(bar.getAttribute('aria-label')).toContain('Unresolved 5.0s, 2%');
  });

  it('gives a single folded activity its own name', () => {
    const parts = activityParts(
      runToolUsage(
        mkRun(
          [
            shell('vitest run', 0, 7 * SEC),
            shell('cargo build', 0, 6 * SEC),
            shell('tsc --noEmit', 0, 5 * SEC),
            shell('pnpm dev', 0, 4 * SEC),
            shell('git status', 0, 3 * SEC),
            shell('docker ps', 0, 2 * SEC),
            shell('curl -sf localhost', 0, 1 * SEC),
          ],
          MIN,
        ),
      ),
    );
    expect(parts.map((p) => [p.kind, p.label])).toEqual([
      ['activity', 'Run scripts'],
      ['activity', 'Lint, format, types'],
      ['activity', 'Build'],
      ['activity', 'Test'],
      ['activity', 'Version control'],
      ['activity', 'Containers & infra'],
      ['rest', 'Network & web'],
    ]);
  });

  it('never folds unresolved time into another part', () => {
    // eight named activities and unresolved time larger than all of them
    const run = tenActivities();
    const parts = activityParts(runToolUsage(run));
    const unresolved = parts.find((p) => p.id === UNRESOLVED_PART);
    expect(unresolved).toMatchObject({
      kind: 'unresolved',
      activities: ['other'],
      totalMs: 5 * SEC,
    });
    for (const part of parts) {
      if (part.id === UNRESOLVED_PART) continue;
      expect(part.activities).not.toContain('other');
    }
    expect(parts.at(-1)?.id).toBe(UNRESOLVED_PART);
  });

  it('selects a part from the legend and clears it again (spec scenario)', () => {
    mount(<TimeView run={tenActivities()} />);
    expect(entry('Test').getAttribute('aria-pressed')).toBe('false');

    act(() => entry('Test').click());
    expect(entry('Test').getAttribute('aria-pressed')).toBe('true');
    expect(entry('Build').getAttribute('aria-pressed')).toBe('false');
    expect(text(card())).toContain('The tool table shows test only.');

    const clear = all('button', card()).find(
      (b) => text(b) === 'Show all activities',
    );
    act(() => clear?.click());
    expect(entry('Test').getAttribute('aria-pressed')).toBe('false');
    expect(text(card())).not.toContain('The tool table shows');

    // pressing the selected entry again clears it too
    act(() => entry('Build').click());
    act(() => entry('Build').click());
    expect(entry('Build').getAttribute('aria-pressed')).toBe('false');
  });

  it('selects from the bar with the pointer, outside the tab order', () => {
    mount(<TimeView run={tenActivities()} />);
    const part = q<HTMLButtonElement>(
      '[role="img"] button[title^="Test"]',
      card(),
    );
    expect(part.tabIndex).toBe(-1);
    act(() => part.click());
    expect(entry('Test').getAttribute('aria-pressed')).toBe('true');
  });

  it('formats a share without rounding a sliver to nothing', () => {
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(0.004)).toBe('<1%');
    expect(formatShare(0.266)).toBe('27%');
    expect(formatShare(0.998)).toBe('>99%');
    expect(formatShare(1)).toBe('100%');
  });

  it('is absent when the run has no tool time', () => {
    const run = mkRun(
      [span({ kind: 'llm_call', name: 'model', start: 0, ms: MIN })],
      MIN,
    );
    mount(<TimeView run={run} />);
    expect(
      container.querySelector('[aria-label="Tool time by activity"]'),
    ).toBe(null);
  });
});
