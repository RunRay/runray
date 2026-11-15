import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

// Where the commands look for what a person keeps: `runray.config.json`
// and the price override under the home directory, the first-run state
// under the config home.
const HOME_VARIABLES = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME'] as const;
const origHome = new Map<string, string | undefined>();
let stdout: string[];
let stderr: string[];
beforeEach(() => {
  // a home of its own: a config that turns redaction on, a port, a price
  // override or a first run already seen must not reach these commands
  resetInMemoryState();
  const home = scratch();
  for (const name of HOME_VARIABLES) {
    origHome.set(name, process.env[name]);
    process.env[name] = home;
  }
  expect(homedir()).toBe(home);
  process.exitCode = undefined;
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    stdout.push(args.join(' '));
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const [name, value] of origHome) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** The command read every session it found: a candidate that fails to
 * parse is skipped with a warning, and the rest would still be served. */
function expectNothingSkipped(): void {
  expect(process.exitCode).toBeUndefined();
  expect(stderr.join('')).not.toContain('warning: skipped');
}
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

/** A string as JSON writes it. */
const inJson = (text: string) => JSON.stringify(text).slice(1, -1);

/** A string as the export writes it into the page (`injectGlobal`). */
const inPage = (text: string) => inJson(text).replace(/</g, '\\u003c');

/**
 * Attributes whose value is free text of the session (a file's basename, a
 * script's or a skill's name) and not an id from a fixed list in core. They
 * are stamped only without redaction.
 */
const FREE_TEXT_ATTRIBUTES = [
  'runray.target',
  'runray.toolName',
  'runray.toolScript',
  'runray.skill',
];

/** The free-text attributes the runs carry, as `key` strings. */
function freeTextKeysOf(runs: readonly Run[]): string[] {
  const out = new Set<string>();
  for (const run of runs) {
    for (const span of run.spans) {
      for (const key of FREE_TEXT_ATTRIBUTES) {
        if (span.attributes?.[key] !== undefined) out.add(key);
      }
    }
  }
  return [...out].sort();
}

/** A redacted trace holds none of what the unredacted one shows of the
 * session's text: no preview, no title, no free-text attribute, and no
 * preview inside any longer string. */
function expectNoText(data: TraceFile, previews: readonly string[]): void {
  expect(previewsOf(data.runs)).toEqual([]);
  expect(freeTextKeysOf(data.runs)).toEqual([]);
  for (const run of data.runs) expect(run.title).toBeUndefined();
  const strings = stringsIn(data);
  for (const preview of previews) {
    expect(strings.some((text) => text.includes(preview))).toBe(false);
  }
}

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
  expectNothingSkipped();
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
    expect(freeTextKeysOf(data.runs)).toContain('runray.target');
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
    expectNoText(data, previews);
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
      expectNothingSkipped();
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
      expectNoText(data, previews);

      // and neither file holds a preview as text: as it is, as JSON
      // escapes it, or as the page escapes it. The page is also the app,
      // so a preview short enough to be a word of the app's own code is
      // looked for in the trace alone (above), not in the page.
      const template = readFileSync(resolveExportTemplate() ?? '', 'utf8');
      for (const preview of previews) {
        for (const form of [preview, inJson(preview), inPage(preview)]) {
          expect(json).not.toContain(form);
          if (!template.includes(form)) expect(html).not.toContain(form);
        }
      }
    });
  },
);
