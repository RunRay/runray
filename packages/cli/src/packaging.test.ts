import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Publishing guards for the optional native module.
 *
 * better-sqlite3 pulls a deprecated transitive `prebuild-install`, and npm
 * prints its deprecation warning as the very first line of `npx runray demo`
 * — the product's headline pitch. It is needed only to read the OpenCode
 * SQLite store, so it ships as an optional dependency and core degrades when
 * it is absent (packages/core/src/sqlite.ts, sqlite-missing.test.ts).
 *
 * Two ways that regresses silently, both pinned here: moving it back into
 * `dependencies`, or the bundler deriving its externals from `dependencies`
 * alone — which would make esbuild try to inline a native module.
 */

const cliRoot = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const bundleDir = join(cliRoot, 'bundle');

describe('published manifest', () => {
  it('keeps better-sqlite3 optional so a default install stays quiet', () => {
    expect(Object.keys(pkg.optionalDependencies ?? {})).toContain(
      'better-sqlite3',
    );
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('better-sqlite3');
  });
});

describe('bundle externals', () => {
  it('the bundler derives externals from optionalDependencies too', () => {
    const script = readFileSync(join(cliRoot, 'scripts', 'bundle.mjs'), 'utf8');
    // Source-level because the script is a top-level-await build entrypoint,
    // not an importable module: without this line every optional dependency
    // silently becomes a candidate for inlining.
    expect(script).toMatch(/pkg\.optionalDependencies/);
  });

  it.skipIf(!existsSync(bundleDir))(
    'leaves better-sqlite3 as a runtime import, never inlined',
    () => {
      const files = readdirSync(bundleDir).filter((f) => f.endsWith('.js'));
      expect(files.length).toBeGreaterThan(0);
      const text = files
        .map((f) => readFileSync(join(bundleDir, f), 'utf8'))
        .join('\n');
      // The dynamic import survives verbatim; inlining would replace it with
      // the module body (and a `.node` binding load that cannot be bundled).
      expect(text).toMatch(/import\(\s*["']better-sqlite3["']\s*\)/);
      expect(text).not.toMatch(/\.node["']\)/);
    },
  );
});
