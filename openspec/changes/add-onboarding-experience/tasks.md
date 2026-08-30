# Tasks: add-onboarding-experience

Owners: **A** = Track A (data: core/cli), **B** = Track B (experience: ui/design), **A+B** = pair.
Groups follow the six phases in `design.md`; each group is independently shippable, and the
product is strictly better than today if work stops after group 4.

Every user-visible string comes **verbatim** from `docs/12-ONBOARDING-COPY.md` at the cited
`§x.y`. If a string needs to change, change it there first — never in code.

Definition of done for every task: `pnpm lint && pnpm typecheck && pnpm test` green, no schema
drift, **goldens unchanged** (this change touches no adapter output — a moved golden means the
change is wrong).

## 1. Decisions and follow-ups to land first

- [x] 1.1 A File a separate issue for OpenCode's Windows root gap: `defaultRoots()` in `packages/core/src/adapters/opencode.ts` returns `~/.local/share/opencode` unconditionally with no Windows branch (design Q1). Group 3 makes this failure legible for the first time, so the issue must exist before it ships. **Not fixed here** — it changes discovery behavior and needs a `trace-ingestion` delta plus fixtures
- [x] 1.2 A Apply the `§3.7` disambiguation in `docs/12-ONBOARDING-COPY.md`: replace `Nothing was written to disk.` with `No configuration was written.` — the wizard does write `state.json`, and a literally-false sentence in privacy-adjacent copy is not affordable (design Q3)
- [x] 1.3 A+B Confirm `docs/12-ONBOARDING-COPY.md` passes its own §5 review checklist for the strings added during planning (`§3.3` fifth option, `§3.10f`): 80 columns, no colour, no banned words, real numbers only

## 2. Onboarding state and its HTTP surface (phase 1, `cli`)

- [x] 2.1 A Add `packages/cli/src/onboarding-state.ts`: resolve the state path honouring `$XDG_CONFIG_HOME`, defaulting to `~/.config/runray/`, and using `%APPDATA%\runray\` on Windows. Pure path resolution, unit-tested per platform with injected env
- [x] 2.2 A Implement the reader: return empty state when the file is absent, unreadable, or malformed; never throw, never create the file on read; preserve unknown top-level keys for the writer
- [x] 2.3 A Implement the writer: create lazily with mode `0600`, write atomically via a tmp file in the same directory plus rename, shallow-merge into the existing document, and swallow write failures after applying in memory
- [x] 2.4 A Unit tests for group 2: absent · malformed JSON · unreadable · read-only directory · unknown-key round-trip · concurrent writers leave a complete document · `0600` on POSIX
- [x] 2.5 A Add `GET /api/onboarding` to `packages/cli/src/server.ts`, returning the onboarding block or `{}`, with `cache-control: no-store`, behind the existing `isLoopbackHost` guard
- [x] 2.6 A Add `POST /api/onboarding`: read the body with a 4 KB cap (destroy the connection past it), filter to known keys and value shapes dropping the rest silently, shallow-merge, and return the merged block. Return 200 with in-memory state when the write fails
- [x] 2.7 A Add method dispatch for `/api/onboarding` only: anything but `GET`/`POST` answers 405. Do **not** retrofit method checks onto the other five routes — that is a separate change
- [x] 2.8 A Server tests: absent state → `{}` · patch merge preserves prior keys · `DELETE` → 405 · oversized body rejected · unknown key dropped with 200 · non-loopback `Host` → 403 before any read or write · unwritable directory → 200
- [x] 2.9 A+B Cross-track review of the state shape and the endpoint contract before group 5 depends on it (Surface C is the seam, per `openspec/project.md`)

## 3. Discovery roots and "where we looked" (phase 2, `cli`)

- [x] 3.1 A Add `resolveScanRoots(paths, source)` to `packages/cli/src/discover.ts`: the same adapter-`defaultRoots()` union `resolveWatchRoots` computes, **without** the `existsSync` filter, honouring `--source`. Explicit paths are returned verbatim
- [x] 3.2 A Classify each root as `missing` · `empty` · `unreadable`, and return `rootsScanned` on `DiscoveryResult` alongside `candidatesScanned` and `errors`. Add or remove no root from the scan — reporting only
- [x] 3.3 A Replace the `NO_DATA_HINTS` constant in `program.ts` with rendered output per `§3.4`: heading, one `~`-abbreviated line per root with its verdict in scan order, the two ways forward, and the demo pointer. Add the `--source`-narrowed note and the `unreadable` permissions line when they apply
- [x] 3.4 A Snapshot tests for the rendered output: all roots missing · one empty · one unreadable · `--source` narrowed · explicit path supplied. Assert 80-column fit and no colour codes under `NO_COLOR`
- [x] 3.5 A Assert goldens and existing discovery tests are untouched by group 3 — the reporting path must not perturb parse order or run ordering

## 4. CLI first run (phase 3, `cli`)

- [x] 4.1 A Add `@clack/prompts` to `packages/cli`, with the one-line justification in the PR description per `AGENTS.md` (removes ~120 lines of terminal edge cases; zero network; never reaches `packages/ui`)
- [x] 4.2 A Add `packages/cli/src/onboarding.ts` holding the prompt loop, the guide text and the hint selection. `program.ts` gains call sites, not logic
- [x] 4.3 A Implement the first-run banner per `§3.1`: at most three lines, stderr only, printed once per machine on `view`/`demo`/`list`, suppressed under `--json` and non-TTY stderr, colour suppressed under `NO_COLOR` while the text still prints
- [x] 4.4 A Implement the wizard gate: zero runs **and** `stdin.isTTY` **and** `stderr.isTTY` **and** no explicit `[path]`. Anything else falls through to group 3's output and exit 3
- [x] 4.5 A Implement the five-option `select` per `§3.3` with the first option preselected; `isCancel`, `Escape` and empty input all route to the exit branch
- [x] 4.6 A Wire the sample-session branch: load the bundled demo trace, serve, open the browser, record `demoSeenAt`, exit 0. The dashboard must show its sample banner (group 5 owns the banner copy)
- [x] 4.7 A Wire the setup-guides branch: print `§3.5`, then re-present the menu rather than exiting
- [x] 4.8 A Wire the custom-path branch: `text` prompt per `§3.3`, re-scan, serve on success and print `§3.8`'s snippet plus the equivalent `view <path>` invocation; on failure print `§3.6` and re-prompt, maximum three attempts, then group 3's output and exit 3. **Write no configuration file**
- [x] 4.9 A Add `--serve-empty` to `view` and wire the fourth wizard branch to the same path: start the server with zero runs, open the browser, supply `rootsScanned` to the dashboard, exit 0 when stopped. Honour the flag on non-interactive invocations; leave the unrequested no-data path at exit 3
- [x] 4.10 A Wire the exit branch: print group 3's output then `§3.7`, exit 3
- [x] 4.11 A Implement the demo bridge per `§3.9`: one line after `demo`'s server line, recorded via `demoSeenAt` and suppressed on re-run
- [x] 4.12 A Implement next-step hints per `§3.10a-d`: at most two after the first successful `view`, priority order shortcuts → `diff` (≥ 2 runs) → `--watch` (a run under 10 minutes old) → `export --redact` (any insight fired), recorded in `hintsShown` and never repeated
- [x] 4.13 A Implement both framing lines, neither consuming a hint slot: `§3.10e` beside the unpriced-model warning, and `§3.10f` beside per-candidate discovery errors with the real count of runs that loaded
- [x] 4.14 A Surface `rootsScanned` on `/api/viewconfig` for live mode only. Verify it cannot enter the export payload, the same way the pricing `path` is already stripped
- [x] 4.15 A Wizard tests per branch, asserting the exit code of each: sample → 0 · guides → menu returns · path found → 0 · path exhausted → 3 · serve-empty → 0 · exit → 3 · `Ctrl-C` → 3
- [x] 4.16 A Non-TTY regression tests: stdout byte-identical with onboarding present · `list --json` prints `[]` and nothing else · `diff --json` unchanged · no prompt reachable without a TTY · `--serve-empty` still works without one
- [x] 4.17 A Banner and state tests: prints once never twice · never on stdout · absent under `--json` · corrupt `state.json` still serves · explicit wrong `[path]` presents no wizard
- [x] 4.18 A Extend the CLI e2e suite in the existing `*-e2e.test.ts` style (real CLI + local server, no browser): first run under a temp `XDG_CONFIG_HOME` → wizard branch → server up → `GET /api/onboarding` reflects written state → second run is silent

## 5. Dashboard welcome and tour (phase 4, `ui`)

- [x] 5.1 B Add `@floating-ui/react` to `packages/ui` **and the export-exclusion gate in the same commit**: `define: { __RUNRAY_ONBOARDING__: 'false' }` in `vite.export.config.ts` so Rollup eliminates the onboarding subtree, imports included. Include the dependency justification in the PR description
- [x] 5.2 B Extend `packages/ui/src/bundle-guard.test.ts` with a **separate export-only** forbidden list — `@floating-ui`, `data-tour`, `/api/onboarding` — asserted against `dist-export/index.html` only. Do **not** add them to the shared `FORBIDDEN` list: `distBundles()` covers `dist/assets/*` too, where these markers are expected. Assert in the same test that `dist-export/index.html` stays under 1.5 MB
- [x] 5.3 B Add the onboarding store slice: fetch state on load, expose welcome and per-tour status, POST patches, and disable onboarding silently when the endpoint 404s or fails
- [x] 5.4 B Add `data-tour` attributes at the nine sites in plan §9 — `savings`, `overview-trend`, `tool-rank`, `sessions-table`, `help-button`, `waterfall`, `spend-spine`, `insights-strip`, `nav`. Attributes only, no restructuring [UI → /frontend-design]
- [x] 5.5 B Build the welcome dialog per `§4.1`, with the `§4.1b` variant when serving the bundled sample: native `<dialog>`, focus trap, `Esc` as the secondary action, run count from `traceFile`, the privacy line as its own quieter block. Render only after the state fetch resolves — `LoadingScreen` covers that window [UI → /frontend-design]
- [x] 5.6 B Build the tour controller: step index, anchored popover positioning via floating-ui (flip, shift, scroll-into-view, re-measure on resize), focus trap, `Back`/`Next`/`Skip tour`, `n / N` counter, arrow-key and `Tab` navigation. Spotlight is one absolutely-positioned element with a large-spread `box-shadow` — no library [UI → /frontend-design]
- [x] 5.7 B Load the controller through `React.lazy()` / dynamic `import()` so it stays out of the initial chunk in the live build too
- [x] 5.8 B Implement the four dashboard steps with `§4.2`'s copy, anchored in reading order, never navigating between routes [UI → /frontend-design]
- [x] 5.9 B Implement completion per `§4.3`: record `tours.dashboard = "completed"` and offer the single onward action opening the highest-cost visible run, falling back to the newest run when no cost is available [UI → /frontend-design]
- [x] 5.10 B Implement missing-anchor tolerance: skip the step, reduce the counter total, and for an anchor inside the virtualized waterfall scroll it into view before positioning — never pin a popover to a recycled row
- [x] 5.11 B Add the sample-session banner the CLI's wizard branch relies on (task 4.6), so sample data can never be mistaken for the user's own [UI → /frontend-design]
- [x] 5.12 B Component tests: welcome shown once · not shown after dismissal · no flash before the fetch resolves · endpoint failure disables onboarding · zero runs yields the empty state and never a tour · skip is permanent · fallback onward action on a fully unpriced trace
- [x] 5.13 B A11y tests: keyboard-only pass from welcome through all four steps to completion · `Esc` at every step · `prefers-reduced-motion` gives instant transitions with every step still operable · dialog role, label and initial focus match the `HelpSheet` pattern
- [x] 5.14 B Export-mode tests: with `window.__RUNRAY_DATA__` set, no welcome, no tour, and no request to `/api/onboarding`
- [x] 5.15 B Verify the live build still contains the onboarding code and that only the export template is asserted clean — a guard that passes because the feature vanished from both bundles is not a guard

## 6. Run tour and contextual hints (phase 5, `ui`)

- [x] 6.1 B Build the non-modal run-tour offer per `§4.4a`, shown the first time a run view opens when `tours.run` is unset; the run view stays interactive and `No thanks` records `skipped` permanently [UI → /frontend-design]
- [x] 6.2 B Implement the three run steps with `§4.4`'s copy, anchored at `waterfall`, `spend-spine` and `insights-strip` [UI → /frontend-design]
- [x] 6.3 B Make step 3's advance read `Try it` and **perform** the activation — `activateInsight` → `ui.highlighted` — with the payoff visible without scrolling. This is the activation gate; it must not merely describe the click
- [x] 6.4 B Build the hint primitive: one line, one dismiss with an accessible name, at most one visible at a time [UI → /frontend-design]
- [x] 6.5 B Wire the six hints with `§4.5`'s copy and their triggers — `time-view`, `what-if`, `diff`, `limit-mode`, `coverage`, `redact` — persisting dismissal in `localStorage` per the documented asymmetry in design D10
- [x] 6.6 B Verify the `limit-mode` hint states tokens and share of limit and never a currency amount
- [x] 6.7 B Extend `EmptyScreen` with the checked-roots list from `§4.7`, live mode only, rendering its existing content unchanged when no roots were supplied [UI → /frontend-design]
- [x] 6.8 B Tests: offer is non-modal · declining is permanent · step 3 highlights evidence · one hint at a time · dismissal persists · missing insights strip skips its step and the tour still completes · roots listed in the empty state and absent from exports

## 7. Export provenance strip (phase 6, `ui`)

- [x] 7.1 B Render the strip per `§4.6` when `live === false`: what the file is, session count, generation date, generating version, read-only, and the redaction state. Static, no dismiss, no state [UI → /frontend-design]
- [x] 7.2 B Give the `contains prompt text` variant a visually distinct warning treatment — a reader who does not know a report carries prompts cannot handle it correctly [UI → /frontend-design]
- [x] 7.3 B Add the quieter second line stating the report was generated locally and nothing in it was uploaded [UI → /frontend-design]
- [x] 7.4 B Tests: strip present under `live === false` and absent when served live · redacted and unredacted variants differ visibly · no filesystem path in any variant

## 8. Close-out

- [x] 8.1 A+B Confirm every string in the shipped UI and CLI matches `docs/12-ONBOARDING-COPY.md` verbatim; log any divergence as a copy defect against that file rather than patching it in code
- [x] 8.2 A+B Full run of `pnpm lint && pnpm typecheck && pnpm test`, plus a build of both bundles so `bundle-guard.test.ts` actually executes against `dist` and `dist-export`
- [x] 8.3 A+B Confirm `fixtures/normalized/` goldens are byte-identical to `main` and that `schema/runray.schema.json` shows no drift — `TraceFile` gains no onboarding field
- [x] 8.4 A+B Record in the PR description: both dependency justifications with their zero-network checks, the two deviations from issue #14 (endpoint over injection, patch over boolean), and the F8 resolution that `--serve-empty` is opt-in so no unrequested no-data path changed its exit code
