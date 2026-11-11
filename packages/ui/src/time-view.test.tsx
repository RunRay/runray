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
import { familyCounts, tableRows, UTILITIES_ROW } from './lib/tool-table';
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
/** What a screen reader would read: decorative glyphs are left out. */
const text = (el: Element): string => {
  const copy = el.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden]')) hidden.remove();
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
};
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

/** Calls one after another, a second apart, so nothing overlaps. */
function sequence(build: (at: (ms: number) => number) => Span[]): Span[] {
  let t = 0;
  return build((ms) => {
    const start = t;
    t += ms + SEC;
    return start;
  });
}

function mcp(server: string, tool: string, start: number, ms: number): Span {
  const name = `mcp__${server}__${tool}`;
  return span({
    kind: 'mcp_call',
    name,
    start,
    ms,
    tool: { name, mcpServer: server, isError: false },
  });
}

describe('tool table (visualizer "Tool usage table")', () => {
  const table = () => q('[aria-label="Tools"]');
  /** Ranked rows only: the first tbody, without revealed sub-rows. */
  const body = () => q('tbody', table());
  const rowOf = (label: string, scope: Element = table()): HTMLElement => {
    const found = all('tbody tr', scope).find((tr) =>
      text(tr.children[0] as Element).startsWith(label),
    );
    if (found === undefined) throw new Error(`no row ${label}`);
    return found;
  };
  const labels = (scope: Element = body()) =>
    all('tr > th[scope="row"]', scope).map((th) => text(th));
  const expander = (label: string) =>
    q<HTMLButtonElement>('button[aria-expanded]', rowOf(label));
  const filter = (label: string): HTMLElement => {
    const found = all('[aria-label="Filter tools by family"] button').find(
      (b) => text(b).startsWith(label),
    );
    if (found === undefined) throw new Error(`no filter ${label}`);
    return found;
  };
  const figures = (label: string) => cells(rowOf(label)).slice(1);

  it('lists tools by identity instead of one row for the shell (spec scenario)', () => {
    const run = mkRun(
      sequence((at) => [
        shell('docker ps', at(2 * SEC), 2 * SEC),
        shell('docker build .', at(40 * SEC), 40 * SEC),
        shell('vitest run', at(30 * SEC), 30 * SEC),
        shell('vitest run', at(50 * SEC), 50 * SEC),
        shell('vitest run', at(10 * SEC), 10 * SEC),
      ]),
      5 * MIN,
    );
    mount(<TimeView run={run} />);
    expect(labels()).toEqual(['vitestshell', 'dockershell']);
    expect(text(table())).not.toContain('Bash');
    // calls, total, share, p50, p95, max, errors
    expect(figures('vitest')).toEqual([
      '3',
      '1m 30s',
      '68%',
      '30s',
      '50s',
      '50s',
      '0',
    ]);
    expect(figures('docker')).toEqual([
      '2',
      '42s',
      '32%',
      '2.0s',
      '40s',
      '40s',
      '0',
    ]);
  });

  it('shows the programs behind the shell and expands to subcommands (spec scenario)', () => {
    const run = mkRun(
      sequence((at) => [
        shell('docker exec db psql', at(4 * SEC), 4 * SEC),
        shell('docker exec db psql -c "select 1"', at(3 * SEC), 3 * SEC),
        shell('docker exec -it web sh', at(2 * SEC), 2 * SEC),
        shell('docker exec api env', at(SEC), SEC),
        shell('docker ps', at(500), 500),
      ]),
      MIN,
    );
    mount(<TimeView run={run} />);
    expect(labels()).toEqual(['dockershell']);
    expect(figures('docker')[0]).toBe('5');
    expect(expander('docker').getAttribute('aria-expanded')).toBe('false');
    expect(all('tbody tr', table())).toHaveLength(1);

    act(() => expander('docker').click());
    expect(expander('docker').getAttribute('aria-expanded')).toBe('true');
    const subs = all('tbody tr', table()).slice(1);
    expect(subs.map((tr) => cells(tr).slice(0, 3))).toEqual([
      ['exec', '4', '10s'],
      ['ps', '1', '500ms'],
    ]);
  });

  it('rolls MCP tools up to their server (spec scenario)', () => {
    const run = mkRun(
      sequence((at) => [
        ...Array.from({ length: 6 }, () =>
          mcp('playwright', 'browser_click', at(SEC), SEC),
        ),
        ...Array.from({ length: 4 }, () =>
          mcp('playwright', 'browser_type', at(SEC), SEC),
        ),
        ...Array.from({ length: 2 }, () =>
          mcp('playwright', 'browser_close', at(SEC), SEC),
        ),
      ]),
      MIN,
    );
    mount(<TimeView run={run} />);
    expect(labels()).toEqual(['playwrightmcp']);
    expect(figures('playwright')[0]).toBe('12');
    act(() => expander('playwright').click());
    expect(
      all('tbody tr', table())
        .slice(1)
        .map((tr) => cells(tr).slice(0, 2)),
    ).toEqual([
      ['browser_click', '6'],
      ['browser_type', '4'],
      ['browser_close', '2'],
    ]);
  });

  it('filters by family and exposes the filter as pressed (spec scenario)', () => {
    const run = mkRun(
      sequence((at) => [
        shell('docker ps', at(3 * SEC), 3 * SEC),
        span({ name: 'Read', start: at(2 * SEC), ms: 2 * SEC }),
        mcp('playwright', 'browser_click', at(SEC), SEC),
      ]),
      MIN,
    );
    mount(<TimeView run={run} />);
    expect(filter('all').getAttribute('aria-pressed')).toBe('true');
    expect(text(filter('all'))).toBe('all 3');
    expect(labels()).toHaveLength(3);

    act(() => filter('mcp').click());
    expect(filter('mcp').getAttribute('aria-pressed')).toBe('true');
    expect(filter('all').getAttribute('aria-pressed')).toBe('false');
    expect(labels()).toEqual(['playwrightmcp']);

    act(() => filter('built-in').click());
    expect(labels()).toEqual(['Readbuilt-in']);
    act(() => filter('all').click());
    expect(labels()).toHaveLength(3);
  });

  it('has a native, focusable expand control that reports its state (spec scenario)', () => {
    const run = mkRun(
      [shell('git status', 0, SEC), shell('git diff', 2 * SEC, SEC)],
      MIN,
    );
    mount(<TimeView run={run} />);
    const control = expander('git');
    // a native button: Enter and Space activate it without any key handler
    expect(control.tagName).toBe('BUTTON');
    expect(control.type).toBe('button');
    expect(control.tabIndex).toBe(0);
    control.focus();
    expect(document.activeElement).toBe(control);
    act(() => control.click());
    expect(expander('git').getAttribute('aria-expanded')).toBe('true');
    expect(labels(table())).toContain('status');
    act(() => expander('git').click());
    expect(expander('git').getAttribute('aria-expanded')).toBe('false');
    expect(labels(table())).not.toContain('status');
  });

  it('re-sorts by p95 and by calls and says which column sorts', () => {
    const run = mkRun(
      sequence((at) => [
        // many short calls
        ...Array.from({ length: 6 }, () =>
          span({ name: 'Read', start: at(SEC), ms: SEC }),
        ),
        // one long call
        shell('cargo build', at(5 * SEC), 5 * SEC),
        // most time in total
        shell('vitest run', at(4 * SEC), 4 * SEC),
        shell('vitest run', at(4 * SEC), 4 * SEC),
      ]),
      5 * MIN,
    );
    mount(<TimeView run={run} />);
    const header = (label: string): HTMLElement => {
      const found = all('thead th', table()).find((th) =>
        text(th).startsWith(label),
      );
      if (found === undefined) throw new Error(`no header ${label}`);
      return found;
    };
    const order = () => labels().map((l) => l.replace(/(shell|built-in)$/, ''));
    expect(order()).toEqual(['vitest', 'Read', 'cargo']);
    expect(header('total').getAttribute('aria-sort')).toBe('descending');
    expect(header('p95').getAttribute('aria-sort')).toBe('none');
    expect(text(table())).toContain('tools · by total time');

    act(() => q('button', header('p95')).click());
    expect(order()).toEqual(['cargo', 'vitest', 'Read']);
    expect(header('p95').getAttribute('aria-sort')).toBe('descending');
    expect(header('total').getAttribute('aria-sort')).toBe('none');
    expect(text(table())).toContain('tools · by p95');

    act(() => q('button', header('calls')).click());
    expect(order()).toEqual(['Read', 'vitest', 'cargo']);
  });

  it('narrows to the activity selected in the bar and back (spec scenario)', () => {
    mount(<TimeView run={tenActivities()} />);
    expect(labels().length).toBeGreaterThan(8);
    const entry = all('[data-testid="activity-legend"] button').find((b) =>
      text(b).startsWith('Test'),
    );
    act(() => entry?.click());
    expect(labels()).toEqual(['vitestshell']);
    expect(text(table())).toContain('tools · by total time · Test only');
    // the share keeps the run-wide denominator: 60s of 3m 45s
    expect(figures('vitest')[2]).toBe('27%');

    const clear = all('button').find((b) => text(b) === 'Show all activities');
    act(() => clear?.click());
    expect(labels().length).toBeGreaterThan(8);
  });

  it('narrows to every folded activity when the neutral part is selected', () => {
    mount(<TimeView run={tenActivities()} />);
    const entry = all('[data-testid="activity-legend"] button').find((b) =>
      text(b).startsWith('4 smaller activities'),
    );
    act(() => entry?.click());
    expect(labels().map((l) => l.replace(/shell$/, ''))).toEqual([
      'git',
      'pnpm',
      'docker',
      'curl',
    ]);
  });
});

describe('tool table markers (visualizer "Shared, background and partial figures are marked")', () => {
  const table = () => q('[aria-label="Tools"]');
  const rowOf = (label: string): HTMLElement => {
    const found = all('tbody tr', table()).find((tr) =>
      text(tr.children[0] as Element).startsWith(label),
    );
    if (found === undefined) throw new Error(`no row ${label}`);
    return found;
  };

  it('shows shared time beside the total, never inside it (spec scenario)', () => {
    const run = mkRun(
      sequence((at) => [
        shell('git commit -m wip', at(85 * SEC), 85 * SEC),
        shell('git add -A && pnpm build', at(50 * SEC), 50 * SEC),
      ]),
      5 * MIN,
    );
    mount(<TimeView run={run} />);
    const git = cells(rowOf('git'));
    expect(git[1]).toBe('1');
    expect(git[2]).toBe('1m 25s+50s shared');
    const also = q('span[title*="led by another tool"]', rowOf('git'));
    expect(text(also)).toBe('+50s shared');
    expect(also.getAttribute('title')).toContain('Ran in 1 command');

    // the tool that led the command says how much of its own total was shared
    const pnpm = cells(rowOf('pnpm'));
    expect(pnpm[2]).toBe('50sincl. 50s shared');
    // and the totals still add up to the two calls
    expect(text(q('[aria-label="Tool time by activity"]'))).toContain(
      'summed tool time · 2m 15s',
    );
  });

  it('marks a call sent to the background and says what the time means (spec scenario)', () => {
    const up = shell('docker compose up -d', 0, 72 * SEC);
    up.attributes['runray.toolFlags'] = ['background'];
    const run = mkRun([up, shell('docker ps', 2 * MIN, SEC)], 5 * MIN);
    mount(<TimeView run={run} />);
    const marker = q('span[title^="Sent to the background"]', rowOf('docker'));
    expect(text(marker)).toBe('bg');
    expect(marker.getAttribute('title')).toBe(
      'Sent to the background: the time shown is the launch, not the run.',
    );
    act(() =>
      q<HTMLButtonElement>('button[aria-expanded]', rowOf('docker')).click(),
    );
    // the marker sits on the subcommand that was sent there, not on its sibling
    expect(rowOf('compose up').querySelector('[title^="Sent to"]')).not.toBe(
      null,
    );
    expect(rowOf('ps').querySelector('[title^="Sent to"]')).toBe(null);
  });

  it('shows a figure the source cannot provide as unavailable, never as zero', () => {
    const run = mkRun([shell('pnpm dev', 0, null)], MIN);
    mount(<TimeView run={run} />);
    // calls, total, share, p50, p95, max, errors
    expect(cells(rowOf('pnpm')).slice(1)).toEqual([
      '1',
      '—',
      '0%',
      '—',
      '—',
      '—',
      '0',
    ]);
    // an old session's call without a result is not "running": say what is known
    expect(text(rowOf('pnpm'))).toContain('no result');
    expect(
      q('span[title^="No result was recorded"]', rowOf('pnpm')).title,
    ).toContain('no time added');
  });

  it('marks timeouts and interruptions on the row', () => {
    const slow = shell('cargo build', 0, 2 * MIN);
    slow.attributes['runray.toolFlags'] = ['timeout', 'interrupted'];
    slow.status = 'error';
    mount(<TimeView run={mkRun([slow], 5 * MIN)} />);
    expect(text(rowOf('cargo'))).toContain('timed out');
    expect(text(rowOf('cargo'))).toContain('interrupted');
    expect(cells(rowOf('cargo')).at(-1)).toBe('1');
  });
});

describe('utilities, delegations and hooks in the tool table', () => {
  const table = () => q('[aria-label="Tools"]');
  const rowOf = (label: string, scope: Element = table()): HTMLElement => {
    const found = all('tbody tr', scope).find((tr) =>
      text(tr.children[0] as Element).startsWith(label),
    );
    if (found === undefined) throw new Error(`no row ${label}`);
    return found;
  };

  it('folds shell utilities into one group row (spec scenario)', () => {
    const calls = sequence((at) => [
      ...Array.from({ length: 17 }, () =>
        shell('grep -rn x src', at(SEC), SEC),
      ),
      ...Array.from({ length: 9 }, () =>
        shell('sed -n 1,5p a.txt', at(SEC), SEC),
      ),
      ...Array.from({ length: 7 }, () => shell('cat a.txt', at(SEC), SEC)),
      ...Array.from({ length: 5 }, () => shell('ls -la', at(SEC), SEC)),
      shell('vitest run', at(20 * SEC), 20 * SEC),
    ]);
    mount(<TimeView run={mkRun(calls, 5 * MIN)} />);
    const rows = all('tbody tr', table());
    expect(rows).toHaveLength(2);
    const group = cells(rowOf('shell utilities'));
    expect(group[0]).toBe('shell utilitiesshell4 tools');
    // thirty-eight calls and their combined time
    expect(group[1]).toBe('38');
    expect(group[2]).toBe('38s');
    // percentiles across different tools are not a figure anyone computed
    expect(group[4]).toBe('—');
    expect(group[5]).toBe('—');
    expect(group[6]).toBe('1.0s');

    act(() =>
      q<HTMLButtonElement>(
        'button[aria-expanded]',
        rowOf('shell utilities'),
      ).click(),
    );
    // the group leads on total time, its four tools follow, then vitest
    expect(
      all('tbody tr', table())
        .slice(1, 5)
        .map((tr) => cells(tr).slice(0, 3)),
    ).toEqual([
      ['grep', '17', '17s'],
      ['sed', '9', '9.0s'],
      ['cat', '7', '7.0s'],
      ['ls', '5', '5.0s'],
    ]);
  });

  it('keeps a single utility as a row of its own', () => {
    mount(<TimeView run={mkRun([shell('grep -rn x src', 0, SEC)], MIN)} />);
    expect(text(table())).not.toContain('shell utilities');
    expect(cells(rowOf('grep'))[0]).toBe('grepshell');
  });

  it('lists a delegation apart, with its own tool calls among the ranked rows (spec scenario)', () => {
    const agent = span({ name: 'Agent', start: 0, ms: 3 * MIN });
    const subagent = span({
      kind: 'subagent',
      name: 'subagent:Explore',
      parentId: agent.id,
      agent: { name: 'Explore' },
      start: 0,
      ms: 3 * MIN,
    });
    const run = mkRun(
      [
        agent,
        subagent,
        span({ name: 'Grep', parentId: subagent.id, start: SEC, ms: MIN }),
        span({ name: 'Read', parentId: subagent.id, start: 90 * SEC, ms: MIN }),
        span({ name: 'AskUserQuestion', start: 4 * MIN, ms: 10 * MIN }),
        span({
          kind: 'hook',
          name: 'PostToolUse:Edit',
          start: 15 * MIN,
          ms: 350,
        }),
      ],
      16 * MIN,
    );
    mount(<TimeView run={run} />);
    const apart = q('[data-testid="tools-apart"]', table());
    expect(text(apart)).toContain('Not part of summed tool time');
    expect(cells(rowOf('Explore', apart)).slice(0, 3)).toEqual([
      'Exploreagent',
      '1',
      '3m 0s',
    ]);
    expect(cells(rowOf('AskUserQuestion', apart)).slice(0, 3)).toEqual([
      'AskUserQuestionwaits on you',
      '1',
      '10m 0s',
    ]);
    expect(cells(rowOf('PostToolUse:Edit', apart)).slice(0, 3)).toEqual([
      'PostToolUse:Edithook',
      '1',
      '350ms',
    ]);
    // the agent's own calls are ranked, and they are all the sum holds
    const ranked = q('tbody', table());
    expect(all('tr', ranked)).toHaveLength(2);
    expect(text(ranked)).toContain('Grep');
    expect(text(ranked)).toContain('Read');
    expect(text(ranked)).not.toContain('Explore');
    expect(text(q('[aria-label="Tool time by activity"]'))).toContain(
      'summed tool time · 2m 0s',
    );
  });

  it('hides the group under a family filter, where it would not belong', () => {
    const agent = span({ name: 'Agent', start: 0, ms: MIN });
    const subagent = span({
      kind: 'subagent',
      name: 'subagent:Explore',
      parentId: agent.id,
      start: 0,
      ms: MIN,
    });
    const run = mkRun(
      [
        agent,
        subagent,
        span({ name: 'Read', parentId: subagent.id, start: SEC, ms: SEC }),
        shell('docker ps', 2 * MIN, SEC),
      ],
      5 * MIN,
    );
    mount(<TimeView run={run} />);
    expect(table().querySelector('[data-testid="tools-apart"]')).not.toBe(null);
    const shellFilter = all(
      '[aria-label="Filter tools by family"] button',
    ).find((b) => text(b).startsWith('shell'));
    act(() => shellFilter?.click());
    expect(table().querySelector('[data-testid="tools-apart"]')).toBe(null);
  });

  it('pages a long list of sub-rows', () => {
    const calls = sequence((at) =>
      Array.from({ length: 12 }, (_, i) =>
        shell(
          `node scripts/step-${String(i).padStart(2, '0')}.mjs`,
          at(SEC),
          SEC,
        ),
      ),
    );
    mount(<TimeView run={mkRun(calls, 5 * MIN)} />);
    act(() =>
      q<HTMLButtonElement>('button[aria-expanded]', rowOf('node')).click(),
    );
    // the row, eight sub-rows, one "show more" line
    expect(all('tbody tr', table())).toHaveLength(10);
    const more = all('button', table()).find((b) =>
      text(b).startsWith('Show 4 more'),
    );
    act(() => more?.click());
    expect(all('tbody tr', table())).toHaveLength(13);
  });
});

describe('hook rows (visualizer "Hook durations are partial")', () => {
  const table = () => q('[aria-label="Tools"]');
  const apart = () => q('[data-testid="tools-apart"]', table());
  const rowOf = (label: string): HTMLElement => {
    const found = all('tr', apart()).find((tr) =>
      text(tr.children[0] as Element).startsWith(label),
    );
    if (found === undefined) throw new Error(`no row ${label}`);
    return found;
  };
  /** A failed hook, stamped the way the adapter stamps its command. */
  const hook = (name: string, command: string, start: number, ms: number) =>
    span({
      kind: 'hook',
      name,
      start,
      ms,
      status: 'error',
      statusReason: 'exit 1',
      attributes: toolUsageAttributes(command, 'posix', false),
    });
  /** A turn's Stop hooks, reported together: a count and no duration. */
  const stop = (start: number, hookCount: number) =>
    span({
      kind: 'hook',
      name: 'Stop',
      start,
      ms: 0,
      attributes: { 'runray.hookCount': hookCount },
    });
  const session = (source = 'claude-code') =>
    mkRun(
      [
        span({ name: 'Edit', start: 0, ms: 2 * SEC }),
        hook('PostToolUse:Edit', 'npx prettier --write src/a.ts', SEC, 400),
        hook('PostToolUse:Edit', 'npx prettier --write src/b.ts', 3 * SEC, 600),
        hook(
          'PostToolUse:Edit',
          'node /Users/alex/hooks/lint.mjs',
          5 * SEC,
          300,
        ),
        stop(10 * SEC, 3),
        stop(20 * SEC, 3),
      ],
      MIN,
      source,
    );

  it('labels hook time as failed and cancelled runs only (spec scenario)', () => {
    mount(<TimeView run={session()} />);
    const note = text(q('[data-testid="tools-apart-hooks"]', apart()));
    expect(note).toContain('Failed and cancelled runs only');
    expect(note).toContain('a hook that succeeds leaves no record');
    // the label stands above the rows it is about
    const lines = all('tr', apart()).map((tr) => text(tr));
    expect(lines[0]).toBe('Not part of summed tool time');
    expect(lines[1]).toBe(note);
    expect(lines[2]).toMatch(/^PostToolUse:Edit/);
  });

  it('does not claim that limit for a source that records every hook run', () => {
    mount(<TimeView run={session('otlp')} />);
    const note = text(q('[data-testid="tools-apart-hooks"]', apart()));
    expect(note).toBe('A hook runs inside the call that triggered it.');
    expect(text(apart())).not.toContain('Failed and cancelled');
  });

  it('shows a turn summary as a count without a time, never as zero', () => {
    mount(<TimeView run={session()} />);
    expect(cells(rowOf('Stop'))).toEqual([
      'Stophook6 hook runs, time not recorded',
      '2',
      '—',
      '',
      '—',
      '—',
      '—',
      '0',
    ]);
    // the timed row beside it keeps its figures
    expect(cells(rowOf('PostToolUse:Edit')).slice(0, 3)).toEqual([
      'PostToolUse:Edithook',
      '3',
      '1.3s',
    ]);
    expect(cells(rowOf('PostToolUse:Edit'))[7]).toBe('3');
  });

  it('expands a hook to the tools its commands ran', () => {
    mount(<TimeView run={session()} />);
    const row = rowOf('PostToolUse:Edit');
    const toggle = q<HTMLButtonElement>('button[aria-expanded]', row);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    const lines = all('tr', apart()).map((tr) => cells(tr).slice(0, 3));
    const at = lines.findIndex((c) => c[0]?.startsWith('PostToolUse:Edit'));
    expect(lines.slice(at + 1, at + 3)).toEqual([
      ['prettier', '2', '1.0s'],
      ['node lint.mjs', '1', '300ms'],
    ]);
    // the directory of the hook script is not in the page
    expect(text(table())).not.toContain('alex');
    // a summary has no command to split by: its row does not expand
    expect(rowOf('Stop').querySelector('button[aria-expanded]')).toBe(null);
  });

  it('keeps failed Stop hooks and turn summaries apart inside one row', () => {
    const run = mkRun(
      [
        hook('Stop', 'node /h/stop.mjs', SEC, 800),
        stop(10 * SEC, 3),
        stop(20 * SEC, 2),
      ],
      MIN,
    );
    mount(<TimeView run={run} />);
    expect(cells(rowOf('Stop')).slice(0, 3)).toEqual([
      'Stophookincl. 2 turn summaries of 5 hook runs, time not recorded',
      '3',
      '800ms',
    ]);
    act(() =>
      q<HTMLButtonElement>('button[aria-expanded]', rowOf('Stop')).click(),
    );
    const lines = all('tr', apart()).map((tr) => cells(tr).slice(0, 3));
    expect(lines.slice(-2)).toEqual([
      ['node stop.mjs', '1', '800ms'],
      ['turn summaries5 hook runs, time not recorded', '2', '—'],
    ]);
  });

  it('says what each kind of row is, right above it', () => {
    const agent = span({ name: 'Agent', start: 0, ms: MIN });
    const subagent = span({
      kind: 'subagent',
      name: 'subagent:Explore',
      parentId: agent.id,
      agent: { name: 'Explore' },
      start: 0,
      ms: MIN,
    });
    const run = mkRun(
      [
        agent,
        subagent,
        span({ name: 'AskUserQuestion', start: 2 * MIN, ms: MIN }),
        stop(4 * MIN, 1),
      ],
      5 * MIN,
    );
    mount(<TimeView run={run} />);
    expect(
      all('tr', apart()).map((tr) => text(tr.children[0] as Element)),
    ).toEqual([
      'Not part of summed tool time',
      "A delegation contains its agent's own calls, which are counted above.",
      'Exploreagent',
      "Failed and cancelled runs only: a hook that succeeds leaves no record in the transcript. A tool hook's time is already counted in the call that triggered it.",
      'Stophook1 hook run, time not recorded',
      'A question or a plan that waited for your answer.',
      'AskUserQuestionwaits on you',
    ]);
  });
});

describe('degraded states (visualizer "Tool usage degraded states")', () => {
  const table = () => q('[aria-label="Tools"]');
  const names = () =>
    all('tbody tr > th[scope="row"]', table()).map((th) => text(th));
  const notice = () =>
    container.querySelector('[data-testid="tools-unclassified"]');

  it('lists a trace recorded before tool identification under Bash and says so once (spec scenario)', () => {
    const run = mkRun(
      sequence((at) => [
        span({ name: 'Bash', start: at(3 * SEC), ms: 3 * SEC }),
        span({ name: 'Bash', start: at(2 * SEC), ms: 2 * SEC }),
        span({ name: 'Read', start: at(SEC), ms: SEC }),
      ]),
      MIN,
    );
    mount(<TimeView run={run} />);
    expect(names()).toEqual(['Bashshell', 'Readbuilt-in']);
    expect(all('[data-testid="tools-unclassified"]')).toHaveLength(1);
    expect(text(notice() as Element)).toContain(
      'recorded before tool identification',
    );
    expect(text(notice() as Element)).toContain('Export the session again');
  });

  it('words the notice by source for an import that carries no command (spec scenario)', () => {
    // the shape the OTLP adapter emits: a generic span name, the tool in tool.name
    const run = mkRun(
      [
        span({
          name: 'claude_code.tool',
          tool: { name: 'Bash', isError: false },
          start: 0,
          ms: 2 * SEC,
        }),
      ],
      MIN,
      'otlp',
    );
    mount(<TimeView run={run} />);
    expect(names()).toEqual(['Bashshell']);
    expect(text(notice() as Element)).toContain(
      'records the name of the shell tool and no command',
    );
    expect(text(notice() as Element)).not.toContain('recorded before');
    expect(text(notice() as Element)).not.toContain('Export the session again');
  });

  it('says nothing when every shell call is classified', () => {
    mount(<TimeView run={mkRun([shell('docker ps', 0, SEC)], MIN)} />);
    expect(notice()).toBe(null);
  });

  it('shows one nameless row for other programs in a redacted report (spec scenario)', () => {
    const run = mkRun(
      sequence((at) => [
        shell('docker ps', at(2 * SEC), 2 * SEC, true),
        shell('acme-deploy --prod', at(9 * SEC), 9 * SEC, true),
        shell('frobctl sync', at(4 * SEC), 4 * SEC, true),
      ]),
      MIN,
    );
    mount(<TimeView run={run} />);
    const rows = all('tbody tr', table());
    expect(rows).toHaveLength(2);
    expect(cells(rows[0] as Element).slice(1, 3)).toEqual(['2', '13s']);
    expect(text(rows[0] as Element)).toContain('other command');
    expect(text(rows[1] as Element)).toContain('docker');
    // nothing to expand, and no name anywhere on the page
    expect(rows[0]?.querySelector('button[aria-expanded]')).toBe(null);
    expect(text(container)).not.toMatch(/acme|frobctl/);
    expect(rows[0]?.getAttribute('title')).toContain(
      'Their names are not in this report',
    );
  });

  it('names those programs in a local, unredacted view', () => {
    const run = mkRun(
      sequence((at) => [
        shell('acme-deploy --prod', at(9 * SEC), 9 * SEC),
        shell('frobctl sync', at(4 * SEC), 4 * SEC),
      ]),
      MIN,
    );
    mount(<TimeView run={run} />);
    act(() => q<HTMLButtonElement>('button[aria-expanded]', table()).click());
    const [row, ...programs] = names();
    expect(row).toContain('other command');
    // the row says what it holds to a screen reader too
    expect(row).toContain('Programs outside the tool list, by name.');
    expect(programs).toEqual(['acme-deploy', 'frobctl']);
  });

  it('explains an empty run instead of drawing empty charts', () => {
    const run = mkRun(
      [span({ kind: 'llm_call', name: 'model', start: 0, ms: MIN })],
      MIN,
    );
    mount(<TimeView run={run} />);
    expect(text(q('[data-testid="tools-empty"]'))).toBe(
      'This session made no tool calls, so there is no tool time to break down.',
    );
    expect(container.querySelector('[aria-label="Tools"]')).toBe(null);
  });

  it('still lists delegations when they are all the run has', () => {
    const agent = span({ name: 'Agent', start: 0, ms: MIN });
    const subagent = span({
      kind: 'subagent',
      name: 'subagent:Explore',
      parentId: agent.id,
      start: 0,
      ms: MIN,
    });
    mount(<TimeView run={mkRun([agent, subagent], 2 * MIN)} />);
    expect(text(q('[data-testid="tools-apart"]'))).toContain('Explore');
    expect(container.querySelector('[data-testid="tools-empty"]')).toBe(null);
  });
});

describe('limits (visualizer "Limits of tool time are stated")', () => {
  it('explains permission wait and shared time inside the breakdown (spec scenario)', () => {
    mount(<TimeView run={mkRun([shell('docker ps', 0, SEC)], MIN)} />);
    const note = q('[data-testid="tools-limits"]', q('[aria-label="Tools"]'));
    expect(text(note)).toContain('includes any wait for your permission');
    expect(text(note)).toContain('does not record that wait on its own');
    expect(text(note)).toContain('has one duration');
    expect(text(note)).toContain('shown as shared on the others');
  });
});

describe('tableRows', () => {
  const rows = () =>
    runToolUsage(
      mkRun(
        sequence((at) => [
          shell('grep x', at(3 * SEC), 3 * SEC),
          shell('ls', at(SEC), SEC),
          shell('docker ps', at(2 * SEC), 2 * SEC),
          span({ name: 'Read', start: at(SEC), ms: SEC }),
        ]),
        MIN,
      ),
    );

  it('folds utilities, keeps the rest, and sorts by the chosen figure', () => {
    const usage = rows();
    const shown = tableRows(usage.rows, usage.summedMs, {
      family: 'all',
      sort: 'total',
    });
    expect(shown.map((r) => [r.id, r.stats.totalMs])).toEqual([
      [UTILITIES_ROW, 4 * SEC],
      ['shell/registry/docker', 2 * SEC],
      ['harness/name/Read', SEC],
    ]);
    const group = shown[0];
    expect(group).toMatchObject({ group: 'utilities', percentiles: false });
    expect(group?.children.map((c) => c.label)).toEqual(['grep', 'ls']);
    expect(group?.share).toBeCloseTo(4 / 7);
  });

  it('counts tools per family in a fixed order', () => {
    expect(familyCounts(rows().rows)).toEqual([
      { family: 'shell', count: 3 },
      { family: 'harness', count: 1 },
    ]);
  });

  it('does not fold when the family filter leaves one utility', () => {
    const usage = runToolUsage(
      mkRun([shell('grep x', 0, SEC), shell('docker ps', 2 * SEC, SEC)], MIN),
    );
    const shown = tableRows(usage.rows, usage.summedMs, {
      family: 'shell',
      sort: 'calls',
    });
    expect(shown.map((r) => r.label)).toEqual(['docker', 'grep']);
  });
});
