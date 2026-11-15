import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run, TraceFile } from '@runray/schema';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { resetInMemoryState } from './onboarding-state.js';
import { createProgram } from './program.js';
import { codexFixtures } from './test-fixtures.js';
import { resolveExportTemplate, resolveUiDistDir } from './ui-dist.js';

/**
 * End-to-end smoke for Codex sessions through the commands a person runs
 * (add-codex-adapter 8.2): `runray view` and `runray export` over the
 * committed Codex fixtures, with and without `--redact`. Everything between
 * the argument list and the bytes served or written is the real code; the
 * one seam is below, and it changes nothing the command does.
 */

// `view` keeps its server to itself. The handle is taken on its way out of
// the real `startServer`, so each test can close what it started.
const servers = vi.hoisted(() => [] as Array<{ close(): Promise<void> }>);
vi.mock('./server.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./server.js')>();
  return {
    ...real,
    startServer: async (...args: Parameters<typeof real.startServer>) => {
      const server = await real.startServer(...args);
      servers.push(server);
      return server;
    },
  };
});

const fixturesDir = codexFixtures();
vi.setConfig({ testTimeout: 30_000 });

const scratchDirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'runray-codex-e2e-'));
  scratchDirs.push(dir);
  return dir;
};

let origXdg: string | undefined;
let stdout: string[];
beforeEach(() => {
  // a config home of its own: the commands read the price override and the
  // first-run state from it, and must find neither on any machine
  resetInMemoryState();
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = scratch();
  process.exitCode = undefined;
  stdout = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    stdout.push(args.join(' '));
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** Every prompt and output preview of the runs: the text a person typed or
 * a model wrote, which is what redaction exists to keep out. */
function previewsOf(runs: readonly Run[]): string[] {
  const out = new Set<string>();
  for (const run of runs) {
    for (const span of run.spans) {
      for (const text of [
        span.content?.promptPreview,
        span.content?.outputPreview,
      ]) {
        if (typeof text === 'string' && text !== '') out.add(text);
      }
    }
  }
  return [...out];
}

/** Every string anywhere in a value, keys excluded. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) stringsIn(item, out);
  }
  return out;
}

/** A string as the export writes it into the page (`injectGlobal`). */
const inPage = (text: string) =>
  JSON.stringify(text).slice(1, -1).replace(/</g, '\\u003c');

/** The trace a written report carries. */
function dataOf(html: string): TraceFile {
  // the tag the export adds; the app's own code names the global too
  const tag = '<script>window.__RUNRAY_DATA__=';
  const start = html.indexOf(tag);
  expect(start).toBeGreaterThan(-1);
  const from = start + tag.length;
  // `<` is escaped inside the payload, so the first tag end closes it
  const end = html.indexOf(';</script>', from);
  return JSON.parse(html.slice(from, end)) as TraceFile;
}

function expectCodexRuns(runs: readonly Run[]): void {
  expect(runs.length).toBeGreaterThan(0);
  for (const run of runs) {
    expect(run.source).toMatchObject({ tool: 'codex', format: 'codex-jsonl' });
  }
  // the reviewer fixture: its threads are subagents of the session
  expect(
    runs.some((run) =>
      run.spans.some(
        (span) => span.kind === 'subagent' && span.name === 'subagent:guardian',
      ),
    ),
  ).toBe(true);
  // commands are spans named by what ran them, with a classified program
  expect(
    runs.some((run) =>
      run.spans.some(
        (span) =>
          span.kind === 'tool_call' &&
          typeof span.attributes?.['runray.tool'] === 'string',
      ),
    ),
  ).toBe(true);
}

/** Runs `runray view` on the fixtures and returns where it is served. */
async function view(...flags: string[]): Promise<string> {
  // a test may start two: the address read below is this one's
  stdout.length = 0;
  await createProgram().parseAsync([
    'node',
    'runray',
    'view',
    fixturesDir,
    '--no-open',
    '--port',
    '4390',
    ...flags,
  ]);
  expect(process.exitCode).toBeUndefined();
  const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout.join('\n'))?.[0];
  if (url === undefined) throw new Error('view printed no address');
  return url;
}

async function traceFileAt(url: string): Promise<TraceFile> {
  const res = await fetch(new URL('/api/tracefile', url));
  expect(res.status).toBe(200);
  return (await res.json()) as TraceFile;
}

/** The transcript slice of the first call the model made in the first run
 * that has one. */
async function sliceAt(url: string, data: TraceFile): Promise<unknown> {
  for (const run of data.runs) {
    const span = run.spans.find(
      (s) => s.kind === 'llm_call' && s.provenance?.file !== undefined,
    );
    if (span === undefined) continue;
    const res = await fetch(
      new URL(
        `/api/transcript?run=${encodeURIComponent(run.id)}&span=${encodeURIComponent(span.id)}`,
        url,
      ),
    );
    expect(res.status).toBe(200);
    return await res.json();
  }
  throw new Error('no llm_call with a provenance file');
}

describe('runray view on Codex sessions', () => {
  it('serves the sessions with their text, and a transcript slice', async () => {
    const url = await view();
    expect(stdout.join('\n')).toMatch(/RunRay viewing [1-9]\d* run\(s\) at /);

    const home = await fetch(url);
    expect(home.status).toBe(200);
    if (resolveUiDistDir() !== undefined) {
      expect(await home.text()).toContain('<div id="root">');
    }

    const data = await traceFileAt(url);
    expectCodexRuns(data.runs);
    expect(previewsOf(data.runs).length).toBeGreaterThan(0);
    expect(await sliceAt(url, data)).toMatchObject({ status: 'ok' });
  });

  it('--redact serves the same sessions with no text, and no slice', async () => {
    const plain = await traceFileAt(await view());
    const previews = previewsOf(plain.runs);
    expect(previews.length).toBeGreaterThan(0);

    const url = await view('--redact');
    const data = await traceFileAt(url);
    expectCodexRuns(data.runs);
    expect(data.runs.map((run) => run.id)).toEqual(
      plain.runs.map((run) => run.id),
    );
    expect(data.runs.map((run) => run.spans.length)).toEqual(
      plain.runs.map((run) => run.spans.length),
    );
    expect(previewsOf(data.runs)).toEqual([]);
    const served = stringsIn(data);
    for (const preview of previews) {
      expect(served.some((text) => text.includes(preview))).toBe(false);
    }
    for (const run of data.runs) {
      expect(run.title).toBeUndefined();
      for (const span of run.spans) {
        expect(span.attributes?.['runray.target']).toBeUndefined();
      }
    }
    expect(await sliceAt(url, data)).toMatchObject({ status: 'redacted' });
  });
});

describe.skipIf(resolveExportTemplate() === undefined)(
  'runray export on Codex sessions',
  () => {
    /** Runs `runray export` on the fixtures; returns the page and the
     * trace written beside it. */
    async function exported(
      ...flags: string[]
    ): Promise<{ html: string; json: string; data: TraceFile }> {
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
        ...flags,
      ]);
      expect(process.exitCode).toBeUndefined();
      const json = readFileSync(jsonOut, 'utf8');
      return {
        html: readFileSync(out, 'utf8'),
        json,
        data: JSON.parse(json) as TraceFile,
      };
    }

    it('writes one self-contained page that holds the sessions and their text', async () => {
      const { html, data } = await exported('--yes');
      expect(html).not.toMatch(/<script[^>]+src=/);
      expect(html).not.toMatch(/<link[^>]+href=/);
      expectCodexRuns(data.runs);
      // the page carries what the JSON beside it does
      expect(dataOf(html).runs).toEqual(data.runs);

      const previews = previewsOf(data.runs);
      expect(previews.length).toBeGreaterThan(0);
      for (const preview of previews) {
        expect(html).toContain(inPage(preview));
      }
    });

    it('--redact writes a page with no string from the unredacted previews', async () => {
      const plain = await exported('--yes');
      const previews = previewsOf(plain.data.runs);
      expect(previews.length).toBeGreaterThan(0);

      const { html, json, data } = await exported('--redact');
      expectCodexRuns(data.runs);
      expect(data.runs.map((run) => run.id)).toEqual(
        plain.data.runs.map((run) => run.id),
      );
      expect(dataOf(html).runs).toEqual(data.runs);
      expect(previewsOf(data.runs)).toEqual([]);

      // neither file holds a preview: as written, as JSON escapes it, as
      // the page escapes it, or inside any longer string of the trace
      const written = stringsIn(data);
      for (const preview of previews) {
        for (const form of [preview, inPage(preview)]) {
          expect(html).not.toContain(form);
          expect(json).not.toContain(form);
        }
        expect(written.some((text) => text.includes(preview))).toBe(false);
      }
      for (const run of data.runs) {
        expect(run.title).toBeUndefined();
        for (const span of run.spans) {
          expect(span.attributes?.['runray.target']).toBeUndefined();
        }
      }
    });
  },
);
