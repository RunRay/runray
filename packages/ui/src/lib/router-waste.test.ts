import { describe, expect, it } from 'vitest';
import { formatHash, parseHash, type Route, toHash } from './router';

describe('waste route (waste-grouping / visualizer "Waste tab")', () => {
  it('parses and formats #/run/:id/waste', () => {
    expect(parseHash('#/run/abc123/waste')).toEqual({
      view: 'waste',
      runId: 'abc123',
    });
    const route: Route = { view: 'waste', runId: 'odd/id with space' };
    expect(parseHash(toHash(route))).toEqual(route);
    expect(toHash({ view: 'waste', runId: 'r1' })).toBe('#/run/r1/waste');
  });

  it('carries the filter suffix like every other run route', () => {
    expect(
      formatHash(
        { view: 'waste', runId: 'r1' },
        {
          project: 'p',
          source: null,
          periodDays: 7,
          model: null,
          day: null,
          tool: null,
        },
      ),
    ).toBe('#/run/r1/waste?project=p&period=7');
  });
});
