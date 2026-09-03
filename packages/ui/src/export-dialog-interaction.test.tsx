/**
 * @vitest-environment jsdom
 *
 * Export dialog interaction contract (Task 4.3 / 6.2, visualizer spec
 * "Export dialog interaction contract"). The rest of the UI suite renders with
 * `renderToStaticMarkup`, which cannot observe focus, key handling, or the
 * clipboard — the four scenarios below are DOM behaviours, so this one file
 * opts into jsdom and drives React through `createRoot` + `act`.
 */
import type { Run } from '@runray/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportDialog } from './components/ExportDialog';
import { Inspector } from './components/Inspector';
import { useAppStore } from './store';

declare global {
  // React 18 requires this flag for `act` outside a test-framework integration.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const stubRun = (id: string): Run => ({
  id,
  source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
  startedAt: '2026-08-10T10:00:00.000Z',
  spans: [
    {
      id: 's1',
      parentId: null,
      kind: 'session',
      name: 'Session',
      status: 'ok',
      depth: 0,
      startedAt: '2026-08-10T10:00:00.000Z',
      attributes: {},
      provenance: { file: 'transcript-1', line: 1 },
    },
  ],
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

function unmount(): void {
  act(() => {
    root.unmount();
  });
}

/** jsdom has no default-action for keys; a focused control's activation is a click. */
function activate(el: HTMLElement): void {
  act(() => {
    el.focus();
    el.click();
  });
}

function pressKey(key: string, opts: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...opts,
      }),
    );
  });
}

function q<T extends HTMLElement>(testId: string): T {
  const el = container.querySelector<T>(`[data-testid="${testId}"]`);
  if (el === null) throw new Error(`no element with data-testid="${testId}"`);
  return el;
}

function setClipboard(writeText: ((t: string) => Promise<void>) | null): void {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: writeText === null ? undefined : { writeText },
    configurable: true,
    writable: true,
  });
}

describe('Export dialog interaction contract (Task 4.3/6.2, visualizer spec)', () => {
  beforeEach(() => {
    useAppStore.setState(initialStore, true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    container.remove();
    setClipboard(null);
  });

  const run = stubRun('run_100');
  const dialogProps = {
    route: { view: 'timeline', runId: 'run_100' } as const,
    allRuns: [run],
    visibleRuns: [run],
  };

  it('moves focus into the dialog on open and traps Tab inside it', () => {
    mount(<ExportDialog onClose={() => {}} {...dialogProps} />);

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // focus moved into the dialog, not left on <body>
    expect(dialog?.contains(document.activeElement)).toBe(true);

    const focusable = Array.from(
      (dialog as HTMLElement).querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;

    // Tab off the last control wraps to the first — focus never escapes
    act(() => last.focus());
    pressKey('Tab');
    expect(document.activeElement).toBe(first);

    // Shift+Tab off the first control wraps to the last
    act(() => first.focus());
    pressKey('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);

    unmount();
  });

  it('keyboard-only handoff puts the selected profile’s command on the clipboard', async () => {
    const written: string[] = [];
    setClipboard(async (t: string) => {
      written.push(t);
    });

    mount(<ExportDialog onClose={() => {}} {...dialogProps} />);

    // sanitized is preselected
    expect(q('rendered-export-command').textContent).toBe(
      'runray export run_100 -o report.html --anonymize',
    );

    // select "metadata only" from the keyboard (Space on a focused radio)
    const metadataRadio = q<HTMLLabelElement>(
      'profile-option-metadata-only',
    ).querySelector<HTMLInputElement>('input[type="radio"]');
    expect(metadataRadio).not.toBeNull();
    activate(metadataRadio as HTMLInputElement);

    // the command re-renders in place for the new selection
    expect(q('rendered-export-command').textContent).toBe(
      'runray export run_100 -o report.html --metadata-only',
    );

    // activate the copy control from the keyboard
    activate(q('copy-export-command-button'));
    await act(async () => {});

    expect(written).toEqual([
      'runray export run_100 -o report.html --metadata-only',
    ]);
    expect(q('copy-export-command-button').textContent).toContain('Copied!');

    unmount();
  });

  it('confirms a successful copy of the default (sanitized) command', async () => {
    setClipboard(async () => {});
    mount(<ExportDialog onClose={() => {}} {...dialogProps} />);

    expect(q('copy-export-command-button').textContent).toContain(
      'Copy command',
    );
    expect(
      container.querySelector('[data-testid="copy-error-hint"]'),
    ).toBeNull();

    activate(q('copy-export-command-button'));
    await act(async () => {});

    expect(q('copy-export-command-button').textContent).toContain('Copied!');
    expect(
      container.querySelector('[data-testid="copy-error-hint"]'),
    ).toBeNull();

    unmount();
  });

  it('states the failure and keeps the command selectable when the clipboard is denied', async () => {
    setClipboard(async () => {
      throw new Error('NotAllowedError: write permission denied');
    });
    mount(<ExportDialog onClose={() => {}} {...dialogProps} />);

    activate(q('copy-export-command-button'));
    await act(async () => {});

    // the failure is stated, not silent
    const hint = q('copy-error-hint');
    expect(hint.textContent).toContain('Clipboard access denied');
    // ...and no false confirmation is shown
    expect(q('copy-export-command-button').textContent).not.toContain(
      'Copied!',
    );

    // the manual path survives: the command is still rendered and select-all
    const code = q('rendered-export-command');
    expect(code.textContent).toBe(
      'runray export run_100 -o report.html --anonymize',
    );
    expect(code.className).toContain('select-all');

    unmount();
  });

  it('also states the failure when the Clipboard API is unavailable entirely', async () => {
    setClipboard(null);
    mount(<ExportDialog onClose={() => {}} {...dialogProps} />);

    activate(q('copy-export-command-button'));
    await act(async () => {});

    expect(q('copy-error-hint').textContent).toContain(
      'Clipboard access denied',
    );
    expect(q('rendered-export-command').className).toContain('select-all');

    unmount();
  });

  it('Esc closes the dialog and returns focus to the control that opened it', () => {
    const trigger = document.createElement('button');
    trigger.setAttribute('data-testid', 'topbar-export-button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const onClose = vi.fn();
    mount(<ExportDialog onClose={onClose} {...dialogProps} />);

    // focus left the trigger for the dialog
    expect(document.activeElement).not.toBe(trigger);

    pressKey('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);

    // the owner unmounts the dialog in response; focus returns to the trigger
    unmount();
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });
});

describe('Inspector metadata-only notice reacts to a late manifest (Task 5.2)', () => {
  beforeEach(() => {
    useAppStore.setState(initialStore, true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('renders the notice when the view config arrives after first paint', () => {
    const run = stubRun('run_200');
    mount(<Inspector run={run} spanId={null} insightId={null} />);

    // no manifest yet — no notice
    expect(
      container.querySelector('[data-testid="inspector-metadata-only-notice"]'),
    ).toBeNull();

    // the CLI's view config lands after mount (the live `/api/view-config` fetch)
    act(() => {
      useAppStore.getState().viewConfigLoaded({
        manifest: {
          profile: 'metadata-only',
          textRedacted: true,
          pathsScrubbed: true,
          spansPruned: true,
        },
      });
    });

    const notice = container.querySelector(
      '[data-testid="inspector-metadata-only-notice"]',
    );
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('metadata-only');

    unmount();
  });
});
