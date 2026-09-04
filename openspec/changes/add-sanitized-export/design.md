# Design: add-sanitized-export

## Context

`--redact` is a **parse-time** flag: adapters null `content.*` as they emit
(`packages/core/src/adapters/claude-code.ts:386`), `readTranscriptSlice` refuses
before touching the file (`packages/core/src/transcript.ts:290`), and the OTLP
adapter admits only `gen_ai.*` attributes. Text is handled. Identity is not:
`run.project.path`/`name`/`gitBranch`, `run.source.files[]`,
`run.warnings[].file`, `span.provenance.file` (a *required* field) and the
`runray.target` attribute all carry real local paths in every profile.

The build pipeline is one expression —
`applyInsights(normalize(priceRun(raw, pricing)), thresholds)` at
`packages/cli/src/discover.ts:236` — and that ordering is the pivot for this
whole design, because insight prose interpolates identity: rules.ts:849 renders
`“${display}” was read N times`, where `display` comes from `runray.target`.
Any sanitizer that runs *after* `applyInsights` is scrubbing prose, and prose
scrubbing is guesswork.

Existing surfaces this must not disturb: the frozen v0.1 schema; the
`--redact`/`--yes` consent guard (`packages/cli/src/export.ts:51`); the
provenance strip, which today *infers* redaction by sniffing spans
(`packages/ui/src/components/ProvenanceStrip.tsx:7`); and the goldens.

Signed off before drafting: `--redact` keeps its meaning and new flags compose
around it; `metadata-only` keeps session-header spans; paths become ordinal
pseudonyms (`project-1`), basename included.

## Goals / Non-Goals

**Goals:**
- One core-owned definition of what each profile strips, consumed by the CLI and
  described by the report manifest, with no consumer-side filtering anywhere.
- A sanitized export in which no home directory, project name, branch name, or
  filename survives anywhere in the serialized bytes — provable by a test that
  greps the output, not by a field-by-field review.
- Sanitized output that still validates against the frozen v0.1 schema.
- A report banner that can never over-promise: the badge is data-backed.

**Non-Goals:**
- Sanitizing the live dashboard. Local inspection keeps full fidelity.
- Scrubbing secrets *inside* prompt text — the profiles remove the text entirely.
- Cross-export correlation, uploading, or hosting. No network, ever.
- Schema changes. No `sanitization` field is added to `TraceFile`.

## Decisions

### D1: Two stages, straddling the insight engine

The sanitizer is not one pass. It is two, inserted at different points of the
existing pipeline expression:

```
applyInsights( scrubIdentity( normalize(priceRun(raw)) ) )   → then → pruneToMetadata()
```

- **`scrubIdentity`** runs *before* `applyInsights`, so insight prose is
  generated from pseudonyms. rules.ts:849 already degrades gracefully when
  `runray.target` is absent (`"The same target was read N times"`) — deleting the
  attribute before the rules run reuses a path that is already specced and
  tested, instead of inventing prose repair.
- **`pruneToMetadata`** runs *after* `applyInsights`, so findings and totals are
  computed on the full tree and only then is the tree reduced. Insights are the
  product; computing them on a pruned tree would silently weaken them.

*Alternative rejected:* one post-hoc projection over the finished `TraceFile`.
It cannot clean insight `detail` strings or adapter-authored
`warnings[].message` without regex-editing prose, and a missed pattern is a
silent leak.

### D2: Ordinals assigned over a sorted key set, not in traversal order

`scrubIdentity` owns a per-build mapping table, shared across every run in the
`TraceFile` so `project-1` means the same thing throughout one report. Ordinals
are assigned by collecting the distinct real values, sorting them
lexicographically, then numbering — **not** by first-seen order, which would
make output depend on discovery traversal and flap the goldens. Namespaces are
separate: `project-N`, `transcript-N`, `branch-N`.

Path-bearing fields and their treatment:

| Field | `full` | `sanitized` / `--scrub-paths` |
|---|---|---|
| `run.project.path` | verbatim | `project-N` |
| `run.project.name` | verbatim | `project-N` (same N) |
| `run.project.gitBranch` | verbatim | `branch-N` |
| `run.source.files[]` | verbatim | `transcript-N` |
| `span.provenance.file` | verbatim | `transcript-N` (required — replaced, never deleted) |
| `run.warnings[].file` | verbatim | `transcript-N` |
| `run.warnings[].message` | verbatim | passed through the path-shape net (D3) |
| `runray.target` | basename | deleted (`targetKey`/`targetKind` survive — a hash and an enum) |
| `run.title` | verbatim | dropped (already dropped under `--redact`) |
| `span.attributes.*` | verbatim | allowlist: reserved `runray.*` counters, `gen_ai.*`, and legacy `tracepulse.*` metadata (excluding deleted `tracepulse.target`); everything else dropped |

`span.attributes` is `{"type":"object"}` — an open map. For an open map the only
safe rule is an allowlist, because an OTLP importer can put anything in it.

### D3: A path-shape net as the backstop, and the test that proves totality

Field mapping is the mechanism; a regex net over the *serialized* output is the
guarantee. `sanitized` and `metadata-only` output is asserted to contain no
match for `/Users/…`, `/home/…`, `C:\Users\…`, `\\?\`-prefixed and UNC paths, or
`file://` URLs — plus, in fixture tests, no occurrence of the fixture's known
project basenames. Matching is case-insensitive (macOS and Windows filesystems
are). A surviving match fails the build; it does not get scrubbed silently,
because a silent scrub hides a field the mapping table forgot.

### D4: A profile that strips text also redacts at parse time, and an equivalence invariant proves the two agree

When the resolved profile strips prompt text, the CLI SHALL pass `redact: true`
into the parse itself rather than relying on the projection alone. That keeps the
strongest existing guarantee intact: `readTranscriptSlice` refuses before opening
a file (`transcript.ts:290`), so the text never enters the process. The
projection remains the definition of what a profile strips; parse-time redaction
is the belt that makes it moot for the text half.

That leaves one drift risk. `--scrub-paths` without `--redact` parses
unredacted, and a future adapter could add a prompt-derived field that the
parse-time path nulls but the projection does not. The invariant that catches it,
run over every fixture:

```
sanitize(parse(file, {redact: false})) ≡ sanitize(parse(file, {redact: true}))
```

Deep equality, both sanitizing profiles. This holds *only because* `scrubIdentity`
precedes `applyInsights` (D1) — otherwise the unredacted branch bakes
`Invoice.tsx` into insight prose and the two sides diverge. So the ordering
decision and the safety test are the same decision seen twice. If the invariant
fails, a prompt-derived field escaped the profile definition, and the failure
names it.

This also retires the proposal's tentative **BREAKING** note. With D7 there is no
served-data export path at all: every artifact comes from a fresh `runray
export`, where D1's ordering applies by construction.

### D5: `metadata-only` keeps container spans and re-anchors insight evidence

`kind: 'session'` and `kind: 'subagent'` spans survive; `llm_call`, `tool_call`,
`mcp_call`, `hook` leaves are dropped. What still works, from `run.totals`
alone: KPI cards, the per-model treemap (`totals.costUSD.byModel`), counts,
cache hit-rate, and insight badges.

Dangling `Insight.spanIds` and surviving container `span.parentId` links are
not acceptable output. Each evidence id and surviving container `span.parentId`
is **re-anchored to its nearest surviving ancestor** — normally the session span —
deduplicated, so clicking a finding still highlights the session bar that
contains it, and tree traversal remains sound. When no ancestor survives, the
evidence array is empty (the schema sets no `minItems`) and `parentId` becomes
`null`. `estimatedWasteUSD` and `detail` are untouched: the finding is
still true, only its evidence is coarser.

*Alternative rejected:* dropping spans entirely. It empties the waterfall for no
additional privacy — turn counts are already exposed by `totals.counts`.

### D6: The manifest travels in `__RUNRAY_VIEW_CONFIG__`, and the badge distrusts it

The schema is frozen, so the applied profile cannot live in `TraceFile`. It goes
into the existing `__RUNRAY_VIEW_CONFIG__` global (`packages/cli/src/export.ts`
`injectGlobal`), as `{profile, textRedacted, pathsScrubbed, spansPruned}`.

`ProvenanceStrip` reads the manifest **but keeps its existing span-sniffing**
(`hasUnredactedPrompts`) as a cross-check. If the manifest claims redaction and
sniffing finds prompt text, the strip renders the warning treatment and says the
file contains prompt text. The badge can therefore under-promise but never
over-promise — the property that makes it worth showing a compliance reviewer.

### D7: The dashboard hands off a command; it never generates a file

No export endpoint is added. The dashboard's export control opens a dialog that
presents the three profiles and renders the exact `runray export` invocation for
the current selection, with a copy control. The user runs it in their terminal.

This is not only the cheaper option, it is the better fit:

- **No new attack surface.** A `POST` endpoint that returns a generated file is
  the single most security-sensitive thing this change could add to a tool whose
  guarantee is "nothing leaves your machine". Not adding it is worth real UX
  friction.
- **The command is the audit record.** A reviewer asking "what was stripped from
  this report?" gets a literal answer the user can paste into the PR, and CI can
  run the same line (issue #18).
- **It teaches the flag.** The problem this change addresses is that developers
  do not know sanitized sharing is possible. A dialog reached at the moment of
  intent does what documentation does not.
- **No re-derivation problem.** Every artifact comes from a fresh build, so
  `scrubIdentity` always precedes `applyInsights` in the pipeline itself. There
  is no already-computed insight prose to un-bake, no pre-insight retention, and
  no object shared between an export and a live dashboard.

The dialog SHALL only offer commands the CLI can actually express. `export` takes
`[target] -o <file> --source --since` (`packages/cli/src/program.ts:409`), so a
single-run export is exact (`state.route.runId`), and source and period map to
flags. The **project filter has no CLI equivalent** — it is store-only
(`packages/ui/src/store.ts:122`) — so when viewing a single run, the command
narrows to that run id (`state.route.runId`); when on a multi-run overview
with store-only filters, the dialog explains that CLI export covers all runs
matching supported flags (`--since`/`--source`), never misrepresenting scope.

`navigator.clipboard.writeText` is available: `http://127.0.0.1` is a secure
context. A select-all fallback covers a denied clipboard permission.

Flag composition in `export`: `--redact` (text) and `--scrub-paths` (identity)
are independent; `--anonymize` sets both; `--metadata-only` implies both and adds
pruning; `--redact-prompts` is a documented alias of `--redact`. The consent
guard is unchanged except that `--scrub-paths` alone does **not** satisfy it —
only text redaction does, because the guard exists to protect prompt text.

*Alternative rejected:* `POST /api/export` returning the file for a browser
download. Kept viable for later — adding it is purely additive and changes
nothing specced here — but it costs an endpoint, body validation, a second
profile-resolution site, in-flight and failure UI states, and a way to re-derive
insights over an already-served trace — all to save a copy-paste.

## Risks / Trade-offs

- **The mapping table forgets a field a future adapter adds** → D3's net runs
  over serialized output, so a new path-bearing field fails the test suite
  rather than shipping. D4's equivalence invariant covers prompt-derived fields
  the same way.
- **Ordinals still correlate two exports of the same run set** (accepted at
  sign-off) → both files call it `project-1`. Cross-machine correlation is
  impossible since ordinals encode nothing about the real path; a recipient
  holding two reports from the same developer can align them. Documented in the
  manifest wording, not mitigated.
- **`metadata-only` leaks session count and working hours** via surviving
  container spans and `startedAt` → inherent to keeping a waterfall at all; the
  profile is documented as "structure hidden, schedule visible". Users needing
  more get `full`-free aggregates by exporting a single run.
- **Insight prose gets vaguer under scrubbing** ("The same target" instead of the
  filename) → already the behavior under `--redact` today, and `targetKey`
  grouping keeps the *findings* identical. Only the label degrades.
- **Re-anchored evidence changes what a click highlights** in `metadata-only` →
  the UI must not assume a `spanId` resolves to a leaf; a session-level highlight
  is the specified behavior, tested.
- **UI degraded states** for a pruned payload (empty inspector, session-only
  waterfall, time view without turns) are new render paths that can only be
  covered by fixtures, not by types → one `metadata-only` golden per source, and
  the export-mode UI tests run against it.
- **The handoff is two steps, and a command can lie about scope** → copy, paste,
  run. Acceptable for a deliberate occasional action, wrong for a frequent one;
  if export becomes frequent, D7's rejected alternative is the answer. The
  scope hazard is sharper: a command that exports more runs than the screen
  shows would be a privacy surprise, so the dialog narrows to the current run
  whenever the active filters cannot be expressed as flags.
- **Windows and case-folding** → the net is case-insensitive and covers UNC and
  `\\?\` forms; drive-root cwd already has a documented basename fallback
  (`claude-code.ts:866`) that the pseudonym path replaces outright.
- **No golden may move** for the default profile. New goldens are added per
  profile in their own commit; a moved existing golden means the change is wrong.

## Open Questions

- Should `runray.targetKey` (the 16-hex target hash) survive `sanitized`? It is
  not reversible, and dropping it would weaken cross-run target grouping — but
  a recipient with a guessed path list could confirm a guess. Kept for now.
- Does `--metadata-only` deserve a `list`/`diff` counterpart, or is export the
  only surface? Out of scope here; `diff` already parses redacted.
- `agent.name` is the second identity-bearing string in insight prose
  (`rules.ts:356`, `Subagent code-reviewer consumed 41% of the run`). Custom
  subagent type names are user-authored and can carry a client name
  (`acme-migrator`), but they are not path-shaped, so D3's net does not catch
  them. Left verbatim for now — pseudonymizing agent types would gut the
  delegation view's usefulness. Flagged for the privacy review.
