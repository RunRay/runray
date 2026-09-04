# Proposal: add-sanitized-export

## Why

`--redact` strips prompt and output text, but a redacted `report.html` still names
the machine and the client: `run.project.path` and `run.project.name` carry the cwd
(`/Users/alex/work/acme-billing`), `run.source.files[]` and every
`span.provenance.file` carry absolute transcript paths, `run.project.gitBranch`
carries branch names, and `runray.target` carries file basenames. A developer under
an NDA or an enterprise infosec policy cannot hand that file to anyone — not to a
cost autopsy, not into a PR, not into a Slack budget review — even though the parts
that make the report useful (token counts, model mix, cache behavior, latency,
insight findings) contain nothing sensitive. Today the only way to share is to not
share.

## What Changes

- **New sanitization levels in core**, applied as one named profile per export
  rather than as scattered flags. `full` (unchanged, default for local inspection),
  `sanitized` (redacted text **plus** scrubbed paths and local identifiers), and
  `metadata-only` (aggregates, model/tool rollups and session headers; no span
  bodies). The profile is a core projection, so no consumer can opt out of it and
  no consumer can implement its own.
- **Path and identifier scrubbing** over every path-bearing field the schema
  allows: home directories (`/Users/…`, `/home/…`, `C:\Users\…`), project paths,
  transcript file paths, git branch names, and tool target basenames. Structure
  survives: paths become stable placeholders, so grouping and per-project rollups
  still work in the report.
- **CLI flags on `export`**: `--sanitized` (or the requested `--anonymize`) and
  `--metadata-only` select a profile; `--scrub-paths` adds path scrubbing on its
  own. `--redact` keeps its exact current meaning and stays the text-only lever;
  `--redact-prompts` is documented as its alias. The existing consent guard
  (`--yes` / interactive confirm for unredacted exports) is unchanged — a
  `sanitized` or `metadata-only` export never prompts.
- **UI export handoff** (issue #24 is unbuilt — there is no export trigger in
  `TopBar` or the ⌘K palette today): a trigger plus a dialog offering the three
  profiles with their consequences stated, defaulting to `sanitized`. The dialog
  renders the exact `runray export` command for the current selection with a copy
  control; the user runs it. The dashboard generates no file, adds no endpoint,
  and transmits nothing — the copied command is both the mechanism and the audit
  record of what was stripped, and it is the same line CI can run.
- **Privacy manifest on the exported file**, extending the existing provenance
  strip (which today sniffs spans for prompt text) to state the applied profile
  explicitly: what was stripped, what was preserved. The manifest travels in
  `__RUNRAY_VIEW_CONFIG__`, not in `TraceFile` — the schema stays frozen.

Out of scope: sharing, uploading, or hosting reports (no network, ever);
sanitizing the live dashboard (local inspection keeps full fidelity);
pseudonymizing across runs so two exports from the same machine can be correlated;
scrubbing secrets *inside* prompt text (the `sanitized` profile removes the text
entirely, which is strictly stronger).

## Capabilities

### New Capabilities

- `trace-sanitization`: the profile contract — the three levels, and for each one a
  field-by-field statement of what is stripped, what is replaced with a placeholder,
  and what is preserved verbatim, across `TraceFile`, `Run`, `Span`, `RunTotals` and
  `Insight`. Owns the path-scrubbing rules (which path shapes are recognized, what
  replaces them, determinism of the replacement) and the invariant that a sanitized
  `TraceFile` still validates against the frozen v0.1 schema. Lives in
  `packages/core` per the privacy-in-core rule, and is consumed by the CLI and
  described by the report's privacy manifest — one definition, no UI-side
  filtering, no second implementation behind an endpoint.

### Modified Capabilities

- `cli`: `export` gains the profile flags above and their precedence against the
  existing `--redact` / `--yes` guard, and reports the applied profile on success
  so a scripted export is auditable; `--redact` semantics and all exit codes are
  unchanged. No new endpoint and no change to the local server.
- `visualizer`: the export trigger in `TopBar` and the ⌘K palette; the profile
  dialog with its keyboard and focus contract (hand-rolled, matching `HelpSheet` /
  `CommandPalette` — no component library) and the command it hands off; the
  provenance strip stating the applied profile instead of inferring it; and every
  view rendering correctly against a `metadata-only` payload, including the empty
  and degraded states.

No `trace-ingestion` or `cost-engine` delta: sanitization is a projection over
already-normalized output and changes no adapter, no cost math, and no golden.
**If a golden moves, the change is wrong.**

## Impact

**`packages/core`** — new sanitizer module plus the path scrubber. No adapter or
normalizer change. Two constraints the design must resolve: `Span.provenance.file`
is a *required* field, so scrubbing replaces it rather than dropping it; and
`Insight.spanIds` points at spans that `metadata-only` removes, so either a header
skeleton survives or dangling references are specified as acceptable.

**`packages/cli`** — flag parsing and profile resolution in `program.ts`, profile
handling in `export.ts`. `server.ts` is untouched: no endpoint is added.
`__RUNRAY_VIEW_CONFIG__` carries the manifest; the pricing-override local path
must stay out of the shareable file, as today.

**`packages/ui`** — export trigger, profile dialog with command rendering and
clipboard copy, provenance-strip extension, and degraded-payload handling in the
views. No network call is added to the UI. Every UI task is
`[UI → /frontend-design]` per CLAUDE.md. No new dependency is expected.

**Schema** — untouched. No `sanitization` field is added to `TraceFile`; a sanitized
export is a valid v0.1 `TraceFile` whose sensitive strings are placeholders.

**Fixtures** — needs a golden per profile to prove the sanitizer is total (a test
that asserts *no* home-directory-shaped string survives, not a sample of fields).
Generated via the regen script, in its own commit.

## Decisions requiring human sign-off

1. **Flag naming.** The request asks for `--anonymize` / `--redact-prompts` /
   `--scrub-paths` / `--metadata-only`; `--redact` already ships. The recommendation
   above keeps `--redact` as the text lever and makes `--anonymize` an alias of
   `--sanitized` (text + paths), so no existing invocation changes meaning. Confirm,
   or pick one vocabulary and accept the rename.
2. **`metadata-only` fidelity.** Dropping spans breaks insight→span evidence links
   and the waterfall. Confirm whether the profile keeps a session-header span
   skeleton (report stays navigable, structure leaks turn counts) or drops spans
   entirely (smallest surface, several views go empty).
3. **Placeholder determinism.** Stable placeholders (`project-1`, `project-2`) keep
   rollups readable but let a recipient correlate two exports from the same machine.
   Confirm per-export randomization is not wanted.

All three are resolved: `--redact` keeps its meaning with composable new flags;
`metadata-only` keeps session-header spans; paths become ordinal pseudonyms
including the basename. A fourth decision, taken after review: the dashboard hands
off a copyable command instead of gaining an export endpoint (design D7).
