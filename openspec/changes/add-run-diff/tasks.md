# Tasks: add-run-diff

Track A = data (`packages/core`, `packages/cli`), Track B = experience
(`packages/ui`). Every task: `pnpm lint && pnpm typecheck && pnpm test`
green, goldens untouched (diff adds no normalizer changes). UI tasks run
under the `/frontend-design` skill per CLAUDE.md. Coordinate with
add-profiler-depth: this change lands **after** it and rebases onto its
router parse/format matrix (filter params + time route) and its browser-safe
`@runray/core` subpath infrastructure; both changes touch run-selection
surfaces (SessionsTable, CommandPalette).

## 1. Core diff module (Track A)
- [x] 1.1 A `packages/core/src/diff/index.ts` — pure, dependency-free
      (schema types only), exposed as a `@runray/core/diff` subpath
      export (rides add-profiler-depth's browser-safe subpath family and
      its import-purity test) so the UI bundles the exact implementation
      the CLI prints: `RunDiff` types + `diffRuns(a, b)` header deltas —
      cost total, tokens by class, tool errors, llm-call count, max span
      depth, wall-clock — absolute + percent (percent null on zero base),
      round6 rounding; unit tests incl. identical-runs → all-zero
- [x] 1.2 A Span alignment: recursive per-sibling-group matching keyed by
      (kind, name) multiset, order-independent within a group (spec
      "Alignment robustness"), deterministic tie-break (startedAt, then
      id); matched/added/removed lists stably ordered; unit tests:
      reordered independent tools → matched with zero delta,
      duplicate-name multiset, subtree add/remove
- [x] 1.3 A Per-pair deltas (cost/tokens/duration/status flip) and
      subagent-pair subtree rollup deltas; property test: sum of pair
      deltas + added − removed ≈ header delta

## 2. CLI (Track A)
- [x] 2.1 A `runray diff <runA> <runB> [--json]` in `program.ts` +
      `diff.ts`: resolve each ref via the export command's `selectRun`
      prefix matcher; ambiguous/missing → exit 3 with the `runray list`
      hint; human summary (delta chips as text, worst regressions first);
      `--json` prints the RunDiff shape verbatim; e2e test diffing two
      golden runs
- [x] 2.2 A Document the `--json` contract as the CI-gate input: cli spec
      scripting section + `05-ARCHITECTURE` CLI table row; note the shape
      is additive-only from here (add-ci-gate depends on it)

## 3. Diff view (Track B)
- [x] 3.1 B Router `#/diff/:a/:b`: parse/format + tests, rebased onto
      add-profiler-depth's final matrix (filter params, time route);
      unknown id in either slot falls back to the dashboard (never a
      broken view)
- [x] 3.2 B `lib/diff-view.ts`: display adapter over `@runray/core/diff`
      — interleaved aligned rows for the paired waterfall
      (matched | added | removed), regression flags; unit tests against
      1.2's cases
- [x] 3.3 B DiffView per the archived stylebook's Diff section (§4.6 of
      `docs/03-design.md` at dc5873a^ — the proposal's "§4.5" is stale;
      §4.5 is the Inspector): two-column run headers with delta chips,
      aligned waterfall pairing (added = brass tint, removed = dimmed,
      cost-regressed = ember underline), summary table mirroring the CLI
      figures [UI → /frontend-design]
- [x] 3.4 B Compare entry points: sessions-table row action ("Compare
      with…" two-step) + command palette action; works offline in an
      exported multi-run file [UI → /frontend-design]

## 4. Verification
- [x] 4.1 B E2E: CLI diff vs Diff view figure parity on the same run pair;
      export round-trip (`#/diff` deep link from file://); a11y pass on
      the paired waterfall and compare picker; restore/relocate the Diff
      stylebook section so the shipped view has a live design reference
      (whether to restore the whole deleted `docs/03-design.md` is a
      human/repo decision — flag it, don't decide it here)
      > Verified 2026-07-19: figure parity automated in
      > `packages/cli/src/diff.test.ts` (`--json` verbatim-equals core
      > `diffRuns`, which is exactly what DiffView renders) and confirmed
      > interactively — real CLI binary vs the view on
      > subagents × tool-errors: identical six figures and span counts.
      > Export round-trip: `runray export fixtures/claude-code --redact`
      > opened from `file://`, `#/diff/:a/:b` renders identically offline
      > (compare picker + cancel also work in the export). A11y: compare
      > button focusable with aria-labels, banner `role=status`, rows
      > tabbable, summary/subtree `th scope=col`, chips as a labeled list,
      > swap link labeled.
      > **OPEN (human decision):** the Diff design reference still lives
      > only in the deleted `docs/03-design.md` §4.6 (`git show
      > dc5873a^:docs/03-design.md`). Restore the file or relocate §4.6
      > into a living doc — not decided here.
