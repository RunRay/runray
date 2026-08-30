import { z } from 'zod';
import { TraceFileSchema } from './trace-file.js';

const SCHEMA_ID = 'https://runray.dev/schema/0.1.0/runray.schema.json';
const SCHEMA_TITLE = 'RunRay TraceFile';

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rewrites zod's JSON Schema output into the representation conventions the
 * published contract uses. Semantics-preserving only:
 * - `anyOf [{type: T}, {type: "null"}]` → `type: [T, "null"]`
 * - drop trivial `additionalProperties` ({} or true) and `propertyNames`
 *   ({type: "string"}) — the contract is permissive by design
 *   (forward-compatibility principle in docs/02-DATA-MODEL.md)
 * - drop `pattern` where `format` already carries the intent
 * - drop zod's implicit safe-integer bounds on `int()` (the contract leaves
 *   integers unbounded) and empty `required` arrays
 */
function canonicalize(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) canonicalize(item);
    return;
  }
  if (!isPlainObject(node)) return;

  const anyOf = node.anyOf;
  if (
    Array.isArray(anyOf) &&
    anyOf.length === 2 &&
    isPlainObject(anyOf[0]) &&
    isPlainObject(anyOf[1]) &&
    anyOf[1].type === 'null' &&
    Object.keys(anyOf[1]).length === 1 &&
    typeof anyOf[0].type === 'string' &&
    Object.keys(anyOf[0]).length === 1
  ) {
    delete node.anyOf;
    node.type = [anyOf[0].type, 'null'];
  }

  const ap = node.additionalProperties;
  if (
    ap === true ||
    ap === false ||
    (isPlainObject(ap) && Object.keys(ap).length === 0)
  ) {
    delete node.additionalProperties;
  }

  const pn = node.propertyNames;
  if (
    isPlainObject(pn) &&
    pn.type === 'string' &&
    Object.keys(pn).length === 1
  ) {
    delete node.propertyNames;
  }

  if (typeof node.format === 'string' && typeof node.pattern === 'string') {
    delete node.pattern;
  }

  if (Array.isArray(node.required) && node.required.length === 0) {
    delete node.required;
  }

  if (node.maximum === Number.MAX_SAFE_INTEGER) delete node.maximum;
  if (node.minimum === -Number.MAX_SAFE_INTEGER) delete node.minimum;

  for (const value of Object.values(node)) canonicalize(value);
}

export function buildJsonSchema(): JsonObject {
  const generated = z.toJSONSchema(TraceFileSchema, {
    target: 'draft-2020-12',
  }) as JsonObject;

  canonicalize(generated);

  const { $schema, $defs, ...rest } = generated;
  return {
    $schema,
    $id: SCHEMA_ID,
    title: SCHEMA_TITLE,
    ...rest,
    ...($defs === undefined ? {} : { $defs }),
  };
}

export function buildJsonSchemaString(): string {
  return `${JSON.stringify(buildJsonSchema(), null, 2)}\n`;
}
