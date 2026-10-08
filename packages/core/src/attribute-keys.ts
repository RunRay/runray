import { CACHE_WRITE_1H_ATTR } from './pricing/engine.js';

/**
 * The span attribute keys that may survive redaction and the sanitized
 * profiles (trace-sanitization spec, "Attribute allowlist"; trace-ingestion
 * spec, "OTLP JSON import"). `span.attributes` is an open map, and an OTLP
 * import fills it from whatever the emitter sends, so every prefix gets a
 * list and a key the list doesn't name is dropped without reading its
 * value. One module serves both the OTLP adapter under `redact` and the
 * export profiles, so the redaction parity invariant (D4) covers it.
 */

/**
 * Reserved `runray.*` keys and their legacy `tracepulse.*` spellings that
 * carry no content: a target's hash and kind, the MCP heuristic marker, and
 * the 1-hour cache-write token count. `runray.target` (a basename) is not
 * here, and neither is any other key an emitter might stamp with the prefix.
 */
const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
  'runray.targetKey',
  'runray.targetKind',
  'runray.mcpDetection',
  'tracepulse.targetKey',
  'tracepulse.targetKind',
  'tracepulse.mcpDetection',
  CACHE_WRITE_1H_ATTR,
]);

/**
 * The `gen_ai.*` attributes that describe a call without quoting it.
 *
 * `gen_ai.*` is not metadata by prefix. The OpenTelemetry GenAI conventions
 * put message text under it as opt-in attributes (`gen_ai.input.messages`,
 * `gen_ai.output.messages`, `gen_ai.system_instructions`,
 * `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments`,
 * `gen_ai.tool.call.result`), and older instrumentations write
 * `gen_ai.prompt.N.content` and `gen_ai.completion.N.content`. A key the
 * conventions add later is dropped until it is listed here: the list fails
 * closed.
 */
const GEN_AI_METADATA_KEYS: ReadonlySet<string> = new Set([
  // who and what
  'gen_ai.system',
  'gen_ai.provider.name',
  'gen_ai.operation.name',
  'gen_ai.output.type',
  'gen_ai.conversation.id',
  'gen_ai.agent.id',
  'gen_ai.agent.name',
  // the request's model and numeric parameters (not stop sequences: text)
  'gen_ai.request.model',
  'gen_ai.request.max_tokens',
  'gen_ai.request.temperature',
  'gen_ai.request.top_p',
  'gen_ai.request.top_k',
  'gen_ai.request.frequency_penalty',
  'gen_ai.request.presence_penalty',
  'gen_ai.request.seed',
  'gen_ai.request.choice.count',
  // the response's identity and classification
  'gen_ai.response.id',
  'gen_ai.response.model',
  'gen_ai.response.finish_reasons',
  // tools by name and id (not their definitions, arguments or results)
  'gen_ai.tool.name',
  'gen_ai.tool.call.id',
  'gen_ai.tool.type',
  // token counts and cost, by name: emitters also put strings and JSON
  // blobs under `gen_ai.usage.`, so the prefix alone is not enough
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
  'gen_ai.usage.prompt_tokens', // deprecated spelling of input_tokens
  'gen_ai.usage.completion_tokens', // deprecated spelling of output_tokens
  'gen_ai.usage.cost', // not semconv; the OTLP adapter reads it as reported cost
]);

/** True for a `gen_ai.*` key that is safe to keep under redaction. */
export function isGenAiMetadataKey(key: string): boolean {
  return GEN_AI_METADATA_KEYS.has(key);
}

/** True for a `runray.*` / `tracepulse.*` key that is safe to keep under
 * redaction. */
export function isReservedMetadataKey(key: string): boolean {
  return RESERVED_METADATA_KEYS.has(key);
}
