# Delta for trace-sanitization

## MODIFIED Requirements

### Requirement: Attribute allowlist
`span.attributes` is an open map in the frozen schema, so whenever identity is scrubbed — under `sanitized` and `metadata-only`, and with `--scrub-paths` alone — the system SHALL retain only allowlisted keys and SHALL drop every other key. Retention SHALL NOT depend on inspecting the value. The allowlist names keys, not prefixes, because an OTLP emitter can send any key under any prefix:
- the reserved metadata keys `runray.targetKey`, `runray.targetKind`, `runray.mcpDetection`, their legacy `tracepulse.*` spellings, and `tracepulse.cacheWrite1hTokens`; never `runray.target` / `tracepulse.target` or any other key an emitter stamps with these prefixes;
- the closed-vocabulary tool-usage keys `runray.tool`, `runray.toolSub`, `runray.toolActivity`, `runray.toolVia`, `runray.toolsAlso`, `runray.toolFlags` and `runray.hookCount`, whose values are drawn from fixed lists in core (or, for the count, are a number) and are validated against those lists at ingestion; never the free-form tool-usage keys `runray.toolName`, `runray.toolScript` and `runray.skill`;
- the metadata keys of `gen_ai.*`.

`gen_ai.*` is not metadata by prefix: the OpenTelemetry GenAI conventions carry message text, system instructions, tool definitions and tool arguments and results under it as opt-in attributes, and older instrumentations write `gen_ai.prompt.N.content` and `gen_ai.completion.N.content`. The system SHALL retain only these `gen_ai.*` keys: `gen_ai.system`, `gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.output.type`, `gen_ai.conversation.id`, `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.request.model` and the numeric request parameters (`max_tokens`, `temperature`, `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`, `seed`, `choice.count`), `gen_ai.response.id`, `gen_ai.response.model`, `gen_ai.response.finish_reasons`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`, and the usage counters `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read.input_tokens`, `cache_creation.input_tokens`, the deprecated `prompt_tokens` and `completion_tokens`, and `cost`. Any other `gen_ai.*` key, including one the conventions add later, SHALL be dropped. The same lists SHALL govern parse-time redaction of OTLP imports, so the redaction parity invariant covers them.

#### Scenario: Unknown imported attribute is dropped
- GIVEN an OTLP-imported span carrying a vendor attribute with an absolute path in its value
- WHEN the `sanitized` profile is applied
- THEN the attribute is absent from the output

#### Scenario: GenAI message content is dropped
- GIVEN an OTLP-imported chat span carrying `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.prompt.0.content` next to `gen_ai.request.model` and `gen_ai.usage.input_tokens`
- WHEN the `sanitized` or `metadata-only` profile is applied
- THEN the three content attributes are absent and the model and token count remain on every span that survives

#### Scenario: A GenAI key the list does not name is dropped
- GIVEN an OTLP-imported span carrying a `gen_ai.*` attribute absent from the list
- WHEN the `sanitized` profile is applied
- THEN the attribute is absent from the output

#### Scenario: An emitter's own reserved-prefix key is dropped
- GIVEN an OTLP-imported span carrying `runray.notes` with an absolute path in its value
- WHEN the trace is exported with `--scrub-paths` alone, which keeps prompt and output text
- THEN `runray.notes` and every `gen_ai.*` content attribute are absent, while the previews keep their text

#### Scenario: Tool identity survives, free-form names do not
- GIVEN a shell tool span carrying `runray.tool`, `runray.toolSub`, `runray.toolActivity`, `runray.toolVia`, `runray.toolsAlso` and `runray.toolFlags` next to `runray.toolName`, `runray.toolScript` and `runray.skill`
- WHEN the `sanitized` profile is applied
- THEN the six closed-vocabulary attributes are unchanged and the three free-form attributes are absent

#### Scenario: Tool identity keeps redaction parity
- GIVEN any fixture parsed with `redact: false` and with `redact: true`
- WHEN both results are sanitized under the same profile
- THEN the tool-usage attributes of every surviving span are deeply equal in the two outputs
