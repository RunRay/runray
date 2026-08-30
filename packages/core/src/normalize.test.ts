import { fileURLToPath } from 'node:url';
import { RunSchema } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import type { RawRun, RawSpan } from './adapter.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
import { normalize } from './normalize.js';

function rawSpan(overrides: Partial<RawSpan> & { id: string }): RawSpan {
  return {
    parentId: null,
    kind: 'other',
    name: overrides.id,
    status: 'ok',
    startedAt: '2026-07-02T13:00:00Z',
    attributes: {},
    provenance: { file: 'x.jsonl', line: 1 },
    ...overrides,
  };
}

function rawRun(spans: RawSpan[]): RawRun {
  return {
    source: { tool: 'claude-code', format: 'claude-jsonl', files: ['x.jsonl'] },
    spans,
    warnings: [],
  };
}

describe('normalize', () => {
  it('derives depth and keeps a valid tree', () => {
    const run = normalize(
      rawRun([
        rawSpan({ id: 'root', kind: 'session', agent: { sessionId: 'root' } }),
        rawSpan({ id: 'child', parentId: 'root', kind: 'llm_call' }),
        rawSpan({ id: 'grandchild', parentId: 'child', kind: 'tool_call' }),
      ]),
    );
    const byId = new Map(run.spans.map((s) => [s.id, s]));
    expect(byId.get('root')?.depth).toBe(0);
    expect(byId.get('child')?.depth).toBe(1);
    expect(byId.get('grandchild')?.depth).toBe(2);
  });

  it('sorts spans by (startedAt, id) — stable and chronological', () => {
    const run = normalize(
      rawRun([
        rawSpan({ id: 'b', startedAt: '2026-07-02T13:00:05Z' }),
        rawSpan({ id: 'z', startedAt: '2026-07-02T13:00:01Z' }),
        rawSpan({ id: 'a', startedAt: '2026-07-02T13:00:05Z' }),
        // millisecond precision must not break chronology via string compare
        rawSpan({ id: 'm', startedAt: '2026-07-02T13:00:01.500Z' }),
      ]),
    );
    expect(run.spans.map((s) => s.id)).toEqual(['z', 'm', 'a', 'b']);
  });

  it('applies the Flat Trace Fallback to dangling parents, keeping descendants attached', () => {
    const run = normalize(
      rawRun([
        rawSpan({ id: 'root', kind: 'session', agent: { sessionId: 's' } }),
        rawSpan({
          id: 'orphan',
          parentId: 'ghost',
          startedAt: '2026-07-02T13:00:01Z',
        }),
        rawSpan({
          id: 'kid',
          parentId: 'orphan',
          startedAt: '2026-07-02T13:00:02Z',
        }),
      ]),
    );
    const byId = new Map(run.spans.map((s) => [s.id, s]));
    expect(byId.get('orphan')?.parentId).toBe('root');
    expect(byId.get('orphan')?.depth).toBe(1);
    // descendant of the orphan is untouched and stays under it
    expect(byId.get('kid')?.parentId).toBe('orphan');
    expect(byId.get('kid')?.depth).toBe(2);
    expect(
      run.warnings?.some((w) => /Flat Trace Fallback.*orphan/.test(w.message)),
    ).toBe(true);
  });

  it('breaks parent cycles via the fallback', () => {
    const run = normalize(
      rawRun([
        rawSpan({ id: 'root', kind: 'session', agent: { sessionId: 's' } }),
        rawSpan({ id: 'a', parentId: 'b', startedAt: '2026-07-02T13:00:01Z' }),
        rawSpan({ id: 'b', parentId: 'a', startedAt: '2026-07-02T13:00:02Z' }),
      ]),
    );
    const byId = new Map(run.spans.map((s) => [s.id, s]));
    expect(byId.get('a')?.parentId).toBe('root');
    expect(byId.get('b')?.parentId).toBe('root');
    expect(RunSchema.parse(run)).toBeTruthy();
  });

  it('derives totals: tokens, counts, cache hit-rate, sorted byModel, codeChanges', () => {
    const llm = (
      id: string,
      model: string,
      tokens: [number, number, number, number],
      cost?: number,
    ): RawSpan =>
      rawSpan({
        id,
        parentId: 'root',
        kind: 'llm_call',
        llm: {
          provider: 'anthropic',
          model,
          tokens: {
            input: tokens[0],
            output: tokens[1],
            cacheRead: tokens[2],
            cacheWrite: tokens[3],
          },
          costSource: cost === undefined ? 'unknown' : 'computed',
          ...(cost === undefined ? {} : { costUSD: cost }),
        },
      });
    const run = normalize(
      rawRun([
        rawSpan({
          id: 'root',
          kind: 'session',
          agent: { sessionId: 's' },
          parentId: null,
        }),
        llm('l1', 'zeta-model', [100, 10, 300, 0], 0.5),
        llm('l2', 'alpha-model', [100, 10, 0, 50], 0.25),
        rawSpan({
          id: 't1',
          parentId: 'l1',
          kind: 'tool_call',
          status: 'error',
          tool: { name: 'Bash', isError: true },
        }),
        rawSpan({
          id: 't2',
          parentId: 'l1',
          kind: 'tool_call',
          tool: {
            name: 'Edit',
            isError: false,
            linesAdded: 7,
            linesRemoved: 2,
          },
        }),
        rawSpan({
          id: 'sub',
          parentId: 't2',
          kind: 'subagent',
          agent: { name: 'x' },
        }),
      ]),
    );
    expect(run.totals.tokens).toEqual({
      input: 200,
      output: 20,
      cacheRead: 300,
      cacheWrite: 50,
      reasoning: 0,
      total: 570,
    });
    expect(run.totals.counts).toEqual({
      llmCalls: 2,
      toolCalls: 2,
      toolErrors: 1,
      subagents: 1,
      // root(0) → l1(1) → t2(2) → sub(3)
      maxDepth: 3,
    });
    expect(run.totals.cache.hitRate).toBe(0.6); // 300 / (300 + 200)
    expect(run.totals.costUSD.total).toBe(0.75);
    expect(Object.keys(run.totals.costUSD.byModel)).toEqual([
      'alpha-model',
      'zeta-model',
    ]);
    expect(run.totals.codeChanges).toEqual({ linesAdded: 7, linesRemoved: 2 });
  });

  it('omits codeChanges entirely when no span reports code changes', () => {
    const run = normalize(rawRun([rawSpan({ id: 'root', kind: 'session' })]));
    expect(run.totals.codeChanges).toBeUndefined();
  });

  it('relativizes provenance and source files against baseDir with POSIX separators', () => {
    const raw = rawRun([
      rawSpan({
        id: 'root',
        kind: 'session',
        provenance: {
          file: 'D:\\work\\repo\\fixtures\\a\\session.jsonl',
          line: 1,
        },
      }),
    ]);
    raw.source.files = ['D:\\work\\repo\\fixtures\\a\\session.jsonl'];
    const run = normalize(raw, { baseDir: 'D:\\work\\repo' });
    expect(run.spans[0]?.provenance.file).toBe('fixtures/a/session.jsonl');
    expect(run.source.files).toEqual(['fixtures/a/session.jsonl']);
  });

  it('produces a stable run id and byte-identical output for the same input', () => {
    const make = () =>
      rawRun([
        rawSpan({
          id: 'root',
          kind: 'session',
          agent: { sessionId: 'sess-42' },
        }),
        rawSpan({ id: 'x', parentId: 'root' }),
      ]);
    const a = normalize(make());
    const b = normalize(make());
    expect(a.id).toMatch(/^run_[0-9a-f]{16}$/);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('handles an empty run with a warning and stays schema-valid', () => {
    const run = normalize(rawRun([]));
    expect(run.warnings?.some((w) => /no spans/.test(w.message))).toBe(true);
    expect(RunSchema.parse(run)).toBeTruthy();
  });

  it('normalizes the real claude-code fixture into a schema-valid, ordered run', async () => {
    const fixtureDir = fileURLToPath(
      new URL('../../../fixtures/claude-code/subagents', import.meta.url),
    );
    const candidates = await claudeCodeAdapter.detect([fixtureDir]);
    const candidate = candidates.find(
      (c) =>
        c.runRef.endsWith('72de75e7-d5ab-4c07-a381-6539f4e34e42.jsonl') &&
        !/[\\/]raw[\\/]/.test(c.runRef),
    );
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const raw = await claudeCodeAdapter.parse(candidate, { redact: false });
    const run = normalize(raw, { baseDir: fixtureDir });

    // schema-valid (validate:true already ran; parse again to be explicit)
    RunSchema.parse(run);
    // machine paths stripped
    expect(
      run.source.files.every((f) => !f.includes(':') && !f.includes('\\')),
    ).toBe(true);
    // chronologically ordered
    for (let i = 1; i < run.spans.length; i++) {
      const prev = run.spans[i - 1];
      const next = run.spans[i];
      if (!prev || !next) continue;
      expect(Date.parse(next.startedAt)).toBeGreaterThanOrEqual(
        Date.parse(prev.startedAt),
      );
    }
    // depth is consistent with parent links
    const byId = new Map(run.spans.map((s) => [s.id, s]));
    for (const s of run.spans) {
      if (s.parentId === null) expect(s.depth).toBe(0);
      else expect(s.depth).toBe((byId.get(s.parentId)?.depth ?? -2) + 1);
    }
    // totals reflect the fixture's preserved usage numbers
    expect(run.totals.counts.llmCalls).toBeGreaterThan(0);
    expect(run.totals.tokens.total).toBeGreaterThan(0);
    expect(run.totals.counts.subagents).toBeGreaterThanOrEqual(11);
    // determinism end-to-end
    const again = normalize(
      await claudeCodeAdapter.parse(candidate, { redact: false }),
      {
        baseDir: fixtureDir,
      },
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(run));
  }, 30_000);
});
