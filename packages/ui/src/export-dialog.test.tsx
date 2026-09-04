import type { Run } from '@runray/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExportDialog } from './components/ExportDialog';
import { TopBar } from './components/TopBar';
import { useAppStore } from './store';

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
      provenance: { file: 'transcript.jsonl', line: 1 },
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

describe('Export trigger and profile dialog (Tasks 4.2, 4.3, visualizer spec)', () => {
  beforeEach(() => {
    useAppStore.setState(initialStore, true);
  });

  it('TopBar export trigger is visible in live mode and absent in export mode (Task 4.2)', () => {
    // Live mode
    const liveHtml = renderToStaticMarkup(
      <TopBar live={true} status="ready" />,
    );
    expect(liveHtml).toContain('data-testid="topbar-export-button"');
    expect(liveHtml).toContain('Export');

    // Export mode (live === false)
    const exportHtml = renderToStaticMarkup(
      <TopBar live={false} status="ready" />,
    );
    expect(exportHtml).not.toContain('data-testid="topbar-export-button"');
  });

  it('dialog preselects sanitized profile and renders exact command (Task 4.3)', () => {
    const run = stubRun('run_100');
    const html = renderToStaticMarkup(
      <ExportDialog
        onClose={() => {}}
        route={{ view: 'timeline', runId: 'run_100' }}
        allRuns={[run]}
        visibleRuns={[run]}
      />,
    );

    // Dialog structure & accessibility
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Export report');

    // Three profiles present
    expect(html).toContain('data-testid="profile-option-sanitized"');
    expect(html).toContain('data-testid="profile-option-metadata-only"');
    expect(html).toContain('data-testid="profile-option-full"');

    // Sanitized is preselected
    expect(html).toContain('checked="" value="sanitized"');
    expect(html).toContain('runray export run_100 -o report.html --anonymize');
    expect(html).toContain('Exports the single run currently in view');
    expect(html).toContain('Copy command');
  });

  it('store toggleExport opens and closes export dialog state', () => {
    expect(useAppStore.getState().ui.exportOpen).toBe(false);
    useAppStore.getState().toggleExport(true);
    expect(useAppStore.getState().ui.exportOpen).toBe(true);
    useAppStore.getState().toggleExport(false);
    expect(useAppStore.getState().ui.exportOpen).toBe(false);
  });
});
