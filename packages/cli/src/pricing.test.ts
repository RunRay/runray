import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledPricing } from '@runray/core';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  effectivePricing,
  loadUserPricing,
  refreshPricing,
} from './pricing.js';

const dir = mkdtempSync(join(tmpdir(), 'runray-pricing-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const bundledCount = bundledPricing().entries.length;

/** A LiteLLM-shaped list as large as the bundled snapshot. */
function priceList(count = bundledCount): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `claude-test-${String(i).padStart(4, '0')}`,
      {
        litellm_provider: 'anthropic',
        mode: 'chat',
        input_cost_per_token: 5e-6,
        output_cost_per_token: 25e-6,
      },
    ]),
  );
}

function replyWith(
  body: ConstructorParameters<typeof Response>[0],
  init: ResponseInit = {},
) {
  const calls: Array<RequestInit | undefined> = [];
  const fetchImpl = (async (
    _url: string | URL | Request,
    req?: RequestInit,
  ) => {
    calls.push(req);
    return new Response(body, { status: 200, ...init });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A local HTTP server reached through the real fetch. */
async function localServer(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  const fetchImpl = ((_url: string | URL | Request, req?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}/`, req)) as typeof fetch;
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { fetchImpl, close };
}

function freshDir(): string {
  return mkdtempSync(join(dir, 'case-'));
}

describe('refreshPricing', () => {
  it('fetches, converts and writes the user override (explicit opt-in)', async () => {
    const path = join(dir, 'nested', 'pricing.json');
    const { fetchImpl, calls } = replyWith(JSON.stringify(priceList()));

    const result = await refreshPricing({ path, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(result.entries).toBe(bundledCount);
    expect(result.skipped).toEqual([]);

    const loaded = loadUserPricing(path);
    expect(loaded?.entries[0]?.modelPattern).toBe('claude-test-0000');
    expect(loaded?.entries[0]?.inputPerMTok).toBe(5);
    expect(readdirSync(join(dir, 'nested'))).toEqual(['pricing.json']);
  });

  it('throws on a failing fetch', async () => {
    const { fetchImpl } = replyWith('nope', { status: 503 });
    await expect(
      refreshPricing({ path: join(dir, 'x.json'), fetchImpl }),
    ).rejects.toThrow(/503/);
  });

  it('leaves out models with unusable rates and reports them', async () => {
    const list = priceList();
    list['claude-negative'] = {
      litellm_provider: 'anthropic',
      mode: 'chat',
      input_cost_per_token: 5e-6,
      output_cost_per_token: -25e-6,
    };
    const path = join(freshDir(), 'pricing.json');
    const { fetchImpl } = replyWith(JSON.stringify(list));

    const result = await refreshPricing({ path, fetchImpl });
    expect(result.skipped).toEqual([
      {
        model: 'claude-negative',
        problem: 'output_cost_per_token is negative',
      },
    ]);
    expect(
      loadUserPricing(path)?.entries.some(
        (e) => e.modelPattern === 'claude-negative',
      ),
    ).toBe(false);
  });

  describe('refuses a reply it cannot trust, and writes nothing', () => {
    const previous = `${JSON.stringify(bundledPricing(), null, 2)}\n`;

    async function refused(
      fetchImpl: typeof fetch,
      message: RegExp,
      extra: Parameters<typeof refreshPricing>[0] = {},
    ) {
      const caseDir = freshDir();
      const path = join(caseDir, 'pricing.json');
      writeFileSync(path, previous);
      await expect(
        refreshPricing({ path, fetchImpl, ...extra }),
      ).rejects.toThrow(message);
      expect(readFileSync(path, 'utf8')).toBe(previous);
      expect(readdirSync(caseDir)).toEqual(['pricing.json']);
    }

    it('an empty object', async () => {
      await refused(replyWith('{}').fetchImpl, /no usable models/);
    });

    it('a list under half the bundled snapshot', async () => {
      const short = Math.ceil(bundledCount / 2) - 1;
      await refused(
        replyWith(JSON.stringify(priceList(short))).fetchImpl,
        new RegExp(
          `only ${short} usable models.*looks truncated.*--allow-short-list`,
        ),
      );
    });

    it('a top-level array', async () => {
      await refused(replyWith('[]').fetchImpl, /not a JSON object/);
    });

    it('a body that is not JSON', async () => {
      await refused(replyWith('{"a": ').fetchImpl, /not valid JSON/);
    });

    it('an HTML page from a proxy or captive portal', async () => {
      await refused(
        replyWith('<html>sign in</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }).fetchImpl,
        /HTML page/,
      );
    });

    it('a declared length over the cap, without reading the body', async () => {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(1024));
        },
      });
      await refused(
        replyWith(body, { headers: { 'content-length': String(2 << 20) } })
          .fetchImpl,
        /larger than 1 MiB/,
        { limits: { maxBytes: 1 << 20 } },
      );
      expect(pulled).toBeLessThanOrEqual(1); // the stream's initial pull
    });

    it('an endless body, stopped at the cap', async () => {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      });
      await refused(replyWith(body).fetchImpl, /larger than 1 MiB/, {
        limits: { maxBytes: 1 << 20 },
      });
      expect(pulled).toBeLessThan(20); // 1 MiB is 16 chunks of 64 KiB
    });

    it('a reply that never comes', async () => {
      const fetchImpl = ((_url: string | URL | Request, req?: RequestInit) =>
        new Promise((_resolve, reject) => {
          req?.signal?.addEventListener('abort', () =>
            reject(req.signal?.reason),
          );
        })) as typeof fetch;
      await refused(fetchImpl, /timed out: no data arrived for 0.05s/, {
        limits: { idleTimeoutMs: 50 },
      });
    });

    it('a server that stalls after the headers (real fetch)', async () => {
      const server = await localServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('{');
      });
      try {
        await refused(server.fetchImpl, /timed out: no data arrived for 0.2s/, {
          limits: { idleTimeoutMs: 200 },
        });
      } finally {
        await server.close();
      }
    });

    it('a server that drips just often enough to dodge the idle limit', async () => {
      const server = await localServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('{');
        const drip = setInterval(() => res.write(' '), 50);
        req.on('close', () => clearInterval(drip));
      });
      try {
        await refused(server.fetchImpl, /timed out: it took longer than 0.6s/, {
          limits: { idleTimeoutMs: 300, totalTimeoutMs: 600 },
        });
      } finally {
        await server.close();
      }
    });

    it('an unreachable host, naming the reason', async () => {
      const fetchImpl = (async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'),
        });
      }) as typeof fetch;
      await refused(
        fetchImpl,
        /could not reach raw\.githubusercontent\.com \(getaddrinfo ENOTFOUND/,
      );
    });
  });

  it('accepts a short list when asked, but never an empty one', async () => {
    const short = priceList(3);
    const path = join(freshDir(), 'pricing.json');
    const result = await refreshPricing({
      path,
      fetchImpl: replyWith(JSON.stringify(short)).fetchImpl,
      allowShortList: true,
    });
    expect(result.entries).toBe(3);
    await expect(
      refreshPricing({
        path,
        fetchImpl: replyWith('{}').fetchImpl,
        allowShortList: true,
      }),
    ).rejects.toThrow(/no usable models/);
    expect(loadUserPricing(path)?.entries).toHaveLength(3);
  });
});

describe('loadUserPricing', () => {
  function stored(table: unknown): string {
    const path = join(freshDir(), 'pricing.json');
    writeFileSync(path, JSON.stringify(table));
    return path;
  }
  const valid = {
    snapshotDate: '2026-10-06',
    source: 'litellm-snapshot',
    aliases: {},
    entries: [
      {
        modelPattern: 'claude-test',
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheWritePerMTok: 6.25,
      },
    ],
  };

  it('loads a valid table', () => {
    expect(loadUserPricing(stored(valid))?.entries).toHaveLength(1);
  });

  it.each([
    ['no models', { ...valid, entries: [] }, /entries: no models/],
    [
      'a negative rate',
      { ...valid, entries: [{ ...valid.entries[0], outputPerMTok: -25 }] },
      /entries\.0\.outputPerMTok/,
    ],
    [
      'a rate that is not a number',
      { ...valid, entries: [{ ...valid.entries[0], inputPerMTok: '5' }] },
      /entries\.0\.inputPerMTok/,
    ],
  ])('ignores a table with %s, with a warning', (_case, table, reason) => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const path = stored(table);
    expect(loadUserPricing(path)).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(reason);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /using the bundled snapshot/,
    );
  });
});

describe('effectivePricing', () => {
  it('prefers a valid user override', async () => {
    const path = join(dir, 'valid.json');
    const { fetchImpl } = replyWith(JSON.stringify(priceList()));
    await refreshPricing({ path, fetchImpl });
    const effective = effectivePricing(path);
    expect(effective.origin).toBe('user');
    expect(effective.table.entries).toHaveLength(bundledCount);
  });

  it('falls back to the bundled snapshot when the override is missing or invalid', () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(effectivePricing(join(dir, 'missing.json')).origin).toBe('bundled');

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{not json');
    const effective = effectivePricing(broken);
    expect(effective.origin).toBe('bundled');
    expect(effective.table.entries.length).toBe(bundledCount);
  });
});
