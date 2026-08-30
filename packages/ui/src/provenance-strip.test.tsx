import type { Run, TraceFile } from '@runray/schema';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  hasUnredactedPrompts,
  ProvenanceStrip,
} from './components/ProvenanceStrip';
import { useAppStore } from './store';

const initialStore = useAppStore.getInitialState();

function stubRun(id: string, promptPreview?: string | null): Run {
  return {
    id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: '2026-08-10T10:00:00.000Z',
    spans: [
      {
        id: 'span1',
        parentId: null,
        kind: 'llm_call',
        name: 'claude-3-5-sonnet',
        status: 'ok',
        depth: 0,
        startedAt: '2026-08-10T10:00:00.000Z',
        attributes: {},
        provenance: {
          file: '/Users/secret/path/to/session.jsonl',
          line: 42,
        },
        content:
          promptPreview !== undefined
            ? { promptPreview, outputPreview: null }
            : undefined,
      },
    ],
    totals: {
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
      costUSD: { total: 0.05, wastedEstimate: 0, byModel: {} },
      counts: {
        llmCalls: 1,
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

function stubTraceFile(runs: Run[]): TraceFile {
  return {
    schemaVersion: '0.1.0',
    generator: { name: 'runray', version: '0.1.0' },
    generatedAt: '2026-08-10T12:00:00.000Z',
    runs,
  };
}

describe('Export provenance strip (Task 7.4)', () => {
  beforeEach(() => {
    useAppStore.setState(initialStore, true);
  });

  it('strip present under live === false and absent when served live', () => {
    // Served live
    useAppStore.getState().dataLoaded(stubTraceFile([stubRun('r1')]), true);
    let state = useAppStore.getState();
    const shouldRenderLive = state.data.status === 'ready' && !state.data.live;
    expect(shouldRenderLive).toBe(false);

    // Exported report (live === false)
    useAppStore.getState().dataLoaded(stubTraceFile([stubRun('r1')]), false);
    state = useAppStore.getState();
    const shouldRenderExport =
      state.data.status === 'ready' && !state.data.live;
    expect(shouldRenderExport).toBe(true);

    const html = renderToStaticMarkup(
      React.createElement(ProvenanceStrip, {
        traceFile:
          state.data.status === 'ready'
            ? state.data.traceFile
            : stubTraceFile([]),
      }),
    );
    expect(html).toContain('data-testid="provenance-strip"');
  });

  it('redacted and unredacted variants differ visibly', () => {
    const redactedFile = stubTraceFile([stubRun('r1', null)]);
    const unredactedFile = stubTraceFile([
      stubRun('r2', 'User secret prompt text'),
    ]);

    expect(hasUnredactedPrompts(redactedFile)).toBe(false);
    expect(hasUnredactedPrompts(unredactedFile)).toBe(true);

    const redactedHtml = renderToStaticMarkup(
      React.createElement(ProvenanceStrip, { traceFile: redactedFile }),
    );
    const unredactedHtml = renderToStaticMarkup(
      React.createElement(ProvenanceStrip, { traceFile: unredactedFile }),
    );

    // Redacted variant
    expect(redactedHtml).toContain('prompt text redacted');
    expect(redactedHtml).not.toContain('contains prompt text');
    expect(redactedHtml).not.toContain('bg-heat-2');

    // Unredacted variant carries warning treatment
    expect(unredactedHtml).toContain('contains prompt text');
    expect(unredactedHtml).not.toContain('prompt text redacted');
    expect(unredactedHtml).toContain('bg-heat-2');
    expect(unredactedHtml).toContain('text-heat-2');
  });

  it('no filesystem path in any variant', () => {
    const redactedFile = stubTraceFile([stubRun('r1', null)]);
    const unredactedFile = stubTraceFile([
      stubRun('r2', 'User secret prompt text'),
    ]);

    const redactedHtml = renderToStaticMarkup(
      React.createElement(ProvenanceStrip, { traceFile: redactedFile }),
    );
    const unredactedHtml = renderToStaticMarkup(
      React.createElement(ProvenanceStrip, { traceFile: unredactedFile }),
    );

    const secretPath = '/Users/secret/path/to/session.jsonl';

    // Must not contain any filesystem path from span provenance
    expect(redactedHtml).not.toContain(secretPath);
    expect(unredactedHtml).not.toContain(secretPath);

    // General check: no absolute paths in either HTML
    expect(redactedHtml).not.toContain('/Users/');
    expect(unredactedHtml).not.toContain('/Users/');
    expect(redactedHtml).not.toContain('/home/');
    expect(unredactedHtml).not.toContain('/home/');
  });

  it('renders exact copy from §4.6', () => {
    const file = stubTraceFile([stubRun('r1', null)]);
    const html = renderToStaticMarkup(
      React.createElement(ProvenanceStrip, { traceFile: file }),
    );

    expect(html).toContain('Exported RunRay report');
    expect(html).toContain('1 session');
    expect(html).toContain('generated 2026-08-10 by runray 0.1.0');
    expect(html).toContain('read-only');
    expect(html).toContain('prompt text redacted');
    expect(html).toContain(
      'Generated locally from agent session logs. Nothing in this file was uploaded anywhere.',
    );
  });
});
