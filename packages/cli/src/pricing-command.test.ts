import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshPricing } from './pricing.js';
import { createProgram } from './program.js';

vi.mock('./pricing.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pricing.js')>()),
  refreshPricing: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

function run() {
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const done = createProgram().parseAsync([
    'node',
    'runray',
    'pricing',
    '--refresh',
  ]);
  return {
    done,
    out: () => stdout.mock.calls.map((c) => String(c[0])).join('\n'),
    err: () => stderr.mock.calls.map((c) => String(c[0])).join(''),
  };
}

describe('runray pricing --refresh', () => {
  it('says nothing was written when the refresh is refused', async () => {
    vi.mocked(refreshPricing).mockRejectedValueOnce(
      new Error('the price list is not a JSON object keyed by model'),
    );
    const { done } = run();
    await expect(done).rejects.toThrow(
      /not a JSON object keyed by model\nNothing was written; runray keeps its current prices\./,
    );
  });

  it('warns about left-out models, at most ten by name', async () => {
    vi.mocked(refreshPricing).mockResolvedValueOnce({
      path: '/home/u/.config/runray/pricing.json',
      entries: 300,
      snapshotDate: '2026-10-06',
      skipped: Array.from({ length: 12 }, (_, i) => ({
        model: `model-${i}`,
        problem: 'input_cost_per_token is negative',
      })),
    });
    const { done, out, err } = run();
    await done;
    expect(err()).toContain(
      'warning: left out model-0: input_cost_per_token is negative\n',
    );
    expect(err()).toContain('warning: left out model-9:');
    expect(err()).not.toContain('model-10');
    expect(err()).toContain(
      'warning: left out 2 more models with unusable prices\n',
    );
    expect(out()).toContain('(300 models, snapshot 2026-10-06)');
  });
});
