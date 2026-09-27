/**
 * build-demo.ts — regenerates the `runray demo` sample in `demo/runs/`.
 *
 *   pnpm demo:build
 *
 * The goldens stay test data: this script reads them, never writes them.
 * Each story in scripts/demo/stories.ts re-skins one golden with a coherent
 * storyline; the result then goes through the real pipeline (priceRun →
 * normalize → applyInsights), so totals, costs and insight texts are
 * computed exactly as `runray view` would compute them.
 *
 * Output: demo/runs/<source>/<slug>.json, byte-stable. Regenerate after a
 * golden or insight-engine change and commit the result.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyInsights,
  normalize,
  priceRun,
  unpricedCoverage,
} from '../packages/core/src/index.js';
import type { Run } from '../packages/schema/src/index.js';
import { skinRun } from './demo/skin.js';
import { STORIES } from './demo/stories.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const goldensDir = join(repoRoot, 'fixtures', 'normalized');
const outDir = join(repoRoot, 'demo', 'runs');

/** Scrubber vocabulary; any hit means a string escaped the re-skin. */
const LOREM =
  /\b(lorem|ipsum|dolor|consectetur|adipiscing|incididunt|labore|aliqua|aliquip|nostrud|veniam|tempor|magna|minim|enim|quis|elit|amet)\b|(lorem|ipsum|dolor|adipis|incidi|aliqu|nostrud|consec|veniam|tempor|labore)x/i;

function loremHits(value: unknown, path = ''): string[] {
  if (typeof value === 'string') {
    return LOREM.test(value) ? [`${path}: ${value.slice(0, 60)}`] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => loremHits(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      /(^id|Id)$/.test(k) ? [] : loremHits(v, `${path}.${k}`),
    );
  }
  return [];
}

rmSync(outDir, { recursive: true, force: true });

for (const story of STORIES) {
  const golden = JSON.parse(
    readFileSync(join(goldensDir, `${story.golden}.json`), 'utf8'),
  ) as Run;
  const priced = priceRun(skinRun(golden, story));
  // `<synthetic>` spans are Claude Code's own stand-in messages (API errors,
  // "No response requested.") with zero tokens: they cost nothing, and left
  // `unknown` they would flag every demo total as understated. No costUSD,
  // so they stay out of the per-model cost ranking.
  priced.spans = priced.spans.map((s) =>
    s.llm?.model === '<synthetic>' &&
    s.llm.costSource === 'unknown' &&
    Object.values(s.llm.tokens).every((t) => t === 0)
      ? { ...s, llm: { ...s.llm, costSource: 'computed' } }
      : s,
  );
  const run = applyInsights(normalize(priced));

  if (run.id !== golden.id) {
    throw new Error(`${story.out}: run id changed (${golden.id} → ${run.id})`);
  }
  const coverage = unpricedCoverage(run);
  if (!coverage.complete) {
    throw new Error(
      `${story.out}: ${coverage.unpricedLlmCalls} unpriced llm calls (${coverage.models.join(', ')})`,
    );
  }
  const hits = loremHits(run);
  if (hits.length > 0) {
    throw new Error(
      `${story.out}: ${hits.length} lorem string(s) left, e.g.\n  ${hits.slice(0, 5).join('\n  ')}`,
    );
  }

  const outPath = join(outDir, `${story.out}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  console.log(
    `wrote demo/runs/${story.out}.json (${run.spans.length} spans, $${run.totals.costUSD.total.toFixed(2)}, ${run.insights.length} insights)`,
  );
}
