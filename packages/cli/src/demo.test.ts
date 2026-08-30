import type { TraceFile } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { loadDemoTraceFile, resolveDemoDataDir } from './demo.js';
import { startServer } from './server.js';

describe('demo', () => {
  const dir = resolveDemoDataDir();

  it('finds the bundled demo data (goldens in a monorepo checkout)', () => {
    expect(dir).toBeDefined();
  });

  it('wraps the goldens in a TraceFile envelope, newest first', () => {
    if (dir === undefined) throw new Error('unreachable');
    const traceFile = loadDemoTraceFile(dir, '0.0.0-test');
    expect(traceFile.schemaVersion).toBe('0.1.0');
    expect(traceFile.generator).toEqual({
      name: 'runray',
      version: '0.0.0-test',
    });
    expect(traceFile.runs.length).toBeGreaterThanOrEqual(3);
    const starts = traceFile.runs.map((run) => Date.parse(run.startedAt));
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
    // the sample must actually demo the product: subagents and insights
    expect(traceFile.runs.some((run) => run.totals.counts.subagents > 0)).toBe(
      true,
    );
    expect(traceFile.runs.some((run) => run.insights.length > 0)).toBe(true);
  });

  it('collapses cross-era duplicates so every demo run id is unique', () => {
    if (dir === undefined) throw new Error('unreachable');
    const traceFile = loadDemoTraceFile(dir, '0.0.0-test');
    // The OpenCode storage/sqlite/export goldens capture one session three
    // ways and hash to the same run id; without deduping, the demo would show
    // it three times and the UI could only reach the first (deep-link, rail).
    const ids = traceFile.runs.map((run) => run.id);
    expect(new Set(ids).size).toBe(ids.length);
    // and it must be idempotent/deterministic — the same call, same runs
    expect(loadDemoTraceFile(dir, '0.0.0-test').runs.map((r) => r.id)).toEqual(
      ids,
    );
  });

  it('serves the demo data end to end', async () => {
    if (dir === undefined) throw new Error('unreachable');
    const traceFile = loadDemoTraceFile(dir, '0.0.0-test');
    const server = await startServer({
      getTraceFile: async () => traceFile,
      basePort: 4350,
    });
    try {
      const res = await fetch(new URL('/api/tracefile', server.url));
      expect(res.status).toBe(200);
      const data = (await res.json()) as TraceFile;
      expect(data.runs.length).toBe(traceFile.runs.length);
    } finally {
      await server.close();
    }
  });
});
