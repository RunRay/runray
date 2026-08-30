import { fileURLToPath } from 'node:url';
import type { TraceFile } from '@runray/schema';
import { describe, expect, it, vi } from 'vitest';
import { buildTraceFile } from './discover.js';
import { startServer } from './server.js';
import { resolveUiDistDir } from './ui-dist.js';

/**
 * E2E for task 5.1: `view`'s server with the embedded UI dist over the real
 * scrubbed subagents fixture. Requires a prior `pnpm --filter @runray/ui
 * build` (CI builds before testing); skipped when the dist is absent so a
 * fresh checkout can still run unit tests.
 */

const uiDistDir = resolveUiDistDir();
const fixturesDir = fileURLToPath(
  new URL('../../../fixtures/claude-code', import.meta.url),
);

// parses the full claude-code fixture tree — headroom over vitest's 5s
// default so it doesn't flake under full-suite load (see run-diff 2.1)
vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(uiDistDir === undefined)('view e2e (embedded ui dist)', () => {
  it('serves the dashboard app and the subagents fixture end to end', async () => {
    const { traceFile } = await buildTraceFile({
      paths: [fixturesDir],
      redact: true,
      generatorVersion: 'e2e',
    });
    const server = await startServer({
      getTraceFile: async () => traceFile,
      basePort: 4300,
      ...(uiDistDir === undefined ? {} : { uiDistDir }),
    });
    try {
      // the real app shell, not the placeholder
      const home = await fetch(server.url);
      expect(home.status).toBe(200);
      const html = await home.text();
      expect(html).toContain('<div id="root">');
      expect(html).not.toContain('not embedded in this build');

      // its bundled script must be servable too
      const src = /src="([^"]+\.js)"/.exec(html)?.[1];
      expect(src).toBeDefined();
      const script = await fetch(new URL(src ?? '', server.url));
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toContain('javascript');

      // and the data endpoint carries the subagents run the waterfall renders
      const res = await fetch(new URL('/api/tracefile', server.url));
      expect(res.status).toBe(200);
      const data = (await res.json()) as TraceFile;
      // pin to the COMMITTED subagents fixture — machine-local extras under
      // fixtures/claude-code (e.g. the perf fixture) can also carry
      // subagent spans and must not be the run this asserts against
      const subagentsRun = data.runs.find((run) =>
        run.source.files[0]?.endsWith(
          '72de75e7-d5ab-4c07-a381-6539f4e34e42.jsonl',
        ),
      );
      expect(subagentsRun).toBeDefined();
      expect(subagentsRun?.spans.length).toBeGreaterThan(1000);
      expect(subagentsRun?.spans.some((span) => span.kind === 'subagent')).toBe(
        true,
      );
    } finally {
      await server.close();
    }
  });
});
