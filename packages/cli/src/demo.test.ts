import type { TraceFile } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import {
  DEMO_TRANSCRIPT,
  loadDemoTraceFile,
  resolveDemoDataDir,
} from './demo.js';
import { startServer } from './server.js';

describe('demo', () => {
  const dir = resolveDemoDataDir();

  it('finds the bundled demo data (demo/runs in a monorepo checkout)', () => {
    expect(dir).toBeDefined();
    expect(dir?.replace(/\\/g, '/')).toMatch(/demo\/runs\/$/);
  });

  it('reads like real work: titled, priced, and free of scrubber lorem', () => {
    if (dir === undefined) throw new Error('unreachable');
    const traceFile = loadDemoTraceFile(dir, '0.0.0-test');
    // the scrubber's vocabulary (scripts/scrub-fixture.ts), as words and as
    // the x-joined tokens it writes into paths
    const lorem =
      /\b(lorem|ipsum|dolor|consectetur|adipiscing|incididunt|labore|aliqua|aliquip|nostrud|veniam|tempor|magna|minim|enim|quis|elit|amet)\b|(lorem|ipsum|dolor|adipis|aliqu|nostrud|consec)x/i;
    const leaks: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        if (lorem.test(value)) leaks.push(`${path}: ${value.slice(0, 40)}`);
      } else if (Array.isArray(value)) {
        for (const [i, v] of value.entries()) walk(v, `${path}[${i}]`);
      } else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (!/(^id|Id)$/.test(k)) walk(v, `${path}.${k}`);
        }
      }
    };
    for (const run of traceFile.runs) {
      walk(run, run.id);
      expect(run.title, run.id).toBeTruthy();
      expect(run.project?.name, run.id).toBeTruthy();
      // no "totals are understated" banner on the showcase
      const unpriced = run.spans.filter(
        (s) => s.kind === 'llm_call' && s.llm?.costSource === 'unknown',
      );
      expect(unpriced, run.id).toEqual([]);
      // fixture-truncation warnings are test data, not demo content
      expect(run.warnings, run.id).toBeUndefined();
    }
    expect(leaks.slice(0, 5)).toEqual([]);
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
    // Run ids are not unique by design (the OpenCode cross-era goldens share
    // one); a duplicate in the demo would leave all but the first copy
    // unreachable in the UI (deep-link, rail).
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
      // the same hook `runray demo` and the wizard's demo branch install
      getTranscript: async () => DEMO_TRANSCRIPT,
      basePort: 4350,
    });
    try {
      const res = await fetch(new URL('/api/tracefile', server.url));
      expect(res.status).toBe(200);
      const data = (await res.json()) as TraceFile;
      expect(data.runs.length).toBe(traceFile.runs.length);

      // demo provenance names logs that exist on no one's disk: the
      // transcript endpoint answers with a plain status, never an ENOENT
      const run = traceFile.runs[0];
      const span = run?.spans.find((s) => s.kind === 'llm_call');
      if (run === undefined || span === undefined) {
        throw new Error('demo run without llm calls');
      }
      const transcript = await fetch(
        new URL(
          `/api/transcript?run=${encodeURIComponent(run.id)}&span=${encodeURIComponent(span.id)}`,
          server.url,
        ),
      );
      expect(transcript.status).toBe(200);
      expect(await transcript.json()).toEqual(DEMO_TRANSCRIPT);
    } finally {
      await server.close();
    }
  });

  it('describes the missing demo transcripts without leaking an I/O error', () => {
    expect(DEMO_TRANSCRIPT.status).toBe('unavailable');
    if (DEMO_TRANSCRIPT.status !== 'unavailable') return;
    expect(DEMO_TRANSCRIPT.reason).toMatch(/demo/);
    expect(DEMO_TRANSCRIPT.reason).not.toMatch(/ENOENT|no such file/i);
  });
});
