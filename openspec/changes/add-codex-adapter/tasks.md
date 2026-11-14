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
- [ ] 2.3 A LLM calls and token conversion (T4, T5): one `llm_call` per
      usage record with the response's items attributed to it, span bounds,
      `outputPreview`, the conversion with clamps, and the legacy path from
      running token events. Verify: tests for every scenario of "Codex LLM
      calls", "Codex token conversion" and "Legacy Codex token events", and
      a test over the `simple` and `legacy` fixtures asserting the summed
      tokens equal the thread total recorded in the file.
- [ ] 2.4 A Document the Codex adapter in `docs/05-ARCHITECTURE.md` (storage
      layout, record types read, the two token eras, what is deliberately
      not read). Verify: the section names the record types and files the
      code reads after 2.3.

## 3. Adapter: tools

- [ ] 3.1 A Calls, outputs and action attribution (D4, T7): pair calls with
      outputs by `call_id`; attribute harness actions by id, then to the open
      call, then to the call closed last in the same turn, then to the turn;
      emit action spans with their times, status, exit code, output size and
      error preview; decide at the end of a turn which calls are left without
      an action and emit a span only for those. Verify: tests for every
      scenario of "Codex tool spans are harness actions", built inline, plus
      a check on the `tool-errors` fixture that the number of tool spans
      equals actions plus action-less calls counted independently from the
      raw file.
- [ ] 3.2 A Shell unwrapping (T8): the wrapper table, the dialect guess for
      a script given as a bare string, a `codex` row in `adapters/target.ts`,
      a per-call dialect passed to the tool-usage classification (the
      `adapters/usage.ts` table fixes one dialect per tool name and cannot
      hold Codex), and rows in `tools/registry.ts` for the Codex call names
      the harness table lacks (`shell_command`, `exec`, `wait`, `sleep`,
      `write_stdin`, `js`, `js_reset`, `request_user_input_async`,
      `web.search`, `imagegen`), each with the activity "Harness tool
      classification" gives its kind. Verify: tests
      for every scenario of "Codex commands are unwrapped before identity
      capture", including target-key equality with a Claude Code
      `PowerShell` call, and the registry invariants and snapshot tests
      updated.
- [ ] 3.3 A File changes (T9): line counts per change type, header lines
      excluded, single-path target identity, legacy `shell` calls that run
      `apply_patch`. Verify: tests for every scenario of "Codex file
      changes" and one for the legacy form.
- [ ] 3.4 A MCP calls and extensions: `mcp_call` spans with their server,
      extension kinds as tool names, image views. Verify: tests for the
      "MCP call" scenario and one per extension kind seen in the fixtures.

## 4. Adapter: child threads and privacy

- [ ] 4.1 A Child threads (D2, T10): subagent span per child with its
      subtree, anchor on the named parent turn with the session fallback and
      warning, silent drop of a child with no turn, container extension.
      Verify: tests for every scenario of "Codex child threads nest under
      their parent" on the `guardian` fixture and inline rollouts.
      Found in 2.2, to settle here before coding: `turn_attribution` is on
      372 of 2,404 turn starts and on none in the fixtures. The 20 reviewer
      turns of the `guardian` fixture name a turn of their root in
      `root_turn_id` instead, so T10's anchor needs that as a second source
      (a design and spec change the maintainer signs off).
- [ ] 4.2 A Redaction and identifiers (T11): the `redact` path of every
      content field and `runray.target`, a Codex branch in
      `sanitize/sanitize.ts`, and Codex fixtures added to the redaction
      parity and sanitize invariant tests. Verify: tests for every scenario
      of "Codex content and identifiers stay in the parser", including a
      serialised-run search for the fixture's account id and repository URL.

## 5. Pipeline integration (Codex goldens missing between 5.2 and 5.3)

- [ ] 5.1 A Pricing for Codex models (D6): let `convertLitellmPricing` keep
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
- [ ] 5.2 A Register the adapter after OpenCode, make the Claude Code
      adapter skip rollout files, and add the CLI surface: `codex` in
      `SOURCE_ALIASES`, the four `--source` help strings, the unknown-source
      error, the setup guides text and `docs/12-ONBOARDING-COPY.md`. Verify:
      tests for "Codex rollouts are not Claude Code candidates", "Codex in
      the source filter", "Codex in zero-config roots" and "Codex in the
      setup guides"; `runray list --source codex` on `fixtures/codex` lists
      the fixture sessions. Registration makes `goldens.test.ts` expect
      Codex goldens, so this task and 5.3 land back to back; every other
      test is green here.
- [ ] 5.3 A Generate the Codex goldens in the three profiles with
      `pnpm goldens`, in one dedicated commit. Verify: `goldens.test.ts`
      passes with `fixtures/codex` included, the existing goldens are
      byte-identical, and a second `pnpm goldens` leaves the tree clean.
- [ ] 5.4 A Transcript slices (`transcript.ts`): a Codex branch that reads
      the provenance line through the rollout reader and labels segments per
      record type. Verify: tests for every scenario of "Transcript slices
      for Codex spans" and the redaction short-circuit.
- [ ] 5.5 A Bench and budget: a `pnpm bench` row for parsing a large Codex
      rollout (machine-local `fixtures/codex/large`, git-ignored like the
      Claude Code one, with its README). Verify: the row prints and the
      number is recorded in `docs/05-ARCHITECTURE.md` next to the other
      budgets.
- [ ] 5.6 A User-facing docs for the new source: README, `docs/01-FEATURES.md`
      (Codex moves from V3 to supported), `docs/07-DATA-SOURCES.md`, the
      source lists in `CLAUDE.md` and `openspec/project.md`, and a changeset.
      Verify: `rg -n "Claude Code, OpenCode"` over the repo finds no list
      that should now name Codex, and `pnpm changeset status` shows the
      entry.

## 6. Insights

- [ ] 6.1 A Codex arms in `insights/rules.ts` (T12): `instructionsFile`, the
      four suggestion switches, and the three checks from T12 (a run with
      no cache-write tokens, reviewer as the expensive subagent, rules that read
      `parentId` under `turn` spans). Verify: `suggestions.test.ts` covers
      `codex` for every rule it covers for `opencode`, tests for every
      scenario of "Cache-write rules are silent on Codex runs" and
      "Suggestions and playbooks address Codex", and a guard test that
      findings on the non-Codex fixtures are unchanged.
- [ ] 6.2 A Codex in `insights/meta.ts` (`PlaybookSource`, labels, a section
      per rule) and regenerated `docs/08-FINDINGS.md` via
      `pnpm docs:playbooks`. Verify: `playbooks-docs.test.ts` and
      `pnpm docs:playbooks --check` pass.

## 7. Visualizer

- [ ] 7.1 B [UI → /frontend-design] Source colour: a Codex source colour
      derived from the brand tokens in `packages/ui/src/index.css` for both
      themes, wired in `lib/model-colors.ts`. The legend and the filter show
      the source id, `codex`, as they do for the other sources. Verify: tests for every scenario of "Codex is
      presented as a named source", including the contrast check the theme
      token tests apply to the other source colours.
- [ ] 7.2 B [UI → /frontend-design] Per-source hints: Codex wording in
      `lib/waste.ts`, the transcript cost note in
      `components/PricingProvenance.tsx`, the sentence in
      `components/WelcomeDialog.tsx` that names the sources read, and a
      review of the source branches in `lib/tool-table.ts`. Verify: tests for every scenario of
      "Per-source hints cover Codex".

## 8. Integration checks

- [ ] 8.1 A Real-session check on a machine with Codex data: every rollout
      under the default root parses or is skipped for a documented reason;
      for every root thread the summed tokens equal its recorded thread
      total; `runray view` renders a Codex session with its reviewer
      subagents, and the Time & Tools tab names programs, not `exec`.
      Reference figures from the design survey: 250 files, 67 root threads,
      54 of them with usage records and all 54 reconciling. Verify: the
      counts (files, runs, skipped with reasons, threads reconciled, seconds
      for a full build) are written into this task when it is ticked.
- [ ] 8.2 A End-to-end smoke through the real CLI (`packages/cli/src/*-e2e`):
      `view` and `export` on `fixtures/codex`, with and without `--redact`.
      Verify: the e2e test passes and the redacted export contains no
      string from the unredacted previews.

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
