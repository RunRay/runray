import { describe, expect, it } from 'vitest';
import { SOURCE_COLOR_VAR, sourceColorVar } from './lib/model-colors.js';
import {
  contrast,
  distance,
  inkCss,
  paperCss,
  THEMES,
  token,
  toLinear,
  VISION,
} from './test-support/palette';

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

/** `var(--color-span-llm)` → `span-llm`. */
function tokenOf(cssVar: string): string {
  const name = /^var\(--color-([\w-]+)\)$/.exec(cssVar)?.[1];
  if (name === undefined) throw new Error(`not a colour token: ${cssVar}`);
  return name;
}

/** The sources a run can come from; `unknown` is the fallback, not one. */
const NAMED = ['claude-code', 'opencode', 'codex', 'otlp'];
/** Drawn over the bars of the same chart (Overview, the waste strip). */
const WASTE_STRIP = 'heat-2';
/** The grounds the chart and its legend sit on. */
const GROUNDS = ['surface', 'surface-container-low'];

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
