import { expect, it } from 'vitest';
import { SCHEMA_VERSION } from './index.js';

it('re-exports the schema contract version (workspace wiring smoke test)', () => {
  expect(SCHEMA_VERSION).toBe('0.1.0');
});
