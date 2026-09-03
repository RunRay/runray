import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run, Span, TraceFile } from '@runray/schema';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  abbreviateHome,
  buildTraceFile,
  classifyRoot,
  collapseDuplicateRunIds,
  formatNoDataHints,
  parseSince,
  reportUnpricedCoverage,
  resolveScanRoots,
  type ScannedRoot,
} from './discover.js';

describe('parseSince', () => {
  it.each([
    ['7d', 7 * 86_400_000],
    ['24h', 24 * 3_600_000],
    ['30m', 30 * 60_000],
  ])('%s → %d ms', (input, expected) => {
    expect(parseSince(input)).toBe(expected);
  });

  it('rejects malformed values', () => {
    expect(() => parseSince('7w')).toThrow(/invalid --since/);
    expect(() => parseSince('abc')).toThrow(/invalid --since/);
  });
});

describe('collapseDuplicateRunIds', () => {
  const mk = (id: string, file: string): Run =>
    ({
      id,
      source: { tool: 'opencode', format: 'opencode-storage', files: [file] },
      startedAt: '2026-07-02T13:00:00Z',
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
    }) as Run;

  it('keeps one run per id (first in caller order), leaving unique ids intact', () => {
    // one session captured three storage ways → same id three times
    const runs = [
      mk('run_dup', 'a/export.json'),
      mk('run_dup', 'b/storage'),
      mk('run_dup', 'c/db'),
      mk('run_other', 'd/db'),
    ];
    const out = collapseDuplicateRunIds(runs);
    expect(out.map((r) => r.id)).toEqual(['run_dup', 'run_other']);
    expect(out[0]?.source.files).toEqual(['a/export.json']); // first survives
  });
});

describe('buildTraceFile', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'runray-cli-'));
    const proj = join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 'cli-sess',
        timestamp: '2026-07-02T13:00:00Z',
        cwd: '/home/user/project/x',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 'cli-sess',
        timestamp: '2026-07-02T13:00:05Z',
        message: {
          id: 'm1',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
          content: [{ type: 'text', text: 'hi' }],
        },
      },
    ];
    writeFileSync(
      join(proj, 'cli-sess.jsonl'),
      `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds a TraceFile with priced, insight-bearing runs, newest first', async () => {
    const { traceFile, candidatesScanned } = await buildTraceFile({
      paths: [dir],
      redact: false,
      generatorVersion: '0.1.0',
    });
    expect(candidatesScanned).toBe(1);
    expect(traceFile.schemaVersion).toBe('0.1.0');
    expect(traceFile.generator).toEqual({
      name: 'runray',
      version: '0.1.0',
    });
    expect(traceFile.runs).toHaveLength(1);
    const run = traceFile.runs[0];
    expect(run?.totals.costUSD.total).toBeGreaterThan(0); // priced via snapshot
    expect(run?.insights).toEqual([]); // clean run — no findings
  });

  it('filters by --source', async () => {
    const claude = await buildTraceFile({
      paths: [dir],
      source: 'claude',
      redact: false,
      generatorVersion: '0.1.0',
    });
    expect(claude.traceFile.runs).toHaveLength(1);
    await expect(
      buildTraceFile({
        paths: [dir],
        source: 'nonsense',
        redact: false,
        generatorVersion: '0',
      }),
    ).rejects.toThrow(/unknown --source/);
  });

  it('filters by --since using file mtime', async () => {
    const recent = await buildTraceFile({
      paths: [dir],
      sinceMs: parseSince('7d'),
      redact: false,
      generatorVersion: '0.1.0',
    });
    expect(recent.traceFile.runs).toHaveLength(1); // file written moments ago

    const past = await buildTraceFile({
      paths: [dir],
      sinceMs: 1, // 1 ms window — everything is older
      redact: false,
      generatorVersion: '0.1.0',
    });
    expect(past.traceFile.runs).toHaveLength(0);
    expect(past.candidatesScanned).toBe(1); // still cheap-scanned, never parsed
  });

  it('propagates --redact into the core pipeline', async () => {
    const { traceFile } = await buildTraceFile({
      paths: [dir],
      redact: true,
      generatorVersion: '0.1.0',
    });
    for (const span of traceFile.runs[0]?.spans ?? []) {
      for (const value of Object.values(span.content ?? {}))
        expect(value).toBeNull();
    }
  });

  it('honours a user pricing override (pricing --refresh must have effect)', async () => {
    const absurd = {
      snapshotDate: '2026-07-07',
      source: 'litellm-snapshot' as const,
      aliases: {},
      entries: [
        {
          modelPattern: 'claude-sonnet-4-6',
          inputPerMTok: 1_000_000, // $1 per token — unmistakable in totals
          outputPerMTok: 0,
          cacheReadPerMTok: 0,
          cacheWritePerMTok: 0,
        },
      ],
    };
    const { traceFile } = await buildTraceFile({
      paths: [dir],
      redact: false,
      pricing: absurd,
      generatorVersion: '0.1.0',
    });
    expect(traceFile.runs[0]?.totals.costUSD.total).toBe(100); // 100 input tokens × $1
  });

  it('returns zero runs for an empty directory (CLI exits 3)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'runray-empty-'));
    const result = await buildTraceFile({
      paths: [empty],
      redact: false,
      generatorVersion: '0',
    });
    expect(result.traceFile.runs).toHaveLength(0);
    expect(result.errors).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it('one unparseable candidate does not kill the other runs', async () => {
    // an unreadable opencode.db beside a healthy claude-code session: the db
    // surfaces its clear, actionable error; discovery still returns the run
    writeFileSync(join(dir, 'opencode.db'), 'garbage, not a sqlite database');
    try {
      const result = await buildTraceFile({
        paths: [dir],
        redact: false,
        generatorVersion: '0.1.0',
      });
      expect(result.traceFile.runs).toHaveLength(1); // the claude-code run
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toMatch(
        /read-only.*never modified or locked/s,
      );
    } finally {
      rmSync(join(dir, 'opencode.db'), { force: true });
    }
  });
});

describe('reportUnpricedCoverage', () => {
  const runShell = (spans: Run['spans']): Run => ({
    id: 'run_x',
    source: { tool: 'claude-code', format: 'claude-jsonl', files: ['x'] },
    startedAt: '2026-07-02T13:00:00Z',
    spans,
    totals: {
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 0,
      },
      costUSD: { total: 0, wastedEstimate: 0, byModel: {} },
      counts: {
        llmCalls: spans.length,
        toolCalls: 0,
        toolErrors: 0,
        subagents: 0,
        maxDepth: 1,
      },
      cache: { hitRate: 0 },
    },
    insights: [],
  });
  const llmSpan = (id: string, model: string, unknownCost: boolean): Span => ({
    id,
    parentId: null,
    kind: 'llm_call',
    name: model,
    status: 'ok',
    startedAt: '2026-07-02T13:00:00Z',
    depth: 0,
    attributes: {},
    provenance: { file: 'x' },
    llm: {
      provider: 'anthropic',
      model,
      tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
      ...(unknownCost ? {} : { costUSD: 0.1 }),
      costSource: unknownCost ? 'unknown' : 'computed',
    },
  });
  const tf = (runs: Run[]): TraceFile => ({
    schemaVersion: '0.1.0',
    generator: { name: 'runray', version: 't' },
    generatedAt: '2026-07-02T14:00:00Z',
    runs,
  });

  it('writes ONE stderr warning naming models; stdout stays clean', () => {
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      reportUnpricedCoverage(
        tf([
          runShell([
            llmSpan('a', 'zz-mystery', true),
            llmSpan('b', 'aa-mystery', true),
          ]),
          runShell([llmSpan('c', 'zz-mystery', true)]),
        ]),
      );
      expect(spy).toHaveBeenCalledTimes(2);
      const msg = String(spy.mock.calls[0]?.[0]);
      expect(msg).toContain('3 llm call(s) across 2 run(s)');
      expect(msg).toContain('aa-mystery, zz-mystery');
      expect(msg).toContain('pricing --refresh');
      const framing = String(spy.mock.calls[1]?.[0]);
      expect(framing).toContain('Unpriced models are listed, never guessed');
      expect(outSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      outSpy.mockRestore();
    }
  });

  it('stays silent when every run is fully priced', () => {
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      reportUnpricedCoverage(tf([runShell([llmSpan('a', 'm', false)])]));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('resolveScanRoots', () => {
  it('returns default roots without checking existence', () => {
    const roots = resolveScanRoots([]);
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.some((r) => r.includes('.claude'))).toBe(true);
    expect(roots.some((r) => r.includes('opencode'))).toBe(true);
  });

  it('honours --source', () => {
    const roots = resolveScanRoots([], 'claude');
    expect(roots.length).toBe(1);
    expect(roots[0]).toContain('.claude');
  });

  it('returns explicit paths verbatim', () => {
    expect(resolveScanRoots(['/custom/path'])).toEqual(['/custom/path']);
  });
});

describe('classifyRoot', () => {
  it('classifies non-existent path as missing', () => {
    expect(classifyRoot('/nonexistent/path/for/test')).toBe('missing');
  });

  it('classifies existing directory as empty when accessible', () => {
    const d = mkdtempSync(join(tmpdir(), 'runray-classify-'));
    try {
      expect(classifyRoot(d)).toBe('empty');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('classifies a non-existent explicit path as missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'runray-classify-'));
    const missing = join(d, 'does-not-exist');
    expect(classifyRoot(missing)).toBe('missing');
    rmSync(d, { recursive: true, force: true });
  });
});

describe('abbreviateHome', () => {
  it('abbreviates home directory', () => {
    expect(abbreviateHome('/home/user/project', '/home/user')).toBe(
      '~/project',
    );
    expect(abbreviateHome('/home/user', '/home/user')).toBe('~');
    expect(abbreviateHome('/other/path', '/home/user')).toBe('/other/path');
  });
});

describe('formatNoDataHints', () => {
  const home = '/Users/testuser';

  function check80ColAndNoColor(text: string) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence check
    expect(text).not.toMatch(/\x1b\[/); // no ANSI color codes
    for (const line of text.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  }

  it('scenario 1: both missing', () => {
    const roots: ScannedRoot[] = [
      { path: '/Users/testuser/.claude/projects', verdict: 'missing' },
      { path: '/Users/testuser/.local/share/opencode', verdict: 'missing' },
    ];
    const out = formatNoDataHints(roots, { homeDir: home });
    check80ColAndNoColor(out);
    expect(out).toMatchInlineSnapshot(`
      "No agent sessions found.

      Checked:
        ~/.claude/projects                                    missing
        ~/.local/share/opencode                               missing

      RunRay reads logs coding agents already write — there is nothing to set
      up. Two ways forward:

        Run any agent session once, then:   runray view
        Logs live somewhere else:           runray view <path>

      Never run an agent here? See it on a sample session:  runray demo
      "
    `);
  });

  it('scenario 2: one empty', () => {
    const roots: ScannedRoot[] = [
      { path: '/Users/testuser/.claude/projects', verdict: 'empty' },
      { path: '/Users/testuser/.local/share/opencode', verdict: 'missing' },
    ];
    const out = formatNoDataHints(roots, { homeDir: home });
    check80ColAndNoColor(out);
    expect(out).toMatchInlineSnapshot(`
      "No agent sessions found.

      Checked:
        ~/.claude/projects                                    empty
        ~/.local/share/opencode                               missing

      RunRay reads logs coding agents already write — there is nothing to set
      up. Two ways forward:

        Run any agent session once, then:   runray view
        Logs live somewhere else:           runray view <path>

      Never run an agent here? See it on a sample session:  runray demo
      "
    `);
  });

  it('scenario 3: one unreadable', () => {
    const roots: ScannedRoot[] = [
      { path: '/Users/testuser/.claude/projects', verdict: 'unreadable' },
      { path: '/Users/testuser/.local/share/opencode', verdict: 'missing' },
    ];
    const out = formatNoDataHints(roots, { homeDir: home });
    check80ColAndNoColor(out);
    expect(out).toMatchInlineSnapshot(`
      "No agent sessions found.

      Checked:
        ~/.claude/projects                                    unreadable
        ~/.local/share/opencode                               missing
      One location could not be read — check permissions, or pass the folder directly.

      RunRay reads logs coding agents already write — there is nothing to set
      up. Two ways forward:

        Run any agent session once, then:   runray view
        Logs live somewhere else:           runray view <path>

      Never run an agent here? See it on a sample session:  runray demo
      "
    `);
  });

  it('scenario 4: --source narrowed', () => {
    const roots: ScannedRoot[] = [
      { path: '/Users/testuser/.claude/projects', verdict: 'missing' },
    ];
    const out = formatNoDataHints(roots, { homeDir: home, source: 'claude' });
    check80ColAndNoColor(out);
    expect(out).toMatchInlineSnapshot(`
      "No agent sessions found.

      Checked:
        ~/.claude/projects                                    missing
      (scan limited to --source claude)

      RunRay reads logs coding agents already write — there is nothing to set
      up. Two ways forward:

        Run any agent session once, then:   runray view
        Logs live somewhere else:           runray view <path>

      Never run an agent here? See it on a sample session:  runray demo
      "
    `);
  });

  it('scenario 5: explicit path supplied', () => {
    const roots: ScannedRoot[] = [
      { path: '/tmp/my-custom-logs', verdict: 'missing' },
    ];
    const out = formatNoDataHints(roots, { homeDir: home });
    check80ColAndNoColor(out);
    expect(out).toMatchInlineSnapshot(`
      "No agent sessions found.

      Checked:
        /tmp/my-custom-logs                                   missing

      RunRay reads logs coding agents already write — there is nothing to set
      up. Two ways forward:

        Run any agent session once, then:   runray view
        Logs live somewhere else:           runray view <path>

      Never run an agent here? See it on a sample session:  runray demo
      "
    `);
  });
});

describe('buildTraceFile sanitization pipeline (1.7)', () => {
  const fixturePath = fileURLToPath(
    new URL('../../../fixtures/claude-code', import.meta.url),
  );

  it('applies sanitized profile: scrubs paths and redacts prompt text', async () => {
    const result = await buildTraceFile({
      paths: [fixturePath],
      redact: false,
      profile: 'sanitized',
      generatorVersion: '0.1.0-test',
    });

    expect(result.traceFile.runs.length).toBeGreaterThan(0);
    const run = result.traceFile.runs[0];
    expect(run).toBeDefined();
    if (!run) return;
    expect(run.project?.path).toMatch(/^project-\d+$/);
    expect(run.project?.name).toMatch(/^project-\d+$/);
    expect(run.source.files[0]).toMatch(/^transcript-\d+$/);
    expect(run.title).toBeUndefined();
    // Spans have scrubbed provenance and no prompt text
    for (const span of run.spans) {
      expect(span.provenance.file).toMatch(/^transcript-\d+$/);
      if (span.content) {
        for (const val of Object.values(span.content)) {
          expect(val).toBeNull();
        }
      }
    }
  });

  it('applies metadata-only profile: prunes to session/subagent and re-anchors evidence', async () => {
    const result = await buildTraceFile({
      paths: [fixturePath],
      redact: false,
      profile: 'metadata-only',
      generatorVersion: '0.1.0-test',
    });

    expect(result.traceFile.runs.length).toBeGreaterThan(0);
    const run = result.traceFile.runs[0];
    expect(run).toBeDefined();
    if (!run) return;
    for (const span of run.spans) {
      expect(['session', 'subagent']).toContain(span.kind);
    }
  });
});
