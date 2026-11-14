import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../adapters/codex.js';
import { matchModel } from './engine.js';
import { bundledListSize } from './index.js';
import { BUNDLED_PRICING, RETIRED_MODELS } from './snapshot.js';

/**
 * Model ids that agents record and that no provider publishes a price for.
 * Calls on them stay `costSource: 'unknown'` and count toward the coverage
 * warning. Giving one the price of another model would be a guess, which
 * the cost engine does not make. An id is added here with its reason, never
 * to silence the test below.
 */
const NO_PUBLISHED_PRICE: Readonly<Record<string, string>> = {
  'codex-auto-review':
    'the model of the Codex approval reviewer; OpenAI lists no rates for it',
};

const fixtures = fileURLToPath(
  new URL('../../../../fixtures/codex', import.meta.url),
);

async function modelsOfCodexFixtures(): Promise<string[]> {
  const models = new Set<string>();
  // the committed variants: `large` is a machine-local perf fixture
  const variants = readdirSync(fixtures, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'large')
    .map((entry) => join(fixtures, entry.name));
  for (const candidate of await codexAdapter.detect(variants)) {
    const run = await codexAdapter.parse(candidate, { redact: true });
    for (const span of run.spans)
      if (span.llm !== undefined) models.add(span.llm.model);
  }
  return [...models].sort();
}

describe('the bundled pricing snapshot', () => {
  it('holds every model of the Codex fixtures under its own id, or the id has no published price', async () => {
    const models = await modelsOfCodexFixtures();
    expect(models).toEqual([
      'codex-auto-review',
      'gpt-5',
      'gpt-5.5',
      'gpt-6-astra',
    ]);

    for (const model of models) {
      const entry = matchModel(BUNDLED_PRICING, model);
      if (model in NO_PUBLISHED_PRICE) {
        // unpriced means unpriced: no shorter id may pick it up by prefix
        expect(entry, model).toBeUndefined();
      } else {
        // an entry of that exact id, not the base model its id starts with
        expect(entry?.modelPattern, model).toBe(model);
      }
    }
  });

  it('holds the Codex family under its own ids, at its own rates', () => {
    const rates = (id: string) => {
      const entry = matchModel(BUNDLED_PRICING, id);
      return entry?.modelPattern === id
        ? [entry.inputPerMTok, entry.outputPerMTok, entry.cacheReadPerMTok]
        : `resolves as ${entry?.modelPattern ?? 'nothing'}`;
    };
    expect({
      'gpt-5-codex': rates('gpt-5-codex'),
      'gpt-5.1-codex': rates('gpt-5.1-codex'),
      'gpt-5.1-codex-max': rates('gpt-5.1-codex-max'),
      'gpt-5.1-codex-mini': rates('gpt-5.1-codex-mini'),
      'gpt-5.2-codex': rates('gpt-5.2-codex'),
      'gpt-5.3-codex': rates('gpt-5.3-codex'),
    }).toEqual({
      'gpt-5-codex': [1.25, 10, 0.125],
      'gpt-5.1-codex': [1.25, 10, 0.125],
      'gpt-5.1-codex-max': [1.25, 10, 0.125],
      // a fifth of `gpt-5.1`, which the prefix rule priced it as before
      'gpt-5.1-codex-mini': [0.25, 2, 0.025],
      'gpt-5.2-codex': [1.75, 14, 0.175],
      // no `gpt-5.3` is published; it was priced as `gpt-5` before
      'gpt-5.3-codex': [1.75, 14, 0.175],
    });
  });

  it('keeps the models the list retired, at the rates they last had', () => {
    const rates = (id: string) => {
      const entry = matchModel(BUNDLED_PRICING, id);
      return entry?.modelPattern === id
        ? [entry.inputPerMTok, entry.outputPerMTok, entry.cacheReadPerMTok]
        : `resolves as ${entry?.modelPattern ?? 'nothing'}`;
    };
    // dropped from the list between 2026-08-18 and 2026-11-14
    expect({
      'claude-opus-4-1': rates('claude-opus-4-1'),
      'claude-sonnet-4-20250514': rates('claude-sonnet-4-20250514'),
      'grok-4': rates('grok-4'),
      // would otherwise be priced as today's `mistral-large` (0.5 / 1.5)
      'mistral-large-2402': rates('mistral-large-2402'),
    }).toEqual({
      'claude-opus-4-1': [15, 75, 1.5],
      'claude-sonnet-4-20250514': [3, 15, 0.3],
      'grok-4': [3, 15, 3],
      'mistral-large-2402': [4, 12, 4],
    });
  });

  it('names every retired model once, and each of them has an entry', () => {
    const ids = new Set(BUNDLED_PRICING.entries.map((e) => e.modelPattern));
    expect(ids.size).toBe(BUNDLED_PRICING.entries.length);
    expect([...RETIRED_MODELS]).toEqual([...new Set(RETIRED_MODELS)].sort());
    expect(RETIRED_MODELS.filter((id) => !ids.has(id))).toEqual([]);
    // what a fresh download is compared with leaves the retired ones out
    expect(bundledListSize()).toBe(ids.size - RETIRED_MODELS.length);
  });
});
