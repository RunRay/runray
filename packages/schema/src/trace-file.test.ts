import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { SCHEMA_VERSION, TraceFileSchema } from './trace-file.js';

const exampleUrl = new URL(
  '../../../schema/example-trace.json',
  import.meta.url,
);

it('zod source parses schema/example-trace.json', () => {
  const example = JSON.parse(readFileSync(exampleUrl, 'utf8'));
  const parsed = TraceFileSchema.parse(example);
  expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
  expect(parsed.runs[0]?.spans).toHaveLength(10);
});

it('rejects a negative token count', () => {
  const example = JSON.parse(readFileSync(exampleUrl, 'utf8'));
  example.runs[0].spans[1].llm.tokens.input = -1;
  expect(() => TraceFileSchema.parse(example)).toThrow();
});
