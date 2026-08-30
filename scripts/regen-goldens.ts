/**
 * regen-goldens.ts — regenerates `fixtures/normalized/` golden outputs from
 * the committed fixtures (task 2.6).
 *
 * Rules (AGENTS.md): goldens are regenerated ONLY via this script, and land
 * in a dedicated commit with a justification. If a code change makes goldens
 * flap, the change is wrong — not the goldens.
 *
 *   pnpm goldens
 *
 * Output: fixtures/normalized/<source>/<variant>.json — one normalized Run
 * per fixture run, byte-stable, provenance relative to the repo root. The
 * `large` variant is machine-local (git-ignored) and is skipped.
 */
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adapters,
  applyInsights,
  normalize,
  priceRun,
} from '../packages/core/src/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
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

rmSync(normalizedDir, { recursive: true, force: true });

let written = 0;
for (const adapter of adapters.all()) {
  const sourceDir = join(fixturesDir, adapter.id);
  for (const variant of safeDirs(sourceDir)) {
    if (variant === 'large') {
      console.log(
        `skip ${adapter.id}/large — machine-local perf fixture (not committed)`,
      );
      continue;
    }
    const variantDir = join(sourceDir, variant);
    const candidates = (await adapter.detect([variantDir])).filter(
      (c) => !/[\\/]raw[\\/]/.test(c.runRef),
    );
    for (const [i, candidate] of candidates.entries()) {
      const run = applyInsights(
        normalize(priceRun(await adapter.parse(candidate, { redact: false })), {
          baseDir: repoRoot,
        }),
      );
      const name =
        candidates.length === 1
          ? `${variant}.json`
          : `${variant}-${i + 1}.json`;
      const outDir = join(normalizedDir, adapter.id);
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, name);
      writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
      const kb = Math.round(statSync(outPath).size / 1024);
      console.log(
        `wrote fixtures/normalized/${adapter.id}/${name} (${run.spans.length} spans, ${kb} KB)`,
      );
      written++;
    }
  }
}
console.log(
  written > 0
    ? `${written} golden(s) regenerated`
    : 'no fixtures found — nothing written',
);
