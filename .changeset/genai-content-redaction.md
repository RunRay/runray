---
"runray": patch
---

Redacted, anonymized and path-scrubbed views and exports of OTLP imports no longer carry GenAI message content.

OpenTelemetry GenAI instrumentations can put prompt and output messages, system instructions, tool definitions, and tool arguments and results in `gen_ai.*` span attributes (opt-in), and older ones write `gen_ai.prompt.N.content`. Until now `--redact`, `--anonymize`, `--metadata-only` and `--scrub-paths` kept every `gen_ai.*` attribute, so an export of such an import could include that text and the local paths in it.

Now only metadata keys survive: provider, operation, model and numeric request parameters, response id, model and finish reasons, tool name, call id and type, conversation and agent ids, and token and cost counters. `--scrub-paths` alone still keeps prompt and output previews, but now drops these attributes. Keys an emitter stamps with the reserved `runray.` or `tracepulse.` prefix are dropped too, unless RunRay itself writes them.

If you shared a redacted, anonymized or path-scrubbed export of an OTLP import with content attributes enabled, export it again with this version. Claude Code and OpenCode transcripts were not affected.
