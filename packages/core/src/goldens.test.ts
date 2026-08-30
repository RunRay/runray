import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunSchema } from '@runray/schema';
import { describe, expect, it } from 'vitest';
import { adapters } from './adapters/index.js';
import { applyInsights } from './insights/index.js';
import { normalize } from './normalize.js';
import { priceRun } from './pricing/index.js';

/**
 * Golden tests (task 2.6): every committed fixture must normalize to the
 * byte-identical output committed in fixtures/normalized/. Regenerate
 * deliberately with `pnpm goldens` (dedicated commit — AGENTS.md).
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixturesDir = join(repoRoot, 'fixtures');
const normalizedDir = join(fixturesDir, 'normalized');

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
}

async function expectedGoldens(): Promise<Expected[]> {
  const out: Expected[] = [];
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
          goldenPath: join(normalizedDir, adapter.id, name),
          adapterId: adapter.id,
          variant,
          candidateIndex: i,
        });
      }
    }
  }
  return out;
}

describe('goldens', () => {
  it('every committed fixture has a byte-stable, schema-valid golden', async () => {
    const expected = await expectedGoldens();
    expect(expected.length).toBeGreaterThan(0);

    for (const { goldenPath, adapterId, variant, candidateIndex } of expected) {
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
      const run = applyInsights(
        normalize(priceRun(await adapter.parse(candidate, { redact: false })), {
          baseDir: repoRoot,
        }),
      );
      expect(
        `${JSON.stringify(run, null, 2)}\n`,
        `golden drift: ${goldenPath}`,
      ).toBe(golden);
    }
  }, 60_000);

  it('no stale goldens exist without a matching fixture', async () => {
    const expected = new Set(
      (await expectedGoldens()).map((e) => e.goldenPath),
    );
    for (const adapterDir of safeDirs(normalizedDir)) {
      for (const file of readdirSync(join(normalizedDir, adapterDir))) {
        expect(expected.has(join(normalizedDir, adapterDir, file))).toBe(true);
      }
    }
  }, 60_000);
});
