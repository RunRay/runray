/**
 * The `gen_ai.*` attributes that describe a call without quoting it
 * (trace-sanitization spec, "Attribute allowlist"; trace-ingestion spec,
 * "OTLP import").
 *
 * `gen_ai.*` is not metadata by prefix. The OpenTelemetry GenAI conventions
 * put message text under it as opt-in attributes (`gen_ai.input.messages`,
 * `gen_ai.output.messages`, `gen_ai.system_instructions`,
 * `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments`,
 * `gen_ai.tool.call.result`), and older instrumentations write
 * `gen_ai.prompt.N.content` and `gen_ai.completion.N.content`. Redaction and
 * the sanitized profiles therefore keep only the keys below and drop every
 * other `gen_ai.*` key without reading its value. A key the conventions add
 * later is dropped until it is listed here: the list fails closed.
 *
 * One list serves both the OTLP adapter under `redact` and the export
 * profiles, so the redaction parity invariant (D4) covers it.
 */
const METADATA_KEYS: ReadonlySet<string> = new Set([
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
]);

/** Token counts and cost: numbers, whatever the emitter names them. */
const METADATA_PREFIXES = ['gen_ai.usage.'] as const;

/** True for a `gen_ai.*` key that is safe to keep under redaction. */
export function isGenAiMetadataKey(key: string): boolean {
  return (
    METADATA_KEYS.has(key) ||
    METADATA_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}
