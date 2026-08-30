import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Import-graph purity for the browser-safe subpath family (add-profiler-depth
 * X1). Every entrypoint exported for the visualizer must stay bundleable by
 * Vite: the transitive runtime import graph may contain only relative modules
 * — no `node:` builtins, no bare package specifiers (better-sqlite3 must be
 * unreachable). Type-only imports are erased at compile time and are allowed.
 * New browser-safe subpaths (e.g. insights/meta, later diff) register here.
 */

const SRC = resolve(__dirname);

const BROWSER_SAFE_ENTRYPOINTS = [
  'pricing/engine.ts',
  'insights/meta.ts',
  'diff/index.ts',
];

/** Runtime import/export specifiers of one source file (type-only skipped). */
function runtimeSpecifiers(source: string): string[] {
  const out: string[] = [];
  const pattern =
    /(?:^|\n)\s*(import|export)\s+([^;]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const clause = match[2] ?? '';
    if (/^type[\s{]/.test(clause.trim())) continue; // import type / export type
    out.push(match[3] as string);
  }
  return out;
}

function walk(entry: string, seen: Set<string>): void {
  const file = resolve(SRC, entry);
  if (seen.has(file)) return;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  for (const spec of runtimeSpecifiers(source)) {
    expect(spec, `${entry} imports non-relative module "${spec}"`).toMatch(
      /^\.\.?\//,
    );
    const next = join(dirname(entry), spec).replace(/\.js$/, '.ts');
    walk(next, seen);
  }
}

describe('browser-safe subpath purity', () => {
  for (const entry of BROWSER_SAFE_ENTRYPOINTS) {
    it(`${entry} pulls no node builtins or bare packages, transitively`, () => {
      const seen = new Set<string>();
      walk(entry, seen);
      expect(seen.size).toBeGreaterThan(0);
    });
  }

  it('every browser-safe entrypoint is published in the exports map', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(SRC, '..', 'package.json'), 'utf8'),
    ) as { exports: Record<string, { import: string }> };
    const published = Object.values(pkg.exports).map((e) => e.import);
    expect(published).toContain('./dist/pricing/engine.js');
    expect(published).toContain('./dist/insights/meta.js');
    expect(published).toContain('./dist/diff/index.js');
  });
});
