import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunSchema } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { adapters } from './adapters/index.js';
import { applyInsights } from './insights/index.js';
import { normalize } from './normalize.js';
import { priceRun } from './pricing/index.js';
import {
  createIdentityTable,
  pruneToMetadata,
  type SanitizeProfile,
  scrubIdentity,
} from './sanitize/index.js';

/**
 * Golden tests: every committed fixture must normalize to the byte-identical
 * output committed in fixtures/normalized/ (full), fixtures/sanitized/ (sanitized),
 * and fixtures/metadata-only/ (metadata-only). Regenerate deliberately with
 * `pnpm goldens` (dedicated commit — AGENTS.md).
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixturesDir = join(repoRoot, 'fixtures');
const normalizedDir = join(fixturesDir, 'normalized');
const sanitizedDir = join(fixturesDir, 'sanitized');
const metadataOnlyDir = join(fixturesDir, 'metadata-only');

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

interface Expected {
  goldenPath: string;
  adapterId: string;
  variant: string;
  candidateIndex: number;
  profile: SanitizeProfile;
}

const PROFILE_DIRS: Record<SanitizeProfile, string> = {
  full: normalizedDir,
  sanitized: sanitizedDir,
  'metadata-only': metadataOnlyDir,
};

async function expectedGoldens(
  profile: SanitizeProfile = 'full',
): Promise<Expected[]> {
  const out: Expected[] = [];
  const baseDir = PROFILE_DIRS[profile];
  for (const adapter of adapters.all()) {
    for (const variant of safeDirs(join(fixturesDir, adapter.id))) {
      if (variant === 'large') continue; // machine-local, not committed
      const candidates = (
        await adapter.detect([join(fixturesDir, adapter.id, variant)])
      ).filter((c) => !/[\\/]raw[\\/]/.test(c.runRef));
      for (const [i, _] of candidates.entries()) {
        const name =
          candidates.length === 1
            ? `${variant}.json`
            : `${variant}-${i + 1}.json`;
        out.push({
          goldenPath: join(baseDir, adapter.id, name),
          adapterId: adapter.id,
          variant,
          candidateIndex: i,
          profile,
        });
      }
    }
  }
  return out;
}

describe('goldens', () => {
  const profiles: SanitizeProfile[] = ['full', 'sanitized', 'metadata-only'];

  for (const profile of profiles) {
    it(`every committed fixture has a byte-stable, schema-valid golden (${profile})`, async () => {
      const expected = await expectedGoldens(profile);
      expect(expected.length).toBeGreaterThan(0);

      for (const {
        goldenPath,
        adapterId,
        variant,
        candidateIndex,
      } of expected) {
        expect(
          existsSync(goldenPath),
          `missing golden: ${goldenPath} — run pnpm goldens`,
        ).toBe(true);
        const golden = readFileSync(goldenPath, 'utf8');

        // schema-valid against the frozen contract
        RunSchema.parse(JSON.parse(golden));

        // byte-stable: a fresh pipeline run reproduces the committed golden
        const adapter = adapters.get(adapterId as never);
        expect(adapter).toBeDefined();
        if (!adapter) continue;
        const candidates = (
          await adapter.detect([join(fixturesDir, adapterId, variant)])
        ).filter((c) => !/[\\/]raw[\\/]/.test(c.runRef));
        const candidate = candidates[candidateIndex];
        expect(candidate).toBeDefined();
        if (!candidate) continue;

        if (profile === 'full') {
          const run = applyInsights(
            normalize(
              priceRun(await adapter.parse(candidate, { redact: false })),
              {
                baseDir: repoRoot,
              },
            ),
          );
          expect(
            `${JSON.stringify(run, null, 2)}\n`,
            `golden drift: ${goldenPath}`,
          ).toBe(golden);
        } else {
          const raw = await adapter.parse(candidate, { redact: true });
          const norm = normalize(priceRun(raw), { baseDir: repoRoot });
          const table = createIdentityTable([norm]);
          const runSanitized = applyInsights(scrubIdentity(norm, table));
          const run =
            profile === 'metadata-only'
              ? pruneToMetadata(runSanitized)
              : runSanitized;
          expect(
            `${JSON.stringify(run, null, 2)}\n`,
            `golden drift: ${goldenPath}`,
          ).toBe(golden);
        }
      }
    }, 60_000);

    it(`no stale goldens exist without a matching fixture (${profile})`, async () => {
      const dir = PROFILE_DIRS[profile];
      const expected = new Set(
        (await expectedGoldens(profile)).map((e) => e.goldenPath),
      );
      for (const adapterDir of safeDirs(dir)) {
        for (const file of readdirSync(join(dir, adapterDir))) {
          expect(expected.has(join(dir, adapterDir, file))).toBe(true);
        }
      }
    }, 60_000);
  }
});
