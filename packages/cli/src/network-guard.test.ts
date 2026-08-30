import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { bundledPricing } from '@runray/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadDemoTraceFile, resolveDemoDataDir } from './demo.js';
import { buildTraceFile } from './discover.js';
import { createProgram } from './program.js';
import { startServer } from './server.js';
import { resolveExportTemplate } from './ui-dist.js';

/**
 * Offline guarantee (cli spec "Privacy-preserving defaults", task 5.4):
 * `view`, `list`, `export`, and `demo` make no network requests — the only
 * permitted network operation is an explicit `pricing --refresh`.
 *
 * The guard patches the module-level factories every outbound connection in
 * Node goes through: `net.connect`/`net.createConnection` (undici's fetch and
 * `http.request` call these dynamically — verified empirically; they do NOT
 * route through `Socket.prototype.connect`) and `tls.connect` (https).
 * Loopback stays allowed — the product's own 127.0.0.1 server is the
 * feature, not a leak.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
const blocked: string[] = [];
const real = {
  connect: net.connect,
  createConnection: net.createConnection,
  tlsConnect: tls.connect,
};

/** Destination host of a connect() call; undefined for IPC (path) forms. */
function hostOf(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === 'object' && first !== null) {
    const opts = first as { host?: string; path?: string };
    return opts.path !== undefined ? undefined : (opts.host ?? 'localhost');
  }
  if (typeof first === 'number') {
    return typeof args[1] === 'string' ? args[1] : 'localhost';
  }
  return undefined; // string first arg = IPC path
}

type AnyFn = (...args: unknown[]) => unknown;

function guarded(name: string, fn: AnyFn): AnyFn {
  return (...args) => {
    const host = hostOf(args);
    if (host !== undefined && !LOOPBACK.has(host)) {
      blocked.push(host);
      throw new Error(`network-guard: blocked ${name} to ${host}`);
    }
    return fn(...args);
  };
}

const fixturesDir = fileURLToPath(
  new URL('../../../fixtures/claude-code', import.meta.url),
);
// parses the full claude-code fixture tree under a network guard — headroom
// over vitest's 5s default to avoid full-suite-load flakes (see run-diff 2.1)
vi.setConfig({ testTimeout: 30_000 });
const scratchDirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'runray-offline-'));
  scratchDirs.push(dir);
  return dir;
};

beforeAll(() => {
  net.connect = guarded(
    'net.connect',
    real.connect as unknown as AnyFn,
  ) as unknown as typeof net.connect;
  net.createConnection = guarded(
    'net.createConnection',
    real.createConnection as unknown as AnyFn,
  ) as unknown as typeof net.createConnection;
  tls.connect = guarded(
    'tls.connect',
    real.tlsConnect as unknown as AnyFn,
  ) as unknown as typeof tls.connect;
});
afterAll(() => {
  net.connect = real.connect;
  net.createConnection = real.createConnection;
  tls.connect = real.tlsConnect;
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe('offline-first guarantee (AGENTS.md)', () => {
  it('the guard itself blocks an outbound connection (positive control)', async () => {
    // TEST-NET-1 IP literal: no DNS involved, the connect itself must throw
    await expect(fetch('http://192.0.2.1/')).rejects.toThrow();
    expect(blocked).toContain('192.0.2.1');
  });

  it('buildTraceFile makes no outbound network connections', async () => {
    const { traceFile } = await buildTraceFile({
      paths: [fixturesDir],
      redact: true,
      generatorVersion: 'guard-test',
    });
    expect(traceFile.runs.length).toBeGreaterThan(0);
  });

  it('bundled pricing engine initializes without network access', () => {
    const pricing = bundledPricing();
    expect(pricing.entries.length).toBeGreaterThan(100);
  });

  it('local server listens on 127.0.0.1 and serves data offline', async () => {
    const traceFile = (
      await buildTraceFile({
        paths: [fixturesDir],
        redact: true,
        generatorVersion: 'guard-test',
      })
    ).traceFile;
    const server = await startServer({
      getTraceFile: async () => traceFile,
      basePort: 4320,
    });
    try {
      const res = await fetch(new URL('/api/tracefile', server.url));
      expect(res.status).toBe(200); // loopback allowed, nothing else attempted
    } finally {
      await server.close();
    }
  });

  it('list runs offline', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await createProgram().parseAsync([
        'node',
        'runray',
        'list',
        fixturesDir,
        '--json',
      ]);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it.skipIf(resolveExportTemplate() === undefined)(
    'export runs offline',
    async () => {
      const out = join(scratch(), 'report.html');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await createProgram().parseAsync([
          'node',
          'runray',
          'export',
          fixturesDir,
          '-o',
          out,
          '--redact',
        ]);
      } finally {
        log.mockRestore();
      }
      expect(existsSync(out)).toBe(true);
    },
  );

  it('demo data loads and serves offline', async () => {
    const dir = resolveDemoDataDir();
    expect(dir).toBeDefined();
    if (dir === undefined) return;
    const traceFile = loadDemoTraceFile(dir, 'offline-test');
    const server = await startServer({
      getTraceFile: async () => traceFile,
      basePort: 4380,
    });
    try {
      const res = await fetch(new URL('/api/tracefile', server.url));
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('no outbound connection was attempted by any command', () => {
    // the only entry is the positive control's
    expect(blocked).toEqual(['192.0.2.1']);
  });
});
