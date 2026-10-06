import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Token sheet guards (index.css), for ink and paper.
 *
 * Shadows: Tailwind copies each @theme --shadow-* value into its utility at
 * build time, so overriding --shadow-card under data-theme never reaches
 * `.shadow-card`. Paper once rendered ink's 35% black card shadow that way.
 * Every shadow colour must stay a var() reference set per theme.
 *
 * Text: faint is the lowest text tier. It must clear WCAG AA (4.5:1) on the
 * page and panel grounds and stay a visible step below dim. Raised and
 * tinted grounds re-point faint to dim, so dim must clear AA on those.
 */

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const cssPath = join(uiRoot, 'src', 'index.css');
const code = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(selector: RegExp): string {
  const start = code.search(selector);
  if (start < 0) throw new Error(`index.css has no block matching ${selector}`);
  const open = code.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

/** Custom properties declared in a block; a later declaration wins. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name = '', value = ''] of body.matchAll(
    /(--[\w-]+)\s*:\s*([^;{}]+);/g,
  )) {
    out.set(name, value.replace(/\s+/g, ' ').trim());
  }
  return out;
}

const theme = declarations(block(/@theme\s*\{/));
const paperOverrides = declarations(block(/:root\[data-theme="light"\]\s*\{/));
const ink = new Map([...theme, ...declarations(block(/:root\s*\{/))]);
const paper = new Map([...ink, ...paperOverrides]);

/** Splits on `separator` outside parentheses. */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === separator && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The colour of each shadow layer: the one token that isn't a length. */
function shadowColours(value: string): string[] {
  return splitTopLevel(value, ',').map((layer) => {
    const colours = splitTopLevel(layer, ' ').filter(
      (token) => token !== 'inset' && !/^-?(?:\d*\.)?\d+(?:px)?$/.test(token),
    );
    expect(colours, `one colour in shadow layer "${layer}"`).toHaveLength(1);
    return colours[0] ?? '';
  });
}

const shadows = [...theme].filter(([name]) => name.startsWith('--shadow-'));

describe('elevation follows the theme', () => {
  it('declares the card and popover shadows', () => {
    expect(shadows.map(([name]) => name)).toEqual(
      expect.arrayContaining(['--shadow-card', '--shadow-popover']),
    );
  });

  it.each(shadows)('%s colours are variables set per theme', (_n, value) => {
    for (const colour of shadowColours(value)) {
      const ref = colour.match(/^var\((--[\w-]+)\)$/)?.[1];
      expect(ref, `"${colour}" is baked into the utility`).toBeDefined();
      expect(ink.has(ref ?? ''), `${ref} is not set for ink`).toBe(true);
      expect(paperOverrides.has(ref ?? ''), `${ref} is not set for paper`).toBe(
        true,
      );
    }
  });

  // A build older than index.css is stale and skipped. CI builds after
  // checkout, so there the check always runs.
  const sourceTime = statSync(cssPath).mtimeMs;
  const built = ['dist/assets', 'dist-export']
    .filter((dir) => existsSync(join(uiRoot, dir)))
    .flatMap((dir) =>
      readdirSync(join(uiRoot, dir))
        .filter((file) => file.endsWith('.css') || file.endsWith('.html'))
        .map((file) => ({
          name: `${dir}/${file}`,
          path: join(uiRoot, dir, file),
        })),
    )
    .filter(({ path }) => statSync(path).mtimeMs >= sourceTime)
    .map(({ name, path }) => ({ name, text: readFileSync(path, 'utf8') }));

  it.skipIf(built.length === 0)(
    'the built shadow utilities read their colours from variables',
    () => {
      const withShadows = built.filter(({ text }) =>
        text.includes('.shadow-card{'),
      );
      expect(withShadows, 'no fresh build defines .shadow-card').not.toEqual(
        [],
      );
      for (const { name, text } of withShadows) {
        for (const utility of ['shadow-card', 'shadow-popover']) {
          const rule = text.match(
            new RegExp(`\\.${utility}\\{--tw-shadow:([^;}]+)[;}]`),
          )?.[1];
          expect(rule, `.${utility} in ${name}`).toBeDefined();
          for (const colour of shadowColours(rule ?? '')) {
            expect(colour, `.${utility} in ${name}`).toMatch(
              /^var\(--tw-shadow-color,\s*var\(--[\w-]+\)\)$/,
            );
          }
        }
      }
    },
  );
});

type Rgb = [number, number, number];

function colour(tokens: Map<string, string>, name: string): Rgb {
  const value = tokens.get(name);
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${name} should be a 6-digit hex colour, got ${value}`);
  }
  return [1, 3, 5].map((i) =>
    Number.parseInt(value.slice(i, i + 2), 16),
  ) as Rgb;
}

function over(top: Rgb, alpha: number, below: Rgb): Rgb {
  return top.map((c, i) => c * alpha + (below[i] ?? 0) * (1 - alpha)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r = 0, g = 0, b = 0] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const THEMES = [
  ['ink', ink],
  ['paper', paper],
] as const;

const GROUNDS = [
  '--color-bg',
  '--color-bg-deep-gray',
  '--color-surface',
  '--color-surface-2',
  '--color-surface-container-low',
];

describe.each(THEMES)('%s text tiers', (_theme, tokens) => {
  it.each(GROUNDS)('faint clears AA on %s, a step below dim', (ground) => {
    const bg = colour(tokens, ground);
    const text = contrast(colour(tokens, '--color-text'), bg);
    const dim = contrast(colour(tokens, '--color-text-dim'), bg);
    const faint = contrast(colour(tokens, '--color-text-faint'), bg);
    expect(faint).toBeGreaterThanOrEqual(4.5);
    // keeps the three tiers distinguishable, not just ordered
    expect(dim / faint).toBeGreaterThanOrEqual(1.25);
    expect(text).toBeGreaterThan(dim);
  });
});

/** Classes whose rules re-point faint to dim ("Faint on raised grounds"). */
const raisedGrounds = [
  ...code.matchAll(
    /([^{}]+)\{\s*--color-text-faint:\s*var\(--color-text-dim\);?\s*\}/g,
  ),
].flatMap(([, selectors = '']) =>
  selectors.split(',').map((selector) =>
    selector
      .trim()
      .replace(/\\/g, '')
      .replace(/^\./, '')
      .replace(/:hover$/, ''),
  ),
);

describe('faint on raised grounds', () => {
  it('re-points faint on the raised grounds', () => {
    expect(raisedGrounds).toEqual(
      expect.arrayContaining([
        'bg-surface-variant',
        'bg-surface-container-highest',
      ]),
    );
  });

  // Selected rows, active tabs, chips, table heads; heat tints up to 15%
  // are row and cell grounds (stronger ones are bars and flashes).
  const GROUND_CLASS =
    /(?<![\w:/-])(?:hover:)?bg-(?:surface-variant|surface-container-high(?:est)?)(?:\/\d+)?(?![\w/-])|(?<![\w:/-])(?:hover:)?bg-heat-[1-3]\/(?:\d|1[0-5])(?![\w/-])/g;

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
        ? [path]
        : [];
    });
  }

  const used = [
    ...new Set(
      sources(join(uiRoot, 'src')).flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(GROUND_CLASS)].map(
          ([token]) => token,
        ),
      ),
    ),
  ].sort();

  it.each(used)('%s re-points faint to dim', (token) => {
    expect(
      raisedGrounds,
      `add .${token.replace(/[\\:/]/g, '\\$&')} to "Faint on raised grounds" in index.css`,
    ).toContain(token);
  });

  describe.each(THEMES)('%s', (_theme, tokens) => {
    it.each(raisedGrounds)('dim clears AA on %s', (ground) => {
      const [, name = '', percent] =
        ground.match(/^(?:hover:)?bg-([\w-]+?)(?:\/(\d+))?$/) ?? [];
      const fill = colour(tokens, `--color-${name}`);
      const alpha = percent === undefined ? 1 : Number(percent) / 100;
      const dim = colour(tokens, '--color-text-dim');
      for (const below of GROUNDS) {
        const bg = over(fill, alpha, colour(tokens, below));
        expect(contrast(dim, bg), `over ${below}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
});
