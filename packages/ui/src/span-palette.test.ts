import { describe, expect, it } from 'vitest';
import {
  contrast,
  distance,
  inkCss,
  over,
  THEMES,
  token,
  toLinear,
  VISION,
} from './test-support/palette';

/**
 * The subagent bar must never pass for another span kind. It used to be a
 * violet next to the violet llm bar in ink (OKLab ΔE 3) and a grey next to
 * the grey tool bar in paper. These checks hold it apart from every bar
 * colour and from the finding colours that mark rows, for normal vision
 * and simulated protanopia and deuteranopia, and keep the subagents badge
 * in the sessions table readable.
 */

// Everything that colours a waterfall row: every other span-kind token,
// read from the stylesheet so a new kind is checked as soon as it lands,
// plus the warning notch and chip (critical shares span-error).
const NEIGHBOURS = [
  ...new Set(
    [...inkCss.matchAll(/--color-(span-[\w-]+):/g)].flatMap(([, name]) =>
      name === undefined || name === 'span-subagent' ? [] : [name],
    ),
  ),
  'heat-2',
];

it('finds the span palette it checks against', () => {
  expect(NEIGHBOURS).toEqual(
    expect.arrayContaining(['span-llm', 'span-tool', 'span-error', 'heat-2']),
  );
});

describe.each(THEMES)('subagent colour in $name', ({ source, fallback }) => {
  const colour = (name: string) => token(name, source, fallback);
  const subagent = colour('span-subagent');

  it.each(Object.entries(VISION))(
    'stands apart from every row colour (%s)',
    (_, see) => {
      for (const name of NEIGHBOURS) {
        const other = colour(name);
        expect(
          distance(see(toLinear(subagent)), see(toLinear(other))),
          `${subagent} vs ${name} ${other}`,
        ).toBeGreaterThanOrEqual(12);
      }
    },
  );

  it('reads as a bar on the row ground and as text in the subagents badge', () => {
    const row = colour('surface-container-low');
    const badgeGround = colour('surface');
    expect(contrast(toLinear(subagent), toLinear(row))).toBeGreaterThanOrEqual(
      4.5,
    );
    // SessionsTable: text-span-subagent on bg-span-subagent/12
    expect(
      contrast(toLinear(subagent), over(subagent, 0.12, badgeGround)),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
