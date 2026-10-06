/**
 * @vitest-environment jsdom
 *
 * The keyboard path to findings a collapsed waterfall row hides. The row's
 * "⚠ N inside" chip is skipped by Tab, like the row's own finding chip, so
 * the Inspector lists the hidden findings as buttons when the collapsed row
 * is selected. Picking one opens it the way a deep link does. Rendered
 * through `createRoot` because a static render reads the store's initial
 * state, not the collapsed set.
 */
import type { Run, Span } from '@runray/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Inspector } from './components/Inspector';
import { useAppStore } from './store';

declare global {
  // React 18 requires this flag for `act` outside a test-framework integration.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const span = (over: Partial<Span> & Pick<Span, 'id' | 'kind'>): Span => ({
  parentId: null,
  name: over.id,
  status: 'ok',
  depth: 0,
  startedAt: '2026-07-07T10:00:00.000Z',
  attributes: {},
  provenance: { file: 'stub.jsonl' },
  ...over,
});

const run: Run = {
  id: 'run1',
  source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
  startedAt: '2026-07-07T10:00:00.000Z',
  spans: [
    span({ id: 'session', kind: 'session' }),
    span({ id: 'agent', kind: 'subagent', parentId: 'session', depth: 1 }),
    span({ id: 'a1', kind: 'tool_call', parentId: 'agent', depth: 2 }),
    span({ id: 'a2', kind: 'tool_call', parentId: 'agent', depth: 2 }),
  ],
  totals: {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUSD: { total: 0, wastedEstimate: 0, byModel: {} },
    counts: {
      llmCalls: 0,
      toolCalls: 2,
      toolErrors: 0,
      subagents: 1,
      maxDepth: 2,
    },
    cache: { hitRate: 0 },
  },
  insights: [
    {
      id: 'dup',
      ruleId: 'duplicate-read',
      severity: 'warning',
      title: 'Same file re-read 2× without changes',
      detail: '',
      spanIds: ['a1', 'a2'],
      estimatedWasteUSD: 0.12,
    },
  ],
};

const initialStore = useAppStore.getInitialState();
let container: HTMLDivElement;
let root: Root;

describe('Inspector on a collapsed row', () => {
  beforeEach(() => {
    useAppStore.setState(initialStore, true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderInspector = () =>
    act(() => {
      root.render(<Inspector run={run} />);
    });

  it('lists the findings the row hides as buttons', () => {
    act(() => {
      useAppStore.getState().setCollapsed(new Set(['agent']));
      useAppStore.getState().selectSpan('agent');
    });
    renderInspector();
    expect(container.textContent).toContain('Hidden inside');
    const pick = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('$0.12'),
    );
    expect(pick).toBeDefined();
  });

  it('opens a hidden finding the way a deep link does', () => {
    act(() => {
      useAppStore.getState().setCollapsed(new Set(['agent']));
      useAppStore.getState().selectSpan('agent');
    });
    renderInspector();
    const pick = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('$0.12'),
    );
    act(() => pick?.click());
    const { selection, ui } = useAppStore.getState();
    expect(selection.insightId).toBe('dup');
    // the collapsed row is not evidence, so it is dropped and the waterfall
    // lands on the evidence instead
    expect(selection.spanId).toBeNull();
    expect([...ui.highlighted]).toEqual(['a1', 'a2']);
  });

  it('lists nothing while the row is expanded', () => {
    act(() => useAppStore.getState().selectSpan('agent'));
    renderInspector();
    expect(container.textContent).not.toContain('Hidden inside');
  });
});
