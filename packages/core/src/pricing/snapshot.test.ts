import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../adapters/codex.js';
import { MODELS_WITHOUT_PUBLISHED_PRICE, matchModel } from './engine.js';
import { bundledListSize } from './index.js';
import { BUNDLED_PRICING } from './snapshot.js';

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
      if (model in MODELS_WITHOUT_PUBLISHED_PRICE) {
        // unpriced means unpriced: no shorter id may pick it up by prefix
        expect(entry, model).toBeUndefined();
      } else {
        // an entry of that exact id, not the base model its id starts with
        expect(entry?.modelPattern, model).toBe(model);
      }
    }
  });

  const pricedAs = (id: string) =>
    matchModel(BUNDLED_PRICING, id)?.modelPattern ?? 'unpriced';

  it('holds the Codex family under its own ids', () => {
    // The rates are not pinned: a refresh may change them. What must hold
    // is that each id has an entry of its own, so none is priced as the
    // base model it starts with.
    for (const id of [
      'gpt-5-codex',
      'gpt-5.1-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5.2-codex',
      'gpt-5.3-codex',
    ]) {
      const entry = matchModel(BUNDLED_PRICING, id);
      expect(entry?.modelPattern, id).toBe(id);
      expect(entry?.inputPerMTok, id).toBeGreaterThan(0);
      expect(entry?.outputPerMTok, id).toBeGreaterThan(0);
    }
  });

  it('keeps the models the list retired, each pricing its own id only', () => {
    const retired = BUNDLED_PRICING.retired ?? [];
    // dropped from the list between 2026-08-18 and 2026-11-14
    for (const id of [
      'claude-opus-4-1',
      'claude-sonnet-4-20250514',
      'grok-4',
      'mistral-large-2402',
    ]) {
      expect(retired, id).toContain(id);
      expect(pricedAs(id), id).toBe(id);
    }
    // an id the list never held is not priced as the retired model it
    // starts with (`grok-4-fast` was priced as `grok-4`, 15 times too high)
    for (const id of retired)
      expect(pricedAs(`${id}-zz-not-a-model`), id).not.toBe(id);
  });

  it('does not price another vendor’s model through a one-word alias', () => {
    // `chat` is what the list's `chat-latest` becomes
    expect(pricedAs('chat-bison-zz-not-a-model')).toBe('unpriced');
  });

  it('names every retired model once, and each of them has an entry', () => {
    const retired = BUNDLED_PRICING.retired ?? [];
    const ids = new Set(BUNDLED_PRICING.entries.map((e) => e.modelPattern));
    expect(ids.size).toBe(BUNDLED_PRICING.entries.length);
    expect(retired.length).toBeGreaterThan(0);
    expect([...retired]).toEqual([...new Set(retired)].sort());
    expect(retired.filter((id) => !ids.has(id))).toEqual([]);
    // what a fresh download is compared with leaves the retired ones out
    expect(bundledListSize()).toBe(ids.size - retired.length);
  });
});
