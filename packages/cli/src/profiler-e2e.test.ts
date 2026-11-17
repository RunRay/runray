import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledPricing } from '@runray/core';
import type { TraceFile } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { buildTraceFile } from './discover.js';
import { injectGlobal, injectTraceData } from './export.js';
import { resolveTranscript } from './program.js';
import { startServer } from './server.js';
import { claudeCodeFixtures } from './test-fixtures.js';
import { resolveExportTemplate } from './ui-dist.js';

const fixturesDir = claudeCodeFixtures();

describe('server endpoints (profiler depth)', () => {
  it('GET /api/pricing returns the live pricing payload with provenance', async () => {
    const table = bundledPricing();
    const server = await startServer({
      getTraceFile: async () => ({
        schemaVersion: '0.1.0',
        generator: { name: 'test', version: '0' },
        generatedAt: '2026-07-02T13:00:00Z',
        runs: [],
      }),
      getPricing: () => ({ origin: 'bundled', table }),
      basePort: 4360,
    });
    try {
      const res = await fetch(new URL('/api/pricing', server.url));
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        origin: string;
        table: typeof table;
      };
      expect(data.origin).toBe('bundled');
      expect(data.table.entries.length).toBe(table.entries.length);
    } finally {
      await server.close();
    }
  });

  it('GET /api/viewconfig returns the view config payload', async () => {
    const server = await startServer({
      getTraceFile: async () => ({
        schemaVersion: '0.1.0',
        generator: { name: 'test', version: '0' },
        generatedAt: '2026-07-02T13:00:00Z',
        runs: [],
      }),
      getViewConfig: () => ({ limitWindow: { days: 7, budgetUSD: 100 } }),
      basePort: 4361,
    });
    try {
      const res = await fetch(new URL('/api/viewconfig', server.url));
      expect(res.status).toBe(200);
      const data = (await res.json()) as { limitWindow: { days: 7 } };
      expect(data.limitWindow.days).toBe(7);
    } finally {
      await server.close();
    }
  });

  it('GET /api/transcript serves slice for valid ids, 404 for unknown', async () => {
    const { traceFile } = await buildTraceFile({
      paths: [fixturesDir],
      redact: false,
      generatorVersion: 'e2e',
    });
    const run = traceFile.runs[0];
    const span = run?.spans.find(
      (s) => s.kind === 'llm_call' && s.provenance?.file,
    );
    if (run === undefined || span === undefined) throw new Error('unreachable');

    const server = await startServer({
      getTraceFile: async () => traceFile,
      getTranscript: (runId, spanId) =>
        resolveTranscript(traceFile, runId, spanId, false),
      basePort: 4362,
    });
    try {
      const url = new URL(
        `/api/transcript?run=${encodeURIComponent(run.id)}&span=${encodeURIComponent(span.id)}`,
        server.url,
      );
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe('ok');

      const miss = await fetch(
        new URL('/api/transcript?run=nope&span=nope', server.url),
      );
      expect(miss.status).toBe(200);
      const missData = (await miss.json()) as { status: string };
      expect(missData.status).toBe('unavailable');
    } finally {
      await server.close();
    }
  });
});

describe('tool usage reaches the viewer payload (add-tool-usage-breakdown)', () => {
  const SESSION = 'sess-e2e-tools';
  const CALLS = [
    {
      id: 'tu_docker',
      command: 'docker compose -f dev.yml up -d',
      background: true,
    },
    { id: 'tu_build', command: 'git add -A && pnpm build', background: false },
    { id: 'tu_own', command: 'acme-deploy --prod eu-west', background: false },
  ];

  /** A Claude Code project directory holding one transcript, built inline:
   * committed fixtures keep filler words where commands were. */
  function writeSession(): string {
    const dir = mkdtempSync(join(tmpdir(), 'runray-e2e-tools-'));
    const project = join(dir, 'proj');
    mkdirSync(project, { recursive: true });
    const lines: unknown[] = [
      {
        type: 'user',
        uuid: 'u0',
        sessionId: SESSION,
        timestamp: '2026-11-11T10:00:00Z',
        cwd: '/home/user/project/x',
        message: { role: 'user', content: 'ship it' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u0',
        sessionId: SESSION,
        timestamp: '2026-11-11T10:00:01Z',
        cwd: '/home/user/project/x',
        message: {
          id: 'msg_e2e',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 5 },
          content: CALLS.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: 'Bash',
            input: {
              command: call.command,
              ...(call.background ? { run_in_background: true } : {}),
            },
          })),
        },
      },
      ...CALLS.map((call, index) => ({
        type: 'user',
        uuid: `r${index}`,
        sessionId: SESSION,
        timestamp: `2026-11-11T10:00:${String(10 + index * 10).padStart(2, '0')}Z`,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: call.id,
              content: [{ type: 'text', text: 'ok' }],
            },
          ],
        },
      })),
    ];
    writeFileSync(
      join(project, `${SESSION}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
    return dir;
  }

  async function served(redact: boolean, basePort: number) {
    const dir = writeSession();
    try {
      const { traceFile } = await buildTraceFile({
        paths: [dir],
        redact,
        generatorVersion: 'e2e',
      });
      const server = await startServer({
        getTraceFile: async () => traceFile,
        basePort,
      });
      try {
        const res = await fetch(new URL('/api/tracefile', server.url));
        expect(res.status).toBe(200);
        const body = await res.text();
        const payload = JSON.parse(body) as TraceFile;
        const attributes = (id: string) =>
          payload.runs[0]?.spans.find((s) => s.id === id)?.attributes;
        return { body, attributes };
      } finally {
        await server.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('serves resolved tool identity and none of the command text', async () => {
    const { body, attributes } = await served(false, 4363);
    expect(attributes('tu_docker')).toMatchObject({
      'runray.toolActivity': 'infra',
      'runray.tool': 'docker',
      'runray.toolSub': 'compose up',
      'runray.toolFlags': ['background'],
    });
    expect(attributes('tu_build')).toMatchObject({
      'runray.toolActivity': 'build',
      'runray.tool': 'pnpm',
      'runray.toolSub': 'run',
      'runray.toolsAlso': ['git'],
      'runray.toolScript': 'build',
    });
    expect(attributes('tu_own')).toMatchObject({
      'runray.toolActivity': 'other',
      'runray.toolName': 'acme-deploy',
    });
    // arguments, paths and option values never reach the payload
    expect(body).not.toContain('dev.yml');
    expect(body).not.toContain('eu-west');
    expect(body).not.toContain('--prod');
  });

  it('keeps registry identity and drops free-form names under --redact', async () => {
    const { body, attributes } = await served(true, 4364);
    expect(attributes('tu_docker')).toMatchObject({
      'runray.tool': 'docker',
      'runray.toolSub': 'compose up',
      'runray.toolFlags': ['background'],
    });
    expect(attributes('tu_build')).toMatchObject({
      'runray.tool': 'pnpm',
      'runray.toolsAlso': ['git'],
    });
    expect(attributes('tu_build')).not.toHaveProperty('runray.toolScript');
    expect(attributes('tu_own')).toMatchObject({
      'runray.toolActivity': 'other',
    });
    expect(attributes('tu_own')).not.toHaveProperty('runray.tool');
    expect(body).not.toContain('acme-deploy');
    expect(body).not.toContain('runray.toolName');
  });
});

describe('export template injection (profiler depth)', () => {
  it('injects trace data, pricing, and view config into the export template', async () => {
    const template = resolveExportTemplate();
    if (template === undefined) return;

    const { traceFile } = await buildTraceFile({
      paths: [fixturesDir],
      redact: true,
      pricing: bundledPricing(),
      generatorVersion: 'e2e',
    });
    const html = injectGlobal(
      injectGlobal(
        injectTraceData(readFileSync(template, 'utf8'), traceFile),
        '__RUNRAY_PRICING__',
        { origin: 'bundled', table: bundledPricing() },
      ),
      '__RUNRAY_VIEW_CONFIG__',
      { limitWindow: { days: 7 } },
    );
    expect(html).toContain('window.__RUNRAY_DATA__=');
    expect(html).toContain('window.__RUNRAY_PRICING__=');
    expect(html).toContain('window.__RUNRAY_VIEW_CONFIG__=');
    expect(html).toContain('<div id="root">');
    // sanitization: nothing can close the data script element early
    expect(html).not.toContain('</script><!--');
    // determinism: the same inputs produce byte-identical export HTML
    const again = injectGlobal(
      injectGlobal(
        injectTraceData(readFileSync(template, 'utf8'), traceFile),
        '__RUNRAY_PRICING__',
        { origin: 'bundled', table: bundledPricing() },
      ),
      '__RUNRAY_VIEW_CONFIG__',
      { limitWindow: { days: 7 } },
    );
    expect(again).toBe(html);
  });
});
