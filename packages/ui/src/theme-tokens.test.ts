import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Token sheet guards (index.css), for ink and paper.
 *
 * Shadows: Tailwind copies each @theme --shadow-* value into its utility at
 * build time, so overriding --shadow-card under data-theme never reaches
 * `.shadow-card`. Paper once rendered ink's 35% black card shadow that way.
 * Colours that differ by theme must stay var() references.
 */

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(join(uiRoot, 'src', 'index.css'), 'utf8');

const LITERAL_COLOUR =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i;

function block(selector: RegExp): string {
  const start = css.search(selector);
  if (start < 0) throw new Error(`index.css has no block matching ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

/** Custom properties declared in a block; a later declaration wins. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, name = '', value = ''] of code.matchAll(
    /(--[\w-]+)\s*:\s*([^;]+);/g,
  )) {
    out.set(name, value.replace(/\s+/g, ' ').trim());
  }
  return out;
}

const theme = declarations(block(/@theme\s*\{/));
const paperOverrides = declarations(block(/:root\[data-theme="light"\]\s*\{/));
const ink = new Map([...theme, ...declarations(block(/:root\s*\{/))]);

const shadows = [...theme].filter(([name]) => name.startsWith('--shadow-'));

describe('elevation follows the theme', () => {
  it('declares the card and popover shadows', () => {
    expect(shadows.map(([name]) => name)).toEqual(
      expect.arrayContaining(['--shadow-card', '--shadow-popover']),
    );
  });

  it.each(shadows)('%s keeps its colours in variables', (_name, value) => {
    expect(value).not.toMatch(LITERAL_COLOUR);
  });

  it.each(shadows)('%s colours are set for ink and paper', (_name, value) => {
    for (const [, ref = ''] of value.matchAll(/var\((--[\w-]+)\)/g)) {
      expect(ink.has(ref), `${ref} is not set for ink`).toBe(true);
      expect(paperOverrides.has(ref), `${ref} is not set for paper`).toBe(true);
    }
  });

  // CI builds before testing; a fresh checkout has no dist and skips this.
  const builtCss = ['dist/assets', 'dist-export']
    .filter((dir) => existsSync(join(uiRoot, dir)))
    .flatMap((dir) =>
      readdirSync(join(uiRoot, dir))
        .filter((file) => file.endsWith('.css') || file.endsWith('.html'))
        .map((file) => ({
          name: `${dir}/${file}`,
          text: readFileSync(join(uiRoot, dir, file), 'utf8'),
        })),
    )
    .filter(({ text }) => text.includes('.shadow-card{'));

  it.skipIf(builtCss.length === 0)(
    'the built shadow utilities carry no literal colour',
    () => {
      for (const { name, text } of builtCss) {
        for (const utility of ['shadow-card', 'shadow-popover']) {
          const where = `.${utility} in ${name} (stale? run pnpm build)`;
          const rule = text.match(
            new RegExp(`\\.${utility}\\{--tw-shadow:([^;]+);`),
          );
          expect(rule, where).not.toBeNull();
          expect(rule?.[1], where).not.toMatch(LITERAL_COLOUR);
        }
      }
    },
  );
});
