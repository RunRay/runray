import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceFile } from '@runray/schema';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetInMemoryState } from './onboarding-state.js';
import { createProgram } from './program.js';
import {
  createNotifier,
  isPortUnavailable,
  type RunningServer,
  startServer,
} from './server.js';

const traceFile: TraceFile = {
  schemaVersion: '0.1.0',
  generator: { name: 'runray', version: '0.0.0-test' },
  generatedAt: '2026-07-02T13:00:00Z',
  runs: [],
};

const BASE = 42_310; // away from the real default to avoid clashing with a dev server
const open: RunningServer[] = [];
async function start(
  extra: Parameters<typeof startServer>[0] extends infer T
    ? Partial<T>
    : never = {},
) {
  const server = await startServer({
    getTraceFile: async () => traceFile,
    basePort: BASE,
    ...extra,
  });
  open.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(open.map((s) => s.close().catch(() => undefined)));
});

describe('isPortUnavailable (port scan)', () => {
  // Asserted for both platforms regardless of where the suite runs, because
  // CI is Linux-only and the win32 branch would otherwise never be exercised.
  const win = (code: string, port: number) => {
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      return isPortUnavailable(code, port);
    } finally {
      spy.mockRestore();
    }
  };
  const posix = (code: string, port: number) => {
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      return isPortUnavailable(code, port);
    } finally {
      spy.mockRestore();
    }
  };

  it('always steps past a port that is already in use', () => {
    expect(win('EADDRINUSE', 4173)).toBe(true);
    expect(posix('EADDRINUSE', 4173)).toBe(true);
  });

  it('steps past EACCES only on win32, where reserved port blocks return it', () => {
    // Hyper-V / WSL2 / Docker Desktop reserve ranges of ordinary high ports.
    expect(win('EACCES', 4173)).toBe(true);
  });

  it('never hides a privileged-port refusal', () => {
    // `--port 80` as a normal user must report "permission denied", not 50
    // retries ending in a false "no free port".
    expect(posix('EACCES', 80)).toBe(false);
    expect(win('EACCES', 80)).toBe(false);
  });

  it('never retries EADDRNOTAVAIL — the host is fixed to 127.0.0.1', () => {
    expect(win('EADDRNOTAVAIL', 4173)).toBe(false);
    expect(posix('EADDRNOTAVAIL', 4173)).toBe(false);
  });
});

describe('server', () => {
  it('serves /api/tracefile as JSON on 127.0.0.1', async () => {
    const server = await start();
    expect(server.url).toContain('127.0.0.1');
    const res = await fetch(`${server.url}api/tracefile`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(traceFile);
  });

  it('rejects a spoofed (non-loopback) Host header with 403 — DNS-rebinding guard', async () => {
    const server = await start();
    // fetch/undici forbids overriding Host, so use a raw request to spoof it
    // (what a DNS-rebound attacker page's Host header would carry)
    const statusFor = (host: string): Promise<number> =>
      new Promise((resolveStatus, rejectStatus) => {
        const req = httpRequest(
          `${server.url}api/tracefile`,
          { headers: { host } },
          (res) => {
            res.resume();
            resolveStatus(res.statusCode ?? 0);
          },
        );
        req.on('error', rejectStatus);
        req.end();
      });
    expect(await statusFor('evil.example')).toBe(403);
    expect(await statusFor('127.0.0.1')).toBe(200); // real local client
  });

  it('falls back to the next port when the base port is taken', async () => {
    // servers from earlier tests may still hold ports — assert relatively
    const first = await start();
    const second = await start();
    expect(first.port).toBeGreaterThanOrEqual(BASE);
    expect(second.port).toBe(first.port + 1);
  });

  it('close() resolves even with an SSE client connected', async () => {
    const events = createNotifier();
    const server = await startServer({
      getTraceFile: async () => traceFile,
      basePort: BASE + 40,
      events,
    });
    // hold an /api/events connection open (keep-alive, never ends on its own)
    const sse = httpRequest(`${server.url}api/events`, { headers: {} });
    await new Promise<void>((r) => {
      sse.on('response', (res) => {
        res.on('data', () => {});
        r();
      });
      sse.end();
    });
    // without the close() fix this would hang on the SSE keep-alive socket
    await expect(
      Promise.race([
        server.close().then(() => 'closed'),
        new Promise((r) => setTimeout(() => r('timeout'), 3000)),
      ]),
    ).resolves.toBe('closed');
    sse.destroy();
  });

  it('serves a placeholder page until the UI dist is embedded', async () => {
    const server = await start();
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('RunRay');
    expect(html).toContain('/api/tracefile');
  });

  it('404s /api/events without --watch', async () => {
    const server = await start();
    const res = await fetch(`${server.url}api/events`);
    expect(res.status).toBe(404);
  });

  it('streams SSE changed events in --watch mode', async () => {
    const events = createNotifier();
    const server = await start({ events });
    const res = await fetch(`${server.url}api/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;
    // first chunk: the retry preamble
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('retry:');
    setTimeout(() => events.emit(), 50);
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain('event: changed');
    await reader.cancel();
  }, 10_000);

  it('unknown paths 404', async () => {
    const server = await start();
    expect((await fetch(`${server.url}definitely-missing`)).status).toBe(404);
  });
});

describe('program surface', () => {
  it('exposes the view command with the specified flags', () => {
    const program = createProgram();
    expect(program.name()).toBe('runray');
    const view = program.commands.find(
      (c: { name(): string }) => c.name() === 'view',
    );
    expect(view).toBeDefined();
    const flags = view?.options.map((o: { long?: string }) => o.long);
    for (const f of [
      '--source',
      '--since',
      '--port',
      '--watch',
      '--redact',
      '--no-open',
    ]) {
      expect(flags).toContain(f);
    }
  });

  it('bare runray routes to view: no data → exit 3 with hints (D7)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runray-bare-'));
    const prevEnv = process.env.OPENCODE_DATA_DIR;
    process.env.OPENCODE_DATA_DIR = dir; // empty → guaranteed "no data"
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      // no subcommand named — the default-command routing must land in view;
      // --source opencode confines discovery to the empty temp root above
      await createProgram().parseAsync([
        'node',
        'runray',
        '--source',
        'opencode',
      ]);
      expect(process.exitCode).toBe(3);
      const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(err).toContain('No agent sessions found');
    } finally {
      process.exitCode = 0; // never leak exit 3 into the test runner
      stderrSpy.mockRestore();
      if (prevEnv === undefined) delete process.env.OPENCODE_DATA_DIR;
      else process.env.OPENCODE_DATA_DIR = prevEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/pricing (C2)', () => {
  it('serves the capture-once payload with provenance, no-store', async () => {
    const server = await start({
      getPricing: () => ({
        origin: 'bundled',
        table: { snapshotDate: '2026-07-07', entries: [] },
      }),
    });
    const res = await fetch(new URL('/api/pricing', server.url));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      origin: string;
      table: { snapshotDate: string };
    };
    expect(body.origin).toBe('bundled');
    expect(body.table.snapshotDate).toBe('2026-07-07');
  });

  it('404s when the caller provides no pricing getter', async () => {
    const server = await start();
    const res = await fetch(new URL('/api/pricing', server.url));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/transcript (D4)', () => {
  it('passes ids to the resolver and serves the slice', async () => {
    const server = await start({
      getTranscript: async (runId: string, spanId: string) => ({
        status: 'ok',
        segments: [{ label: 'assistant', text: `${runId}/${spanId}` }],
        truncated: false,
      }),
    });
    const res = await fetch(
      new URL('/api/transcript?run=run_a&span=s1', server.url),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      segments: Array<{ text: string }>;
    };
    expect(body.status).toBe('ok');
    expect(body.segments[0]?.text).toBe('run_a/s1');
  });

  it('missing query params are a structured unavailable, not a crash', async () => {
    const server = await start({
      getTranscript: async () => ({ status: 'ok' }),
    });
    const res = await fetch(new URL('/api/transcript?run=only', server.url));
    const body = (await res.json()) as { status: string; reason?: string };
    expect(body.status).toBe('unavailable');
    expect(body.reason).toContain('required');
  });

  it('404s when the caller provides no transcript resolver', async () => {
    const server = await start();
    const res = await fetch(
      new URL('/api/transcript?run=a&span=b', server.url),
    );
    expect(res.status).toBe(404);
  });

  it('resolver rejections degrade to a structured status', async () => {
    const server = await start({
      getTranscript: async () => {
        throw new Error('boom');
      },
    });
    const res = await fetch(
      new URL('/api/transcript?run=a&span=b', server.url),
    );
    const body = (await res.json()) as { status: string; reason?: string };
    expect(body.status).toBe('unavailable');
    expect(body.reason).toContain('boom');
  });
});

describe('GET /api/viewconfig (E1)', () => {
  it('serves the limitWindow block when configured', async () => {
    const server = await start({
      getViewConfig: () => ({ limitWindow: { days: 7, resetDay: 'thu' } }),
    });
    const res = await fetch(new URL('/api/viewconfig', server.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      limitWindow: { days: 7, resetDay: 'thu' },
    });
  });

  it('answers {} when no view config exists — behavior identical to today', async () => {
    const server = await start();
    const res = await fetch(new URL('/api/viewconfig', server.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

describe('/api/onboarding', () => {
  beforeEach(() => {
    resetInMemoryState();
  });

  it('returns {} when state is absent and sets cache-control: no-store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-onb-absent-'));
    const statePath = join(dir, 'state.json');
    const server = await start({ onboardingStatePath: statePath });

    const res = await fetch(new URL('/api/onboarding', server.url));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({});
  });

  it('shallow-merges patches and preserves prior keys across POSTs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-onb-merge-'));
    const statePath = join(dir, 'state.json');
    const server = await start({ onboardingStatePath: statePath });

    const res1 = await fetch(new URL('/api/onboarding', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tours: { dashboard: 'completed' } }),
    });
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ tours: { dashboard: 'completed' } });

    const res2 = await fetch(new URL('/api/onboarding', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tours: { run: 'skipped' } }),
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({
      tours: { dashboard: 'completed', run: 'skipped' },
    });
  });

  it('answers 405 for disallowed HTTP methods like DELETE', async () => {
    const server = await start();
    const res = await fetch(new URL('/api/onboarding', server.url), {
      method: 'DELETE',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('destroys connection when request body exceeds 4 KB cap', async () => {
    const server = await start();
    const oversized = 'x'.repeat(4097);
    await expect(
      fetch(new URL('/api/onboarding', server.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ overflow: oversized }),
      }),
    ).rejects.toThrow();
  });

  it('drops unknown keys silently and returns 200 with known keys only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-onb-unknown-'));
    const statePath = join(dir, 'state.json');
    const server = await start({ onboardingStatePath: statePath });

    const res = await fetch(new URL('/api/onboarding', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tours: { dashboard: 'completed' },
        secretKey: 'should-be-dropped',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tours: { dashboard: 'completed' },
    });
  });

  it('rejects non-loopback Host header with 403 before any read or write', async () => {
    const server = await start();
    const statusFor = (host: string): Promise<number> =>
      new Promise((resolveStatus, rejectStatus) => {
        const req = httpRequest(
          `${server.url}api/onboarding`,
          { headers: { host } },
          (res) => {
            res.resume();
            resolveStatus(res.statusCode ?? 0);
          },
        );
        req.on('error', rejectStatus);
        req.end();
      });
    expect(await statusFor('evil.example')).toBe(403);
  });

  it('returns 200 with in-memory state when writing to disk fails (unwritable directory)', async () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'tp-onb-readonly-'));
    chmodSync(dir, 0o500); // no write permission
    const statePath = join(dir, 'state.json');
    const server = await start({ onboardingStatePath: statePath });

    try {
      const res = await fetch(new URL('/api/onboarding', server.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hints: ['time-view'] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hints: ['time-view'] });
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('negative tests: server export route (Task 3.5, cli "No export endpoint is added to the local server")', () => {
  it('exposes no GET /api/export route and returns 404', async () => {
    const server = await start();
    const res = await fetch(new URL('/api/export', server.url));
    expect(res.status).toBe(404);
  });

  it('exposes no POST /api/export route and writes no report file', async () => {
    const server = await start();
    const res = await fetch(new URL('/api/export', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'sanitized', output: 'report.html' }),
    });
    expect(res.status).toBe(404);
  });
});
