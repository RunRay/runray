import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Bundle purity guards (task 9.1 / X1): the UI imports runtime code from
 * @runray/core's browser-safe subpaths, so the built bundles must never
 * contain the bundled pricing snapshot, better-sqlite3, or node builtins.
 * Markers: 'chatgpt-4o' and 'ft:gpt-3.5-turbo' exist ONLY in the generated
 * snapshot table (MODEL_TIERS carries none of them). Skipped when the dist
 * is absent (fresh checkout); CI builds before testing.
 */

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(uiRoot, 'dist');
const exportFile = join(uiRoot, 'dist-export', 'index.html');

function distBundles(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const assets = join(distDir, 'assets');
  if (existsSync(assets)) {
    for (const file of readdirSync(assets)) {
      if (file.endsWith('.js') || file.endsWith('.html')) {
        out.push({
          name: `dist/assets/${file}`,
          text: readFileSync(join(assets, file), 'utf8'),
        });
      }
    }
  }
  if (existsSync(exportFile)) {
    out.push({
      name: 'dist-export/index.html',
      text: readFileSync(exportFile, 'utf8'),
    });
  }
  return out;
}

const FORBIDDEN = [
  {
    marker: 'better-sqlite3',
    why: 'native module must never reach the browser',
  },
  { marker: 'chatgpt-4o', why: 'bundled pricing snapshot leaked into the UI' },
  {
    marker: 'ft:gpt-3.5-turbo',
    why: 'bundled pricing snapshot leaked into the UI',
  },
  { marker: 'node:fs', why: 'node builtin in a browser bundle' },
  { marker: 'node:zlib', why: 'node builtin in a browser bundle' },
];

const EXPORT_FORBIDDEN = [
  {
    marker: '@floating-ui',
    why: 'positioning library leaked into a shareable report',
  },
  {
    marker: 'data-tour',
    why: 'tour anchors/controller leaked into a shareable report',
  },
  {
    marker: '/api/onboarding',
    why: 'live-mode endpoint string leaked into a file:// artifact',
  },
];

describe.skipIf(!existsSync(distDir))('browser bundle purity (X1)', () => {
  it('dist and dist-export carry no snapshot, native module, or node builtin', () => {
    const bundles = distBundles();
    expect(bundles.length).toBeGreaterThan(0);
    for (const bundle of bundles) {
      for (const { marker, why } of FORBIDDEN) {
        expect(
          bundle.text.includes(marker),
          `${bundle.name} contains "${marker}" — ${why}`,
        ).toBe(false);
      }
    }
  });

  it('dist-export carries no onboarding markers and stays under 1.5 MB', () => {
    if (!existsSync(exportFile)) return;
    const text = readFileSync(exportFile, 'utf8');
    for (const { marker, why } of EXPORT_FORBIDDEN) {
      expect(
        text.includes(marker),
        `dist-export/index.html contains "${marker}" — ${why}`,
      ).toBe(false);
    }
    const maxSize = 1.5 * 1024 * 1024;
    expect(
      text.length,
      `dist-export/index.html size (${text.length} B) exceeds 1.5 MB budget`,
    ).toBeLessThanOrEqual(maxSize);
  });

  it('live build (dist) contains onboarding code while only export template is asserted clean (Task 5.15 B)', () => {
    const assetsDir = join(distDir, 'assets');
    if (!existsSync(assetsDir)) return;
    const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    const combinedJs = jsFiles
      .map((f) => readFileSync(join(assetsDir, f), 'utf8'))
      .join('\n');

    const containsOnboardingMarker = EXPORT_FORBIDDEN.some(({ marker }) =>
      combinedJs.includes(marker),
    );
    expect(
      containsOnboardingMarker,
      'dist assets must contain onboarding markers (@floating-ui, data-tour, or /api/onboarding)',
    ).toBe(true);
  });
});
