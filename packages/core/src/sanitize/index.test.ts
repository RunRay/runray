import type { Run, Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import {
  createIdentityTable,
  isAttributeAllowed,
  scrubIdentity,
  scrubIdentityRuns,
} from './identity.js';
import { createManifest } from './manifest.js';
import {
  assertNoPathShapes,
  findPathShapes,
  hasPathShape,
} from './path-net.js';
import { profileIntents, resolveProfile } from './profile.js';
import { pruneToMetadata } from './prune.js';
import { sanitize, sanitizeRun, sanitizeTraceFile } from './sanitize.js';

describe('1.1 Profile contract & resolver', () => {
  it('resolves every combination of the three intents to exactly one profile', () => {
    // 8 standard combinations
    expect(
      resolveProfile({
        stripText: false,
        scrubIdentity: false,
        pruneSpans: false,
      }),
    ).toBe('full');
    expect(
      resolveProfile({
        stripText: true,
        scrubIdentity: false,
        pruneSpans: false,
      }),
    ).toBe('full');
    expect(
      resolveProfile({
        stripText: false,
        scrubIdentity: true,
        pruneSpans: false,
      }),
    ).toBe('full');
    expect(
      resolveProfile({
        stripText: true,
        scrubIdentity: true,
        pruneSpans: false,
      }),
    ).toBe('sanitized');
    expect(
      resolveProfile({
        stripText: false,
        scrubIdentity: false,
        pruneSpans: true,
      }),
    ).toBe('metadata-only');
    expect(
      resolveProfile({
        stripText: true,
        scrubIdentity: false,
        pruneSpans: true,
      }),
    ).toBe('metadata-only');
    expect(
      resolveProfile({
        stripText: false,
        scrubIdentity: true,
        pruneSpans: true,
      }),
    ).toBe('metadata-only');
    expect(
      resolveProfile({
        stripText: true,
        scrubIdentity: true,
        pruneSpans: true,
      }),
    ).toBe('metadata-only');
  });

  it('handles alias intent keys (textRedacted, pathsScrubbed, spansPruned)', () => {
    expect(
      resolveProfile({
        textRedacted: true,
        pathsScrubbed: true,
        spansPruned: false,
      }),
    ).toBe('sanitized');
    expect(resolveProfile({ spansPruned: true })).toBe('metadata-only');
    expect(
      resolveProfile({
        textRedacted: true,
        pathsScrubbed: false,
        spansPruned: false,
      }),
    ).toBe('full');
  });

  it('handles string profile names idempotently', () => {
    expect(resolveProfile('full')).toBe('full');
    expect(resolveProfile('sanitized')).toBe('sanitized');
    expect(resolveProfile('metadata-only')).toBe('metadata-only');
    expect(resolveProfile(undefined)).toBe('full');
  });

  it('full profile is a no-op returning its input verbatim', () => {
    const mockRun = createMockRun();
    const result = sanitizeRun(mockRun, 'full');
    expect(result).toBe(mockRun);
  });

  it('returns canonical profile intents', () => {
    expect(profileIntents('full')).toEqual({
      stripText: false,
      scrubIdentity: false,
      pruneSpans: false,
    });
    expect(profileIntents('sanitized')).toEqual({
      stripText: true,
      scrubIdentity: true,
      pruneSpans: false,
    });
    expect(profileIntents('metadata-only')).toEqual({
      stripText: true,
      scrubIdentity: true,
      pruneSpans: true,
    });
  });
});

describe('1.2 scrubIdentity & deterministic mapping', () => {
  it('assigns ordinals in lexicographical order across 3 independent namespaces', () => {
    const runA: Run = {
      ...createMockRun(),
      id: 'run-a',
      project: {
        path: '/Users/zeta/project-z',
        name: 'project-z',
        gitBranch: 'feature/z',
      },
      source: {
        tool: 'claude-code',
        format: 'claude-jsonl',
        files: ['/Users/zeta/.claude/transcripts/b.jsonl'],
      },
      warnings: [{ message: 'warn', file: '/Users/zeta/warn.jsonl' }],
      spans: [
        {
          ...createMockSpan('s1', 'session'),
          provenance: {
            file: '/Users/zeta/.claude/transcripts/b.jsonl',
            recordId: '1',
          },
        },
      ],
    };

    const runB: Run = {
      ...createMockRun(),
      id: 'run-b',
      project: {
        path: '/Users/alpha/project-a',
        name: 'project-a',
        gitBranch: 'main',
      },
      source: {
        tool: 'claude-code',
        format: 'claude-jsonl',
        files: ['/Users/alpha/.claude/transcripts/a.jsonl'],
      },
      spans: [
        {
          ...createMockSpan('s2', 'session'),
          provenance: {
            file: '/Users/alpha/.claude/transcripts/a.jsonl',
            recordId: '1',
          },
        },
      ],
    };

    // Shared table built over [runA, runB]
    const table = createIdentityTable([runA, runB]);
    expect(table.projects.get('/Users/alpha/project-a')).toBe('project-1');
    expect(table.projects.get('/Users/zeta/project-z')).toBe('project-2');
    expect(table.branches.get('feature/z')).toBe('branch-1');
    expect(table.branches.get('main')).toBe('branch-2');
    expect(
      table.transcripts.get('/Users/alpha/.claude/transcripts/a.jsonl'),
    ).toBe('transcript-1');
    expect(
      table.transcripts.get('/Users/zeta/.claude/transcripts/b.jsonl'),
    ).toBe('transcript-2');
    expect(table.transcripts.get('/Users/zeta/warn.jsonl')).toBe(
      'transcript-3',
    );

    const scrubbedA = scrubIdentity(runA, table);
    expect(scrubbedA.project?.path).toBe('project-2');
    expect(scrubbedA.project?.name).toBe('project-2');
    expect(scrubbedA.project?.gitBranch).toBe('branch-1');
    expect(scrubbedA.source.files).toEqual(['transcript-2']);
    expect(scrubbedA.warnings?.[0]?.file).toBe('transcript-3');
    expect(scrubbedA.spans[0]?.provenance.file).toBe('transcript-2');

    const scrubbedB = scrubIdentity(runB, table);
    expect(scrubbedB.project?.path).toBe('project-1');
    expect(scrubbedB.project?.name).toBe('project-1');
    expect(scrubbedB.project?.gitBranch).toBe('branch-2');
    expect(scrubbedB.source.files).toEqual(['transcript-1']);
    expect(scrubbedB.spans[0]?.provenance.file).toBe('transcript-1');
  });

  it('discovery-order independence: table is identical regardless of run ordering', () => {
    const runA: Run = {
      ...createMockRun(),
      project: { path: '/Users/z/work', name: 'work' },
      source: {
        tool: 'claude-code',
        format: 'claude-jsonl',
        files: ['/path/z.json'],
      },
    };
    const runB: Run = {
      ...createMockRun(),
      project: { path: '/Users/a/work', name: 'work' },
      source: {
        tool: 'claude-code',
        format: 'claude-jsonl',
        files: ['/path/a.json'],
      },
    };

    const table1 = createIdentityTable([runA, runB]);
    const table2 = createIdentityTable([runB, runA]);

    expect(Array.from(table1.projects.entries())).toEqual(
      Array.from(table2.projects.entries()),
    );
    expect(Array.from(table1.transcripts.entries())).toEqual(
      Array.from(table2.transcripts.entries()),
    );
  });

  it('is pure: original input run is completely unchanged', () => {
    const original = createMockRun();
    const deepClone = JSON.parse(JSON.stringify(original));
    scrubIdentity(original);
    expect(original).toEqual(deepClone);
  });

  it('drops run.title and deletes target display attributes', () => {
    const run: Run = {
      ...createMockRun(),
      title: 'Real prompt query about billing',
      spans: [
        {
          ...createMockSpan('s1', 'tool_call'),
          attributes: {
            'runray.target': 'Invoice.tsx',
            'runray.targetKey': 'abcdef0123456789',
            'runray.targetKind': 'file-read',
            'tracepulse.target': 'Invoice.tsx',
            'tracepulse.targetKey': 'abcdef0123456789',
          },
        },
      ],
    };

    const scrubbed = scrubIdentity(run);
    expect(scrubbed.title).toBeUndefined();
    expect(scrubbed.spans[0]?.attributes).toEqual({
      'runray.targetKey': 'abcdef0123456789',
      'runray.targetKind': 'file-read',
      'tracepulse.targetKey': 'abcdef0123456789',
    });
    expect(scrubbed.spans[0]?.attributes?.['runray.target']).toBeUndefined();
    expect(
      scrubbed.spans[0]?.attributes?.['tracepulse.target'],
    ).toBeUndefined();
  });
});

describe('1.3 Attribute allowlist', () => {
  it('allows gen_ai.*, runray.* (except target), and tracepulse.* (except target)', () => {
    expect(isAttributeAllowed('gen_ai.request.model')).toBe(true);
    expect(isAttributeAllowed('gen_ai.usage.input_tokens')).toBe(true);
    expect(isAttributeAllowed('runray.targetKey')).toBe(true);
    expect(isAttributeAllowed('runray.targetKind')).toBe(true);
    expect(isAttributeAllowed('runray.cache_write_1h_tokens')).toBe(true);
    expect(isAttributeAllowed('runray.mcpDetection')).toBe(true);
    expect(isAttributeAllowed('tracepulse.targetKey')).toBe(true);
    expect(isAttributeAllowed('tracepulse.mcpDetection')).toBe(true);

    expect(isAttributeAllowed('runray.target')).toBe(false);
    expect(isAttributeAllowed('tracepulse.target')).toBe(false);
    expect(isAttributeAllowed('custom.vendor_path')).toBe(false);
    expect(isAttributeAllowed('http.url')).toBe(false);
    expect(isAttributeAllowed('file.path')).toBe(false);
  });

  it('drops vendor attributes with paths from OTLP spans without inspecting values', () => {
    const run: Run = {
      ...createMockRun(),
      spans: [
        {
          ...createMockSpan('s1', 'llm_call'),
          attributes: {
            'gen_ai.request.model': 'claude-3-5-sonnet-20241022',
            'vendor.user_directory': '/Users/alex/secret/path',
            'custom.env': 'production',
            'runray.targetKey': '1234567890abcdef',
            'runray.target': 'secret.txt',
          },
        },
      ],
    };

    const scrubbed = scrubIdentity(run);
    expect(scrubbed.spans[0]?.attributes).toEqual({
      'gen_ai.request.model': 'claude-3-5-sonnet-20241022',
      'runray.targetKey': '1234567890abcdef',
    });
  });
});

describe('1.4 Path-shape net matcher & assertion', () => {
  it('detects Unix /Users/... and /home/... paths case-insensitively', () => {
    expect(findPathShapes('/Users/alex/work/app')).toHaveLength(1);
    expect(findPathShapes('/users/alex/work/app')).toHaveLength(1);
    expect(findPathShapes('/home/ubuntu/repo')).toHaveLength(1);
    expect(findPathShapes('/HOME/ubuntu/repo')).toHaveLength(1);
  });

  it('detects Windows C:\\Users\\... and C:/Users/... and JSON escaped forms', () => {
    expect(findPathShapes('C:\\Users\\Alex\\Documents')).toHaveLength(1);
    expect(findPathShapes('c:/users/alex/documents')).toHaveLength(1);
    expect(findPathShapes('D:\\\\Users\\\\runner\\\\work')).toHaveLength(1);
  });

  it('detects file:// URLs, UNC paths, and \\\\?\\ device paths', () => {
    expect(findPathShapes('file:///Users/alex/code/index.ts')).toHaveLength(1);
    expect(findPathShapes('\\\\server\\share\\path')).toHaveLength(1);
    expect(findPathShapes('\\\\?\\C:\\Users\\alex')).toHaveLength(1);
  });

  it('assertNoPathShapes throws with matches and known basenames', () => {
    expect(() =>
      assertNoPathShapes('contains /Users/alex/billing and clean text', [
        'billing',
      ]),
    ).toThrow(/Path-shape totality assertion failed/);

    expect(() =>
      assertNoPathShapes('clean serialized project-1 and transcript-1', [
        'secret-app',
      ]),
    ).not.toThrow();

    expect(() =>
      assertNoPathShapes('clean text with secret-app inside', ['secret-app']),
    ).toThrow(/found known project basename/);
  });
});

describe('1.5 pruneToMetadata', () => {
  it('retains session and subagent spans, drops llm_call, tool_call, mcp_call, hook', () => {
    const sessionSpan = createMockSpan('span-session', 'session', null);
    const subagentSpan = createMockSpan(
      'span-subagent',
      'subagent',
      'span-session',
    );
    const llmSpan = createMockSpan('span-llm', 'llm_call', 'span-subagent');
    const toolSpan = createMockSpan('span-tool', 'tool_call', 'span-subagent');
    const mcpSpan = createMockSpan('span-mcp', 'mcp_call', 'span-session');
    const hookSpan = createMockSpan('span-hook', 'hook', 'span-session');

    const run: Run = {
      ...createMockRun(),
      spans: [sessionSpan, subagentSpan, llmSpan, toolSpan, mcpSpan, hookSpan],
      insights: [
        {
          id: 'ins-1',
          ruleId: 'test-rule',
          severity: 'info',
          title: 'Test',
          detail: 'Test detail',
          spanIds: ['span-llm', 'span-tool'],
        },
      ],
    };

    const pruned = pruneToMetadata(run);
    expect(pruned.spans.map((s) => s.id)).toEqual([
      'span-session',
      'span-subagent',
    ]);
    expect(pruned.spans.map((s) => s.kind)).toEqual(['session', 'subagent']);
  });

  it('re-anchors parentId and insight evidence to nearest surviving ancestor and dedupes', () => {
    const session = createMockSpan('session-1', 'session', null);
    const subagent = createMockSpan('subagent-1', 'subagent', 'session-1');
    const tool1 = createMockSpan('tool-1', 'tool_call', 'subagent-1');
    const tool2 = createMockSpan('tool-2', 'tool_call', 'tool-1'); // nested under dropped tool
    const subagent2 = createMockSpan('subagent-2', 'subagent', 'tool-2'); // nested under dropped tool

    const run: Run = {
      ...createMockRun(),
      spans: [session, subagent, tool1, tool2, subagent2],
      insights: [
        {
          id: 'ins-1',
          ruleId: 'rule-1',
          severity: 'warning',
          title: 'Evidence under dropped tool',
          detail: 'Detail',
          spanIds: ['tool-1', 'tool-2'],
        },
        {
          id: 'ins-2',
          ruleId: 'rule-2',
          severity: 'info',
          title: 'Surviving subagent evidence',
          detail: 'Detail',
          spanIds: ['subagent-1'],
        },
      ],
    };

    const pruned = pruneToMetadata(run);
    // subagent-2's parent was tool-2 -> tool-1 -> subagent-1
    const prunedSub2 = pruned.spans.find((s) => s.id === 'subagent-2');
    expect(prunedSub2?.parentId).toBe('subagent-1');

    // rule-1 evidence tool-1 & tool-2 re-anchor to subagent-1 and dedupe to ['subagent-1']
    expect(pruned.insights[0]?.spanIds).toEqual(['subagent-1']);
    expect(pruned.insights[1]?.spanIds).toEqual(['subagent-1']);
  });

  it('empties insight spanIds when no ancestor survives and leaves totals byte-identical', () => {
    const orphanTool = createMockSpan('orphan-tool', 'tool_call', null);
    const run: Run = {
      ...createMockRun(),
      spans: [orphanTool],
      insights: [
        {
          id: 'ins-orphan',
          ruleId: 'orphan-rule',
          severity: 'info',
          title: 'Orphan finding',
          detail: 'Detail',
          spanIds: ['orphan-tool'],
        },
      ],
    };

    const pruned = pruneToMetadata(run);
    expect(pruned.spans).toEqual([]);
    expect(pruned.insights[0]?.spanIds).toEqual([]);
    expect(pruned.totals).toEqual(run.totals);
  });

  it('guarantees no unresolvable span references in output', () => {
    const session = createMockSpan('sess', 'session', null);
    const subagent = createMockSpan('sub', 'subagent', 'sess');
    const llm = createMockSpan('llm', 'llm_call', 'sub');

    const run: Run = {
      ...createMockRun(),
      spans: [session, subagent, llm],
      insights: [
        {
          id: 'ins-1',
          ruleId: 'r1',
          severity: 'info',
          title: 't',
          detail: 'd',
          spanIds: ['llm', 'sub'],
        },
      ],
    };

    const pruned = pruneToMetadata(run);
    const survivingSpanIds = new Set(pruned.spans.map((s) => s.id));

    for (const span of pruned.spans) {
      if (span.parentId !== null) {
        expect(survivingSpanIds.has(span.parentId)).toBe(true);
      }
    }

    for (const insight of pruned.insights) {
      for (const id of insight.spanIds) {
        expect(survivingSpanIds.has(id)).toBe(true);
      }
    }
  });
});

describe('1.6 Manifest producer', () => {
  it('creates manifest for full, sanitized, and metadata-only profiles', () => {
    expect(createManifest('full')).toEqual({
      profile: 'full',
      textRedacted: false,
      pathsScrubbed: false,
      spansPruned: false,
    });
    expect(createManifest('sanitized')).toEqual({
      profile: 'sanitized',
      textRedacted: true,
      pathsScrubbed: true,
      spansPruned: false,
    });
    expect(createManifest('metadata-only')).toEqual({
      profile: 'metadata-only',
      textRedacted: true,
      pathsScrubbed: true,
      spansPruned: true,
    });
  });

  it('records independent boolean states when explicit intents are provided', () => {
    expect(createManifest('full', { textRedacted: true })).toEqual({
      profile: 'full',
      textRedacted: true,
      pathsScrubbed: false,
      spansPruned: false,
    });
    expect(createManifest('full', { pathsScrubbed: true })).toEqual({
      profile: 'full',
      textRedacted: false,
      pathsScrubbed: true,
      spansPruned: false,
    });
  });

  it('contains no filesystem path', () => {
    const m = createManifest('metadata-only');
    const json = JSON.stringify(m);
    expect(hasPathShape(json)).toBe(false);
    expect(json).not.toContain('/');
    expect(json).not.toContain('\\');
  });
});

describe('Full sanitize projection', () => {
  it('sanitizes run and traceFile pure in-memory', () => {
    const run: Run = {
      ...createMockRun(),
      title: 'Prompt Title',
      project: { path: '/Users/alex/proj', name: 'proj' },
      source: {
        tool: 'claude-code',
        format: 'claude-jsonl',
        files: ['/Users/alex/transcripts/1.json'],
      },
      spans: [
        {
          ...createMockSpan('s1', 'session'),
          content: { promptPreview: 'Secret user prompt' },
          provenance: {
            file: '/Users/alex/transcripts/1.json',
            recordId: '1',
          },
        },
      ],
    };

    const sanitized = sanitize(run, 'sanitized');
    expect(sanitized.title).toBeUndefined();
    expect(sanitized.project?.path).toBe('project-1');
    expect(sanitized.spans[0]?.content).toEqual({ promptPreview: null });
    expect(sanitized.spans[0]?.provenance.file).toBe('transcript-1');
    expect(hasPathShape(JSON.stringify(sanitized))).toBe(false);
  });

  it('scrubIdentityRuns and sanitizeTraceFile apply across multiple runs', () => {
    const run1 = createMockRun();
    const run2 = {
      ...createMockRun(),
      id: 'run-mock-5678',
      project: { path: '/Users/bob/other', name: 'other' },
    };

    const scrubbedRuns = scrubIdentityRuns([run1, run2]);
    expect(scrubbedRuns[0]?.project?.name).toBe('project-1');
    expect(scrubbedRuns[1]?.project?.name).toBe('project-2');

    const traceFile = {
      schemaVersion: '0.1.0' as const,
      generator: { name: 'runray', version: '0.1.0-test' },
      generatedAt: '2026-08-20T10:00:00.000Z',
      runs: [run1, run2],
    };

    const sanitizedTrace = sanitizeTraceFile(traceFile, 'sanitized');
    expect(sanitizedTrace.runs[0]?.project?.name).toBe('project-1');
    expect(sanitizedTrace.runs[1]?.project?.name).toBe('project-2');

    const polymorphicTrace = sanitize(traceFile, 'metadata-only');
    expect(polymorphicTrace.runs.length).toBe(2);
  });
});

function createMockSpan(
  id: string,
  kind: Span['kind'],
  parentId: string | null = null,
): Span {
  return {
    id,
    parentId,
    kind,
    name: `mock-${kind}`,
    status: 'ok',
    startedAt: '2026-08-20T10:00:00.000Z',
    durationMs: 100,
    depth: parentId === null ? 0 : 1,
    attributes: {},
    provenance: { file: '/default/transcript.json', recordId: id },
  };
}

function createMockRun(): Run {
  return {
    id: 'run-mock-1234',
    startedAt: '2026-08-20T10:00:00.000Z',
    source: {
      tool: 'claude-code',
      format: 'claude-jsonl',
      files: ['/Users/alex/.claude/transcripts/session.jsonl'],
    },
    project: {
      path: '/Users/alex/work/my-app',
      name: 'my-app',
      gitBranch: 'main',
    },
    totals: {
      costUSD: { total: 0.05, wastedEstimate: 0, byModel: {} },
      counts: {
        llmCalls: 0,
        toolCalls: 0,
        toolErrors: 0,
        subagents: 0,
        maxDepth: 0,
      },
      tokens: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        total: 150,
      },
      cache: { hitRate: 0 },
    },
    spans: [createMockSpan('span-root', 'session')],
    insights: [],
    warnings: [],
  };
}
