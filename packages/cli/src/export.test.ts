import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TraceFile } from '@runray/schema';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildTraceFile } from './discover.js';
import {
  exportConsent,
  injectGlobal,
  injectTraceData,
  selectRun,
} from './export.js';
import { createProgram } from './program.js';
import { resolveExportTemplate } from './ui-dist.js';

const TEMPLATE =
  '<!doctype html><html><head><title>t</title></head><body></body></html>';

// Hostile strings a prompt could contain: script breakout, comment breakout,
// and `$&`-style replacement patterns.
const hostile: TraceFile = {
  schemaVersion: '0.1.0',
  generator: { name: "</script><!--<script>$&$'", version: '0.0.0-test' },
  generatedAt: '2026-07-02T13:00:00Z',
  runs: [],
};

describe('injectTraceData', () => {
  it('injects into <head>, escapes every angle bracket, round-trips', () => {
    const html = injectTraceData(TEMPLATE, hostile);
    const start = html.indexOf('__RUNRAY_DATA__=') + '__RUNRAY_DATA__='.length;
    const end = html.indexOf(';</script></head>');
    expect(start).toBeGreaterThan('__RUNRAY_DATA__='.length);
    expect(end).toBeGreaterThan(start);
    const payload = html.slice(start, end);
    expect(payload).not.toContain('<'); // nothing can close the script element
    expect(JSON.parse(payload)).toEqual(hostile); // `$&` survived the replace
  });

  it('throws on a template without <head>', () => {
    expect(() => injectTraceData('<html></html>', hostile)).toThrow(/template/);
  });
});

describe('exportConsent', () => {
  it.each([
    { redact: true, yes: false, interactive: false, want: 'proceed' },
    { redact: false, yes: true, interactive: false, want: 'proceed' },
    { redact: false, yes: false, interactive: true, want: 'ask' },
    { redact: false, yes: false, interactive: false, want: 'abort' },
  ])('redact=$redact yes=$yes interactive=$interactive -> $want', (c) => {
    expect(
      exportConsent({
        redact: c.redact,
        yes: c.yes,
        interactive: c.interactive,
      }),
    ).toBe(c.want);
  });
});

describe('selectRun', () => {
  // Only ids matter here; runs are not otherwise inspected.
  const withIds = (...ids: string[]) =>
    ({ ...hostile, runs: ids.map((id) => ({ id })) }) as unknown as TraceFile;

  it('matches exact id even when it prefixes another', () => {
    const tf = withIds('run_a', 'run_ab');
    expect(selectRun(tf, 'run_a')?.runs.map((r) => r.id)).toEqual(['run_a']);
  });

  it('matches a unique prefix', () => {
    const tf = withIds('run_abc', 'run_xyz');
    expect(selectRun(tf, 'run_ab')?.runs.map((r) => r.id)).toEqual(['run_abc']);
  });

  it('returns undefined for ambiguous or unknown ids', () => {
    const tf = withIds('run_abc', 'run_abd');
    expect(selectRun(tf, 'run_ab')).toBeUndefined();
    expect(selectRun(tf, 'nope')).toBeUndefined();
  });
});

const fixturesDir = fileURLToPath(
  new URL('../../../fixtures/claude-code', import.meta.url),
);
// runs the real export command over the full claude-code fixture tree —
// headroom over vitest's 5s default to avoid full-suite-load flakes
vi.setConfig({ testTimeout: 30_000 });
const scratchDirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'runray-export-'));
  scratchDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  process.exitCode = undefined; // export failures set it; keep vitest green
});

describe('export command (privacy guard)', () => {
  it('aborts an unredacted export without --yes when non-interactive', async () => {
    // vitest pipes stdio, so this is the cli spec's non-interactive scenario
    const out = join(scratch(), 'report.html');
    await createProgram().parseAsync([
      'node',
      'runray',
      'export',
      fixturesDir,
      '-o',
      out,
    ]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});

describe.skipIf(resolveExportTemplate() === undefined)(
  'export e2e (singlefile template)',
  () => {
    it('writes a self-contained redacted report via the real command', async () => {
      const dir = scratch();
      const out = join(dir, 'report.html');
      const jsonOut = join(dir, 'trace.json');
      await createProgram().parseAsync([
        'node',
        'runray',
        'export',
        fixturesDir,
        '-o',
        out,
        '--json',
        jsonOut,
        '--redact',
      ]);
      expect(process.exitCode).toBeUndefined();

      const html = readFileSync(out, 'utf8');
      // offline from file://: no external script/style/font references
      expect(html).not.toMatch(/<script[^>]+src=/);
      expect(html).not.toMatch(/<link[^>]+href=/);
      expect(html).toContain('window.__RUNRAY_DATA__=');

      const data = JSON.parse(readFileSync(jsonOut, 'utf8')) as TraceFile;
      expect(data.runs.length).toBeGreaterThan(0);
      expect(data.runs.some((run) => run.totals.counts.subagents > 0)).toBe(
        true,
      );
    });

    it('exports a single run when given a run id', async () => {
      const dir = scratch();
      const out = join(dir, 'one-run.html');
      const jsonOut = join(dir, 'one-run.json');
      // discover ids first, then export by id via configured roots
      const { traceFile } = await buildTraceFile({
        paths: [fixturesDir],
        redact: true,
        generatorVersion: 'e2e',
      });
      const id = traceFile.runs[0]?.id;
      expect(id).toBeDefined();
      const config = join(dir, 'runray.config.json');
      writeFileSync(config, JSON.stringify({ dataRoots: [fixturesDir] }));
      await createProgram().parseAsync([
        'node',
        'runray',
        '--config',
        config,
        'export',
        id ?? '',
        '-o',
        out,
        '--json',
        jsonOut,
        '--redact',
      ]);
      expect(process.exitCode).toBeUndefined();
      const data = JSON.parse(readFileSync(jsonOut, 'utf8')) as TraceFile;
      expect(data.runs.map((run) => run.id)).toEqual([id]);
    });
  },
);

describe('injectGlobal (X4)', () => {
  const template = '<html><head></head><body></body></html>';

  it('injects a named global with angle-bracket sanitization', () => {
    const html = injectGlobal(template, '__RUNRAY_PRICING__', {
      origin: 'bundled',
      note: '</script><!--',
    });
    expect(html).toContain('window.__RUNRAY_PRICING__=');
    expect(html).not.toContain('</script><!--');
    expect(html).toContain('\u003c/script>');
  });

  it('stacks multiple globals in one head (data + pricing)', () => {
    const withData = injectTraceData(template, {
      schemaVersion: '0.1.0',
      generator: { name: 'runray', version: 't' },
      generatedAt: '2026-07-02T14:00:00Z',
      runs: [],
    });
    const both = injectGlobal(withData, '__RUNRAY_PRICING__', {
      origin: 'user',
    });
    expect(both).toContain('window.__RUNRAY_DATA__=');
    expect(both).toContain('window.__RUNRAY_PRICING__=');
    expect(both.indexOf('__RUNRAY_DATA__')).toBeLessThan(
      both.indexOf('__RUNRAY_PRICING__'),
    );
  });
});
