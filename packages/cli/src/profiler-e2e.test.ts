import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundledPricing } from '@runray/core';
import { describe, expect, it } from 'vitest';
import { buildTraceFile } from './discover.js';
import { injectGlobal, injectTraceData } from './export.js';
import { resolveTranscript } from './program.js';
import { startServer } from './server.js';
import { resolveExportTemplate } from './ui-dist.js';

const fixturesDir = fileURLToPath(
  new URL('../../../fixtures/claude-code', import.meta.url),
);

describe('server endpoints (profiler depth)', () => {
  it('GET /api/pricing returns the live pricing payload with provenance', async () => {
    const table = bundledPricing();
    const server = await startServer({
      getTraceFile: async () => ({
        schemaVersion: '0.1.0',
        generator: { name: 'test', version: '0' },
        generatedAt: '2026-07-02T13:00:00Z',
        runs: [],
      }),
      getPricing: () => ({ origin: 'bundled', table }),
      basePort: 4360,
    });
    try {
      const res = await fetch(new URL('/api/pricing', server.url));
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        origin: string;
        table: typeof table;
      };
      expect(data.origin).toBe('bundled');
      expect(data.table.entries.length).toBe(table.entries.length);
    } finally {
      await server.close();
    }
  });

  it('GET /api/viewconfig returns the view config payload', async () => {
    const server = await startServer({
      getTraceFile: async () => ({
        schemaVersion: '0.1.0',
        generator: { name: 'test', version: '0' },
        generatedAt: '2026-07-02T13:00:00Z',
        runs: [],
      }),
      getViewConfig: () => ({ limitWindow: { days: 7, budgetUSD: 100 } }),
      basePort: 4361,
    });
    try {
      const res = await fetch(new URL('/api/viewconfig', server.url));
      expect(res.status).toBe(200);
      const data = (await res.json()) as { limitWindow: { days: 7 } };
      expect(data.limitWindow.days).toBe(7);
    } finally {
      await server.close();
    }
  });

  it('GET /api/transcript serves slice for valid ids, 404 for unknown', async () => {
    const { traceFile } = await buildTraceFile({
      paths: [fixturesDir],
      redact: false,
      generatorVersion: 'e2e',
    });
    const run = traceFile.runs[0];
    const span = run?.spans.find(
      (s) => s.kind === 'llm_call' && s.provenance?.file,
    );
    if (run === undefined || span === undefined) throw new Error('unreachable');

    const server = await startServer({
      getTraceFile: async () => traceFile,
      getTranscript: (runId, spanId) =>
        resolveTranscript(traceFile, runId, spanId, false),
      basePort: 4362,
    });
    try {
      const url = new URL(
        `/api/transcript?run=${encodeURIComponent(run.id)}&span=${encodeURIComponent(span.id)}`,
        server.url,
      );
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe('ok');

      const miss = await fetch(
        new URL('/api/transcript?run=nope&span=nope', server.url),
      );
      expect(miss.status).toBe(200);
      const missData = (await miss.json()) as { status: string };
      expect(missData.status).toBe('unavailable');
    } finally {
      await server.close();
    }
  });
});

describe('export template injection (profiler depth)', () => {
  it('injects trace data, pricing, and view config into the export template', async () => {
    const template = resolveExportTemplate();
    if (template === undefined) return;

    const { traceFile } = await buildTraceFile({
      paths: [fixturesDir],
      redact: true,
      pricing: bundledPricing(),
      generatorVersion: 'e2e',
    });
    const html = injectGlobal(
      injectGlobal(
        injectTraceData(readFileSync(template, 'utf8'), traceFile),
        '__RUNRAY_PRICING__',
        { origin: 'bundled', table: bundledPricing() },
      ),
      '__RUNRAY_VIEW_CONFIG__',
      { limitWindow: { days: 7 } },
    );
    expect(html).toContain('window.__RUNRAY_DATA__=');
    expect(html).toContain('window.__RUNRAY_PRICING__=');
    expect(html).toContain('window.__RUNRAY_VIEW_CONFIG__=');
    expect(html).toContain('<div id="root">');
    // sanitization: nothing can close the data script element early
    expect(html).not.toContain('</script><!--');
    // determinism: the same inputs produce byte-identical export HTML
    const again = injectGlobal(
      injectGlobal(
        injectTraceData(readFileSync(template, 'utf8'), traceFile),
        '__RUNRAY_PRICING__',
        { origin: 'bundled', table: bundledPricing() },
      ),
      '__RUNRAY_VIEW_CONFIG__',
      { limitWindow: { days: 7 } },
    );
    expect(again).toBe(html);
  });
});
