import { fileURLToPath } from 'node:url';
import { bundledPricing, diffRuns, type RunDiff } from '@runray/core';
import type { Run } from '@runray/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { worstRegressions } from './diff.js';
import { buildTraceFile } from './discover.js';
import { createProgram } from './program.js';

/**
 * `runray diff` e2e (run-diff 2.1): two real scrubbed fixture runs
 * through the REAL command — resolve by unique id prefix, human summary
 * with absolute + percent cost delta, `--json` printing the RunDiff shape
 * verbatim, and exit 3 on an ambiguous/missing ref.
 */

const fixturesDir = fileURLToPath(
  new URL('../../../fixtures/claude-code', import.meta.url),
);

// One shared parse — each command invocation below re-parses anyway (the
// test exercises commander wiring), but the baseline against which stdout is
// asserted is built from this copy
let cachedRuns: Run[] | undefined;
async function fixtureRuns(): Promise<Run[]> {
  if (cachedRuns) return cachedRuns;
  const res = await buildTraceFile({
    paths: [fixturesDir],
    redact: true,
    pricing: bundledPricing(),
    generatorVersion: '0.0.0-test',
  });
  cachedRuns = res.traceFile.runs;
  return cachedRuns;
}

async function runDiffCommand(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    chunks.push(`${args.join(' ')}\n`);
  });
  try {
    await createProgram().parseAsync(['node', 'runray', 'diff', ...argv]);
    return chunks.join('').trim();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('runray diff e2e', () => {
  it('diffs two golden runs: --json prints the RunDiff shape verbatim', {
    timeout: 30_000,
  }, async () => {
    const runs = await fixtureRuns();
    const [a, b] = [runs[0]?.id ?? '', runs[1]?.id ?? ''];
    const stdout = await runDiffCommand([a, b, fixturesDir, '--json']);
    const parsed = JSON.parse(stdout) as RunDiff;
    expect(parsed.a.id).toBe(a);
    expect(parsed.b.id).toBe(b);
    // verbatim: identical to calling the core module directly
    const direct = diffRuns(
      runs.find((r) => r.id === a) as Run,
      runs.find((r) => r.id === b) as Run,
    );
    expect(parsed).toEqual(JSON.parse(JSON.stringify(direct)));
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('human summary states absolute and percentage cost delta (spec)', {
    timeout: 30_000,
  }, async () => {
    const runs = await fixtureRuns();
    const withCost = runs.filter((r) => r.totals.costUSD.total > 0);
    expect(withCost.length).toBeGreaterThanOrEqual(2);
    const a = withCost[0] as Run;
    const b = withCost[1] as Run;
    const stdout = await runDiffCommand([a.id, b.id, fixturesDir]);
    expect(stdout).toContain(a.id);
    expect(stdout).toContain(b.id);
    // chips row: signed absolute dollars plus a percent on a nonzero base
    expect(stdout).toMatch(/cost\s+[+\-±]\$[\d.]+ \([+-]?\d+%\)/);
    expect(stdout).toMatch(/spans: \d+ matched · \d+ added · \d+ removed/);
    // unique-prefix resolution matches the export command's selectRun
    const prefixOut = await runDiffCommand([
      a.id.slice(0, 12),
      b.id.slice(0, 12),
      fixturesDir,
    ]);
    expect(prefixOut).toBe(stdout);
  });

  it('exits 3 with the runray list hint on a missing ref', {
    timeout: 30_000,
  }, async () => {
    const runs = await fixtureRuns();
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const stdout = await runDiffCommand([
        'run_does-not-exist',
        runs[0]?.id ?? '',
        fixturesDir,
      ]);
      expect(stdout).toBe('');
      expect(process.exitCode).toBe(3);
      expect(err.mock.calls.flat().join('')).toContain('runray list');
    } finally {
      err.mockRestore();
    }
  });

  it('exits 3 on an AMBIGUOUS ref (spec scenario), not just a missing one', {
    timeout: 30_000,
  }, async () => {
    const runs = await fixtureRuns();
    // every fixture id shares the `run_` prefix → ambiguous (>1 match)
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const stdout = await runDiffCommand([
        'run_',
        runs[0]?.id ?? '',
        fixturesDir,
      ]);
      expect(stdout).toBe('');
      expect(process.exitCode).toBe(3);
      expect(err.mock.calls.flat().join('')).toContain('runray list');
    } finally {
      err.mockRestore();
    }
  });

  it('worst regressions sort by pair cost delta, descending', () => {
    const pair = (id: string, deltaUSD: number) => ({
      aId: id,
      bId: id,
      kind: 'llm_call' as const,
      name: id,
      costUSD: { a: 1, b: 1 + deltaUSD, delta: deltaUSD, pct: deltaUSD },
      tokens: { a: 0, b: 0, delta: 0, pct: null },
      durationMs: { a: 0, b: 0, delta: 0, pct: null },
    });
    const diff = {
      alignment: {
        matched: [pair('small', 0.1), pair('big', 0.9), pair('down', -0.5)],
        added: [],
        removed: [],
        subtrees: [],
      },
    } as unknown as RunDiff;
    expect(worstRegressions(diff).map((r) => r.deltaUSD)).toEqual([0.9, 0.1]);
    expect(worstRegressions(diff).map((r) => r.label)).toEqual([
      'llm_call  big',
      'llm_call  small',
    ]);
  });
});
