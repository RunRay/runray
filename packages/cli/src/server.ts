import { readFileSync, type Stats, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { TraceFile } from '@runray/schema';
import {
  getOnboardingState,
  type OnboardingBlock,
  updateOnboardingState,
} from './onboarding-state.js';

/**
 * Local viewer server (05-ARCHITECTURE §3): bare node:http, bound ONLY to
 * 127.0.0.1 — never a network interface (AGENTS.md privacy rules). Base port
 * 4173, incrementing when taken. Endpoints: GET / (embedded UI dist, or a
 * placeholder until task 5.1), GET /api/tracefile, GET /api/events (SSE,
 * only with --watch).
 */

export const DEFAULT_PORT = 4173;
const HOST = '127.0.0.1';
const MAX_PORT_ATTEMPTS = 50;

/** Minimal pub/sub bridging the file watcher to SSE clients. */
export interface ChangeNotifier {
  subscribe(listener: () => void): () => void;
  emit(): void;
}

export function createNotifier(): ChangeNotifier {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) listener();
    },
  };
}

/** Payload of GET /api/pricing (C2): the effective table + provenance. */
export interface PricingPayload {
  origin: 'user' | 'bundled';
  path?: string;
  table: unknown;
}

export interface ServerOptions {
  getTraceFile(): Promise<TraceFile>;
  basePort?: number;
  /** Present only in --watch mode; enables GET /api/events. */
  events?: ChangeNotifier;
  /** Directory with the built UI (task 5.1); placeholder page until then. */
  uiDistDir?: string;
  /**
   * Effective pricing for GET /api/pricing — a getter so the payload always
   * reflects the capture-once table of the CURRENT trace build (C2); the
   * endpoint 404s when absent (older callers, tests).
   */
  getPricing?(): PricingPayload;
  /**
   * Transcript resolution for GET /api/transcript (D4). The callback owns
   * the id→provenance lookup against the server's trusted trace data — the
   * client can only ever send ids, never file paths; redaction is enforced
   * inside core's reader before any file I/O. 404 when absent.
   */
  getTranscript?(runId: string, spanId: string): Promise<unknown>;
  /**
   * View configuration for GET /api/viewconfig (E1) — e.g. the opt-in
   * limitWindow block. The endpoint always answers: `{}` when absent, so a
   * missing config leaves all behavior identical to today.
   */
  getViewConfig?(): unknown;
  /**
   * Onboarding state getters/setters for GET/POST /api/onboarding.
   */
  getOnboarding?(): OnboardingBlock;
  updateOnboarding?(patch: OnboardingBlock): OnboardingBlock;
  onboardingStatePath?: string;
}

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>RunRay</title></head>
<body style="font-family: system-ui; padding: 3rem; max-width: 40rem; margin: auto">
<h1>RunRay</h1>
<p>The dashboard UI is not embedded in this build yet (task 5.1).</p>
<p>The normalized data is served at <a href="/api/tracefile"><code>/api/tracefile</code></a>.</p>
</body></html>
`;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * DNS-rebinding defense: binding to 127.0.0.1 stops other machines from
 * connecting, but a page on an attacker origin can rebind its own DNS to
 * 127.0.0.1 and then fetch this server same-origin (no CORS), reading the
 * full unredacted trace and transcripts. A real local client always sends a
 * loopback Host header, so require one.
 */
function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === '') return false;
  const name = host.startsWith('[')
    ? host.slice(1, host.indexOf(']')) // [::1]:port
    : (host.split(':')[0] ?? '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function serveStatic(
  res: ServerResponse,
  uiDistDir: string,
  urlPath: string,
): boolean {
  const root = resolve(uiDistDir);
  const target = normalize(
    join(root, urlPath === '/' ? 'index.html' : urlPath),
  );
  if (!target.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  // statSync, not existsSync: a directory exists too, and readFileSync on
  // one throws EISDIR straight out of this synchronous request handler,
  // killing the viewer, its watcher and every SSE client. On win32 a
  // backslash is a separator, so such a request resolves to a real
  // directory — inert on POSIX, a crash here.
  let stats: Stats;
  try {
    stats = statSync(target);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  let body: Buffer;
  try {
    body = readFileSync(target);
  } catch {
    res.writeHead(500).end('read error');
    return true;
  }
  const type =
    MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  res.end(body);
  return true;
}

/**
 * Is this bind failure "that port is unusable, try the next one" rather than
 * a real error worth showing the user?
 *
 * EADDRINUSE always is. EACCES only on Windows and only above the privileged
 * range: Hyper-V, WSL2 and Docker Desktop reserve whole blocks of ordinary
 * high ports there and binding one returns EACCES, not EADDRINUSE, so a
 * single reserved port used to abort `view` instead of stepping past it. On
 * POSIX, EACCES means the port is privileged and the process is not — the
 * clear "permission denied" must survive, or `--port 80` as a normal user
 * turns into 50 pointless retries and a false "no free port" report.
 * EADDRNOTAVAIL is never retried: the host is fixed to 127.0.0.1, so the
 * address not being available is a real problem the next port cannot fix.
 */
export function isPortUnavailable(
  code: string | undefined,
  port: number,
): boolean {
  if (code === 'EADDRINUSE') return true;
  return code === 'EACCES' && process.platform === 'win32' && port >= 1024;
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (isPortUnavailable(err.code, port)) resolvePromise(false);
      else reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolvePromise(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

export async function startServer(
  options: ServerOptions,
): Promise<RunningServer> {
  // open SSE responses (keep-alive, never end on their own) — tracked so
  // close() can end them; otherwise server.close() waits forever on them
  const sseClients = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';

    // reject non-loopback Host before any route runs (DNS-rebinding guard)
    if (!isLoopbackHost(req.headers.host)) {
      sendJson(res, 403, { error: 'forbidden host' });
      return;
    }

    if (urlPath === '/api/tracefile') {
      options
        .getTraceFile()
        .then((traceFile) => sendJson(res, 200, traceFile))
        .catch((err: unknown) => sendJson(res, 500, { error: String(err) }));
      return;
    }

    if (urlPath === '/api/pricing') {
      if (options.getPricing === undefined) {
        sendJson(res, 404, { error: 'pricing not available' });
        return;
      }
      sendJson(res, 200, options.getPricing());
      return;
    }

    if (urlPath === '/api/viewconfig') {
      sendJson(res, 200, options.getViewConfig?.() ?? {});
      return;
    }

    if (urlPath === '/api/onboarding') {
      if (req.method !== 'GET' && req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }

      const getOnboarding =
        options.getOnboarding ??
        (() => getOnboardingState(options.onboardingStatePath));
      const updateOnboarding =
        options.updateOnboarding ??
        ((patch: OnboardingBlock) =>
          updateOnboardingState(patch, options.onboardingStatePath));

      if (req.method === 'GET') {
        sendJson(res, 200, getOnboarding());
        return;
      }

      if (req.method === 'POST') {
        let bodyBytes = 0;
        const chunks: Buffer[] = [];
        let exceeded = false;

        req.on('data', (chunk: Buffer) => {
          if (exceeded) return;
          bodyBytes += chunk.length;
          if (bodyBytes > 4096) {
            exceeded = true;
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });

        req.on('end', () => {
          if (exceeded) return;
          let patch: OnboardingBlock = {};
          try {
            const raw = Buffer.concat(chunks).toString('utf-8');
            if (raw.trim().length > 0) {
              const parsed = JSON.parse(raw);
              if (
                typeof parsed === 'object' &&
                parsed !== null &&
                !Array.isArray(parsed)
              ) {
                patch = parsed as OnboardingBlock;
              }
            }
          } catch {
            // Malformed JSON -> patch stays {}
          }
          const updated = updateOnboarding(patch);
          sendJson(res, 200, updated);
        });
        return;
      }
    }

    if (urlPath === '/api/transcript') {
      const getTranscript = options.getTranscript;
      if (getTranscript === undefined) {
        sendJson(res, 404, { error: 'transcripts not available' });
        return;
      }
      const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
      const runId = params.get('run');
      const spanId = params.get('span');
      if (runId === null || spanId === null) {
        sendJson(res, 200, {
          status: 'unavailable',
          reason: 'run and span query parameters are required',
        });
        return;
      }
      getTranscript(runId, spanId)
        .then((slice) => sendJson(res, 200, slice))
        .catch((err: unknown) =>
          sendJson(res, 200, {
            status: 'unavailable',
            reason: String(err),
          }),
        );
      return;
    }

    if (urlPath === '/api/events') {
      if (options.events === undefined) {
        sendJson(res, 404, { error: 'events available only with --watch' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      sseClients.add(res);
      const unsubscribe = options.events.subscribe(() => {
        res.write('event: changed\ndata: {}\n\n');
      });
      req.on('close', () => {
        unsubscribe();
        sseClients.delete(res);
      });
      return;
    }

    if (
      options.uiDistDir !== undefined &&
      serveStatic(res, options.uiDistDir, urlPath)
    )
      return;
    if (urlPath === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PLACEHOLDER);
      return;
    }
    res.writeHead(404).end('not found');
  });

  const basePort = options.basePort ?? DEFAULT_PORT;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const port = basePort + attempt;
    if (await listen(server, port)) {
      return {
        port,
        url: `http://${HOST}:${port}/`,
        close: () =>
          new Promise((resolvePromise, reject) => {
            // end open SSE responses first, else server.close() hangs
            // forever waiting on their keep-alive connections
            for (const client of sseClients) client.end();
            sseClients.clear();
            server.close((err) => (err ? reject(err) : resolvePromise()));
          }),
      };
    }
  }
  throw new Error(
    `no free port in ${basePort}–${basePort + MAX_PORT_ATTEMPTS - 1}`,
  );
}
