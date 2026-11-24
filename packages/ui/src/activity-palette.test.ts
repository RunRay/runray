import { describe, expect, it } from 'vitest';
import {
  contrast,
  css,
  distance,
  inkCss,
  paperCss,
  THEMES,
  token,
  toLinear,
  VISION,
} from './test-support/palette';

/**
 * The activity ramp of the Time view (design T12). Parts sit side by side
 * in one stacked bar, so what must hold is that neighbours never pass for
 * one another: each colour keeps its distance from the next one in bar
 * order, for normal vision and simulated protanopia and deuteranopia, on
 * ink and on paper. Every part must also read as a shape on the card
 * ground. The legend carries each value as text, so colour is never the
 * only carrier; this guards the bar itself.
 */

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
