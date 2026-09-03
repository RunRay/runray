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
import type { Run, Span } from '@runray/schema';
import { afterAll, describe, expect, it } from 'vitest';
import type { Candidate } from '../adapter.js';
import { normalize } from '../normalize.js';
import { priceRun } from '../pricing/index.js';
import { opencodeAdapter } from './opencode.js';

/**
 * OpenCode adapter tests (task 2.3). The three fixture eras were captured
 * from ONE live install: `storage/simple`, `sqlite/simple`, and
 * `export-json/simple.json` all hold session ses_3b2ada6f… — which makes the
 * spec's cross-era guarantee ("identical normalized structure across eras for
 * equivalent sessions") directly testable. The export era differs from the
 * raw stores in free text only (`opencode export` transforms text slightly),
 * so its equivalence check strips content.
 */

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const fixtures = join(repoRoot, 'fixtures', 'opencode');
const SIMPLE_SESSION = 'ses_3b2ada6f9ffe39UZtceZsbPc4e';

async function detectIn(dir: string): Promise<Candidate[]> {
  return (await opencodeAdapter.detect([dir])).filter(
    (c) => !/[\\/]raw[\\/]/.test(c.runRef),
  );
}

async function runOn(dir: string, redact = false): Promise<Run> {
  const candidates = await detectIn(dir);
  expect(candidates).toHaveLength(1);
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error('unreachable');
  const raw = await opencodeAdapter.parse(candidate, { redact });
  return normalize(priceRun(raw), { baseDir: repoRoot });
}

function withoutProvenance(run: Run): Omit<Span, 'provenance'>[] {
  return run.spans.map(({ provenance: _p, ...rest }) => rest);
}

describe('opencode detect', () => {
  it('finds an export document by bounded sniff', async () => {
    const candidates = await detectIn(join(fixtures, 'export-json'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.format).toBe('opencode-export');
  });

  it('parses an export bundle saved with a UTF-8 BOM', async () => {
    // The documented way to make one is a shell redirect
    // (`opencode export <id> > file`), which on Windows prepends U+FEFF.
    // The sniff is a substring search and does not notice, so without a BOM
    // strip the document matched, failed JSON.parse, and vanished — the same
    // "root reported as empty" failure the OTLP reader had.
    const dir = mkdtempSync(join(tmpdir(), 'runray-oc-bom-'));
    const doc = readFileSync(
      join(fixtures, 'export-json', 'simple.json'),
      'utf8',
    );
    writeFileSync(join(dir, 'export.json'), `﻿${doc}`, 'utf8');
    const run = await runOn(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(run.spans.length).toBeGreaterThan(0);
  });

  it('names a filesystem-root project after the path, never the empty string', async () => {
    // basename('/') and basename('D:\\') are both '', and an empty project
    // name collides with the UI's "all projects" sentinel, so the run drops
    // out of the project filter. This half reproduces on POSIX too, which is
    // why it is asserted here rather than behind a win32 guard.
    const dir = mkdtempSync(join(tmpdir(), 'runray-oc-root-'));
    const doc = JSON.parse(
      readFileSync(join(fixtures, 'export-json', 'simple.json'), 'utf8'),
    ) as { info: { directory: string } };
    doc.info.directory = '/';
    writeFileSync(join(dir, 'export.json'), JSON.stringify(doc), 'utf8');
    const run = await runOn(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(run.project?.name).toBe('/');
  });

  it('finds one storage-era candidate with the full stitched file set', async () => {
    const candidates = await detectIn(join(fixtures, 'storage'));
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c?.format).toBe('opencode-storage');
    expect(c?.runRef.endsWith(`${SIMPLE_SESSION}.json`)).toBe(true);
    // 1 session + 29 messages + 113 parts
    expect(c?.files).toHaveLength(143);
  });

  it('emits one candidate per ROOT db session — children join the parent run', async () => {
    const candidates = await detectIn(join(fixtures, 'sqlite', 'subagents'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.format).toBe('opencode-sqlite');
    expect(candidates[0]?.runRef).toContain('::ses_364dd82b7');
  });
});

describe('opencode parse (export era)', () => {
  it('maps session/llm_call/tool_call with usage, reasoning, and previews', async () => {
    const run = await runOn(join(fixtures, 'export-json'));
    const kinds = new Map<string, number>();
    for (const s of run.spans) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
    expect(Object.fromEntries(kinds)).toEqual({
      session: 1,
      llm_call: 28,
      tool_call: 28,
    });

    const llm = run.spans.find(
      (s) => s.id === 'msg_c4d52593d001682oTfGPvWdad4',
    );
    expect(llm?.llm).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.3-codex',
      tokens: {
        input: 8582,
        output: 160,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 139,
      },
      stopReason: 'tool-calls',
      costSource: 'computed', // cost: 0 from the source is never trusted
    });
    expect(llm?.content?.promptPreview).toBeTruthy();

    const tool = run.spans.find((s) => s.kind === 'tool_call');
    expect(tool?.tool?.name).toBe(tool?.name);
    expect(run.totals.tokens.reasoning).toBe(1906);
    expect(run.totals.costUSD.total).toBeGreaterThan(0);
  });

  it('nulls prompt-derived content and drops the title under --redact', async () => {
    const run = await runOn(join(fixtures, 'export-json'), true);
    expect(run.title).toBeUndefined();
    const withContent = run.spans.filter((s) => s.content !== undefined);
    expect(withContent.length).toBeGreaterThan(0);
    for (const s of withContent) {
      for (const v of Object.values(s.content ?? {})) expect(v).toBeNull();
    }
  });
});

describe('opencode declined calls (trace-ingestion "User-rejected tool calls")', () => {
  it('marks a permission refusal cancelled with the harness message as preview', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runray-oc-reject-'));
    try {
      const doc = JSON.parse(
        readFileSync(join(fixtures, 'export-json', 'simple.json'), 'utf8'),
      ) as {
        messages: {
          parts: { id: string; type: string; state: Record<string, unknown> }[];
        }[];
      };
      const part = doc.messages
        .flatMap((m) => m.parts)
        .find((p) => p.type === 'tool');
      if (part === undefined) throw new Error('fixture has no tool part');
      part.state = {
        ...part.state,
        status: 'error',
        error:
          'Error: The user rejected permission to use this specific tool call.',
      };
      writeFileSync(join(dir, 'export.json'), JSON.stringify(doc), 'utf8');
      const run = await runOn(dir);
      const span = run.spans.find((s) => s.id === part.id);
      expect(span?.status).toBe('cancelled');
      expect(span?.statusReason).toBe('user-rejected');
      expect(span?.tool?.isError).toBe(false);
      expect(
        span?.content?.outputPreview?.startsWith(
          'Error: The user rejected permission',
        ),
      ).toBe(true);
      expect(run.totals.counts.toolErrors).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cross-era equivalence (trace-ingestion spec)', () => {
  it('storage and sqlite eras of the same snapshot are identical modulo provenance', async () => {
    const storage = await runOn(join(fixtures, 'storage'));
    const sqlite = await runOn(join(fixtures, 'sqlite', 'simple'));
    expect(storage.id).toBe(sqlite.id);
    expect(storage.totals).toEqual(sqlite.totals);
    expect(withoutProvenance(storage)).toEqual(withoutProvenance(sqlite));
  });

  it('export era matches the raw stores modulo provenance and free text', async () => {
    // `opencode export` re-renders text slightly, so text-derived values
    // (content previews, tool outputBytes) differ where the original bytes
    // differed — everything structural must still be identical
    const storage = await runOn(join(fixtures, 'storage'));
    const exported = await runOn(join(fixtures, 'export-json'));
    const strip = (run: Run) =>
      withoutProvenance(run).map(({ content: _c, tool, ...rest }) => ({
        ...rest,
        ...(tool === undefined
          ? {}
          : { tool: { ...tool, outputBytes: undefined } }),
      }));
    expect(strip(exported)).toEqual(strip(storage));
    expect(exported.id).toBe(storage.id);
    expect(exported.totals).toEqual(storage.totals);
  });
});

describe('opencode subagents (sqlite era)', () => {
  it('nests the child session under the spawning task tool part', async () => {
    const run = await runOn(join(fixtures, 'sqlite', 'subagents'));
    const sub = run.spans.find((s) => s.kind === 'subagent');
    expect(sub).toMatchObject({
      name: 'subagent:general',
      depth: 3,
      agent: { name: 'general', sessionId: 'ses_364d62d1bffe0Urvi3LCZqVsai' },
    });
    expect(sub?.content?.delegationReason).toBeTruthy();

    const parent = run.spans.find((s) => s.id === sub?.parentId);
    expect(parent?.kind).toBe('tool_call');
    expect(parent?.name).toBe('task');

    // the child transcript's llm calls sit BELOW the subagent span
    const subDepth = sub?.depth ?? 0;
    const childLlm = run.spans.filter(
      (s) => s.kind === 'llm_call' && s.depth > subDepth,
    );
    expect(childLlm.length).toBeGreaterThan(0);
    expect(run.totals.counts.maxDepth).toBe(5);
  });
});

describe('opencode sqlite read-only (spec scenario)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'runray-oc-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('reports a clear, actionable error when the db is unreadable', async () => {
    const garbage = join(tmp, 'opencode.db');
    writeFileSync(garbage, 'this is not a sqlite database');
    const candidate: Candidate = {
      runRef: garbage,
      format: 'opencode-sqlite',
      files: [garbage],
      mtimeMs: 0,
      sizeBytes: 0,
    };
    await expect(
      opencodeAdapter.parse(candidate, { redact: false }),
    ).rejects.toThrow(/read-only.*never modified or locked/s);
  });

  it('never creates a database that does not exist', async () => {
    const missing = join(tmp, 'nope', 'opencode.db');
    const candidate: Candidate = {
      runRef: missing,
      format: 'opencode-sqlite',
      files: [missing],
      mtimeMs: 0,
      sizeBytes: 0,
    };
    await expect(
      opencodeAdapter.parse(candidate, { redact: false }),
    ).rejects.toThrow(/cannot open/);
    expect(existsSync(missing)).toBe(false);
  });
});

describe('opencode MCP classification (E4)', () => {
  // Synthetic export-era document (never a committed fixture): the on-disk
  // format carries no MCP marker, so classification is allowlist + name
  // heuristic, flagged via runray.mcpDetection.
  const SES = 'ses_mcp0000000000000000000000';
  const MSG = 'msg_mcp0000000000000000000001';
  const toolPart = (
    id: string,
    tool: string,
    input: Record<string, unknown>,
  ) => ({
    id: `prt_${id}`,
    sessionID: SES,
    messageID: MSG,
    type: 'tool',
    tool,
    state: {
      status: 'completed',
      input,
      output: 'ok',
      time: { start: 1770823773832, end: 1770823773852 },
    },
  });
  const doc = {
    info: {
      id: SES,
      title: 'mcp classification probe',
      directory: '/home/user/project',
      time: { created: 1770823768327, updated: 1770824247477 },
    },
    messages: [
      {
        info: {
          id: MSG,
          sessionID: SES,
          role: 'assistant',
          time: { created: 1770823768381, completed: 1770823773890 },
          modelID: 'gpt-5.3-codex',
          providerID: 'openai',
          cost: 0,
          tokens: {
            total: 100,
            input: 90,
            output: 10,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          toolPart('a', 'context7_query-docs', { query: 'x' }),
          toolPart('b', 'apply_patch', {}),
          toolPart('c', 'todowrite', {}),
          toolPart('d', '_leading', {}),
          toolPart('e', 'read', { filePath: '/src/a.ts' }),
        ],
      },
    ],
  };

  const tmp = mkdtempSync(join(tmpdir(), 'runray-oc-mcp-'));
  writeFileSync(join(tmp, 'probe-export.json'), JSON.stringify(doc));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('classifies MCP-shaped names with server prefix and heuristic flag', async () => {
    const run = await runOn(tmp);
    const mcp = run.spans.find((s) => s.name === 'context7_query-docs');
    expect(mcp?.kind).toBe('mcp_call');
    expect(mcp?.tool?.mcpServer).toBe('context7');
    expect(mcp?.attributes['runray.mcpDetection']).toBe('name-heuristic');
  });

  it('built-in underscore and non-underscore tools stay tool_call', async () => {
    const run = await runOn(tmp);
    for (const name of ['apply_patch', 'todowrite', '_leading']) {
      const span = run.spans.find((s) => s.name === name);
      expect(span?.kind).toBe('tool_call');
      expect(span?.tool?.mcpServer).toBeUndefined();
      expect('runray.mcpDetection' in (span?.attributes ?? {})).toBe(false);
    }
  });

  it('target identity capture rides the same emit site', async () => {
    const run = await runOn(tmp);
    const read = run.spans.find((s) => s.name === 'read');
    expect(read?.attributes['runray.targetKind']).toBe('file-read');
    expect(read?.attributes['runray.targetKey']).toMatch(/^[0-9a-f]{16}$/);
    expect(read?.attributes['runray.target']).toBe('a.ts');
    const redacted = await runOn(tmp, true);
    const readR = redacted.spans.find((s) => s.name === 'read');
    expect(readR?.attributes['runray.targetKey']).toBe(
      read?.attributes['runray.targetKey'],
    );
    expect('runray.target' in (readR?.attributes ?? {})).toBe(false);
  });
});
