import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Run,
  RunSchema,
  SCHEMA_VERSION,
  TraceFileSchema,
} from '@runray/schema';
import { describe, expect, it } from 'vitest';
import type { Candidate, SourceAdapter } from '../adapter.js';
import { adapters } from '../adapters/index.js';
import { applyInsights } from '../insights/index.js';
import { normalize } from '../normalize.js';
import { priceRun } from '../pricing/index.js';
import { createIdentityTable } from './identity.js';
import { assertNoPathShapes, findPathShapes } from './path-net.js';
import type { SanitizeProfile } from './profile.js';
import { pruneToMetadata } from './prune.js';
import { sanitizeRun } from './sanitize.js';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const fixturesDir = join(repoRoot, 'fixtures');

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

interface FixtureTarget {
  adapter: SourceAdapter;
  variant: string;
  candidateIndex: number;
  candidate: Candidate;
}

async function allFixtureTargets(): Promise<FixtureTarget[]> {
  const targets: FixtureTarget[] = [];
  for (const adapter of adapters.all()) {
    const sourceDir = join(fixturesDir, adapter.id);
    for (const variant of safeDirs(sourceDir)) {
      if (variant === 'large') continue;
      const variantDir = join(sourceDir, variant);
      const candidates = (await adapter.detect([variantDir])).filter(
        (c) => !/[\\/]raw[\\/]/.test(c.runRef),
      );
      for (const [i, candidate] of candidates.entries()) {
        targets.push({
          adapter,
          variant,
          candidateIndex: i,
          candidate,
        });
      }
    }
  }
  return targets;
}

function buildPipelineRun(
  raw: Parameters<typeof normalize>[0],
  profile: SanitizeProfile,
): Run {
  const norm = normalize(priceRun(raw), { baseDir: repoRoot });
  if (profile === 'full') {
    return applyInsights(norm);
  }
  const table = createIdentityTable([norm]);
  const scrubbed = sanitizeRun(norm, 'sanitized', table);
  const withInsights = applyInsights(scrubbed);
  return profile === 'metadata-only'
    ? pruneToMetadata(withInsights)
    : withInsights;
}

export function findFirstDiff(
  a: unknown,
  b: unknown,
  path = '',
): string | null {
  if (a === b) return null;
  if (a === null || b === null || typeof a !== typeof b) {
    return `${path || '<root>'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`;
  }
  if (typeof a !== 'object') {
    return `${path || '<root>'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return `${path || '<root>'}: array mismatch`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return `${path || '<root>'}.length: expected ${b.length}, got ${a.length}`;
    }
    for (let i = 0; i < a.length; i++) {
      const diff = findFirstDiff(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keys = Array.from(
    new Set([...Object.keys(objA), ...Object.keys(objB)]),
  ).sort();
  for (const k of keys) {
    if (!(k in objA)) return `${path ? `${path}.${k}` : k}: missing in A`;
    if (!(k in objB)) return `${path ? `${path}.${k}` : k}: missing in B`;
    const diff = findFirstDiff(objA[k], objB[k], path ? `${path}.${k}` : k);
    if (diff) return diff;
  }
  return null;
}

function extractKnownProjectBasenames(run: Run): string[] {
  const basenames: string[] = [];
  if (run.project?.name) {
    basenames.push(run.project.name);
  }
  if (run.project?.path) {
    const base = basename(run.project.path.replace(/\\/g, '/'));
    if (base && base !== '.' && base !== '/') {
      basenames.push(base);
    }
  }
  return Array.from(new Set(basenames.filter(Boolean)));
}

describe('2. Invariants, fixtures, goldens', () => {
  describe('2.1 Redaction parity invariant (D4)', () => {
    const sanitizingProfiles: SanitizeProfile[] = [
      'sanitized',
      'metadata-only',
    ];

    it('holds across every fixture: sanitize(parse(f, {redact:false})) === sanitize(parse(f, {redact:true}))', async () => {
      const targets = await allFixtureTargets();
      expect(targets.length).toBeGreaterThan(0);

      for (const { adapter, variant, candidateIndex, candidate } of targets) {
        const rawUnredacted = await adapter.parse(candidate, { redact: false });
        const rawRedacted = await adapter.parse(candidate, { redact: true });

        for (const profile of sanitizingProfiles) {
          const unredactedRun = buildPipelineRun(rawUnredacted, profile);
          const redactedRun = buildPipelineRun(rawRedacted, profile);

          const diff = findFirstDiff(unredactedRun, redactedRun);
          expect(
            diff,
            `Redaction parity failed for ${adapter.id}/${variant}#${candidateIndex} under profile "${profile}": ${diff}`,
          ).toBeNull();
          expect(unredactedRun).toEqual(redactedRun);
        }
      }
    }, 60_000);

    it('fails and names the diverging field when an unredacted field leaks', () => {
      const mockA = {
        id: 'run-1',
        spans: [{ id: 's1', content: { promptPreview: 'Secret prompt' } }],
      };
      const mockB = {
        id: 'run-1',
        spans: [{ id: 's1', content: { promptPreview: null } }],
      };

      const diff = findFirstDiff(mockA, mockB);
      expect(diff).toBe(
        'spans[0].content.promptPreview: expected null, got "Secret prompt"',
      );
    });
  });

  describe('2.2 Totality test over serialized output (D3)', () => {
    const sanitizingProfiles: SanitizeProfile[] = [
      'sanitized',
      'metadata-only',
    ];

    it('asserts no path-shape match and no fixture project basenames in serialized output across every fixture', async () => {
      const targets = await allFixtureTargets();
      expect(targets.length).toBeGreaterThan(0);

      for (const { adapter, variant, candidateIndex, candidate } of targets) {
        const rawUnredacted = await adapter.parse(candidate, { redact: false });
        const unredactedNorm = normalize(priceRun(rawUnredacted), {
          baseDir: repoRoot,
        });
        const knownBasenames = extractKnownProjectBasenames(unredactedNorm);

        for (const profile of sanitizingProfiles) {
          const run = buildPipelineRun(rawUnredacted, profile);
          const serialized = JSON.stringify(run);

          // 1. Path shapes regex matching
          const pathShapes = findPathShapes(serialized);
          expect(
            pathShapes,
            `Path shape found in serialized ${adapter.id}/${variant}#${candidateIndex} under ${profile}: ${pathShapes.join(', ')}`,
          ).toEqual([]);

          // 2. Known project basenames must not appear anywhere in serialized output
          for (const base of knownBasenames) {
            expect(
              serialized.includes(base),
              `Known project basename "${base}" leaked in serialized ${adapter.id}/${variant}#${candidateIndex} under ${profile}`,
            ).toBe(false);
          }

          // 3. assertNoPathShapes helper must pass cleanly
          expect(() =>
            assertNoPathShapes(serialized, knownBasenames),
          ).not.toThrow();
        }
      }
    }, 60_000);

    it('fails the test when a path shape or known project basename survives', () => {
      const dirtyOutput = JSON.stringify({
        project: { path: '/Users/alex/work/secret-app', name: 'secret-app' },
      });

      expect(() => assertNoPathShapes(dirtyOutput, ['secret-app'])).toThrow(
        /Path-shape totality assertion failed/,
      );
    });
  });

  describe('2.3 Schema conformance test', () => {
    const allProfiles: SanitizeProfile[] = [
      'full',
      'sanitized',
      'metadata-only',
    ];

    it('validates full, sanitized, and metadata-only output against the RunSchema and TraceFileSchema', async () => {
      const targets = await allFixtureTargets();
      expect(targets.length).toBeGreaterThan(0);

      for (const { adapter, candidate } of targets) {
        const raw = await adapter.parse(candidate, { redact: false });

        for (const profile of allProfiles) {
          const run = buildPipelineRun(raw, profile);

          // 1. Run schema validation
          const parsedRun = RunSchema.parse(run);
          expect(parsedRun.id).toBe(run.id);

          // 2. TraceFile schema validation
          const traceFile = {
            schemaVersion: SCHEMA_VERSION,
            generator: { name: 'runray', version: '0.1.0-test' },
            generatedAt: new Date().toISOString(),
            runs: [run],
          };
          const parsedTrace = TraceFileSchema.parse(traceFile);
          expect(parsedTrace.runs).toHaveLength(1);
        }
      }
    }, 60_000);
  });
});
