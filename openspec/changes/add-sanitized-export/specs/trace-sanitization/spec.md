# Delta for trace-sanitization

## ADDED Requirements

### Requirement: Three named sanitization profiles
The system SHALL define exactly three sanitization profiles — `full`, `sanitized`, and `metadata-only` — in `packages/core`, and every consumer (the CLI and the report manifest) SHALL name a profile rather than choose fields. `full` SHALL be the default and SHALL alter nothing. `sanitized` SHALL remove prompt-derived text and every local identifier. `metadata-only` SHALL apply `sanitized` and additionally prune the span tree to container spans. No consumer SHALL be able to compose a fourth behaviour, and no consumer outside `packages/core` SHALL implement any part of a profile.

#### Scenario: Profiles are core-owned
- GIVEN a consumer requesting a sanitized export
- WHEN it invokes the sanitizer
- THEN it passes only a profile name, and the resulting payload is determined entirely by `packages/core`

#### Scenario: Full is the default and is a no-op
- GIVEN no profile is named
- WHEN a trace is built
- THEN the `full` profile applies and the output is byte-identical to output built without any sanitizer

### Requirement: Identity scrubbing coverage
Under `sanitized` and `metadata-only`, the system SHALL replace or remove every field that carries a local identifier: `run.project.path` and `run.project.name` SHALL become the same `project-N` pseudonym; `run.project.gitBranch` SHALL become `branch-N`; `run.source.files[]`, `span.provenance.file`, and `run.warnings[].file` SHALL become `transcript-N`; `run.title` SHALL be dropped; and the `runray.target` attribute SHALL be deleted, together with its legacy `tracepulse.target` spelling, which the insight rules still read as a fallback. `span.provenance.file` is a required field and SHALL therefore be replaced, never deleted. `run.warnings[].message` SHALL be passed through the path-shape net.

#### Scenario: Project identity is fully pseudonymized
- GIVEN a run whose cwd is `/Users/alex/work/acme-billing`
- WHEN the `sanitized` profile is applied
- THEN both `project.path` and `project.name` read `project-1`, and neither `acme-billing` nor `/Users/alex` appears anywhere in the run

#### Scenario: Required provenance field survives as a pseudonym
- GIVEN any span
- WHEN the `sanitized` profile is applied
- THEN `span.provenance.file` is present and holds a `transcript-N` pseudonym

#### Scenario: Target basename is dropped but grouping survives
- GIVEN spans carrying `runray.target`, `runray.targetKey`, and `runray.targetKind`
- WHEN the `sanitized` profile is applied
- THEN `runray.target` is absent while `runray.targetKey` and `runray.targetKind` are unchanged

#### Scenario: Legacy attribute spelling is covered
- GIVEN a span carrying the legacy `tracepulse.target` attribute
- WHEN the `sanitized` profile is applied
- THEN that attribute is absent, and no insight text names the target

### Requirement: Attribute allowlist
`span.attributes` is an open map in the frozen schema, so whenever identity is scrubbed — under `sanitized` and `metadata-only`, and with `--scrub-paths` alone — the system SHALL retain only allowlisted keys and SHALL drop every other key. Retention SHALL NOT depend on inspecting the value. The allowlist names keys, not prefixes, because an OTLP emitter can send any key under any prefix:
- the reserved metadata keys `runray.targetKey`, `runray.targetKind`, `runray.mcpDetection`, their legacy `tracepulse.*` spellings, and `tracepulse.cacheWrite1hTokens`; never `runray.target` / `tracepulse.target` or any other key an emitter stamps with these prefixes;
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

### Requirement: Pseudonyms are assigned deterministically across the whole trace
The system SHALL hold one mapping table per build, shared by every run in the `TraceFile`, so a given real value maps to the same pseudonym throughout one report. Ordinals SHALL be assigned by collecting the distinct real values, sorting them lexicographically, and numbering from 1 — never in traversal or discovery order. Each namespace (`project`, `transcript`, `branch`) SHALL be numbered independently.

#### Scenario: One pseudonym per project across runs
- GIVEN three runs, two of which share a cwd
- WHEN the `sanitized` profile is applied
- THEN the two runs carry the same `project-N` and the third carries a different one

#### Scenario: Assignment does not depend on discovery order
- GIVEN the same set of runs discovered in a different order
- WHEN the `sanitized` profile is applied
- THEN every pseudonym assignment is identical

### Requirement: Scrubbing precedes insight generation
Identity scrubbing SHALL be applied to the normalized, priced trace **before** the insight engine runs, so that insight `title`, `detail`, and `suggestion` text is generated from pseudonyms and never from real identifiers. The system SHALL NOT repair insight prose after the fact.

#### Scenario: Insight prose carries no filename
- GIVEN a run that triggers the repeated-read rule on a real file
- WHEN the `sanitized` profile is applied
- THEN the finding is still reported with its estimated waste, and its detail text names no filename

#### Scenario: Findings themselves are unchanged
- GIVEN the same run built under `full` and under `sanitized`
- WHEN both are built
- THEN the set of `ruleId`s and their `estimatedWasteUSD` values are identical

### Requirement: Sanitization is a pure projection
Sanitization SHALL NOT mutate the trace it is given: it SHALL return new objects for the nodes it changes and SHALL leave its input observably unchanged, so a caller holding the same trace for another purpose is unaffected. Sanitization SHALL require no filesystem access, no discovery, and no adapter invocation — it operates only on a trace already in memory. When the resolved profile strips prompt text, the system SHALL additionally parse with redaction enabled rather than relying on the projection alone, so the text never enters the process.

#### Scenario: Input is left unchanged
- GIVEN a normalized trace held by a caller
- WHEN a profile is applied to it
- THEN the caller's trace is observably unchanged and the sanitized result is a separate value

#### Scenario: No file access during sanitization
- GIVEN a trace already in memory
- WHEN any profile is applied
- THEN no file is opened, no directory is scanned, and no adapter runs

#### Scenario: A text-stripping profile also redacts at parse time
- GIVEN an export whose resolved profile strips prompt text
- WHEN the trace is built
- THEN the parse itself runs with redaction enabled, and no transcript slice is read

### Requirement: Redaction parity invariant
For every fixture and for both `sanitized` and `metadata-only`, sanitizing a trace parsed **without** redaction SHALL produce output deeply equal to sanitizing the same trace parsed **with** redaction. A divergence SHALL fail the build and SHALL name the diverging field.

#### Scenario: Parity holds across parse modes
- GIVEN any fixture
- WHEN it is parsed with `redact: false` and with `redact: true` and both results are sanitized under the same profile
- THEN the two outputs are deeply equal

#### Scenario: A newly added prompt-derived field is caught
- GIVEN an adapter that starts emitting a new prompt-derived field which the profile does not cover
- WHEN the parity test runs
- THEN it fails and identifies the field

### Requirement: Path-shape totality
The system SHALL assert, over the **serialized** output of `sanitized` and `metadata-only`, that no home-directory or absolute-path shape survives: `/Users/…`, `/home/…`, `C:\Users\…`, UNC and `\\?\`-prefixed paths, and `file://` URLs. Matching SHALL be case-insensitive. A surviving match SHALL fail the build; the system SHALL NOT silently scrub the match, because a silent scrub conceals a field the mapping table omitted.

#### Scenario: Serialized output contains no path shapes
- GIVEN a sanitized export of any fixture
- WHEN its serialized bytes are scanned
- THEN no path shape matches, and no fixture project basename appears

#### Scenario: An uncovered path-bearing field fails the build
- GIVEN a trace in which one path-bearing field was not mapped
- WHEN the totality assertion runs
- THEN the build fails rather than emitting the file

### Requirement: Metadata-only prunes to container spans and re-anchors evidence
Under `metadata-only`, the system SHALL retain spans of kind `session` and `subagent` and SHALL drop `llm_call`, `tool_call`, `mcp_call`, and `hook` spans. Pruning SHALL happen **after** the insight engine has run, so findings and totals are computed on the complete tree. Every `Insight.spanIds` entry and surviving container `span.parentId` SHALL be re-anchored to its nearest surviving ancestor and deduplicated; where no ancestor survives, `Insight.spanIds` SHALL be empty and `span.parentId` SHALL be `null`. The system SHALL NOT emit a span id that does not resolve to a span in the same run. `run.totals` and `estimatedWasteUSD` SHALL be unchanged by pruning.

#### Scenario: Container spans survive, leaves do not
- GIVEN a run with session, subagent, llm_call, and tool_call spans
- WHEN the `metadata-only` profile is applied
- THEN only the session and subagent spans remain

#### Scenario: Totals are unaffected by pruning
- GIVEN the same run under `sanitized` and `metadata-only`
- WHEN both are built
- THEN `run.totals` is identical in both

#### Scenario: Evidence resolves to a surviving span
- GIVEN a finding whose evidence spans were all pruned
- WHEN the profile is applied
- THEN each surviving evidence id resolves to a span present in the run, or the array is empty

#### Scenario: No dangling span reference
- GIVEN any `metadata-only` output
- WHEN every `Insight.spanIds` entry is resolved against the run's spans
- THEN no entry is unresolvable

### Requirement: Sanitized output conforms to the frozen contract
Output of every profile SHALL validate against `schema/runray.schema.json` v0.1. The system SHALL NOT add, rename, or remove any schema field to express sanitization state.

#### Scenario: Every profile validates
- GIVEN output of `full`, `sanitized`, and `metadata-only`
- WHEN each is validated against the committed JSON Schema
- THEN all three validate with no error

### Requirement: Sanitization manifest
The system SHALL produce, alongside the sanitized trace, a manifest stating the applied profile and the three independent facts a recipient needs: whether prompt text was redacted, whether identifiers were scrubbed, and whether spans were pruned. The manifest SHALL be carried outside `TraceFile` and SHALL contain no filesystem path.

#### Scenario: Manifest describes the applied profile
- GIVEN a `metadata-only` export
- WHEN the manifest is read
- THEN it names the profile and reports text redacted, identifiers scrubbed, and spans pruned

#### Scenario: Manifest carries no path
- GIVEN any manifest
- WHEN it is inspected
- THEN it contains no filesystem path
