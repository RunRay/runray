# Tasks: add-codex-adapter

Track **A** = data (`packages/schema`, `packages/core`, `packages/cli`,
`scripts`), Track **B** = experience (`packages/ui`). Every task:
`pnpm lint && pnpm typecheck && pnpm test` green. The schema is touched
**only** in 1.1. Goldens are touched **only** in 5.1 and 5.3 (dedicated
commits); every other task asserts the existing ones byte-identical. UI tasks
run under the `/frontend-design` skill per CLAUDE.md. References (D1…, T1…)
point at `design.md`; quoted names are requirements in the spec deltas.

Prerequisite: `add-tool-usage-breakdown` (RunRay/runray#79). This change is
stacked on its branch until it merges.

Hard chains: 1.2→1.3→1.4; 1.4→group 2→group 3→group 4→5.2→5.3; 5.1 before
5.3; group 6 and group 7 may start once 5.3 is done; group 8 last.

The adapter is **not registered** until 5.2, so groups 2 to 4 test it
directly and the goldens test does not see `fixtures/codex` yet.

## 1. Contract, reader and fixtures

- [x] 1.1 A Schema 0.2.0 (D1): add `codex` to `SourceToolSchema` and
      `codex-jsonl` to `SourceFormatSchema`, set `SCHEMA_VERSION` to `0.2.0`,
      regenerate `schema/runray.schema.json`, move the tests and the example
      trace that pin `0.1.0`, and record the bump in `docs/02-DATA-MODEL.md`
      (enum rows and the versioning note). Verify: the schema drift check is
      clean, the generated diff holds only the two enum values and the
      version, and a test validates a 0.1.0 run against the new run schema
      ("Codex is a named source").
- [x] 1.2 A Rollout line reader in `packages/core` (T3, D5): streaming lines
      from a plain or zstd-compressed file, split on LF only (not
      `node:readline`), UTF-8 decoded across chunk boundaries, with 1-based
      line numbers, BOM stripping, early stop for a first-record read, and a
      `ZstdUnavailableError` naming the Node version when the runtime lacks
      zstd. Verify: tests that write a plain and a compressed temp file and
      read identical lines from both; a test with a raw U+2028, a raw U+2029
      and a multi-byte character straddling a chunk boundary inside one
      record, read back as one line ("Line separator inside a string"); a
      test that stops after line one without reading the rest; and a test
      with zstd support stubbed out asserting the error text.
- [x] 1.3 A `scripts/scrub-fixture.ts --source codex` (T14): path keys of
      `changes`, diff and patch shape, shell wrappers kept and scripts
      scrubbed, placeholder for `encrypted_content` and `base_instructions`,
      compressed in and out, the extra preserved keys. Document the flag in
      `scripts/README.md`. Verify: a table-driven test over inline records
      asserting no input path, account id or repository URL survives, that
      line counts of a diff are equal before and after, and that a scrubbed
      file carries the `SCRUBBED` marker as its first line in both forms.
- [x] 1.4 A Capture fixtures under `fixtures/codex/` from real rollouts:
      `simple` (plain), `zstd` (compressed), `guardian` (root plus reviewer
      children), `tool-errors` (failed command, failed change, failed script,
      interrupted turn, turn ended by an API error), `legacy` (CLI 0.47
      shapes) and `compaction`. Write `fixtures/codex/README.md` with the
      capture recipe and the unverified variants from design "Risks", and the
      Codex section of `docs/04-SAMPLE-LOGS.md`. On the compaction fixture,
      record in the README whether a compaction request has its own usage
      record. **The maintainer reviews each scrubbed file before it is
      committed.** Verify: every file carries the marker, a search of
      `fixtures/codex` for the OS user name, host name and any `sk-` /
      32-hex string finds nothing, and each fixture's first record parses.

## 2. Adapter: discovery and run skeleton

- [x] 2.1 A `adapters/codex.ts` discovery (T1, T2): `defaultRoots()` with
      `CODEX_HOME`, the name pattern at any depth, first-record read,
      children grouped under their root thread, one candidate for a thread in
      both forms, orphan children as their own candidates, sorted output,
      mtime and size over all files of a candidate. Verify: adapter tests
      for every scenario of "Codex rollout discovery" plus "Orphan child",
      run against `fixtures/codex` and temp directories.
- [x] 2.2 A Session and turn spans (D3, T6) and the tolerant parse loop:
      session span, project and branch, turn spans matched by turn id with
      status and reason (a completion for an id that never started is
      ignored),
      `promptPreview` skipping harness context, `NoSessionYet` for a rollout
      with no turn, a reasoned error for a file that is not a rollout,
      warnings for broken lines. Verify: tests for every scenario of "Codex
      session and turn spans" and "Codex parsing tolerates unknown records",
      including the byte-identical double parse.
- [x] 2.3 A LLM calls and token conversion (T4, T5): one `llm_call` per
      usage record with the response's items attributed to it, span bounds,
      `outputPreview`, the conversion with clamps, and the legacy path from
      running token events. Verify: tests for every scenario of "Codex LLM
      calls", "Codex token conversion" and "Legacy Codex token events", and
      a test over the `simple` and `legacy` fixtures asserting the summed
      tokens equal the thread total recorded in the file.
- [x] 2.4 A Document the Codex adapter in `docs/05-ARCHITECTURE.md` (storage
      layout, record types read, the two token eras, what is deliberately
      not read). Verify: the section names the record types and files the
      code reads after 2.3.

## 3. Adapter: tools

- [x] 3.1 A Calls, outputs and action attribution (D4, T7): pair calls with
      outputs by `call_id`; attribute harness actions by id, then to the open
      call, then to the call closed last in the same turn, then to the turn;
      emit action spans with their times, status, exit code, output size and
      error preview; decide at the end of a turn which calls are left without
      an action and emit a span only for those. Verify: tests for every
      scenario of "Codex tool spans are harness actions", built inline, plus
      a check on the `tool-errors` fixture that the number of tool spans
      equals actions plus action-less calls counted independently from the
      raw file.
      Changed while doing it, with the measurements in T7: an action goes
      to the call that was waiting when it **started** before the call open
      when its record was written (1,061 of 11,649 actions outlive their
      call), and which calls are left without an action is decided when the
      file has been read, not at the end of a turn (27 actions are written
      after their turn's end). Scenario "Command that outlives its call"
      added to the spec. Figures on the 250 surveyed rollouts: 16,406 tool
      spans in 214 threads, 16,404 under an `llm_call`, no id twice, every
      run valid against the schema.
- [x] 3.2 A Shell unwrapping (T8): the wrapper table, the dialect guess for
      a script given as a bare string, a `codex` row in `adapters/target.ts`,
      a per-call dialect passed to the tool-usage classification (the
      `adapters/usage.ts` table fixes one dialect per tool name and cannot
      hold Codex), and rows in `tools/registry.ts` for the Codex call names
      the harness table lacks (`shell_command`, `exec`, `wait`, `sleep`,
      `write_stdin`, `request_user_input_async`, `web.search`, `imagegen`;
      `js` and `js_reset` were listed here too and taken out by the review
      of group 3), each with the activity "Harness tool
      classification" gives its kind. Verify: tests
      for every scenario of "Codex commands are unwrapped before identity
      capture", including target-key equality with a Claude Code
      `PowerShell` call, and the registry invariants and snapshot tests
      updated.
      Changed while doing it, with the measurements in T8: a script given
      as a bare string is read as PowerShell when the thread works in a
      Windows directory, before the text is asked (176 of 336 have no
      backslash to go by); the scenario "PowerShell wrapper" named
      `runray.toolSub: "test"`, which the classifier does not give
      `pnpm test` (it is `run` with the script `test`), and now asks for
      what a Claude Code `PowerShell` call gets. The id and runner
      snapshots did not move: harness names are not registry ids. On the
      250 surveyed rollouts 9,075 of 9,488 command spans resolve to a
      registry tool and none is left unclassified.
- [x] 3.3 A File changes (T9): line counts per change type, header lines
      excluded, single-path target identity, legacy `shell` calls that run
      `apply_patch`. Verify: tests for every scenario of "Codex file
      changes" and one for the legacy form.
      Beyond the wording, with the measurements in T9: a legacy patch call
      also gets its line counts and its single-file identity, read from
      the patch text, in all three forms it takes (the `apply_patch` tool,
      a `shell` argv, a here-document), 568 calls in the survey. On the 250
      rollouts: 2,626 `apply_patch` spans, and in each of the 54 threads
      with `FileChange` items the counted lines equal a plain count of
      `+` and `-` lines.
- [x] 3.4 A MCP calls and extensions: `mcp_call` spans with their server,
      extension kinds as tool names, image views. Verify: tests for the
      "MCP call" scenario and one per extension kind seen in the fixtures.
      The spans themselves came with 3.1. Added here: `tool.outputBytes`
      for MCP calls (the insight rules on tool output read it) and, for a
      tool the model called directly, the size and the failure text of the
      call's own output. On the 250 rollouts all 2,011 MCP spans have a
      server and a size, all 148 failed ones a preview. Open: the scrubber
      replaces the keys inside an MCP `result`, so the fixtures show MCP
      results only through the call's output record (design T7); keeping
      the protocol's own keys there would mean re-scrubbing the fixtures.

      Review of group 3 (after 3.4), fixed in one commit: a call that
      failed or was stopped while its actions went through is a span (new
      scenario "Script that failed after its commands"; 19 calls on the
      250 rollouts, 16,425 tool spans in all); a failure with no text has
      no `content` in either mode, so the redaction parity scenario holds
      without a status rule in `sanitize.ts`; the script is read from
      behind the wrapper's command switch and an unwrapped argv keeps its
      arguments apart; a legacy patch path is taken from the call's
      `workdir`; `js` and `js_reset` are out of the harness table. Left
      as it is: `runray.targetKey` from the script's first token (1,717
      of 9,220 command spans start with a here-string, `&` or an
      assignment), which the retry-loop rule shares with every source and
      RunRay/runray#80 re-keys.

## 4. Adapter: child threads and privacy

- [x] 4.1 A Child threads (D2, T10): subagent span per child with its
      subtree, anchor on the named parent turn with the session fallback and
      warning, silent drop of a child with no turn, container extension.
      Verify: tests for every scenario of "Codex child threads nest under
      their parent" on the `guardian` fixture and inline rollouts.
      Found in 2.2, to settle here before coding: `turn_attribution` is on
      372 of 2,404 turn starts and on none in the fixtures. The 20 reviewer
      turns of the `guardian` fixture name a turn of their root in
      `root_turn_id` instead, so T10's anchor needs that as a second source
      (a design and spec change the maintainer signs off).
      Done with `root_turn_id` as the second source (signed off), and with
      two things the survey of all 183 child threads added, both in the
      spec delta and both accepted by the maintainer. A third
      source: 28 of the 147 threads that ran name no turn at all, and each
      of their 249 turns began while exactly one turn of its parent was
      running, so such a thread goes under that turn; a thread that names a
      turn its parent lacks still goes to the session with a warning. And
      one span per thread: 67 of 119 reviewers answered in more than one
      turn of their parent, so 80 of 147 spans end after the turn they hang
      on (D2 says why a span per parent turn was rejected). On the 67 real
      runs: 147 subagent spans, every one on a turn, no warning, no
      duplicate id, every run valid against the schema; 16,425 tool spans
      and 15,053 model calls as before.
- [x] 4.2 A Redaction and identifiers (T11): the `redact` path of every
      content field and `runray.target`, a Codex branch in
      `sanitize/sanitize.ts`, and Codex fixtures added to the redaction
      parity and sanitize invariant tests. Verify: tests for every scenario
      of "Codex content and identifiers stay in the parser", including a
      serialised-run search for the fixture's account id and repository URL.
      The content fields were already nulled by the tasks that added them;
      what this task added: the `llm_call` and `turn` arms in the sanitizer,
      the Codex adapter in `invariants.test.ts` ahead of its registration
      (5.2 leaves the helper as it is: it lists an adapter once), and two
      things the audit found. A reason, an error code and an extension kind
      survive redaction, so each is taken only when it is one word of the
      harness's vocabulary (all 982 values surveyed are). And a child file
      that cannot be opened is named by its error code: the system's message
      holds the path, and neither redaction nor the sanitizer rewrites a
      warning's message. On the 67 real runs: both parses agree after
      sanitizing in both profiles, all 18,826 content values of the redacted
      parse are null, and no account id, user id, repository URL, path shape
      or project name is in a sanitized run. A commit hash is in two open
      previews, because the model and `git` printed it; nothing reads it
      from `session_meta`.
      Review of group 4, fixed in one commit after 4.2: a turn of the
      reviewer's thread has no prompt preview (1,764 of 1,765 had the
      harness's request as one, 4 fixed texts); a subagent span starts no
      later than what is under it; the clock anchor treats a turn the parent
      never closed as over once the next one started; only a child file
      that cannot be read is a warning, and a defect of the reader fails the
      run; the container walk is shared with the Claude Code adapter
      (`adapters/span-time.ts`); and the spec says a child with no turn
      found hangs on its parent thread's span. Left as it is: child files
      are read one after another (250 files parse in 13 s).

## 5. Pipeline integration (Codex goldens missing between 5.2 and 5.3)

- [x] 5.1 A Pricing for Codex models (D6): let `convertLitellmPricing` keep
      `responses`-mode entries next to `chat` ones, refresh the bundled
      snapshot with `scripts/build-pricing-snapshot.ts`, regenerate the
      goldens that move (the OpenCode fixtures on `gpt-5.3-codex`), rebuild
      the demo runs with `pnpm demo:build`, and note the price change in
      `docs/02-DATA-MODEL.md` and the changeset. Converter code and tests in
      one commit, snapshot plus regenerated goldens and demo runs in a
      dedicated commit with the reason. Verify: converter tests for "A Codex
      variant is not priced as its base model" and "A refreshed table keeps
      Codex ids"; a test that every model id in `fixtures/codex` matches an
      entry of that exact id or is on the documented no-price list; the
      golden diff touches only cost fields of runs on a model whose entry
      changed; and `pnpm test` green on the regenerated goldens.
      Done in four commits: the converter, the retired-model rule, the
      generated files, and the snapshot test with the docs. The snapshot
      goes from 249 to 363 entries (114 new, 38 re-priced, 76 retired and
      kept). Two things the design did not foresee, both accepted by the
      maintainer or recorded in D6: the list had dropped 76 ids, which
      the build script now keeps at their last rates (the table's `retired` list,
      spec "A refreshed snapshot keeps retired models"), and a fifth
      golden moved, `claude-code/duplicate-records`, whose model
      `claude-fable-5-1` got an entry of its own ($1.09 to $0.75). The
      golden and demo diff touches cost fields only: 171 calls on
      `gpt-5.3-codex` in the goldens and 115 in the demo runs at 1.4
      times their cost, and 4 calls on `claude-fable-5-1`.
- [x] 5.2 A Register the adapter after OpenCode, make the Claude Code
      adapter skip rollout files, and add the CLI surface: `codex` in
      `SOURCE_ALIASES`, the four `--source` help strings, the unknown-source
      error, the setup guides text and `docs/12-ONBOARDING-COPY.md`. Verify:
      tests for "Codex rollouts are not Claude Code candidates", "Codex in
      the source filter", "Codex in zero-config roots" and "Codex in the
      setup guides"; `runray list --source codex` on `fixtures/codex` lists
      the fixture sessions. Registration makes `goldens.test.ts` expect
      Codex goldens, so this task and 5.3 land back to back; every other
      test is green here.
      Done: the registry order is claude-code, opencode, codex, otlp, and
      one name test (`isRolloutFileName`) decides for both adapters whose
      file a rollout is. `runray list fixtures/codex --source codex` lists
      7 sessions with nothing skipped, and the dashboard and a run view
      render them (`cli-view-codex` in `.claude/launch.json`). The
      wizard hint and the "Expected one of" line name Codex too. Red here,
      as planned: the three tests of `goldens.test.ts`, until 5.3. Left
      for later tasks: the unpriced warning still suggests
      `runray pricing --refresh` for `codex-auto-review`, which no
      refresh can price.
- [x] 5.3 A Generate the Codex goldens in the three profiles with
      `pnpm goldens`, in one dedicated commit. Verify: `goldens.test.ts`
      passes with `fixtures/codex` included, the existing goldens are
      byte-identical, and a second `pnpm goldens` leaves the tree clean.
      Done: 24 files, eight runs in each profile (`simple` and `zstd`
      are one thread and get a golden each, since goldens are generated per
      variant folder). No golden holds a user name, a host name, a home
      path, a repository URL or an account id. Two tests that count or
      re-derive over all goldens needed a line each: the number of goldens
      the schema test validates (33 to 57), and the golden usage test's own
      list of tools that wait on the person, which lacked Codex's
      `request_user_input_async`.
- [x] 5.4 A Transcript slices (`transcript.ts`): a Codex branch that reads
      the provenance line through the rollout reader and labels segments per
      record type. Verify: tests for every scenario of "Transcript slices
      for Codex spans" and the redaction short-circuit.
      Done (design T15): a call's slice goes on to its output record and a
      turn's to the person's prompt; a session record shows no account id,
      user id, repository URL or commit; base64 of 512 characters or more
      reads `(not text)`. The spec gained four scenarios for these. All
      1,183 spans of the fixtures give an `ok` slice, and so does a sample
      of 714 spans of the surveyed sessions (slowest 1.1 s); the endpoint
      was checked through the live server on `fixtures/codex`.
- [x] 5.5 A Bench and budget: a `pnpm bench` row for parsing a large Codex
      rollout (machine-local `fixtures/codex/large`, git-ignored like the
      Claude Code one, with its README). Verify: the row prints and the
      number is recorded in `docs/05-ARCHITECTURE.md` next to the other
      budgets.
      Done: the row reads 0.29 s for 38 MB of text (130 MB/s) against the
      budget of 20 MB/s. With no rollout in `fixtures/codex/large` the
      bench makes one from `tool-errors` (`synthesizeCodex`: each copy
      gets its own ids, later times and ordinals, and reads as new turns
      and calls). A synthetic file has no large records, so the largest
      real rollout of the surveyed machine was timed too: 150 MB on disk,
      245 MB of text, a longest line of 9.3 MB, parsed in 2.2 s (111 MB/s)
      at a peak RSS of 191 MB. Tests that scan the whole fixture folder
      now leave `large` out, in core by listing the committed variants
      and in the CLI through a hermetic copy (`codexFixtures()`).
- [x] 5.6 A User-facing docs for the new source: README, `docs/01-FEATURES.md`
      (Codex moves from V3 to supported), `docs/07-DATA-SOURCES.md`, the
      source lists in `CLAUDE.md` and `openspec/project.md`, and a changeset.
      Verify: `rg -n "Claude Code, OpenCode"` over the repo finds no list
      that should now name Codex, and `pnpm changeset status` shows the
      entry.
      Done, and beyond the list: the Codex mapping in
      `docs/02-DATA-MODEL.md`, the npm description of the CLI package and
      the feature-request template. Four lists still name two sources and
      are left to their tasks or are not lists of sources: the welcome
      sentence in `WelcomeDialog.tsx` and its copy in
      `docs/12-ONBOARDING-COPY.md` (7.2), a comment in
      `insights/rules.ts` (6.1), and a persona's setup in
      `docs/03-PERSONAS.md`. The changeset is `codex-sessions.md`
      (minor), next to `codex-model-prices.md` from 5.1.

- Review of group 5 (`3865312..HEAD`): nine of ten findings fixed. A
  retired entry prices its own id only, and a one-word pattern only its
  numbered variants (`grok-4-fast` was priced as the retired `grok-4`,
  `chat-bison-001` as `chat`); the retired list moved into the table so
  the browser's matcher has it. The unpriced warning names a model with no
  published price and leaves out the refresh advice for it; the list is in
  core. In transcript slices: only the legacy shell output is unwrapped, a
  turn's prompt search ends at that turn's own end, an argv keeps its
  argument bounds, binary data is named inside JSON and when wrapped. The
  snapshot test no longer pins rates, and the schema test no longer pins
  the number of goldens. The spec gained three requirements for the pricing
  rules. Left open: zero-config builds and `--watch` re-parse the whole
  Codex history (about 13 s on the surveyed machine), which waits for the
  persistent index; and the same refresh advice in the dashboard
  (`CoverageNotices.tsx`), which belongs to 7.2.

## 6. Insights

- [x] 6.1 A Codex arms in `insights/rules.ts` (T12): `instructionsFile`, the
      four suggestion switches, and the three checks from T12 (a run with
      no cache-write tokens, reviewer as the expensive subagent, rules that read
      `parentId` under `turn` spans). Verify: `suggestions.test.ts` covers
      `codex` for every rule it covers for `opencode`, tests for every
      scenario of "Cache-write rules are silent on Codex runs" and
      "Suggestions and playbooks address Codex", and a guard test that
      findings on the non-Codex fixtures are unchanged.
      Done. The guard is `goldens.test.ts`: after the regeneration the 33
      goldens of the other sources are byte-identical, and the 21 Codex
      goldens with a `fixed-context-overhead` finding differ in that one
      suggestion line. The "Playbooks have a Codex section" scenario is
      6.2. Beyond the list, and waiting for a decision: a scenario for the
      reviewer added to the spec (the finding carries no saving for it),
      and the Codex command tools on the list of shell tools. Found and
      left: the downgrade ladder knows no family after `gpt-5` (design
      T12).
- [x] 6.2 A Codex in `insights/meta.ts` (`PlaybookSource`, labels, a section
      per rule) and regenerated `docs/08-FINDINGS.md` via
      `pnpm docs:playbooks`. Verify: `playbooks-docs.test.ts` and
      `pnpm docs:playbooks --check` pass.
      Done, and wider than the list: `PlaybookSource` also types the
      error-class playbooks in `triage/meta.ts`, so the 22 error classes
      got a Codex section too and both generated blocks of
      `docs/08-FINDINGS.md` changed. Two shared cause lines that named
      only Claude Code (`CLAUDE.md`, `claude -p`) now name Codex beside
      it. Seen in the built UI: the Waste tab of a Codex session reads
      "What you can do · Codex". The levers checked are listed in design
      T12.
- Review of group 6 (`ebaa0da..HEAD`): seven of eight findings fixed. A
  session that ends on a turn stopped at the usage limit is no longer a
  dead end (it was burned in full), and a failed turn is triaged as a
  failed model call, so the Codex sections of the `model-*` error classes
  can be reached; both are in `insights/rules.ts` and `triage/`, outside
  the two tasks. Shell and edit tools are read from `HARNESS_TOOLS`, the
  reviewer's name is one constant shared with the adapter and checked on
  the `guardian` fixture, `model-mismatch` leaves the reviewer out, the
  agent-file copy names both folders, and the shared cause line of
  `tool-unavailable` names no Claude Code file. Left, to be filed in
  planning: the downgrade ladder maps every `gpt-5*` id, Codex-family ones
  included, to `gpt-5.4-mini` and knows no family after `gpt-5` (design
  T12). Seen while fixing and left as it is: a failed turn that still has
  model calls after its start is not the last span, so `dead-end-run`
  does not see it; and a Claude Code session that ends on a model call
  refused at the usage limit is still a dead end.

## 7. Visualizer

- [x] 7.1 B [UI → /frontend-design] Source colour: a Codex source colour
      derived from the brand tokens in `packages/ui/src/index.css` for both
      themes, wired in `lib/model-colors.ts`. The legend and the filter show
      the source id, `codex`, as they do for the other sources. Verify: tests for every scenario of "Codex is
      presented as a named source", including the contrast check the theme
      token tests apply to the other source colours.
      Done: `--color-source-codex`, the brand hue turned 40 degrees toward
      magenta, `#febeff` on ink and `#5b007f` on paper. The other sources
      borrow span hues; the one left, the subagent chartreuse, is the
      subagents badge on the same page, and the warm hues are waste and
      severity, so Codex got a token of its own. No test held the source
      colours to a threshold before, so `source-palette.test.ts` takes the
      ones of the activity ramp: 12 OKLab ΔE from every other source and
      from the waste strip in three visions, and 3:1 on the card ground for
      every named source. `overview-sources.test.tsx` covers the chart, the
      ranking row and the URL. The source filter needed no change: it
      lists the sources of the loaded runs. Seen in both themes on the
      fixtures root, which loads no Claude Code run (see the review of
      group 7). Noticed and left: on paper OpenCode
      and OTLP are two greys, and the fallback grey is under 3:1 on white.
- [x] 7.2 B [UI → /frontend-design] Per-source hints (and, from the review
      of group 5, the unpriced notice in `components/CoverageNotices.tsx`:
      no "Try runray pricing --refresh" when every unpriced model is on
      `MODELS_WITHOUT_PUBLISHED_PRICE`, as the CLI warning already does):
      Codex wording in
      `lib/waste.ts`, the transcript cost note in
      `components/PricingProvenance.tsx`, the sentence in
      `components/WelcomeDialog.tsx` that names the sources read, and a
      review of the source branches in `lib/tool-table.ts`. Verify: tests for every scenario of
      "Per-source hints cover Codex".
      Done: `lib/sources.ts` is the one place that says which sources are
      agents RunRay reads (core's playbook list without OTLP); the Waste
      lead, the cost note and the welcome sentence ask it, so a fourth
      agent cannot fall into the custom-agent wording in one of them only.
      Waste lead on Codex: `AGENTS.md` and `codex resume --last`. The two
      cache groups cannot occur on a Codex run; see the review of group 7
      for what the lead says should one appear. The welcome sentence names
      the agents of the loaded runs, not a fixed list (copy rule in
      `docs/12-ONBOARDING-COPY.md` §4.1). The unpriced banner follows the
      CLI warning: no refresh advice when no price is published for any of
      the models, and it says what the model is, from core's list.
      `lib/tool-table.ts` needed no change: a rollout has no hook spans, so
      no hook rows and no note are drawn, and the adapter stamps every
      command with tool usage, one it cannot read included
      (`commandAttributes`), so the "recorded before tool identification"
      line cannot show. Tests: `codex-hints.test.tsx`, and
      the hook scenario in `time-view.test.tsx`. Seen in the built UI on
      `fixtures/codex`: the banner and the cost note on a session with
      reviewer calls. Not seen live: the welcome dialog (dismissed on this
      machine, and its state was left alone) and a Codex burned group (no
      fixture has one); both are held by mounted-component tests. Left as
      it is: the empty-state screen still gives `claude "explain this
      repo"` as its one example of running an agent.
- Review of group 7 (`be5ea60..a289307`): eight findings, all fixed.
  The transcript cost note names what is missing from the log (utility
  calls, unlogged retries, web-search fees) only for Claude Code and
  OpenCode: nobody checked that list against a rollout, so a Codex run
  gets the lower bound and the reason that holds whatever a rollout
  leaves out. A lever that names a command of one agent is read from
  core's playbook and no longer copied into `lib/waste.ts`: the dead-end
  lever for every source, and on Codex the lead of the two cache groups,
  which had taken the shared `/compact` before ~200k wording (a
  threshold nobody measured for Codex) above a playbook that says the
  finding is not reported on Codex. That branch stays unreachable while
  Codex records no cache writes. The unpriced banner says `1 llm call
  carries`, and a model recorded under two spellings is explained as the
  one model it is. The colour maths of the three palette tests moved to
  `test-support/palette.ts`. `overview-sources.test.tsx` mounts the
  filter bar and reads the `codex` option. The `cli-view-sources` preview
  is gone: the Claude Code adapter scans a root and one level below it,
  the fixtures sit two levels down, so no single path shows every source
  and the orchid beside the Claude Code violet is held by
  `source-palette.test.ts` alone.

## 8. Integration checks

- [x] 8.1 A Real-session check on a machine with Codex data: every rollout
      under the default root parses or is skipped for a documented reason;
      for every root thread the summed tokens equal its recorded thread
      total; `runray view` renders a Codex session with its reviewer
      subagents, and the Time & Tools tab names programs, not `exec`.
      Reference figures from the design survey: 250 files, 67 root threads,
      54 of them with usage records and all 54 reconciling. Verify: the
      counts (files, runs, skipped with reasons, threads reconciled, seconds
      for a full build) are written into this task when it is ticked.
      Done on 2026-11-15, on the machine of the design survey, with counters
      and closed-vocabulary values only (no session text was printed, copied
      or screenshotted).
      - Files: 250 rollouts under the default root, all compressed, and no
        other entry. Detection puts every one in a candidate: 67 candidates,
        67 root files and 183 child files, none left out.
      - Runs: the build of `--source codex` gives 67 runs from 67 candidates
        with 0 errors and no run warning: 34,096 spans, of them 15,053
        `llm_call`, 14,414 `tool_call`, 2,011 `mcp_call`, 2,404 `turn` and
        147 `subagent`.
      - Skipped: 36 child files, each a reviewer thread started and never
        consulted (no turn; design D2). Read alone they raise `NoSessionYet`;
        inside their run they add no span and no warning. Nothing else was
        skipped and no file failed to parse.
      - Reconciled: all 67 root threads. 54 have usage records and the sum of
        their calls' tokens equals the recorded thread total; the 13 legacy
        ones equal the last running total (T4). Of the 147 child threads
        read, 140 reconcile the same way and 7 start from a total inherited
        from their parent, with their own sum below it, as T4 says.
      - Seconds for a full build: 15.3 and 15.7 inside one process
        (`buildTraceFile`), 16.5 and 18.8 for `runray list --source codex
        --json` from start to exit. Design T3 measured 57 s for reading the
        same files.
      - Seen in `runray view` (zero-config, every source loaded), on a Codex
        session with reviewer calls: the timeline holds `subagent:guardian`
        rows with the `codex-auto-review` model, all 147 subagent spans of
        the build hang on a turn, and the session shows the Codex cost note
        and the "no price is published" banner. Time & Tools lists programs
        (`node`, `tsc`, `npm`, `eslint`, `git`, `python`,
        `Invoke-WebRequest`) as shell rows. Across the build 9,220 shell
        calls sit in 780 rows (counted per run), 754 of them a program of
        the registry, and no shell call is unclassified.
      - `exec` is still a row, and that is the spec rather than a gap: 562
        of the 14,414 tool calls are a span named `exec`, shown as a
        built-in in 47 runs. 463 of them are `ok`, a call with no action
        attributed to it. 95 are `error` and 4 `cancelled` (declined by the
        person): a call that did nothing recorded, or one that failed or
        was stopped after commands that did not fail.
      - Not a finding of this check, noted for the price list: 1,752 calls
        in 50 runs carry no price, the reviewer's model and `unknown` (2 runs
        hold calls with no model recorded).
- [x] 8.2 A End-to-end smoke through the real CLI (`packages/cli/src/*-e2e`):
      `view` and `export` on `fixtures/codex`, with and without `--redact`.
      Verify: the e2e test passes and the redacted export contains no
      string from the unredacted previews.
      Done: `packages/cli/src/codex-e2e.test.ts` runs both commands through
      `createProgram()` on the committed Codex fixtures, under a home
      directory and a config home of its own. `view` is asked over HTTP for
      the trace and for a transcript slice: `ok` and previews without the
      flag; with `--redact` the same run ids and span counts, no preview, no
      title, no free-text attribute, and the slice answers `redacted`.
      `export` is read back from both files it writes: the page carries the
      trace the JSON beside it does, and with `--redact` no preview of the
      unredacted export is in either file, as it is, as JSON or the page
      escapes it, or inside a longer string. The one seam is a wrapper
      around the real `startServer` that hands the test the server `view`
      starts, so it can be closed. The export half is skipped where the UI
      was not built, as the existing export e2e is.
- Review of group 8 (`e5c171a..0c432d7`): six findings, all fixed, none in
  the product's code. The e2e set `XDG_CONFIG_HOME` only, and
  `runray.config.json` and the price override are read under the home
  directory: a developer's `"redact": true` would have failed the
  unredacted tests. It now gives the commands a home of its own and checks
  that the override took. It fails when a command skipped a candidate
  (`warning: skipped` on stderr), where one fixture that stopped parsing
  used to pass. A redacted trace is checked for every free-text attribute
  (`runray.target`, `runray.toolName`, `runray.toolScript`,
  `runray.skill`), not for the first alone. The redacted files are searched
  for a preview in three forms, the JSON one added, and a preview that is
  also a word of the export template is looked for in the trace and not in
  the page. The 8.1 note counted all 562 `exec` spans as scripts that ran
  no command; it now gives them by status.

## Final review of the whole change

Five independent readers took one area each over
`feat/tool-usage-breakdown..05868e7` (ingestion against the spec, the
parser on input no scenario covers, prices and advice, the command line with
transcript slices and the scrubber, the UI with the documents). Every
finding was checked in the code before it was acted on. The common path
held: fixtures parse twice to the same bytes, token sums equal the recorded
totals, the 20 calls of `fixtures/codex/simple` match a price worked out by
hand, the slice endpoint reads no file a request names, and the committed
fixtures hold nothing real.

Fixed:

- `dead-end-run` goes by the turn a run ended in. It took the last span of
  the run, and a turn stands before what happened inside it: a failed turn
  with work beneath it was missed, and the usage-limit exemption held only
  for a turn with no child, the one shape the test written in the review of
  group 6 had.
- Triage counts a declined call only for a tool or MCP call. An interrupted
  turn was reported as "1 call you declined".
- A reviewer thread read without its parent keeps the reviewer's name on its
  session span, and `fixed-context-overhead` leaves such a run out: what it
  opens with is the transcript handed to it, and the advice was to trim
  `AGENTS.md`. The `compaction` goldens lose that finding.
- A transcript slice names binary data inside a text too (an image in the
  JSON a tool printed, a data URL after a command's lines), and a turn of
  the reviewer shows the request under `review request`, not `user`.
- The parser, on a file Codex did not write that way: the thread's and the
  turns' ids are claimed like every other span's (a response named like its
  turn was its own parent, and `normalize` never returned); a number too
  large for a count or an exit code and a time that names no moment are
  absent instead of failing the run at validation; a completion whose error
  is a string is `error`; a compressed rollout that gives no text is refused
  with a reason instead of skipped as a session not begun; no list as long
  as the file is spread into a call.
- The scrubber takes a directory with a rollout in it as Codex's without
  `--source` (it went to the generic walker and came out stamped as
  scrubbed with a file change's paths in it), and keeps a value under a
  structural key only when it is one word, a word that opens with a colon,
  a UTC time or, under `originator`, a name of up to three words. A
  sentence, a person's name and a `host:port` are scrubbed and reported.
  The fixture checker uses the same rule; the committed fixtures pass it.
- Two sentences of advice: on Codex `oversized-output` says to read a range
  of a file (`offset` and `limit` are parameters of the other agents' read
  tools), and the `model-limit` playbook no longer speaks of a reset "the
  message names", since a Codex turn carries a code and no message.
- Documents: `--source` with `codex` in the CLI section of
  `docs/05-ARCHITECTURE.md`, three sentences of `docs/02-DATA-MODEL.md`
  that listed the sources without Codex, the README's list of what a log
  leaves out (given for Claude Code and OpenCode only, as the UI does), the
  build time and the `--since` caveat in `docs/07-DATA-SOURCES.md` (design
  "Risks" said both were documented), and the stale sentences of
  `design.md`, `proposal.md` and task 3.2.
- `openspec validate --strict` passes: three requirements over 500
  characters were each split in two with their scenarios, no sentence
  dropped. Four scenarios are new and await acceptance with the earlier
  additions: "The turn that failed did work first", "Usage limit after a
  failed command", "Image inside the text a tool handed back" and "Turn of
  the approval reviewer".

What was left for a decision, and what the maintainer decided on
2026-11-15:

- **Pricing override older than the bundled table.** It stays in use and is
  now reported once per command, with the file and both dates. The warning
  does not advise `pricing --refresh`, which writes a list without the
  retired models. Merging the two tables, and a refresh that keeps the
  retired models, go to the planning board.
- **Prefix pricing of an id the table does not hold.** Left as it is, for
  every source; on the planning board.
- **`fixed-context-overhead` and the cache-write rate.** A session none of
  whose calls wrote to the cache takes the input rate for the leg that
  carried the footprint in. Five Codex goldens move by that leg
  (`simple`: 0.23792 to 0.219037); no golden of another source does. T12 is
  corrected.
- **`expensive-subagent` naming a dearer model.** `suggestedDowngrade`
  takes a stage only when neither rate is above the model's own and one is
  below, and walks on down otherwise. In the snapshot that ends three
  suggestions that cost more (`gpt-5.6-luna`, `gemini-2.0-flash` and its
  dated id) and moves two that cost more on one rate to the stage below
  (`gemini-2.5-pro`, `gemini-2.5-pro-preview-tts`). `model-mismatch` and the
  what-if view read the same function.
- **Discovery bounds.** The spec states them (six levels, `raw` and
  `node_modules` beneath the root left out) in a requirement of its own. A
  root the person names is read whatever it is called; the OpenCode and
  OTLP adapters still skip a root named `raw`.
- **A turn still open when the next one starts**, **a call with no answer**
  and **the rare shapes** stay as they are. Counted again on the surveyed
  machine: no call of 16,430 is `in_progress`, the 20 interrupted turns
  included, and none of the 36 child files with no turn holds a usage
  record or a token event. The rule that drops a child with no turn was to
  be made the root's rule; it was not, because the difference is meant (a
  usage record before a child's first turn is its parent's, and a test
  holds that). Design "Risks" lists all of them.
- **`retry-loop` copy outside Codex.** Accepted; the changeset says so.
- **Scrubber.** A number under an identity key (`creator_account_id`,
  `creator_user_id`) becomes 0; every other number stays, and so does a
  host name that is one word. The slice reader's cap and its five fallbacks
  go to the planning board.

Four requirements are new with these decisions and await acceptance with
the earlier additions: "Codex discovery is bounded", "An override older
than the bundled table is reported", "A suggested cheaper tier costs less"
and "No write premium where nothing was written", each with its scenarios.

## What the final review did not reach

The five readers did not read how much the tests of commands, file changes
and MCP calls assert, and nobody looked at the UI in a browser. Both were
done on 2026-11-15.

**The tests, by mutation.** 78 deliberate defects were put into the
adapter's code for those three areas, one at a time (a wrapper not
unwrapped, a count off by one, a field not read), and the adapter's tests
were run against each. 58 failed a test as they stood. 20 did not, and
19 of those now fail one: the one word a POSIX shell takes after its
switch, the switch behind an option with a value and `cmd /k`, the `cmd`
argument of `exec_command`, a quoted program where `cmd` may be the shell,
the size and the failure text of a command with only one of its two
outputs, an action's own end time, the three places a span is kept from
starting after it ended, the no-newline marker inside a hunk, a hunk side
with no stated size, a change the adapter cannot read, a script that only
quotes a patch, the script after a patch, MCP text counted in bytes, and a
failure whose first text is blank. The twentieth is left: taking the
`["apply_patch", <patch>]` argv by its own branch or by the script branch
gives the same span, so no test can tell them apart. No defect was found
in the adapter itself.

Two questions the reading raised were counted on the surveyed machine and
changed nothing. An action that carries its call's id is always written
before the call's output (2,020 of 2,020), which the code that completes
such a span from the output relies on. A failure whose preview opens with
the harness line `Script error:` is 2 of about 1,470; the fixtures show it
more often because their text is scrubbed.

**The UI, in a browser**, on `fixtures/codex`: dashboard, session list,
overview, timeline with the reviewer subagent, Inspector with transcript
slices of a session, a subagent and a model call, Time & Tools, Waste,
Errors, in both themes. Three things were wrong and are fixed:

- The total on a session or subagent row of the timeline left out every
  span that stands before its parent in the run. The normalizer orders
  spans that start together by id, so the first model call of a Codex turn
  often does (`simple` showed `Σ $0.4330 · 9 calls` for a session of
  $0.7002 and 12 calls). The fold assumed parents come first; it now walks
  the tree. The goldens of Claude Code and OTLP hold such spans too, so
  the totals were short there as well.
- A session none of whose calls has a price (a reviewer thread read on its
  own) showed `Local / $0.00` as its cost. It shows `Unpriced`; `Local`
  stays for a session whose calls were all priced at nothing.
- The explanation of a usage limit said "the message names the reset
  time". A Codex turn carries a code and no message; the sentence is gone
  from the shared text and stays in the Claude Code step that needs it.

A second pass over these changes found three more, fixed the same day.
The session list drew a model from the priced ones only, so a session with
the reviewer showed no dot for it and a reviewer thread on its own showed
no model at all; the list now takes the models from the calls, as the
dashboard does. The scrubber turned a text nested under an identity key
into a hash of itself, where before the number fix it was scrubbed as
text; only the value under the key itself is an id again. And the
discovery requirement said of the six-level bound "as the other adapters
do", which holds for OpenCode and OTLP and not for Claude Code; the clause
is gone. A check of every analysis in core and the UI against the 19
golden runs, 9 of which hold a child before its parent, found no other
function whose result depends on that order.

Seen and left: the page is a desktop layout and does not fit a phone
width, the tool leaderboard's "spend share" is each row against the
largest row, and a count of one reads "1 errors". None is of this change.

## Workflow follow-up

- File the out-of-scope items from `proposal.md` and the unverified variants
  from design "Risks" as issues in the planning repository.
- File the `node:readline` defect in the Claude Code adapter and
  `transcript.ts` (design T3) as its own fix: a record holding a raw U+2028
  or U+2029 is split and lost.
- File the `scrubPath` weakness found in 1.3 as its own fix: the shared
  path canonicalisation keeps a dot-directory or a dotted name whole
  (design T14). The Codex path is not affected; the committed Claude Code
  and OpenCode fixtures should be checked for such segments.
- Rebase onto `develop` once `add-tool-usage-breakdown` has merged.
- Archive the change after the project's review requirements are satisfied.
