/**
 * bundle (05-ARCHITECTURE §3): produce the *publishable* CLI under `bundle/`.
 *
 * Only the `cli` package is published, so the private workspace packages
 * (@runray/core, @runray/schema) must be inlined — a published manifest can
 * not reference them. Everything installed from npm stays external and is
 * declared in `dependencies` or `optionalDependencies`, including
 * better-sqlite3, which is native and must not be bundled.
 *
 * `dist/` stays the tsc output: it carries declarations for project
 * references and the compiled tests, and is never published.
 */

import { execSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(cliRoot, 'bundle');
const pkg = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'));

/**
 * Runtime deps resolved from node_modules at install time, never inlined.
 * optionalDependencies count: better-sqlite3 lives there (it is native, and
 * only the OpenCode SQLite store needs it), and inlining it would both break
 * the native binding and defeat `--omit=optional` installs. Core loads it
 * through a dynamic import that degrades when it is absent.
 */
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];

// esbuild resolves the workspace packages through their published exports,
// i.e. their tsc output, so core and schema must be built before bundling.
// They are also built at the head of the prepack chain, because prepack-ui
// builds the UI, and the UI imports @runray/core — this call is the
// belt-and-braces for anyone running `pnpm bundle` on its own.
execSync('pnpm --filter @runray/core build', {
  cwd: dirname(dirname(cliRoot)),
  stdio: 'inherit',
});

rmSync(outdir, { recursive: true, force: true });

const result = await build({
  entryPoints: [
    join(cliRoot, 'src', 'bin.ts'),
    join(cliRoot, 'src', 'index.ts'),
  ],
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
});

for (const warning of result.warnings) {
  console.warn(`bundle: warning ${warning.text}`);
}

// A workspace package that survived as an import means the bundle is not
// self-sufficient and the published package would be uninstallable.
const leaked = Object.values(result.metafile.outputs)
  .flatMap((o) => o.imports)
  .filter((i) => i.external && i.path.startsWith('@runray/'));
if (leaked.length > 0) {
  console.error(
    `bundle: private workspace packages left external: ${[...new Set(leaked.map((i) => i.path))].join(', ')}`,
  );
  process.exit(1);
}

// esbuild drops the shebang when an entry is part of a code-splitting build.
const binPath = join(outdir, 'bin.js');
const bin = readFileSync(binPath, 'utf8');
if (!bin.startsWith('#!')) {
  writeFileSync(binPath, `#!/usr/bin/env node\n${bin}`);
}
chmodSync(binPath, 0o755);

const bytes = Object.entries(result.metafile.outputs)
  .map(([file, o]) => `${basename(file)} ${(o.bytes / 1024).toFixed(1)}kB`)
  .join(', ');
console.log(
  `bundle: wrote ${bytes} (external: ${external.join(', ') || 'none'})`,
);
