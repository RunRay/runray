# Tasks: add-tool-usage-breakdown

Track **A** = data (`packages/core`, `packages/cli`), Track **B** = experience
(`packages/ui`). Every task: `pnpm lint && pnpm typecheck && pnpm test` green
and the schema untouched. Goldens are touched **only** in 2.6 and 5.4
(dedicated commits); every other task asserts them byte-identical. UI tasks
run under the `/frontend-design` skill per CLAUDE.md. References (D1…, T1…)
point at `design.md`; quoted names are requirements in the spec deltas.

Hard chains: 1.1→1.2→1.4; 1.3→1.4→1.5; group 1→group 2→2.6; group 2→group 3
→group 4; 5.1→5.2→5.4. Group 5 may start once 3.2 is done. Group 7 is gated.

## 1. Decomposition and registry (nothing calls it; goldens byte-identical)

- [x] 1.1 A Shell scanner in `packages/core/src/tools/shell.ts` (T4): pipelines
      and stages, quotes, escapes, command substitution, heredoc bodies,
      comments, the PowerShell dialect, the 8,192-character cap. Verify:
      table-driven tests covering every scenario of "Shell command
      decomposition" and "Decomposition is total and bounded", plus a
      property test over random and adversarial strings that asserts no throw.
- [x] 1.2 A Program resolution within a stage: skip assignments, wrappers and
      control keywords; normalise to a lowercase basename without Windows
      executable extensions; report unresolved when the last path segment
      holds an expansion. Verify: table-driven tests for the five scenarios of
      "Program resolution within a stage".
- [x] 1.3 A Registry in `tools/registry.ts` (T5): the activity enum and the
      expected-duration rank (T6); tool entries with label, activity, aliases
      and the `utility` / `plumbing` marks; subcommand tables and global
      options for git, docker, gh, kubectl, cargo, go, dotnet, flutter, dart,
      the JS and Python package managers, supabase, vercel, terraform, helm,
      turbo, nx and make; the runner list; the harness-tool table for Claude
      Code and OpenCode names. Seed beyond the measured sample (Python, Go,
      JVM, .NET, Apple toolchains). Verify: an invariants test (unique ids and
      aliases, non-empty labels, activities inside the enum) and a snapshot
      test of the id list.
- [x] 1.4 A Classification in `tools/classify.ts`: runner unwrapping with
      nested shells to depth 2, subcommand lookup, package-manager scripts and
      script-name activity patterns, primary selection by rank, also-ran list
      capped at eight, the shape gate for free-form names (T3), and the
      redaction switch. Returns the attribute map. Verify: table-driven tests
      for every scenario of "Runner unwrapping", "Subcommand tables",
      "Package-manager scripts", "Activity taxonomy", "Primary tool selection"
      and "Privacy class of identity values", including the argument-leak
      scenario in both redaction modes.
- [x] 1.5 A Browser-safe export `@runray/core/tools` in core `package.json`,
      registered in `browser-safe.test.ts` (T1), and a `scripts/bench.ts`
      entry that classifies a 1 MB command and a batch of typical commands.
      Verify: the import-graph purity test passes for the new entrypoint and
      `pnpm bench` reports the entry inside the existing budgets.
- [x] 1.6 A Document the module in `docs/05-ARCHITECTURE.md` (decomposition
      rules, registry shape, the two privacy classes). Verify: the section
      names the files and exports that exist after 1.5.

## 2. Adapters stamp identity (goldens change; regeneration deferred to 2.6)

- [x] 2.1 A claude-code adapter: stamp the classification on `Bash` and
      `PowerShell` spans at the tool emit site, dialect chosen by tool name,
      next to the existing target attributes. Verify: adapter tests that build
      transcripts inline for "Compound command resolved", "Also-ran tools",
      "Identity survives redaction", "Unresolved command" and "Target identity
      is untouched".
- [x] 2.2 A opencode adapter: the same for `bash` at the tool-part emit site,
      identical across the three storage eras. Verify: an adapter test for
      "Cross-adapter identity" and an era-parity assertion.
- [x] 2.3 A Command result flags (claude-code): `background` from
      `run_in_background` or a recorded background task id, `timeout` from the
      recorded harness timeout, `interrupted` from the result flag, in that
      fixed order. Verify: tests for the three scenarios of "Command result
      flags".
- [x] 2.4 A Skill identity: `runray.skill` from the Claude Code `Skill` input,
      unredacted only. For OpenCode's `skill` tool, inspect a real session to
      find where the name is recorded; stamp it if it is, and record the
      finding in an adapter comment if it is not. Verify: tests for both
      scenarios of "Skill identity capture" and the recorded finding.
- [x] 2.5 A Allowlist and OTLP validation: add the closed-vocabulary keys to
      `attribute-keys.ts`; the OTLP adapter validates incoming `runray.tool*`
      values against their vocabularies and drops free-form keys under
      redaction (T10). Verify: tests for the three scenarios of "Reserved
      tool-usage keys from OTLP are validated", the two new "Attribute
      allowlist" scenarios, and the redaction-parity suite green.
- [x] 2.6 A Regenerate goldens with `pnpm goldens` in a dedicated commit.
      Verify: the diff adds `runray.tool*` attributes to shell spans and
      changes nothing else; the path-shape totality assertion still passes on
      the sanitized and metadata-only goldens.
- [x] 2.7 A Document the reserved attributes in `docs/02-DATA-MODEL.md`: key,
      value, privacy class, behaviour under redaction, and the disclosure note
      from D1. Verify: the table matches T3 key for key.

## 3. Resolver and aggregation

- [x] 3.1 A `tools/identity.ts`: span to identity (family, key, label,
      subcommand, activity, flags, container mark), with the fallback for
      spans that carry no tool-usage attributes (T2). Verify: tests for every
      scenario of "Tool identity resolution", "Identity outside the registry
      and outside the vocabulary" and "Harness tool classification".
- [x] 3.2 A `tools/usage.ts`: ranked rows with sub-rows, total, shared and
      also-ran time, nearest-rank percentiles, errors and flag counts; the
      utilities group mark; the three side groups; summed tool time and
      activity totals (T7, T11). Verify: tests for every scenario of "Tool
      usage aggregation", "Sub-rows by subcommand and name", "Time
      attribution" and "Containers, hooks and waiting stay out of tool time".
- [x] 3.3 A Invariants over real shapes: run the aggregation against every
      committed golden, including the metadata-only ones. Verify: a test
      asserting no throw, row totals summing to summed tool time, and activity
      totals partitioning it, on every golden.

## 4. Time view

- [x] 4.1 B `lib/time-breakdown.ts`: the `waiting` category with precedence
      model, then tool, then waiting (D3, T8). Verify: unit tests for "Waiting
      on the person is its own segment" and "A tool running during a pending
      question", and the existing segment-sum tests unchanged.
- [x] 4.2 B [UI → /frontend-design] Wall-clock strip and legend with the fifth
      segment; update the `time-view` hint and any tour or onboarding copy
      that enumerates the segments. Verify: a component test that renders five
      legend rows and an accessible label naming five segments;
      `onboarding.test.ts` green.
- [x] 4.3 B [UI → /frontend-design] Activity bar (T12): fixed activity order,
      six colored parts plus one neutral part plus the unresolved pattern,
      legend with time and share, the summed-time heading, selection that
      filters the table. Verify: component tests for the four scenarios of
      "Tool time by activity"; the palette's separation check on the ink and
      paper surfaces recorded in the PR; `theme-tokens.test.ts` green.
- [x] 4.4 B [UI → /frontend-design] Tool table from `usage`: family tag,
      columns, share bar, sort by total, p95 or calls, expandable sub-rows,
      family filter, the utilities group, the delegations-and-hooks group, the
      shared, background and partial markers. Verify: component tests for
      every scenario of "Tool usage table", "Shared, background and partial
      figures are marked", "Shell utilities are grouped" and "Delegations and
      hooks are listed apart", including the keyboard scenario.
- [x] 4.5 B [UI → /frontend-design] Degraded states and the limits note: the
      pre-change trace notice, the "other command" row, the metadata-only
      empty state, the explanation of permission wait and shared time. An
      OTLP run also has unclassified shell calls (its tool spans carry no
      command, T10), so the notice is worded by source and does not call such
      a run "recorded before tool identification".
      Verify: tests for the three scenarios of "Tool usage degraded states"
      (extending `metadata-only-render.test.tsx`) and for "Limits of tool time
      are stated".
- [x] 4.6 B Remove the per-run `toolDurationStats` and its test once the Time
      view no longer calls it; keep `toolDurationStatsAcrossRuns` (T11).
      Verify: typecheck passes and no import of the removed function remains.
- [x] 4.7 B Release note and end-to-end proof: a changeset (`pnpm changeset`)
      describing the Time view change; the component tree in
      `docs/05-ARCHITECTURE.md`; a case in
      `packages/cli/src/profiler-e2e.test.ts` that serves a transcript built
      inline and asserts the payload carries tool-usage attributes. Verify:
      the e2e case passes and the changeset file exists.
- [x] 4.8 B Demo data: `scripts/demo/skin.ts` re-skins shell targets but
      copies tool-usage attributes from the goldens, where commands are filler
      words. Give each re-skinned command the tool identity of its new
      executable, then rebuild with `pnpm demo:build`. Verify: no demo run
      carries a filler word in `runray.toolName`, and the demo Time view lists
      the storyline tools (`pnpm`, `git`, and `tsc` for what ran behind
      `npx`).

## 5. Claude Code hook spans (goldens change; regeneration in 5.4)

- [x] 5.1 A `dead-end-run` skips `hook` spans when it picks the run's terminal
      span (T9). Verify: a rule test with a run ending in a failed hook span
      and one ending in an `ok` hook span after a failed tool call, and an
      assertion that findings on every fixture are unchanged.
- [x] 5.2 A Emit hook spans from failed and cancelled hook records and from
      stop-hook summaries (T9): ids from the record uuid, parent from the
      triggering tool call, the hook command classified and then dropped.
      Verify: adapter tests for every scenario of "Claude Code hook spans",
      "Hook spans attach to their trigger and stay out of tool totals" and
      "Hook commands are classified, never stored", plus a re-appended
      transcript emitting each hook span once.
- [x] 5.3 B [UI → /frontend-design] Hook rows in the delegations-and-hooks
      group, with the "failed and cancelled runs only" label and a count
      without a time for zero-duration `Stop` spans. Verify: a component test
      for "Hook durations are partial".
- [x] 5.4 A Regenerate goldens with `pnpm goldens` in a dedicated commit.
      Verify: the diff adds hook spans only where a fixture holds hook
      records; no finding and no token, cost, call or error total in any
      golden changes; the only other differences are container and run
      bounds that now cover a hook, and `counts.maxDepth` one higher where a
      hook hangs off the deepest call (design T9).
- [x] 5.5 A Document hook spans in `docs/02-DATA-MODEL.md`: which records
      become spans, which hook runs leave no record, why durations are
      partial. Verify: the section names the three record shapes from D5.

## 6. Integration check

- [x] 6.1 Full gate: `pnpm lint && pnpm typecheck && pnpm test`, `pnpm bench`,
      the schema-diff check, and
      `openspec validate add-tool-usage-breakdown --strict`. Verify: all four
      pass.
- [x] 6.2 Real-session check: open a local session known to use `docker` in
      `runray view` and export it with `--redact`. Verify: the Time view shows
      a `docker` row in both; the redacted report shows no program name
      outside the registry; screenshots attached to the PR.
      Checked on a session with 58 `docker` calls: the row has the same calls
      and time in the view and in the redacted report. The PR carries the
      Time view of the demo run in both themes; a screenshot of a real
      session shows private work and was not published.

## 7. Fixture with a command skeleton (GATED)

Do not start this group without an explicit go-ahead from the maintainer: it
changes the scrubber and adds a fixture, which AGENTS.md reserves for a human
decision (D6). If the go-ahead is declined, delete this group; the change is
complete without it.

- [ ] 7.1 A `scripts/scrub-fixture.ts` keeps a command's registry program and
      table subcommand and replaces every other word with filler; a program
      outside the registry becomes filler. Verify: scrubber tests, including
      one asserting that no argument, path or option value survives.
- [ ] 7.2 A New fixture `fixtures/claude-code/shell-tools` produced by the
      scrubber, carrying the `SCRUBBED` marker, with its goldens. Verify: the
      normalized golden holds resolved `runray.tool` values and the path-shape
      totality assertion passes on its sanitized golden.

## Workflow follow-up

- The work left out of scope is on the team's planning board, one item
  each: retry-loop identity on the primary tool (D4), the dashboard "By
  tool" card keyed by tool id, the tool filter matching sessions by the
  program they ran, tool names on timeline rows, and OTLP
  `blocked_on_user` spans counted as waiting.
- Archive the change after review, then verify the archived specs.
