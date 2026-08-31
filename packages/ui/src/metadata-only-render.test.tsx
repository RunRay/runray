import type { Insight, Run, Span, TraceFile } from '@runray/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { Inspector } from './components/Inspector';
import { TimeView } from './components/TimeView';
import { TranscriptPane } from './components/TranscriptPane';
import { flattenVisible } from './lib/waterfall';
import { useAppStore } from './store';

const stubMetadataOnlyRun = (id: string, reanchoredInsight?: Insight): Run => {
  const sessionSpan: Span = {
    id: 's_root',
    parentId: null,
    kind: 'session',
    name: 'Session',
    status: 'ok',
    depth: 0,
    startedAt: '2026-08-10T10:00:00.000Z',
    durationMs: 5000,
    attributes: {},
    provenance: { file: 'transcript_scrubbed.jsonl', line: 1 },
  };

  return {
    id,
    source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
    startedAt: '2026-08-10T10:00:00.000Z',
    spans: [sessionSpan],
    totals: {
      tokens: {
        input: 1200,
        output: 400,
        cacheRead: 500,
        cacheWrite: 200,
        total: 2300,
      },
      costUSD: {
        total: 0.05,
        wastedEstimate: 0.01,
        byModel: { 'claude-sonnet-4': 0.05 },
      },
      counts: {
        llmCalls: 2,
        toolCalls: 3,
        toolErrors: 0,
        subagents: 0,
        maxDepth: 1,
      },
      cache: { hitRate: 0.25 },
    },
    insights: reanchoredInsight ? [reanchoredInsight] : [],
  };
};

const stubTraceFile = (run: Run): TraceFile => ({
  schemaVersion: '0.1.0',
  generator: { name: 'runray', version: '0.1.0' },
  generatedAt: '2026-08-10T12:00:00.000Z',
  runs: [run],
});

const initialStore = useAppStore.getInitialState();

describe('Degraded render paths for metadata-only payload (Tasks 5.2, 5.3)', () => {
  beforeEach(() => {
    useAppStore.setState(initialStore, true);
  });

  it('TranscriptPane explains metadata-only profile without error or false state (Task 5.2)', () => {
    const manifest = {
      profile: 'metadata-only' as const,
      textRedacted: true,
      pathsScrubbed: true,
      spansPruned: true,
    };

    const html = renderToStaticMarkup(
      <TranscriptPane runId="r1" spanId="s_root" manifest={manifest} />,
    );

    expect(html).toContain('Transcript omitted');
    expect(html).toContain('metadata-only');
    expect(html).not.toContain('OTLP');
    expect(html).not.toContain('unavailable');
  });

  it('Waterfall keeps one bar per session for metadata-only runs (Task 5.2)', () => {
    const run = stubMetadataOnlyRun('r1');
    const rows = flattenVisible(run, new Set());
    expect(rows.length).toBe(1);
    expect(rows[0]?.span.id).toBe('s_root');
    expect(rows[0]?.span.name).toBe('Session');
    expect(rows[0]?.span.kind).toBe('session');
  });

  it('TimeView renders without turns and explains metadata-only profile (Task 5.2)', () => {
    const manifest = {
      profile: 'metadata-only' as const,
      textRedacted: true,
      pathsScrubbed: true,
      spansPruned: true,
    };

    const run = stubMetadataOnlyRun('r1');
    const html = renderToStaticMarkup(
      <TimeView run={run} manifest={manifest} />,
    );

    expect(html).toContain('wall-clock');
    expect(html).toContain('Turn and tool breakdowns are omitted under the');
    expect(html).toContain('metadata-only');
  });

  it('Inspector explains the profile instead of an empty panel or a misleading zero (Task 5.2)', () => {
    const manifest = {
      profile: 'metadata-only' as const,
      textRedacted: true,
      pathsScrubbed: true,
      spansPruned: true,
    };

    const run = stubMetadataOnlyRun('r1');
    const html = renderToStaticMarkup(
      <Inspector
        run={run}
        spanId={null}
        insightId={null}
        manifest={manifest}
      />,
    );

    // states the profile as the reason the per-call list is absent
    expect(html).toContain('inspector-metadata-only-notice');
    expect(html).toContain('Individual LLM and tool calls omitted under the');
    expect(html).toContain('metadata-only');
    // no error state
    expect(html).not.toContain('Select a span to inspect it.');
    // and no misleading zero — the aggregates still come from run.totals
    expect(html).toContain('Run at a glance');
    expect(html).toContain('>2<'); // llm calls
    expect(html).toContain('>3<'); // tool calls
    expect(html).toContain('25.0%'); // cache hit-rate
  });

  it('Inspector shows no metadata-only notice under a full-profile report', () => {
    const run = stubMetadataOnlyRun('r1');
    const html = renderToStaticMarkup(
      <Inspector
        run={run}
        spanId={null}
        insightId={null}
        manifest={{
          profile: 'full',
          textRedacted: false,
          pathsScrubbed: false,
          spansPruned: false,
        }}
      />,
    );

    expect(html).not.toContain('inspector-metadata-only-notice');
  });

  it('evidence selection highlights re-anchored surviving container span without errors (Task 5.3, D5)', () => {
    const insight: Insight = {
      id: 'ins_1',
      ruleId: 'retry-loop',
      severity: 'warning',
      title: 'Retry loop detected',
      detail: 'Repeated calls to tool',
      estimatedWasteUSD: 0.01,
      // Re-anchored to the surviving session container span ID
      spanIds: ['s_root'],
    };

    const run = stubMetadataOnlyRun('r1', insight);
    useAppStore.getState().dataLoaded(stubTraceFile(run), false);
    useAppStore.getState().routeChanged({ view: 'timeline', runId: 'r1' });
    useAppStore.getState().activateInsight(insight);

    // Highlighted contains the re-anchored container span
    expect(useAppStore.getState().ui.highlighted.has('s_root')).toBe(true);

    // Inspector renders finding detail and evidence linking to s_root
    const html = renderToStaticMarkup(
      <Inspector run={run} insightId={insight.id} spanId={null} />,
    );
    expect(html).toContain('Retry loop detected');
    expect(html).toContain('Evidence (1)');
    expect(html).toContain('Session');
  });
});
