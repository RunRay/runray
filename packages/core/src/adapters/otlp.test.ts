import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run } from '@runray/schema';
import { afterAll, describe, expect, it } from 'vitest';
import type { Candidate } from '../adapter.js';
import { normalize } from '../normalize.js';
import { priceRun } from '../pricing/index.js';
import { stripBom } from '../text.js';
import { otlpAdapter } from './otlp.js';

/**
 * OTLP adapter tests (task 2.8). The Claude Code beta span names and
 * attribute encodings are pinned by `fixtures/otlp/claude-traces-beta/*`
 * (captured from CC 2.1.81, scope com.anthropic.claude_code.tracing@1.0.0);
 * unknown shapes are covered by synthetic documents — shape tolerance is the
 * spec, not fixture data.
 */

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const fixtures = join(repoRoot, 'fixtures', 'otlp');
const SIMPLE_SESSION = 'c49f23a4-0e3a-4ef9-be02-1b115c13a98e';

async function runOn(runRef: string, redact = false): Promise<Run> {
  const candidates = await otlpAdapter.detect([fixtures]);
  const candidate = candidates.find((c) => c.runRef.includes(runRef));
  expect(candidate).toBeDefined();
  if (candidate === undefined) throw new Error('unreachable');
  const raw = await otlpAdapter.parse(candidate, { redact });
  return normalize(priceRun(raw), { baseDir: repoRoot });
}

describe('UTF-8 BOM tolerance', () => {
  // PowerShell (>, Out-File, Set-Content -Encoding utf8), Notepad and
  // VS Code's "UTF-8 with BOM" all prepend U+FEFF. readFile keeps it and
  // JSON.parse rejects it, so a valid OTLP capture became invisible and the
  // directory was reported as empty. Linux CI never writes a BOM.
  it('strips a leading BOM', () => {
    expect(stripBom('﻿{}')).toBe('{}');
    expect(stripBom('{}')).toBe('{}');
    expect(stripBom('')).toBe('');
  });

  it('discovers a pretty-printed OTLP document saved with a BOM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runray-otlp-bom-'));
    const doc = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../fixtures/otlp/claude-traces-beta/simple.json',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    writeFileSync(join(dir, 'trace.json'), `﻿${doc}`, 'utf8');
    const candidates = await otlpAdapter.detect([dir]);
    rmSync(dir, { recursive: true, force: true });
    expect(candidates.length).toBe(1);
  });
});
describe('otlp detect', () => {
  it('finds nothing without explicit roots — no zero-config location', async () => {
    expect(await otlpAdapter.detect([])).toHaveLength(0);
  });

  it('emits one candidate per session id found in the documents', async () => {
    const candidates = await otlpAdapter.detect([fixtures]);
    expect(candidates).toHaveLength(2);
    for (const c of candidates) expect(c.format).toBe('otlp-json');
    expect(candidates.some((c) => c.runRef.endsWith(SIMPLE_SESSION))).toBe(
      true,
    );
  });
});

describe('otlp parse (Claude Code beta import — spec scenario)', () => {
  it('maps the pinned claude_code.* names onto span kinds', async () => {
    const run = await runOn(SIMPLE_SESSION);
    const kinds = new Map<string, number>();
    for (const s of run.spans) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
    expect(Object.fromEntries(kinds)).toEqual({
      session: 1, // synthetic root: spans sharing a session id form one run
      turn: 1, // claude_code.interaction
      llm_call: 3, // claude_code.llm_request
      tool_call: 2, // claude_code.tool
      other: 4, // claude_code.tool.blocked_on_user / .execution
    });
    expect(run.source.format).toBe('otlp-json');
  });

  it('reads usage from the pinned bespoke token attrs and prices the model', async () => {
    const run = await runOn(SIMPLE_SESSION);
    const llm = run.spans.find(
      (s) => s.kind === 'llm_call' && s.llm?.model.startsWith('claude-haiku'),
    );
    expect(llm?.llm).toMatchObject({
      provider: 'anthropic',
      tokens: { input: 527, output: 16, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'end_turn',
      costSource: 'computed',
    });
    expect(llm?.name).toBe('claude_code.llm_request');

    const tools = run.spans.filter((s) => s.kind === 'tool_call');
    for (const t of tools) expect(t.name).toBe('claude_code.tool');
    expect(tools.map((t) => t.tool?.name).sort()).toEqual(['Bash', 'Read']);
  });

  it('passes gen_ai.* through unchanged and drops identity attributes', async () => {
    const run = await runOn(SIMPLE_SESSION);
    const llm = run.spans.find((s) => s.kind === 'llm_call');
    const keys = Object.keys(llm?.attributes ?? {});
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.startsWith('gen_ai.')).toBe(true);
    expect(llm?.attributes['gen_ai.system']).toBe('anthropic');
    // decoded from the AnyValue envelope, values intact
    expect(llm?.attributes['gen_ai.response.finish_reasons']).toEqual([
      'end_turn',
    ]);
    // identity attrs must never reach the normalized output
    expect(keys).not.toContain('user.email');
    expect(keys).not.toContain('organization.id');
  });

  it('subagent nesting follows the span parent links', async () => {
    const run = await runOn('4ef60afa-89ea-4cb8-a831-cc7e4b90445f');
    // the subagent's llm/tool spans nest under the spawning tool's execution
    // span — depth alone proves the chain (no synthetic subagent spans)
    expect(run.totals.counts.maxDepth).toBe(5);
    const nestedLlm = run.spans.filter(
      (s) => s.kind === 'llm_call' && s.depth >= 4,
    );
    expect(nestedLlm.length).toBeGreaterThan(0);
    expect(run.warnings).toBeUndefined();
  });

  it('nulls the prompt under --redact', async () => {
    const run = await runOn(SIMPLE_SESSION, true);
    const turn = run.spans.find((s) => s.kind === 'turn');
    expect(turn?.content).toEqual({ promptPreview: null });
  });
});

describe('otlp unknown shapes (spec scenario)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'runray-otlp-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('degrades unrecognized spans to kind: other and never fails the import', async () => {
    const file = join(tmp, 'weird.json');
    writeFileSync(
      file,
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'b'.repeat(32),
                    spanId: 'c'.repeat(16),
                    name: 'custom.agent.weird_span',
                    startTimeUnixNano: '1783425685375000000',
                    attributes: [
                      { key: 'session.id', value: { stringValue: 'ses-x' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const candidate: Candidate = {
      runRef: `${file}::ses-x`,
      format: 'otlp-json',
      files: [file],
      mtimeMs: 0,
      sizeBytes: 0,
    };
    const raw = await otlpAdapter.parse(candidate, { redact: false });
    const weird = raw.spans.find((s) => s.name === 'custom.agent.weird_span');
    expect(weird?.kind).toBe('other');
  });

  it('filters spans to the candidate session.id when multiple sessions share a file', async () => {
    const file = join(tmp, 'multi-session.json');
    writeFileSync(
      file,
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'a'.repeat(32),
                    spanId: '1'.repeat(16),
                    name: 'claude_code.turn',
                    startTimeUnixNano: '1783425685375000000',
                    attributes: [
                      { key: 'session.id', value: { stringValue: 'ses-a' } },
                    ],
                  },
                  {
                    traceId: 'a'.repeat(32),
                    spanId: '2'.repeat(16),
                    name: 'claude_code.turn',
                    startTimeUnixNano: '1783425685375000000',
                    attributes: [
                      { key: 'session.id', value: { stringValue: 'ses-b' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const candidate: Candidate = {
      runRef: `${file}::ses-a`,
      format: 'otlp-json',
      files: [file],
      mtimeMs: 0,
      sizeBytes: 0,
    };
    const raw = await otlpAdapter.parse(candidate, { redact: false });
    // only ses-a's span plus its synthetic session root
    expect(raw.spans).toHaveLength(2);
    expect(raw.spans[0]?.agent?.sessionId).toBe('ses-a');
  });

  it('drops runray.target display text under --redact, keeps identity keys', async () => {
    const file = join(tmp, 'runray-stamped.json');
    writeFileSync(
      file,
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'd'.repeat(32),
                    spanId: 'e'.repeat(16),
                    name: 'claude_code.tool',
                    startTimeUnixNano: '1783425685375000000',
                    attributes: [
                      { key: 'session.id', value: { stringValue: 'ses-r' } },
                      { key: 'tool_name', value: { stringValue: 'Read' } },
                      {
                        key: 'runray.targetKey',
                        value: { stringValue: 'deadbeefdeadbeef' },
                      },
                      {
                        key: 'runray.targetKind',
                        value: { stringValue: 'file-read' },
                      },
                      {
                        key: 'runray.target',
                        value: { stringValue: 'secret-project-plan.md' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const candidate = (await otlpAdapter.detect([tmp])).find((c) =>
      c.runRef.includes('runray-stamped'),
    );
    if (candidate === undefined) throw new Error('unreachable');

    const open = await otlpAdapter.parse(candidate, { redact: false });
    const openTool = open.spans.find((s) => s.name === 'claude_code.tool');
    expect(openTool?.attributes['runray.target']).toBe(
      'secret-project-plan.md',
    );
    expect(openTool?.attributes['runray.targetKey']).toBe('deadbeefdeadbeef');

    const redacted = await otlpAdapter.parse(candidate, { redact: true });
    const redTool = redacted.spans.find((s) => s.name === 'claude_code.tool');
    // identity survives, the display token does not
    expect(redTool?.attributes['runray.targetKey']).toBe('deadbeefdeadbeef');
    expect(redTool?.attributes['runray.targetKind']).toBe('file-read');
    expect('runray.target' in (redTool?.attributes ?? {})).toBe(false);
  });

  it('detects and parses .jsonl files with multiple OTLP objects separated by newlines', async () => {
    const file = join(tmp, 'traces.jsonl');
    const span = (id: string, session: string) => ({
      traceId: 'f'.repeat(32),
      spanId: id.repeat(16),
      name: 'claude_code.interaction',
      startTimeUnixNano: '1783425685375000000',
      attributes: [{ key: 'session.id', value: { stringValue: session } }],
    });
    // Create JSONL file with two separate JSON objects on new lines
    const line1 = JSON.stringify({
      resourceSpans: [{ scopeSpans: [{ spans: [span('1', 'ses-c')] }] }],
    });
    const line2 = JSON.stringify({
      resourceSpans: [{ scopeSpans: [{ spans: [span('2', 'ses-c')] }] }],
    });
    writeFileSync(file, `${line1}\n${line2}\n`);

    const candidates = await otlpAdapter.detect([tmp]);
    const candidate = candidates.find(
      (c) => c.runRef.includes('traces.jsonl') || c.runRef.includes('ses-c'),
    );
    expect(candidate).toBeDefined();
    if (candidate === undefined) throw new Error('unreachable');

    const raw = await otlpAdapter.parse(candidate, { redact: false });
    // Should have 2 interaction spans + 1 session root = 3
    expect(raw.spans).toHaveLength(3);
    expect(
      raw.spans.filter((s) => s.name === 'claude_code.interaction'),
    ).toHaveLength(2);
  });
});

describe('otlp metrics ingestion', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'runray-otlp-metrics-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('correlates metrics.jsonl token and cost usage with traces from traces.jsonl', async () => {
    const tracesFile = join(tmp, 'traces.jsonl');
    const metricsFile = join(tmp, 'metrics.jsonl');

    // Write trace with an LLM call
    writeFileSync(
      tracesFile,
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'g'.repeat(32),
                    spanId: '1'.repeat(16),
                    name: 'claude_code.llm_request',
                    startTimeUnixNano: '1783425685375000000',
                    attributes: [
                      {
                        key: 'session.id',
                        value: { stringValue: 'ses-metrics' },
                      },
                      { key: 'model', value: { stringValue: 'claude-opus' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    // Write metrics decoupled from the trace
    writeFileSync(
      metricsFile,
      JSON.stringify({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'opencode.token.usage',
                    sum: {
                      dataPoints: [
                        {
                          attributes: [
                            {
                              key: 'session.id',
                              value: { stringValue: 'ses-metrics' },
                            },
                            { key: 'type', value: { stringValue: 'input' } },
                          ],
                          asDouble: 100,
                        },
                        {
                          attributes: [
                            {
                              key: 'session.id',
                              value: { stringValue: 'ses-metrics' },
                            },
                            { key: 'type', value: { stringValue: 'output' } },
                          ],
                          asDouble: 50,
                        },
                      ],
                    },
                  },
                  {
                    name: 'opencode.cost.usage',
                    sum: {
                      dataPoints: [
                        {
                          attributes: [
                            {
                              key: 'session.id',
                              value: { stringValue: 'ses-metrics' },
                            },
                          ],
                          asDouble: 0.75,
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const candidates = await otlpAdapter.detect([tmp]);
    const candidate = candidates.find((c) => c.runRef.includes('ses-metrics'));
    expect(candidate).toBeDefined();
    if (candidate === undefined) throw new Error('unreachable');

    // Both files should be part of the candidate
    expect(candidate.files).toHaveLength(2);

    const raw = await otlpAdapter.parse(candidate, { redact: false });
    const run = normalize(priceRun(raw), { baseDir: repoRoot });

    // Ensure tokens and cost were extracted and correlated to the LLM call span
    const llmCall = run.spans.find((s) => s.kind === 'llm_call');
    expect(llmCall).toBeDefined();
    expect(llmCall?.llm?.tokens.input).toBe(100);
    expect(llmCall?.llm?.tokens.output).toBe(50);
    expect(llmCall?.llm?.costUSD).toBeCloseTo(0.75);

    // Verify run totals reflect the metrics
    expect(run.totals.tokens.input).toBe(100);
    expect(run.totals.costUSD.total).toBeCloseTo(0.75);
  });
});

describe('otlp parse errors', () => {
  it('reports a clear error for a broken document handed directly to parse', async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), 'runray-otlp-bad-'));
    const file = join(tmp2, 'broken.json');
    writeFileSync(file, '{"resourceSpans": [truncated');
    const candidate: Candidate = {
      runRef: `${file}::x`,
      format: 'otlp-json',
      files: [file],
      mtimeMs: 0,
      sizeBytes: 0,
    };
    await expect(
      otlpAdapter.parse(candidate, { redact: false }),
    ).rejects.toThrow(/cannot parse OTLP\/JSON/);
    rmSync(tmp2, { recursive: true, force: true });
  });
});
