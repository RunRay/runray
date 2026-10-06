/**
 * @vitest-environment jsdom
 *
 * Inspector width and copy controls (visualizer spec "Inspector width and
 * copy controls"). Clicks, the clipboard, timers and localStorage are DOM
 * behaviours, so this file opts into jsdom like the export dialog's.
 */
import type { Run, Span } from '@runray/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Inspector } from './components/Inspector';
import { useAppStore } from './store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const span = (id: string, content: Span['content']): Span => ({
  id,
  parentId: null,
  kind: 'llm_call',
  name: `call ${id}`,
  status: 'ok',
  depth: 0,
  startedAt: '2026-08-10T10:00:00.000Z',
  attributes: {},
  provenance: { file: 'transcript-1', line: 1 },
  content,
});

const run = (spans: Span[]): Run => ({
  id: 'run_1',
  source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
  startedAt: '2026-08-10T10:00:00.000Z',
  spans,
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
});

const initialStore = useAppStore.getInitialState();

let container: HTMLDivElement;
let root: Root;

function mount(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

function setClipboard(writeText: ((t: string) => Promise<void>) | null): void {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: writeText === null ? undefined : { writeText },
    configurable: true,
    writable: true,
  });
}

/** The section whose title row reads `title`. */
function section(title: string): HTMLElement {
  const heading = Array.from(container.querySelectorAll('h3')).find(
    (h) => h.textContent === title,
  );
  const el = heading?.closest('section');
  if (el == null) throw new Error(`no section titled ${title}`);
  return el;
}

function button(scope: ParentNode, name: RegExp): HTMLButtonElement {
  const el = Array.from(scope.querySelectorAll('button')).find((b) =>
    name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  );
  if (el === undefined) throw new Error(`no button matching ${name}`);
  return el;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

beforeEach(() => {
  useAppStore.setState(initialStore, true);
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setClipboard(null);
  vi.useRealTimers();
});

describe('Inspector wide mode', () => {
  it('widens from 360px, keeping the centre pane 400px, and narrows back', async () => {
    mount(<Inspector run={run([])} spanId={null} insightId={null} />);
    const aside = container.querySelector('aside') as HTMLElement;
    const toggle = button(container, /^Wide inspector$/);

    expect(aside.className).toContain('w-[360px]');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.title).toBe('Widen the inspector');

    await click(toggle);
    // beside the expanded rail: 240 + 280 + 400 = 920px stays for the rest
    expect(aside.className).toContain(
      'w-[min(560px,max(360px,calc(100vw_-_920px)))]',
    );
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.title).toBe('Narrow the inspector');

    // the icon-only rail frees 184px for the inspector to take
    act(() => useAppStore.getState().toggleNav());
    expect(aside.className).toContain(
      'w-[min(560px,max(360px,calc(100vw_-_736px)))]',
    );

    await click(toggle);
    expect(aside.className).toContain('w-[360px]');
  });

  it('persists the choice the way the rail does', async () => {
    mount(<Inspector run={run([])} spanId={null} insightId={null} />);
    await click(button(container, /^Wide inspector$/));
    expect(localStorage.getItem('runray.inspectorWide')).toBe('on');
    await click(button(container, /^Wide inspector$/));
    expect(localStorage.getItem('runray.inspectorWide')).toBe('off');
  });
});

describe('Inspector copy controls', () => {
  const s1 = span('s1', {
    promptPreview: 'Refactor the parser\nand keep the goldens',
    outputPreview: 'Done.',
    delegationReason: 'Search the repo',
  });

  it('copies each preview and says so for 1.5 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const written: string[] = [];
    setClipboard(async (t) => {
      written.push(t);
    });
    mount(<Inspector run={run([s1])} spanId="s1" insightId={null} />);

    const prompt = button(section('Prompt'), /^Copy prompt$/);
    await click(prompt);
    expect(written).toEqual(['Refactor the parser\nand keep the goldens']);
    expect(prompt.textContent).toBe('Copied prompt');
    expect(
      section('Prompt').querySelector('[role="status"]')?.textContent,
    ).toBe('Copied the prompt');
    // the other controls are untouched
    expect(button(section('Output'), /^Copy output$/).textContent).toBe(
      'Copy output',
    );

    act(() => vi.advanceTimersByTime(1499));
    expect(prompt.textContent).toBe('Copied prompt');
    act(() => vi.advanceTimersByTime(1));
    expect(prompt.textContent).toBe('Copy prompt');

    await click(button(section('Output'), /^Copy output$/));
    await click(button(section('Delegation reason'), /^Copy delegation/));
    expect(written.slice(1)).toEqual(['Done.', 'Search the repo']);
  });

  it('shows only "Copy" in the title row; the noun is for assistive tech', () => {
    mount(<Inspector run={run([s1])} spanId="s1" insightId={null} />);
    const noun = button(section('Prompt'), /^Copy prompt$/).querySelector(
      '.sr-only',
    );
    expect(noun?.textContent).toBe(' prompt');
  });

  it('offers no copy control for a redacted preview', () => {
    const redacted = span('s2', { promptPreview: null, outputPreview: 'ok' });
    mount(<Inspector run={run([redacted])} spanId="s2" insightId={null} />);
    expect(section('Prompt').querySelector('button')).toBeNull();
    expect(section('Prompt').textContent).toContain('redacted');
    expect(section('Output').querySelector('button')).not.toBeNull();
  });

  it('states a denied clipboard until the next try', async () => {
    setClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    mount(<Inspector run={run([s1])} spanId="s1" insightId={null} />);

    const prompt = button(section('Prompt'), /^Copy prompt$/);
    await click(prompt);
    expect(prompt.textContent).toBe('Copy failed');
    expect(prompt.title).toContain('Select the text');
    expect(
      section('Prompt').querySelector('[role="status"]')?.textContent,
    ).toBe('Could not copy the prompt. Select the text to copy it.');

    setClipboard(async () => {});
    await click(prompt);
    expect(prompt.textContent).toBe('Copied prompt');
  });

  it('also states the failure without a Clipboard API', async () => {
    setClipboard(null);
    mount(<Inspector run={run([s1])} spanId="s1" insightId={null} />);
    const prompt = button(section('Prompt'), /^Copy prompt$/);
    await click(prompt);
    expect(prompt.textContent).toBe('Copy failed');
  });

  it('drops a confirmation when another span takes its place', async () => {
    setClipboard(async () => {});
    const s2 = span('s2', { promptPreview: 'Another prompt' });
    const both = run([s1, s2]);
    mount(<Inspector run={both} spanId="s1" insightId={null} />);
    await click(button(section('Prompt'), /^Copy prompt$/));
    expect(button(section('Prompt'), /prompt$/).textContent).toBe(
      'Copied prompt',
    );

    mount(<Inspector run={both} spanId="s2" insightId={null} />);
    expect(button(section('Prompt'), /prompt$/).textContent).toBe(
      'Copy prompt',
    );
  });

  it('copies the raw record shown under Show raw', async () => {
    const written: string[] = [];
    setClipboard(async (t) => {
      written.push(t);
    });
    mount(<Inspector run={run([s1])} spanId="s1" insightId={null} />);

    // hidden with the record
    expect(() => button(container, /^Copy JSON$/)).toThrow();
    await click(button(container, /^Show raw$/));

    const copyJson = button(container, /^Copy JSON$/);
    await click(copyJson);
    expect(written).toEqual([JSON.stringify(s1, null, 2)]);
    expect(copyJson.textContent).toBe('Copied JSON');
    // the clipboard gets exactly the record on screen
    expect(container.querySelector('pre.max-h-80')?.textContent).toBe(
      written[0],
    );
  });
});
