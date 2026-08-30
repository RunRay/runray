/**
 * Regenerates `schema/runray.schema.json` (repo root) from the zod source.
 * Run via `pnpm --filter @runray/schema generate`. The committed file is
 * byte-identical to `buildJsonSchemaString()`; any drift fails CI.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildJsonSchemaString } from './json-schema.js';

const target = fileURLToPath(
  new URL('../../../schema/runray.schema.json', import.meta.url),
);
writeFileSync(target, buildJsonSchemaString(), 'utf8');
console.log(`wrote ${target}`);
