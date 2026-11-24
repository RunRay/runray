import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the palette tests share (activity ramp, span kinds, source colours):
 * reading a colour token out of the stylesheet as each theme renders it,
 * and the maths that says whether two colours can pass for one another.
 * Test support only: nothing in the app imports it.
 */

export const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
const [ink = '', afterLight = ''] = css.split(':root[data-theme="light"]');
/** The declarations of the ink (dark) theme: everything before paper. */
export const inkCss = ink;
/**
 * The declarations of the paper (light) theme: its `:root` block, which
 * holds declarations only, so it ends at the first closing brace.
 */
export const paperCss = afterLight.split('}')[0] ?? '';

/**
 * A colour token as the theme renders it: the last declaration wins (ink
 * declares --color-surface twice), and paper falls back to ink for a token
 * it does not override.
 */
export function token(name: string, source: string, fallback?: string): string {
  const pattern = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'g');
  const value = [...source.matchAll(pattern)].at(-1)?.[1];
  if (value !== undefined) return value;
  if (fallback !== undefined) return token(name, fallback);
  throw new Error(`--color-${name} not found`);
}

/** Both themes, each with where a token it does not declare comes from. */
export const THEMES = [
  { name: 'ink', source: inkCss, fallback: undefined },
  { name: 'paper', source: paperCss, fallback: inkCss },
];

export type Rgb = [number, number, number];

const channels = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
];
const linear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** `#rrggbb` as linear RGB. */
export function toLinear(hex: string): Rgb {
  const [r, g, b] = channels(hex);
  return [linear(r), linear(g), linear(b)];
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** WCAG contrast ratio of two linear-RGB colours. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** Viénot et al. 1999 dichromat projections, on linear RGB. */
export const VISION: Record<string, (c: Rgb) => Rgb> = {
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

/** OKLab ΔE of two linear-RGB colours, on a 0 to 100 scale. */
export function distance(a: Rgb, b: Rgb): number {
  const [x, y] = [oklab(clamp(a)), oklab(clamp(b))];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100;
}

/** Blend `fg` at `alpha` over `bg`, in sRGB like the browser. */
export function over(fg: string, alpha: number, bg: string): Rgb {
  const [f, b] = [channels(fg), channels(bg)];
  return [
    linear(f[0] * alpha + b[0] * (1 - alpha)),
    linear(f[1] * alpha + b[1] * (1 - alpha)),
    linear(f[2] * alpha + b[2] * (1 - alpha)),
  ];
}
