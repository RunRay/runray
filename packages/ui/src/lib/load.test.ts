import type { Run, TraceFile } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { loadPricing } from './load';

function stubRun(id: string): Run {
  return {
    id,
    source: { tool: 'opencode', format: 'opencode-storage', files: [] },
    startedAt: '2026-02-11T15:29:28.327Z',
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
  };
}

function _traceFile(ids: string[]): TraceFile {
  return {
    schemaVersion: '0.1.0',
    generator: { name: 'test', version: '0.0.0' },
    generatedAt: '2026-07-07T12:00:00.000Z',
    runs: ids.map(stubRun),
  };
}

describe('loadPricing', () => {
  const cleanWindow = () => {
    (globalThis as Record<string, unknown>).window = undefined;
    delete (globalThis as Record<string, unknown>).window;
  };

  it('prefers the embedded payload (__RUNRAY_PRICING__ and legacy __TRACEPULSE_PRICING__)', async () => {
    (globalThis as Record<string, unknown>).window = {
      __RUNRAY_PRICING__: {
        origin: 'bundled',
        table: { snapshotDate: '2026-07-07' },
      },
    };
    try {
      const payload = await loadPricing();
      expect(payload?.origin).toBe('bundled');
      expect(payload?.table.snapshotDate).toBe('2026-07-07');
    } finally {
      cleanWindow();
    }

    (globalThis as Record<string, unknown>).window = {
      __TRACEPULSE_PRICING__: {
        origin: 'bundled',
        table: { snapshotDate: '2026-07-07' },
      },
    };
    try {
      const payload = await loadPricing();
      expect(payload?.origin).toBe('bundled');
      expect(payload?.table.snapshotDate).toBe('2026-07-07');
    } finally {
      cleanWindow();
    }
  });

  it('an old export (data without pricing) yields undefined — no fetch', async () => {
    (globalThis as Record<string, unknown>).window = {
      __RUNRAY_DATA__: {},
    };
    try {
      expect(await loadPricing()).toBeUndefined();
    } finally {
      cleanWindow();
    }

    (globalThis as Record<string, unknown>).window = {
      __TRACEPULSE_DATA__: {},
    };
    try {
      expect(await loadPricing()).toBeUndefined();
    } finally {
      cleanWindow();
    }
  });

  it('live path fetches /api/pricing and tolerates a 404 (older CLI)', async () => {
    (globalThis as Record<string, unknown>).window = {};
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ origin: 'user', table: {} }),
      })) as unknown as typeof fetch;
      expect((await loadPricing())?.origin).toBe('user');
      globalThis.fetch = (async () => ({
        ok: false,
      })) as unknown as typeof fetch;
      expect(await loadPricing()).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
      cleanWindow();
    }
  });
});
