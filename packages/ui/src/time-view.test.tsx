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

const q = <T extends Element = HTMLElement>(selector: string): T => {
  const found = container.querySelector<T>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};
const all = (selector: string): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(selector),
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
