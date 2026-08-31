# Tasks: add-sanitized-export

Track **A** = data (`packages/core`, `packages/cli`), Track **B** = experience
(`packages/ui`). Every task: `pnpm lint && pnpm typecheck && pnpm test` green,
schema untouched, goldens unchanged except where a task says otherwise. UI tasks
run under the `/frontend-design` skill per CLAUDE.md.

## 1. Core sanitizer

- [x] 1.1 A Profile contract in `packages/core/src/sanitize/`: the
      `SanitizeProfile` union (`full` | `sanitized` | `metadata-only`) and a pure
      resolver from the three independent intents (strip text, scrub identity,
      prune spans) to exactly one profile; `full` is a no-op returning its input.
      Unit tests for every intent combination including redundant ones (D7,
      trace-sanitization "Three named sanitization profiles")
- [x] 1.2 A `scrubIdentity()`: one mapping table per build, shared across every
      run, ordinals assigned over the lexicographically sorted distinct values in
      three independent namespaces (`project-N`, `transcript-N`, `branch-N`).
      Covers `project.path`/`name`/`gitBranch`, `source.files[]`,
      `provenance.file`, `warnings[].file`, `run.title`, and both `runray.target`
      and legacy `tracepulse.target`. **Pure** — input observably unchanged.
      Unit tests including discovery-order independence (D2)
- [x] 1.3 A Attribute allowlist inside `scrubIdentity`: retain reserved
      `runray.*` counters, `gen_ai.*`, and legacy `tracepulse.*` internal metadata
      keys (excluding deleted display `tracepulse.target`), drop every other key
      without inspecting its value; test with an OTLP span carrying a path inside
      a vendor attribute (D2, trace-sanitization "Attribute allowlist")
- [x] 1.4 A Path-shape net: case-insensitive matcher for `/Users/…`, `/home/…`,
      `C:\Users\…`, UNC and `\\?\` forms, and `file://` URLs, exported for use as
      an assertion. It reports matches; it never rewrites them (D3)
- [x] 1.5 A `pruneToMetadata()`: keep `session` and `subagent` spans, drop
      `llm_call`/`tool_call`/`mcp_call`/`hook`, re-anchor every
      `Insight.spanIds` entry and surviving container `span.parentId` to its
      nearest surviving ancestor and dedupe, empty array when no ancestor
      survives. `run.totals` byte-identical to the unpruned run. Unit test
      asserting no unresolvable span reference (D5)
- [x] 1.6 A Manifest producer: `{profile, textRedacted, pathsScrubbed,
      spansPruned}`, carrying no filesystem path, outside `TraceFile` (D6)
- [x] 1.7 A Pipeline wiring in `packages/cli/src/discover.ts`: `scrubIdentity`
      between `normalize` and `applyInsights`, `pruneToMetadata` after; the
      mapping table created once per `buildTraceFile` call; a text-stripping
      profile also passes `redact: true` into `adapter.parse` (D1, D4)

## 2. Invariants, fixtures, goldens

- [x] 2.1 A Redaction-parity test over every fixture: `sanitize(parse(f,
      {redact:false})) ≡ sanitize(parse(f, {redact:true}))` for both sanitizing
      profiles, deep equality, failure message naming the diverging field (D4)
- [x] 2.2 A Totality test over the **serialized** output of both sanitizing
      profiles for every fixture: no path-shape match (1.4) and no occurrence of
      the fixture's known project basenames. A match fails the test (D3)
- [x] 2.3 A Schema conformance test: `full`, `sanitized`, and `metadata-only`
      output each validated against `schema/runray.schema.json`
- [x] 2.4 A New goldens for `sanitized` and `metadata-only` per source via the
      regen script, in a **dedicated commit** with justification; the existing
      `full` goldens must not move — if one moves, stop and reopen the design

## 3. CLI surface

- [x] 3.1 A Flags on `export`: `--scrub-paths`, `--anonymize`,
      `--metadata-only`, and `--redact-prompts` as a documented alias of
      `--redact`; resolution through 1.1; the `redact` key in
      `runray.config.json` keeps working unchanged. Table-driven unit tests over
      every combination (cli "Export sanitization flags")
- [x] 3.2 A Consent guard in `export.ts`: satisfied by text redaction, `--yes`,
      or interactive confirmation — **not** by `--scrub-paths` alone; a
      text-stripping profile never prompts; non-interactive prompt-text export
      still aborts with today's warning and exit code (cli "Consent guard
      responds to text redaction only")
- [x] 3.3 A Success line on stderr names the applied profile; `--json` stdout
      stays clean; `--help` text documents each flag and the alias
- [x] 3.4 A Manifest injected into `__RUNRAY_VIEW_CONFIG__` through the existing
      `injectGlobal`; the local pricing-override path stays out of the shareable
      file, as today (D6)
- [x] 3.5 A Negative tests: the local server exposes no export route and writes
      no report file (cli "No export endpoint is added to the local server"), and
      the existing network guard covers a sanitized export end to end

## 4. Dashboard handoff

- [x] 4.1 B Pure command builder in `packages/ui/src/lib/`: `exportCommand(view,
      profile)` → the exact `runray export` invocation, run id from
      `state.route.runId`, plus the scope sentence. Narrows to the run in view
      whenever an active filter has no CLI equivalent — it must never render a
      command covering more runs than the screen shows. Unit tests per profile
      and per filter shape (D7, visualizer "The rendered command is exact and
      never overstates its scope")
- [x] 4.2 B Export trigger in `TopBar` and as a `CommandPalette` action, both
      opening the one dialog; live-mode only, absent from an exported report
      [UI → /frontend-design]
- [x] 4.3 B Export dialog [UI → /frontend-design]: three profiles with their
      consequences in plain language, `sanitized` preselected, a visible caution
      on the full-trace option, the command re-rendering in place on selection,
      one copy control with success confirmation and a select-all fallback when
      clipboard access is denied, and the command readable without horizontal
      scrolling. Hand-rolled against the design tokens, matching `HelpSheet` /
      `CommandPalette` for focus trap, `Esc`, keyboard selection, and labelling;
      hover / `focus-visible` / active states on every control (visualizer
      "Export dialog interaction contract")

## 5. Rendering a sanitized report

- [x] 5.1 B Provenance strip reads the manifest and names the applied profile
      plus the three facts independently, while keeping its own span inspection
      as a cross-check — a manifest claiming redaction over present prompt text
      renders the warning treatment [UI → /frontend-design] (D6)
- [x] 5.2 B Degraded render paths for a `metadata-only` payload: inspector and
      transcript pane explain the profile instead of showing an error or a
      misleading zero, the waterfall keeps one bar per session, and the time view
      renders without turns [UI → /frontend-design]
- [x] 5.3 B Evidence selection tolerates re-anchored ids: selecting a finding
      highlights the surviving container span, with no unresolved-reference error
      anywhere in the views (D5)

## 6. Verification and release

- [x] 6.1 A E2E through the real CLI: export each profile, assert the file opens
      from `file://` offline, the banner states the profile, and the bytes carry
      no path shape
- [x] 6.2 B A11y pass on the trigger and dialog (keyboard-only handoff, focus
      return, labelling, reduced-motion) and a browser check of the copy flow
- [x] 6.3 A Docs: the `export` block in `docs/05-ARCHITECTURE.md` §CLI and the
      README sharing story gain the new flags and the profile table; the privacy
      section states that the dashboard generates nothing
- [x] 6.4 A `pnpm changeset` — user-visible: new export flags and a sanitized
      sharing path
