import { readdirSync, readFileSync } from 'node:fs';
import ajv2020 from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { buildJsonSchema, buildJsonSchemaString } from './json-schema.js';

// ajv ships CJS; under NodeNext its types resolve to the module namespace
// while the runtime default import already is the class / plugin function.
const Ajv2020 = ajv2020 as unknown as typeof ajv2020.default;
const addFormats = ajvFormats as unknown as typeof ajvFormats.default;

const contractUrl = new URL(
  '../../../schema/runray.schema.json',
  import.meta.url,
);
const exampleUrl = new URL(
  '../../../schema/example-trace.json',
  import.meta.url,
);

it('generated schema matches the committed contract byte-for-byte (no drift)', () => {
  // Regenerate via `pnpm --filter @runray/schema generate` — but remember:
  // a semantic schema change requires a version bump and a human decision.
  expect(readFileSync(contractUrl, 'utf8')).toBe(buildJsonSchemaString());
});

describe('generated schema validates instances', () => {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(buildJsonSchema());

  it('accepts schema/example-trace.json', () => {
    const example = JSON.parse(readFileSync(exampleUrl, 'utf8'));
    const valid = validate(example);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it('rejects a run missing derived totals', () => {
    const example = JSON.parse(readFileSync(exampleUrl, 'utf8'));
    delete example.runs[0].totals;
    expect(validate(example)).toBe(false);
  });

  it('rejects an unknown span kind', () => {
    const example = JSON.parse(readFileSync(exampleUrl, 'utf8'));
    example.runs[0].spans[0].kind = 'not-a-kind';
    expect(validate(example)).toBe(false);
  });

  it('validates every golden across full, sanitized, and metadata-only profiles', () => {
    const profileDirs = ['normalized', 'sanitized', 'metadata-only'];
    let validated = 0;

    for (const profileDir of profileDirs) {
      const pUrl = new URL(`../../../fixtures/${profileDir}`, import.meta.url);
      for (const adapterDir of readdirSync(pUrl)) {
        const aUrl = new URL(
          `../../../fixtures/${profileDir}/${adapterDir}`,
          import.meta.url,
        );
        for (const file of readdirSync(aUrl)) {
          if (!file.endsWith('.json')) continue;
          const fUrl = new URL(
            `../../../fixtures/${profileDir}/${adapterDir}/${file}`,
            import.meta.url,
          );
          const run = JSON.parse(readFileSync(fUrl, 'utf8'));
          const traceFile = {
            schemaVersion: '0.1.0',
            generator: { name: 'runray', version: '0.1.0-test' },
            generatedAt: new Date().toISOString(),
            runs: [run],
          };
          const valid = validate(traceFile);
          expect(
            validate.errors ?? [],
            `Schema validation failed for ${profileDir}/${adapterDir}/${file}`,
          ).toEqual([]);
          expect(valid).toBe(true);
          validated++;
        }
      }
    }
    expect(validated).toBe(27);
  });
});
