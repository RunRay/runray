import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCE_COLOR_VAR, sourceColorVar } from './lib/model-colors.js';

/**
 * Source colours of the By source chart (add-codex-adapter, "Codex is
 * presented as a named source"). Sources sit in one stacked bar with the
 * waste strip drawn over it, so what must hold is that the Codex segment
 * never passes for another source or for waste: it keeps its distance from
 * each, for normal vision and simulated protanopia and deuteranopia, on ink
 * and on paper. Every named source must also read as a shape on the card
 * ground. The legend carries each source id as text, so colour is never the
 * only carrier; this guards the bar itself.
 */

const css = readFileSync(join(__dirname, 'index.css'), 'utf8');
const [inkCss = '', afterLight = ''] = css.split(':root[data-theme="light"]');
const paperCss = afterLight.split('}')[0] ?? '';

/** A colour token as the theme renders it; paper falls back to ink. */
function token(name: string, source: string, fallback?: string): string {
  const pattern = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'g');
  const value = [...source.matchAll(pattern)].at(-1)?.[1];
  if (value !== undefined) return value;
  if (fallback !== undefined) return token(name, fallback);
  throw new Error(`--color-${name} not found`);
}

/** `var(--color-span-llm)` → `span-llm`. */
function tokenOf(cssVar: string): string {
  const name = /^var\(--color-([\w-]+)\)$/.exec(cssVar)?.[1];
  if (name === undefined) throw new Error(`not a colour token: ${cssVar}`);
  return name;
}

type Rgb = [number, number, number];
const linear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toLinear = (hex: string): Rgb => [
  linear(Number.parseInt(hex.slice(1, 3), 16) / 255),
  linear(Number.parseInt(hex.slice(3, 5), 16) / 255),
  linear(Number.parseInt(hex.slice(5, 7), 16) / 255),
];
const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** Viénot et al. 1999 dichromat projections, on linear RGB. */
const VISION: Record<string, (c: Rgb) => Rgb> = {
  normal: (c) => c,
  protanopia: ([r, g, b]) => {
    const y = 0.11238 * r + 0.88762 * g;
    return [y, y, 0.00401 * r - 0.00401 * g + b];
  },
  deuteranopia: ([r, g, b]) => {
    const y = 0.29275 * r + 0.70725 * g;
    return [y, y, -0.02234 * r + 0.02234 * g + b];
  },
};

function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const clamp = (c: Rgb): Rgb => [
  Math.min(1, Math.max(0, c[0])),
  Math.min(1, Math.max(0, c[1])),
  Math.min(1, Math.max(0, c[2])),
];
function distance(a: Rgb, b: Rgb): number {
  const [x, y] = [oklab(clamp(a)), oklab(clamp(b))];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100;
}

/** The sources a run can come from; `unknown` is the fallback, not one. */
const NAMED = ['claude-code', 'opencode', 'codex', 'otlp'];
/** Drawn over the bars of the same chart (Overview, the waste strip). */
const WASTE_STRIP = 'heat-2';
/** The grounds the chart and its legend sit on. */
const GROUNDS = ['surface', 'surface-container-low'];

const THEMES = [
  { name: 'ink', source: inkCss, fallback: undefined },
  { name: 'paper', source: paperCss, fallback: inkCss },
];

describe('source colour assignment', () => {
  it('every source a run can come from has a colour of its own', () => {
    for (const source of NAMED) {
      expect(SOURCE_COLOR_VAR[source], source).toBeDefined();
    }
    expect(new Set(NAMED.map(sourceColorVar)).size).toBe(NAMED.length);
  });

  it('Codex is not drawn in the colour of an unrecognised source', () => {
    expect(sourceColorVar('codex')).not.toBe(sourceColorVar('something-else'));
    expect(sourceColorVar('codex')).not.toBe(sourceColorVar('unknown'));
  });

  it('paper sets the Codex colour itself and does not inherit the ink one', () => {
    expect(token('source-codex', paperCss)).not.toBe(
      token('source-codex', inkCss),
    );
  });
});

describe.each(THEMES)('source colours in $name', ({ source, fallback }) => {
  const colour = (name: string) => token(name, source, fallback);
  const of = (id: string) => colour(tokenOf(sourceColorVar(id)));
  const codex = of('codex');

  it.each(Object.entries(VISION))(
    'Codex stands apart from every other source and from the waste strip (%s)',
    (_, see) => {
      const others: [string, string][] = [
        ...NAMED.filter((id) => id !== 'codex').map((id): [string, string] => [
          id,
          of(id),
        ]),
        ['unknown', of('unknown')],
        ['waste strip', colour(WASTE_STRIP)],
      ];
      for (const [name, other] of others) {
        expect(
          distance(see(toLinear(codex)), see(toLinear(other))),
          `${codex} vs ${name} ${other}`,
        ).toBeGreaterThanOrEqual(12);
      }
    },
  );

  it('every named source reads as a shape on the card ground', () => {
    for (const id of NAMED) {
      for (const ground of GROUNDS) {
        expect(
          contrast(toLinear(of(id)), toLinear(colour(ground))),
          `${id} ${of(id)} on ${ground}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
