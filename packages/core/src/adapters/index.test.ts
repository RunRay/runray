import type { Span } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import type { Candidate, RawRun, RawSpan, SourceAdapter } from '../adapter.js';
import { createAdapterRegistry } from './index.js';

const sampleCandidate: Candidate = {
  runRef: '/home/user/project/session.jsonl',
  format: 'claude-jsonl',
  files: ['/home/user/project/session.jsonl'],
  mtimeMs: 1_750_000_000_000,
  sizeBytes: 1024,
};

const sampleRawSpan: RawSpan = {
  id: 's1',
  parentId: null,
  kind: 'session',
  name: 'session',
  status: 'ok',
  startedAt: '2026-07-02T13:02:10Z',
  attributes: {},
  provenance: { file: 'session.jsonl', line: 1 },
};

// Compile-time contract: a RawSpan plus derived `depth` must be a valid Span.
const _derivedSpan: Span = { ...sampleRawSpan, depth: 0 };

function fakeAdapter(id: SourceAdapter['id']): SourceAdapter {
  const rawRun: RawRun = {
    source: { tool: id, format: 'claude-jsonl', files: sampleCandidate.files },
    spans: [sampleRawSpan],
    warnings: [],
  };
  return {
    id,
    defaultRoots: () => [],
    detect: () => Promise.resolve([sampleCandidate]),
    parse: () => Promise.resolve(rawRun),
  };
}

describe('adapter default roots (A1)', () => {
  it('claude-code exposes ~/.claude/projects', async () => {
    const { claudeCodeAdapter } = await import('./claude-code.js');
    const roots = claudeCodeAdapter.defaultRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0]?.replace(/\\/g, '/')).toMatch(/\.claude\/projects$/);
  });

  it('opencode honors OPENCODE_DATA_DIR (comma-split), else XDG default', async () => {
    const { opencodeAdapter } = await import('./opencode.js');
    const prev = process.env.OPENCODE_DATA_DIR;
    try {
      process.env.OPENCODE_DATA_DIR = '/tmp/a,/tmp/b';
      expect(opencodeAdapter.defaultRoots()).toEqual(['/tmp/a', '/tmp/b']);
      delete process.env.OPENCODE_DATA_DIR;
      const roots = opencodeAdapter.defaultRoots();
      expect(roots).toHaveLength(1);
      expect(roots[0]?.replace(/\\/g, '/')).toMatch(
        /\.local\/share\/opencode$/,
      );
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_DATA_DIR;
      else process.env.OPENCODE_DATA_DIR = prev;
    }
  });

  it('otlp is import-only: no default roots, nothing for watch', async () => {
    const { otlpAdapter } = await import('./otlp.js');
    expect(otlpAdapter.defaultRoots()).toEqual([]);
  });
});

describe('adapter registry', () => {
  it('returns adapters in registration (priority) order', () => {
    const registry = createAdapterRegistry();
    registry.register(fakeAdapter('claude-code'));
    registry.register(fakeAdapter('opencode'));
    registry.register(fakeAdapter('otlp'));
    expect(registry.all().map((a) => a.id)).toEqual([
      'claude-code',
      'opencode',
      'otlp',
    ]);
  });

  it('looks up an adapter by id', () => {
    const registry = createAdapterRegistry();
    registry.register(fakeAdapter('opencode'));
    expect(registry.get('opencode')?.id).toBe('opencode');
    expect(registry.get('claude-code')).toBeUndefined();
  });

  it('rejects duplicate registration', () => {
    const registry = createAdapterRegistry();
    registry.register(fakeAdapter('claude-code'));
    expect(() => registry.register(fakeAdapter('claude-code'))).toThrow(
      /already registered/,
    );
  });

  it('adapter contract round-trips: detect -> parse -> RawRun', async () => {
    const adapter = fakeAdapter('claude-code');
    const [candidate] = await adapter.detect(['/home/user']);
    expect(candidate).toBeDefined();
    const rawRun = await adapter.parse(candidate as Candidate, {
      redact: false,
    });
    expect(rawRun.source.tool).toBe('claude-code');
    expect(rawRun.spans).toHaveLength(1);
    expect(rawRun.warnings).toEqual([]);
  });
});
