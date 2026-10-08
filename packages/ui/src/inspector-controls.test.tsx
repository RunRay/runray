/**
 * @vitest-environment jsdom
 *
 * Inspector width and copy controls (visualizer spec "Inspector width and
 * copy controls"). Clicks, the clipboard, timers, ResizeObserver and
 * localStorage are DOM behaviours, so this file opts into jsdom like the
 * export dialog's.
 */
import type { Run, Span } from '@runray/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './components/CommandPalette';
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

/** A button by its accessible name (aria-label, else its whole text). */
function button(scope: ParentNode, name: RegExp): HTMLButtonElement {
  const el = Array.from(scope.querySelectorAll('button')).find((b) =>
    name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  );
  if (el === undefined) throw new Error(`no button matching ${name}`);
  return el;
}

/** What a sighted person reads: the text without the sr-only parts. */
function visible(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('.sr-only')) hidden.remove();
  return copy.textContent ?? '';
}

function status(scope: HTMLElement): string | null | undefined {
  return scope.querySelector('[role="status"]')?.textContent;
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
  vi.unstubAllGlobals();
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
    // 100% is the row beside the rail; 280px sessions + 400px centre stay
    expect(aside.className).toContain(
      'w-[min(560px,max(360px,calc(100%_-_680px)))]',
    );
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.title).toBe('Narrow the inspector');

    await click(toggle);
    expect(aside.className).toContain('w-[360px]');
  });

  it('says there is no room instead of seeming to do nothing', async () => {
    let report: ((entries: unknown[]) => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: (entries: unknown[]) => void) {
          report = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const resizeRow = (width: number) =>
      act(() => report?.([{ contentRect: { width } }]));
    mount(<Inspector run={run([])} spanId={null} insightId={null} />);
    const toggle = button(container, /^Wide inspector$/);

    // a 1280px window with the rail expanded leaves a 1040px row
    resizeRow(1040);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(toggle.title).toContain('No room to widen');
    await click(toggle);
    expect(useAppStore.getState().ui.inspectorWide).toBe(false);

    resizeRow(1200);
    expect(toggle.getAttribute('aria-disabled')).toBeNull();
    await click(toggle);
    expect(useAppStore.getState().ui.inspectorWide).toBe(true);

    // shrinking the window never traps wide mode on
    resizeRow(1000);
    expect(toggle.getAttribute('aria-disabled')).toBeNull();
    await click(toggle);
    expect(useAppStore.getState().ui.inspectorWide).toBe(false);
  });

  it('persists the choice the way the rail does', async () => {
    mount(<Inspector run={run([])} spanId={null} insightId={null} />);
    await click(button(container, /^Wide inspector$/));
    expect(localStorage.getItem('runray.inspectorWide')).toBe('on');
    await click(button(container, /^Wide inspector$/));
    expect(localStorage.getItem('runray.inspectorWide')).toBe('off');
  });

  it('opens wide after a reload when the choice was wide', async () => {
    localStorage.setItem('runray.inspectorWide', 'on');
    vi.resetModules();
    const fresh = await import('./store');
    expect(fresh.useAppStore.getState().ui.inspectorWide).toBe(true);
  });

  it('is in the palette, named for what it will do, and opens a closed inspector', async () => {
    // jsdom has no scrollIntoView; the palette keeps its highlight in view
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => {};
    try {
      act(() => useAppStore.getState().toggleInspector());
      expect(useAppStore.getState().ui.inspectorOpen).toBe(false);

      mount(<CommandPalette onClose={() => {}} />);
      expect(() => button(container, /^Narrow the inspector$/)).toThrow();
      await click(button(container, /^Widen the inspector$/));
      expect(useAppStore.getState().ui.inspectorWide).toBe(true);
      expect(useAppStore.getState().ui.inspectorOpen).toBe(true);

      // persisted wide: the same command now offers the way back
      expect(() => button(container, /^Widen the inspector$/)).toThrow();
      await click(button(container, /^Narrow the inspector$/));
      expect(useAppStore.getState().ui.inspectorWide).toBe(false);
    } finally {
      Element.prototype.scrollIntoView = scroll;
    }
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

    const prompt = button(section('Prompt'), /^Copy preview of the prompt$/);
    await click(prompt);
    expect(written).toEqual(['Refactor the parser\nand keep the goldens']);
    expect(visible(prompt)).toBe('Copied');
    expect(prompt.textContent).toBe('Copied the prompt preview');
    expect(status(section('Prompt'))).toBe('Copied the prompt preview');
    // the other controls are untouched
    expect(
      visible(button(section('Output'), /^Copy preview of the output$/)),
    ).toBe('Copy preview');

    act(() => vi.advanceTimersByTime(1499));
    expect(visible(prompt)).toBe('Copied');
    act(() => vi.advanceTimersByTime(1));
    expect(visible(prompt)).toBe('Copy preview');
    expect(status(section('Prompt'))).toBe('');

    await click(button(section('Output'), /^Copy preview of the output$/));
    await click(
      button(section('Delegation reason'), /^Copy the delegation reason$/),
    );
    expect(written.slice(1)).toEqual(['Done.', 'Search the repo']);
  });

  it('calls a cut preview a preview, and a whole text plain Copy', () => {
    mount(<Inspector run={run([s1])} spanId="s1" insightId={null} />);
    // core stops prompt and output at 200 characters
    expect(visible(button(section('Prompt'), /prompt$/))).toBe('Copy preview');
    expect(visible(button(section('Output'), /output$/))).toBe('Copy preview');
    // the delegation reason is kept whole
    expect(visible(button(section('Delegation reason'), /reason$/))).toBe(
      'Copy',
    );
  });

  it('offers no copy control for a redacted preview', () => {
    const redacted = span('s2', { promptPreview: null, outputPreview: 'ok' });
    mount(<Inspector run={run([redacted])} spanId="s2" insightId={null} />);
    expect(section('Prompt').querySelector('button')).toBeNull();
    expect(section('Prompt').textContent).toContain('redacted');
    expect(section('Output').querySelector('button')).not.toBeNull();
  });

  it('states a denied clipboard on the button until the next try', async () => {
    setClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    mount(<Inspector run={run([s1])} spanId="s1" insightId={null} />);

    const prompt = button(section('Prompt'), /^Copy preview of the prompt$/);
    await click(prompt);
    // visible to everyone, not only on hover or to screen readers
    expect(visible(prompt)).toBe('Copy failed: select the text');
    // and the name still says which text, when several fail
    expect(prompt.textContent).toBe(
      'Copy failed: select the text of the prompt preview',
    );
    expect(prompt.title).toContain('Select the text');
    expect(status(section('Prompt'))).toBe(
      'Could not copy the prompt preview. Select the text to copy it.',
    );

    setClipboard(async () => {});
    await click(prompt);
    expect(visible(prompt)).toBe('Copied');
  });

  it('also states the failure without a Clipboard API', async () => {
    setClipboard(null);
    mount(<Inspector run={run([s1])} spanId="s1" insightId={null} />);
    const prompt = button(section('Prompt'), /^Copy preview of the prompt$/);
    await click(prompt);
    expect(visible(prompt)).toBe('Copy failed: select the text');
  });

  it('lets only the latest of overlapping attempts report', async () => {
    let rejectFirst: (e: Error) => void = () => {};
    let calls = 0;
    setClipboard(() => {
      calls += 1;
      // the first write hangs on a permission prompt, the second succeeds
      return calls === 1
        ? new Promise<void>((_, reject) => {
            rejectFirst = reject;
          })
        : Promise.resolve();
    });
    mount(<Inspector run={run([s1])} spanId="s1" insightId={null} />);
    const prompt = button(section('Prompt'), /^Copy preview of the prompt$/);

    await click(prompt);
    await click(prompt);
    expect(visible(prompt)).toBe('Copied');

    // the first attempt settles late and must not overwrite the second
    await act(async () => {
      rejectFirst(new Error('NotAllowedError'));
    });
    expect(visible(prompt)).toBe('Copied');
  });

  it('drops a confirmation when another span takes its place', async () => {
    setClipboard(async () => {});
    const s2 = span('s2', { promptPreview: 'Another prompt' });
    const both = run([s1, s2]);
    mount(<Inspector run={both} spanId="s1" insightId={null} />);
    await click(button(section('Prompt'), /^Copy preview of the prompt$/));
    expect(visible(button(section('Prompt'), /prompt preview$/))).toBe(
      'Copied',
    );

    mount(<Inspector run={both} spanId="s2" insightId={null} />);
    expect(visible(button(section('Prompt'), /of the prompt$/))).toBe(
      'Copy preview',
    );
  });

  it('copies the raw record shown under Show raw', async () => {
    const written: string[] = [];
    setClipboard(async (t) => {
      written.push(t);
    });
    mount(<Inspector run={run([s1])} spanId="s1" insightId={null} />);

    // hidden with the record
    expect(() => button(container, /^Copy JSON of the span$/)).toThrow();
    await click(button(container, /^Show raw$/));

    const copyJson = button(container, /^Copy JSON of the span$/);
    expect(visible(copyJson)).toBe('Copy JSON');
    await click(copyJson);
    expect(written).toEqual([JSON.stringify(s1, null, 2)]);
    expect(copyJson.textContent).toBe('Copied the span JSON');
    // the clipboard gets exactly the record on screen
    expect(container.querySelector('pre.max-h-80')?.textContent).toBe(
      written[0],
    );
  });
});
