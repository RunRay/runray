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
  createIdentityTable,
  normalize,
  priceRun,
  pruneToMetadata,
  scrubIdentity,
} from '../packages/core/src/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
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

rmSync(normalizedDir, { recursive: true, force: true });
rmSync(sanitizedDir, { recursive: true, force: true });
rmSync(metadataOnlyDir, { recursive: true, force: true });

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
      const name =
        candidates.length === 1
          ? `${variant}.json`
          : `${variant}-${i + 1}.json`;

      // 1. full profile golden (fixtures/normalized/)
      const runFull = applyInsights(
        normalize(priceRun(await adapter.parse(candidate, { redact: false })), {
          baseDir: repoRoot,
        }),
      );
      const outDirFull = join(normalizedDir, adapter.id);
      mkdirSync(outDirFull, { recursive: true });
      const outPathFull = join(outDirFull, name);
      writeFileSync(
        outPathFull,
        `${JSON.stringify(runFull, null, 2)}\n`,
        'utf8',
      );
      const kbFull = Math.round(statSync(outPathFull).size / 1024);
      console.log(
        `wrote fixtures/normalized/${adapter.id}/${name} (${runFull.spans.length} spans, ${kbFull} KB)`,
      );
      written++;

      // 2. sanitized profile golden (fixtures/sanitized/)
      const rawRedacted = await adapter.parse(candidate, { redact: true });
      const normRedacted = normalize(priceRun(rawRedacted), {
        baseDir: repoRoot,
      });
      const table = createIdentityTable([normRedacted]);
      const runSanitized = applyInsights(scrubIdentity(normRedacted, table));
      const outDirSanitized = join(sanitizedDir, adapter.id);
      mkdirSync(outDirSanitized, { recursive: true });
      const outPathSanitized = join(outDirSanitized, name);
      writeFileSync(
        outPathSanitized,
        `${JSON.stringify(runSanitized, null, 2)}\n`,
        'utf8',
      );
      const kbSanitized = Math.round(statSync(outPathSanitized).size / 1024);
      console.log(
        `wrote fixtures/sanitized/${adapter.id}/${name} (${runSanitized.spans.length} spans, ${kbSanitized} KB)`,
      );
      written++;

      // 3. metadata-only profile golden (fixtures/metadata-only/)
      const runMetadataOnly = pruneToMetadata(runSanitized);
      const outDirMetadata = join(metadataOnlyDir, adapter.id);
      mkdirSync(outDirMetadata, { recursive: true });
      const outPathMetadata = join(outDirMetadata, name);
      writeFileSync(
        outPathMetadata,
        `${JSON.stringify(runMetadataOnly, null, 2)}\n`,
        'utf8',
      );
      const kbMetadata = Math.round(statSync(outPathMetadata).size / 1024);
      console.log(
        `wrote fixtures/metadata-only/${adapter.id}/${name} (${runMetadataOnly.spans.length} spans, ${kbMetadata} KB)`,
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
