import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the built dashboard (05-ARCHITECTURE §3). Two layouts:
 * - published package: `prepack` copies `ui/dist` into `cli/assets/ui`
 *   (the `files` field ships it; only the cli package is published),
 * - monorepo checkout: `packages/ui/dist` straight from `vite build`.
 * `undefined` → the server falls back to its placeholder page.
 */
export function resolveUiDistDir(): string | undefined {
  // Monorepo dist first: a stale prepack copy in assets/ must never shadow
  // a fresh `vite build` during development. Published installs only have
  // assets/ui, so the order is irrelevant there.
  return firstWithIndexHtml(['../../ui/dist/', '../assets/ui/']);
}

/**
 * Locate the singlefile export template (`index.html` with everything
 * inlined) built by `vite build --config vite.export.config.ts`. Same two
 * layouts and the same monorepo-first ordering as {@link resolveUiDistDir}.
 * `undefined` → `runray export` fails with a build hint.
 */
export function resolveExportTemplate(): string | undefined {
  const dir = firstWithIndexHtml([
    '../../ui/dist-export/',
    '../assets/ui-export/',
  ]);
  return dir === undefined ? undefined : join(dir, 'index.html');
}

function firstWithIndexHtml(relative: string[]): string | undefined {
  for (const rel of relative) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return undefined;
}
