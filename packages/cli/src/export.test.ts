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
import { findPathShapes } from '@runray/core';
import type { TraceFile } from '@runray/schema';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildTraceFile } from './discover.js';
import {
  exportConsent,
  injectGlobal,
  injectTraceData,
  resolveExportSanitization,
  selectRun,
} from './export.js';
import { createProgram } from './program.js';
import { resolveExportTemplate } from './ui-dist.js';

const TEMPLATE =
  '<!doctype html><html><head><title>t</title></head><body></body></html>';

// Hostile strings a prompt could contain: script breakout, comment breakout,
// `$&`-style replacement patterns, and U+2028/U+2029 line terminators.
const hostile: TraceFile = {
  schemaVersion: '0.1.0',
  generator: {
    name: "</script><!--<script>$&$'\u2028\u2029",
    version: '0.0.0-test',
  },
  generatedAt: '2026-07-02T13:00:00Z',
  runs: [],
};

describe('resolveExportSanitization (cli "Export sanitization flags")', () => {
  it.each([
    {
      name: 'defaults with no flags or config',
      opts: {},
      config: undefined,
      want: {
        stripText: false,
        scrubIdentity: false,
        pruneSpans: false,
        profile: 'full',
        manifest: {
          profile: 'full',
          textRedacted: false,
          pathsScrubbed: false,
          spansPruned: false,
        },
      },
    },
    {
      name: '--redact strips text, keeps identity, profile is full',
      opts: { redact: true },
      config: undefined,
      want: {
        stripText: true,
        scrubIdentity: false,
        pruneSpans: false,
        profile: 'full',
        manifest: {
          profile: 'full',
          textRedacted: true,
          pathsScrubbed: false,
          spansPruned: false,
        },
      },
    },
    {
      name: '--redact-prompts alias behaves identically to --redact',
      opts: { redactPrompts: true },
      config: undefined,
      want: {
        stripText: true,
        scrubIdentity: false,
        pruneSpans: false,
        profile: 'full',
        manifest: {
          profile: 'full',
          textRedacted: true,
          pathsScrubbed: false,
          spansPruned: false,
        },
      },
    },
    {
      name: '--scrub-paths scrubs identity, keeps text, profile is full',
      opts: { scrubPaths: true },
      config: undefined,
      want: {
        stripText: false,
        scrubIdentity: true,
        pruneSpans: false,
        profile: 'full',
        manifest: {
          profile: 'full',
          textRedacted: false,
          pathsScrubbed: true,
          spansPruned: false,
        },
      },
    },
    {
      name: '--anonymize sets both stripText and scrubIdentity -> sanitized',
      opts: { anonymize: true },
      config: undefined,
      want: {
        stripText: true,
        scrubIdentity: true,
        pruneSpans: false,
        profile: 'sanitized',
        manifest: {
          profile: 'sanitized',
          textRedacted: true,
          pathsScrubbed: true,
          spansPruned: false,
        },
      },
    },
    {
      name: '--redact + --scrub-paths composite -> sanitized',
      opts: { redact: true, scrubPaths: true },
      config: undefined,
      want: {
        stripText: true,
        scrubIdentity: true,
        pruneSpans: false,
        profile: 'sanitized',
        manifest: {
          profile: 'sanitized',
          textRedacted: true,
          pathsScrubbed: true,
          spansPruned: false,
        },
      },
    },
    {
      name: '--metadata-only implies stripText, scrubIdentity, and pruneSpans -> metadata-only',
      opts: { metadataOnly: true },
      config: undefined,
      want: {
        stripText: true,
        scrubIdentity: true,
        pruneSpans: true,
        profile: 'metadata-only',
        manifest: {
          profile: 'metadata-only',
          textRedacted: true,
          pathsScrubbed: true,
          spansPruned: true,
        },
      },
    },
    {
      name: 'redundant flags compose without error',
      opts: {
        metadataOnly: true,
        anonymize: true,
        redact: true,
        scrubPaths: true,
      },
      config: undefined,
      want: {
        stripText: true,
        scrubIdentity: true,
        pruneSpans: true,
        profile: 'metadata-only',
        manifest: {
          profile: 'metadata-only',
          textRedacted: true,
          pathsScrubbed: true,
          spansPruned: true,
        },
      },
    },
    {
      name: 'config.redact: true strips text when no flags passed',
      opts: {},
      config: { redact: true },
      want: {
        stripText: true,
        scrubIdentity: false,
        pruneSpans: false,
        profile: 'full',
        manifest: {
          profile: 'full',
          textRedacted: true,
          pathsScrubbed: false,
          spansPruned: false,
        },
      },
    },
    {
      name: 'config.redact: true with --scrub-paths resolves to sanitized',
      opts: { scrubPaths: true },
      config: { redact: true },
      want: {
        stripText: true,
        scrubIdentity: true,
        pruneSpans: false,
        profile: 'sanitized',
        manifest: {
          profile: 'sanitized',
          textRedacted: true,
          pathsScrubbed: true,
          spansPruned: false,
        },
      },
    },
  ])('$name', ({ opts, config, want }) => {
    expect(resolveExportSanitization(opts, config)).toEqual(want);
  });
});

describe('injectTraceData', () => {
  it('injects into <head>, escapes every angle bracket and line terminators, round-trips', () => {
    const html = injectTraceData(TEMPLATE, hostile);
    const start = html.indexOf('__RUNRAY_DATA__=') + '__RUNRAY_DATA__='.length;
    const end = html.indexOf(';</script></head>');
    expect(start).toBeGreaterThan('__RUNRAY_DATA__='.length);
    expect(end).toBeGreaterThan(start);
    const payload = html.slice(start, end);
    expect(payload).not.toContain('<'); // nothing can close the script element
    expect(payload).not.toContain('\u2028'); // line separator escaped
    expect(payload).not.toContain('\u2029'); // paragraph separator escaped
    expect(JSON.parse(payload)).toEqual(hostile); // `$&` and unicode separators survived the replace
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

describe('export command (privacy guard & consent)', () => {
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

  it('scrubbing paths alone does NOT satisfy the consent guard without --yes', async () => {
    const out = join(scratch(), 'report.html');
    await createProgram().parseAsync([
      'node',
      'runray',
      'export',
      fixturesDir,
      '-o',
      out,
      '--scrub-paths',
    ]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('--anonymize never prompts and satisfies the consent guard', async () => {
    const out = join(scratch(), 'report.html');
    await createProgram().parseAsync([
      'node',
      'runray',
      'export',
      fixturesDir,
      '-o',
      out,
      '--anonymize',
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(out)).toBe(true);
  });

  it('--metadata-only satisfies the consent guard', async () => {
    const out = join(scratch(), 'report.html');
    await createProgram().parseAsync([
      'node',
      'runray',
      'export',
      fixturesDir,
      '-o',
      out,
      '--metadata-only',
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(out)).toBe(true);
  });

  it('--redact-prompts satisfies the consent guard', async () => {
    const out = join(scratch(), 'report.html');
    await createProgram().parseAsync([
      'node',
      'runray',
      'export',
      fixturesDir,
      '-o',
      out,
      '--redact-prompts',
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(out)).toBe(true);
  });
});

describe('export --help text documentation (Task 3.3)', () => {
  it('documents every sanitization flag and the alias', () => {
    const program = createProgram();
    const exportCmd = program.commands.find((c) => c.name() === 'export');
    expect(exportCmd).toBeDefined();
    const help = exportCmd?.helpInformation() ?? '';
    expect(help).toContain('--redact');
    expect(help).toContain('--redact-prompts');
    expect(help).toContain('--scrub-paths');
    expect(help).toContain('--anonymize');
    expect(help).toContain('--metadata-only');
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

    it('reports applied profile on stderr and keeps stdout clean (Task 3.3)', async () => {
      const dir = scratch();
      const out = join(dir, 'report-meta.html');
      const stderrLines: string[] = [];
      const stdoutLines: string[] = [];
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk) => {
          stderrLines.push(String(chunk));
          return true;
        });
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk) => {
          stdoutLines.push(String(chunk));
          return true;
        });
      try {
        await createProgram().parseAsync([
          'node',
          'runray',
          'export',
          fixturesDir,
          '-o',
          out,
          '--metadata-only',
        ]);
      } finally {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
      }
      expect(process.exitCode).toBeUndefined();
      expect(stdoutLines.join('')).toBe('');
      const errOut = stderrLines.join('');
      expect(errOut).toContain('profile: metadata-only');
    });

    it('injects manifest into __RUNRAY_VIEW_CONFIG__ without local pricing path (Task 3.4)', async () => {
      const dir = scratch();
      const out = join(dir, 'report-anon.html');
      await createProgram().parseAsync([
        'node',
        'runray',
        'export',
        fixturesDir,
        '-o',
        out,
        '--anonymize',
      ]);
      expect(process.exitCode).toBeUndefined();

      const html = readFileSync(out, 'utf8');
      expect(html).toContain('window.__RUNRAY_VIEW_CONFIG__=');
      const match = /window\.__RUNRAY_VIEW_CONFIG__=([^;]+);/.exec(html);
      expect(match).not.toBeNull();
      const viewConfig = JSON.parse(match?.[1] ?? '{}');
      expect(viewConfig.manifest).toEqual({
        profile: 'sanitized',
        textRedacted: true,
        pathsScrubbed: true,
        spansPruned: false,
      });

      // Pricing payload has origin and table but never a local path
      const pricingMatch = /window\.__RUNRAY_PRICING__=([^;]+);/.exec(html);
      expect(pricingMatch).not.toBeNull();
      const pricingPayload = JSON.parse(pricingMatch?.[1] ?? '{}');
      expect(pricingPayload.origin).toBeDefined();
      expect(pricingPayload.path).toBeUndefined();
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

    it('E2E export each profile: self-contained offline, manifest in view config, and sanitized bytes carry no path shape (Task 6.1)', async () => {
      const dir = scratch();
      const outFull = join(dir, 'full.html');
      const outSanitized = join(dir, 'sanitized.html');
      const outMeta = join(dir, 'metadata-only.html');

      await createProgram().parseAsync([
        'node',
        'runray',
        'export',
        fixturesDir,
        '-o',
        outFull,
        '--yes',
      ]);
      await createProgram().parseAsync([
        'node',
        'runray',
        'export',
        fixturesDir,
        '-o',
        outSanitized,
        '--anonymize',
      ]);
      await createProgram().parseAsync([
        'node',
        'runray',
        'export',
        fixturesDir,
        '-o',
        outMeta,
        '--metadata-only',
      ]);

      expect(existsSync(outFull)).toBe(true);
      expect(existsSync(outSanitized)).toBe(true);
      expect(existsSync(outMeta)).toBe(true);

      const htmlFull = readFileSync(outFull, 'utf8');
      const htmlSanitized = readFileSync(outSanitized, 'utf8');
      const htmlMeta = readFileSync(outMeta, 'utf8');

      // Manifests are injected and contain the exact profile
      const matchFull = /window\.__RUNRAY_VIEW_CONFIG__=([^;]+);/.exec(
        htmlFull,
      );
      const matchSanitized = /window\.__RUNRAY_VIEW_CONFIG__=([^;]+);/.exec(
        htmlSanitized,
      );
      const matchMeta = /window\.__RUNRAY_VIEW_CONFIG__=([^;]+);/.exec(
        htmlMeta,
      );

      expect(JSON.parse(matchFull?.[1] ?? '{}').manifest.profile).toBe('full');
      expect(JSON.parse(matchSanitized?.[1] ?? '{}').manifest.profile).toBe(
        'sanitized',
      );
      expect(JSON.parse(matchMeta?.[1] ?? '{}').manifest.profile).toBe(
        'metadata-only',
      );

      // Sanitized and metadata-only HTML bytes carry no path shape that the
      // export itself introduced. The shipped UI bundle is a constant and
      // carries no trace data, but its own copy may quote a path shape (the
      // Browser-pane playbook names a `file://` page), so shapes already
      // present in the pristine template are not the export's leak.
      const templateShapes = new Set(
        findPathShapes(readFileSync(resolveExportTemplate() ?? '', 'utf8')),
      );
      const introduced = (html: string) =>
        findPathShapes(html).filter((shape) => !templateShapes.has(shape));
      expect(introduced(htmlSanitized)).toEqual([]);
      expect(introduced(htmlMeta)).toEqual([]);
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

  it('stacks multiple globals in one head (data + pricing + view config)', () => {
    const withData = injectTraceData(template, {
      schemaVersion: '0.1.0',
      generator: { name: 'runray', version: 't' },
      generatedAt: '2026-07-02T14:00:00Z',
      runs: [],
    });
    const withPricing = injectGlobal(withData, '__RUNRAY_PRICING__', {
      origin: 'user',
    });
    const withAll = injectGlobal(withPricing, '__RUNRAY_VIEW_CONFIG__', {
      manifest: {
        profile: 'metadata-only',
        textRedacted: true,
        pathsScrubbed: true,
        spansPruned: true,
      },
    });
    expect(withAll).toContain('window.__RUNRAY_DATA__=');
    expect(withAll).toContain('window.__RUNRAY_PRICING__=');
    expect(withAll).toContain('window.__RUNRAY_VIEW_CONFIG__=');
    expect(withAll.indexOf('__RUNRAY_DATA__')).toBeLessThan(
      withAll.indexOf('__RUNRAY_PRICING__'),
    );
    expect(withAll.indexOf('__RUNRAY_PRICING__')).toBeLessThan(
      withAll.indexOf('__RUNRAY_VIEW_CONFIG__'),
    );
  });

  it('escapes U+2028 (line separator) and U+2029 (paragraph separator) and round-trips losslessly', () => {
    const payload = {
      prompt: 'line 1\u2028line 2\u2029paragraph 2',
      metadata: { note: '\u2028\u2029' },
    };
    const html = injectGlobal(template, '__RUNRAY_DATA__', payload);
    // Raw U+2028 and U+2029 should not be present in the script
    expect(html).not.toContain('\u2028');
    expect(html).not.toContain('\u2029');
    // Instead escaped unicode sequences should be present
    expect(html).toContain('\\u2028');
    expect(html).toContain('\\u2029');

    const start =
      html.indexOf('window.__RUNRAY_DATA__=') +
      'window.__RUNRAY_DATA__='.length;
    const end = html.indexOf(';</script>');
    const extracted = html.slice(start, end);
    expect(JSON.parse(extracted)).toEqual(payload);
  });
});
