import type { Run } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { exportCommand } from './export-command';
import { EMPTY_FILTER } from './filter-runs';
import { DASHBOARD_ROUTE, SESSIONS_ROUTE } from './router';

const stubRun = (id: string): Run => ({
  id,
  source: { tool: 'claude-code', format: 'claude-jsonl', files: [] },
  startedAt: '2026-08-10T10:00:00.000Z',
  spans: [],
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

describe('exportCommand (Task 4.1, visualizer "The rendered command is exact and never overstates its scope")', () => {
  describe('single run in view', () => {
    it('generates exact command for sanitized profile with run id', () => {
      const res = exportCommand(
        { route: { view: 'timeline', runId: 'run_123' } },
        'sanitized',
      );
      expect(res.command).toBe(
        'runray export run_123 -o report.html --anonymize',
      );
      expect(res.runCount).toBe(1);
      expect(res.hasStoreOnlyFilter).toBe(false);
      expect(res.scopeSentence).toContain('single run');
    });

    it('generates exact command for metadata-only profile with run id', () => {
      const res = exportCommand(
        { route: { view: 'cost', runId: 'run_abc' } },
        'metadata-only',
      );
      expect(res.command).toBe(
        'runray export run_abc -o report.html --metadata-only',
      );
      expect(res.runCount).toBe(1);
    });

    it('generates exact command for full profile with run id', () => {
      const res = exportCommand(
        { route: { view: 'time', runId: 'run_xyz' } },
        'full',
      );
      expect(res.command).toBe('runray export run_xyz -o report.html');
      expect(res.runCount).toBe(1);
    });
  });

  describe('multi-run overview without filters', () => {
    const runs = [stubRun('r1'), stubRun('r2'), stubRun('r3')];

    it('exports all runs with sanitized profile', () => {
      const res = exportCommand(
        { route: DASHBOARD_ROUTE, allRuns: runs, visibleRuns: runs },
        'sanitized',
      );
      expect(res.command).toBe('runray export -o report.html --anonymize');
      expect(res.runCount).toBe(3);
      expect(res.hasStoreOnlyFilter).toBe(false);
      expect(res.scopeSentence).toContain('3 discovered runs');
    });

    it('exports all runs with metadata-only profile', () => {
      const res = exportCommand(
        { route: SESSIONS_ROUTE, allRuns: runs, visibleRuns: runs },
        'metadata-only',
      );
      expect(res.command).toBe('runray export -o report.html --metadata-only');
      expect(res.runCount).toBe(3);
    });

    it('exports all runs with full profile', () => {
      const res = exportCommand(
        { route: DASHBOARD_ROUTE, allRuns: runs, visibleRuns: runs },
        'full',
      );
      expect(res.command).toBe('runray export -o report.html');
      expect(res.runCount).toBe(3);
    });
  });

  describe('multi-run with CLI-expressible filters', () => {
    const runs = [stubRun('r1'), stubRun('r2')];

    it('expresses --source filter', () => {
      const res = exportCommand(
        {
          route: DASHBOARD_ROUTE,
          filter: { ...EMPTY_FILTER, source: 'claude-code' },
          allRuns: runs,
          visibleRuns: runs,
        },
        'sanitized',
      );
      expect(res.command).toBe(
        'runray export -o report.html --source claude-code --anonymize',
      );
      expect(res.hasStoreOnlyFilter).toBe(false);
    });

    it('expresses --since filter for periodDays', () => {
      const res = exportCommand(
        {
          route: DASHBOARD_ROUTE,
          filter: { ...EMPTY_FILTER, periodDays: 7 },
          allRuns: runs,
          visibleRuns: runs,
        },
        'metadata-only',
      );
      expect(res.command).toBe(
        'runray export -o report.html --since 7d --metadata-only',
      );
      expect(res.hasStoreOnlyFilter).toBe(false);
    });

    it('combines --source and --since filters', () => {
      const res = exportCommand(
        {
          route: DASHBOARD_ROUTE,
          filter: { ...EMPTY_FILTER, source: 'opencode', periodDays: 30 },
          allRuns: runs,
          visibleRuns: runs,
        },
        'sanitized',
      );
      expect(res.command).toBe(
        'runray export -o report.html --source opencode --since 30d --anonymize',
      );
      expect(res.hasStoreOnlyFilter).toBe(false);
    });
  });

  describe('multi-run with store-only filters (not expressible in CLI)', () => {
    const allRuns = [stubRun('r1'), stubRun('r2'), stubRun('r3')];
    const visibleRuns = [stubRun('r1')];

    it('flags store-only project filter and explains scope in sentence without misrepresenting command', () => {
      const res = exportCommand(
        {
          route: DASHBOARD_ROUTE,
          filter: { ...EMPTY_FILTER, project: 'my-project' },
          allRuns,
          visibleRuns,
        },
        'sanitized',
      );
      expect(res.command).toBe('runray export -o report.html --anonymize');
      expect(res.hasStoreOnlyFilter).toBe(true);
      expect(res.scopeSentence).toContain('active in-browser filters');
      expect(res.runCount).toBe(3);
    });
  });
});
