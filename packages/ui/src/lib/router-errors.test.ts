import { describe, expect, it } from 'vitest';
import { formatHash, parseHash, type Route, toHash } from './router';

describe('errors route (error-triage / visualizer "Errors tab")', () => {
  it('parses and formats #/run/:id/errors', () => {
    expect(parseHash('#/run/abc123/errors')).toEqual({
      view: 'errors',
      runId: 'abc123',
    });
    const route: Route = { view: 'errors', runId: 'odd/id with space' };
    expect(parseHash(toHash(route))).toEqual(route);
    expect(toHash({ view: 'errors', runId: 'r1' })).toBe('#/run/r1/errors');
  });

  it('carries the filter suffix like every other run route', () => {
    expect(
      formatHash(
        { view: 'errors', runId: 'r1' },
        {
          project: 'p',
          source: null,
          periodDays: 7,
          model: null,
          day: null,
          tool: null,
        },
      ),
    ).toBe('#/run/r1/errors?project=p&period=7');
  });
});
