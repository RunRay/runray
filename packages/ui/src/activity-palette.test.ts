import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The activity ramp of the Time view (design T12). Parts sit side by side
 * in one stacked bar, so what must hold is that neighbours never pass for
 * one another: each colour keeps its distance from the next one in bar
 * order, for normal vision and simulated protanopia and deuteranopia, on
 * ink and on paper. Every part must also read as a shape on the card
 * ground. The legend carries each value as text, so colour is never the
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

/** Bar order: six coloured parts, then everything folded together. */
const RAMP = [
  'activity-1',
  'activity-2',
  'activity-3',
  'activity-4',
  'activity-5',
  'activity-6',
  'activity-rest',
];

const THEMES = [
  { name: 'ink', source: inkCss, fallback: undefined },
  { name: 'paper', source: paperCss, fallback: inkCss },
];

it('declares the whole ramp for ink and overrides all of it for paper', () => {
  for (const name of RAMP) {
    expect(token(name, inkCss), `ink ${name}`).toMatch(/^#[0-9a-f]{6}$/);
    expect(token(name, paperCss), `paper ${name}`).toMatch(/^#[0-9a-f]{6}$/);
  }
});

describe.each(THEMES)('activity ramp in $name', ({ source, fallback }) => {
  const colour = (name: string) => token(name, source, fallback);

  it.each(Object.entries(VISION))(
    'keeps bar neighbours apart (%s)',
    (_, see) => {
      for (let i = 0; i + 1 < RAMP.length; i++) {
        const [a, b] = [RAMP[i] as string, RAMP[i + 1] as string];
        expect(
          distance(see(toLinear(colour(a))), see(toLinear(colour(b)))),
          `${a} ${colour(a)} vs ${b} ${colour(b)}`,
        ).toBeGreaterThanOrEqual(12);
      }
    },
  );

  it('keeps every pair of the six apart for normal vision', () => {
    // the legend swatch has to find its part in the bar
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        const [a, b] = [RAMP[i] as string, RAMP[j] as string];
        expect(
          distance(toLinear(colour(a)), toLinear(colour(b))),
          `${a} vs ${b}`,
        ).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it('reads as a shape on the card ground', () => {
    const ground = toLinear(colour('surface-container-low'));
    for (const name of RAMP) {
      expect(
        contrast(toLinear(colour(name)), ground),
        `${name} ${colour(name)}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

it('draws unresolved time as a hatch of the neutral, not a seventh hue', () => {
  const rule = css.match(/\.hatch-unresolved\s*\{[^}]*\}/)?.[0] ?? '';
  expect(rule).toContain('repeating-linear-gradient');
  expect(rule).toContain('var(--color-activity-rest)');
});
