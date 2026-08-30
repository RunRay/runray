# Design: add-onboarding-experience

## Context

Three surfaces, one state. The plan's §5 diagram is the architecture:

```
terminal            SURFACE A — CLI first run
`runray view` ─▶ banner · no-data wizard · demo bridge · next-step hints
                                    │ starts server, opens browser
                                    ▼
browser (live)      SURFACE B — dashboard first run
127.0.0.1:41xx    ─▶ welcome dialog · dashboard tour (4) · run tour (3) · hints
                                    │ GET/POST /api/onboarding
                                    ▼
                    SURFACE C — state
                    ~/.config/runray/state.json  (port-independent, per user, local)

file:// report.html ─▶ no surfaces. Static provenance strip only.
```

Surface A is Track A (data/CLI), Surface B is Track B (experience), Surface C is the seam
and needs a cross-track review per `openspec/project.md`.

**Current state, verified against the code:**

- `program.ts:141-146` — `first.runs.length === 0` writes `NO_DATA_HINTS` and sets exit 3.
  No wizard, no demo offer, no browser. `NO_DATA_HINTS` (`program.ts:60-66`) is a static
  template literal naming two paths it never actually confirms.
- `server.ts:166-180` — every route runs behind `isLoopbackHost(req.headers.host)`, then
  dispatches on `urlPath` alone. **There is no `req.method` check anywhere**; `/api/tracefile`
  answers a POST as readily as a GET.
- `lib/load.ts:44-46` — `window.__RUNRAY_DATA__` present ⇒ `{ traceFile: embedded,
  live: false }`. Export detection is already free.
- `discover.ts:98-125` — `buildTraceFile` iterates `adapters.all()` and calls
  `adapter.detect(options.paths)`. Root resolution lives *inside* each adapter's
  `defaultRoots()`; the CLI never sees the root list. `DiscoveryResult` returns
  `candidatesScanned` and `errors`, but no roots.
- `discover.ts:44-53` — `resolveWatchRoots()` already unions every adapter's `defaultRoots()`,
  but filters with `existsSync`, which discards exactly the information "where we looked" needs.
- `bundle-guard.test.ts:19-39,41-67` — `distBundles()` returns `dist/assets/*` **and**
  `dist-export/index.html`, and the single `FORBIDDEN` list is asserted against all of them.
- `packages/ui/package.json` — `react`, `react-dom`, `zustand`, `@tanstack/react-virtual`,
  fonts. No Radix, no floating-ui, no component library. `HelpSheet` and `CommandPalette` are
  hand-rolled dialogs and are the a11y reference implementations.

**Binding constraints.** No telemetry and no runtime network calls (`AGENTS.md`). The server
port is not stable — 4173 incrementing up to 50 times — and `localStorage` is origin-scoped
*including port*, so browser-side state evaporates on a port shift. Exported HTML must carry
no filesystem paths (`program.ts:418-419` already strips the pricing `path` for this reason).
The export bundle is at 1.34 MB against a 1.5 MB budget — roughly 91 KB of headroom — while
the live bundle is served over loopback and costs nothing measurable.

**Dependency posture.** `AGENTS.md` forbids new dependencies without justification. The
founder granted a scoped exception for this feature on 2026-08-10: *"for this feature it is ok
to introduce a new library if this brings value or makes implementation easier or improves
UX."* The justification records in D5 and D6 below satisfy the PR-description requirement that
survives the exception. Every other hard rule still binds.

## Goals / Non-Goals

**Goals:**

- Remove the no-data dead end without changing a single exit code on any path the user did not
  explicitly request.
- Make the already-written empty-state recovery screen reachable in live mode.
- Make "where we looked" legible, so a wrong path is distinguishable from an empty one.
- Teach the burned-vs-opportunity distinction once, at the point of first confusion.
- State the privacy promise inside the product, as mechanism rather than slogan.
- Keep durable onboarding state on the CLI side so a port shift cannot resurrect a
  completed tour.
- Guarantee, structurally rather than by convention, that no onboarding code or dependency
  can reach an exported report.
- Preserve machine-readable output byte-for-byte on the non-TTY path.

**Non-Goals:**

- Measuring activation in-product. There is no telemetry and there will be none; the plan's
  §11 replaces it with timed observation of the 5-user beta cohort.
- Persisting discovery configuration on the user's behalf.
- Onboarding inside an exported report beyond one static provenance line.
- A browser-automation harness. The tour's browser half is asserted at component level.
- Fixing OpenCode's Windows root resolution (see Open Questions — genuine bug, wrong change).
- Any change to `TraceFile`, adapters, the normalizer, or the cost engine. **If a golden
  moves, this change is wrong.**

## Decisions

### D1 — State lives in a CLI-owned file, not the browser

`~/.config/runray/state.json`, honouring `$XDG_CONFIG_HOME`, `%APPDATA%\runray\` on
Windows. Created lazily, mode `0600`, written atomically (write tmp in the same directory,
then rename). Unknown top-level keys are read and preserved on write, so a newer RunRay
writing a key an older one does not understand survives a downgrade.

```json
{
  "version": 1,
  "firstSeenAt": "2026-08-10T09:12:44.101Z",
  "demoSeenAt": null,
  "hintsShown": ["shortcuts", "watch"],
  "onboarding": {
    "welcomeDismissedAt": "2026-08-10T09:13:02.880Z",
    "tours": { "dashboard": "completed", "run": "skipped" },
    "hints": ["time-view"]
  }
}
```

**A malformed, unreadable, or read-only file is treated as absent and is never fatal.** An
onboarding file that can break `view` is a strictly worse product than no onboarding at all.
Every read is wrapped; every write failure is swallowed after being reflected in memory.

**No paths, no project names, no prompt text ever enter this file.** That is what lets us say
"nothing was written that you would not want written", and it is why the file needs no
redaction pass of its own.

*Alternatives considered.* `localStorage` — rejected outright by the port instability
(constraint 4); a tour that reappears because the port moved from 4173 to 4174 is worse than
no tour. `conf` / `env-paths` — ~20 lines of `node:path` + `node:os` cover XDG and `%APPDATA%`,
and a config library that throws on a malformed file is a liability given the never-fatal rule.

### D2 — `GET`/`POST /api/onboarding`, not injected HTML

Issue #14 proposes injecting `window.__RUNRAY_ONBOARDED__` into `index.html` "following
the existing pattern used for `__RUNRAY_PRICING__`". **That pattern does not exist on the
live path.** In `view`/`demo`, pricing and view-config are endpoints (`server.ts:182-194`)
that the UI fetches (`lib/load.ts:64-89`); injection happens only in `export`
(`program.ts:420-430`), and `server.ts` serves the UI through a byte-streaming static file
server. Injection would mean parsing and patching HTML per request, to deliver something the
UI can simply fetch.

The endpoint is also symmetric with the POST the feature needs anyway, and exports need no
flag at all because `live === false` already disables everything (D7).

**Hardening**, on top of the existing loopback `Host` guard:

| Rule | Why |
|---|---|
| Only `GET` and `POST`; anything else ⇒ 405 | The server has no method dispatch today; this endpoint is the first that must not accept an arbitrary verb, because it writes. |
| Request body capped at 4 KB, connection destroyed past the cap | An unbounded body on a loopback write endpoint is a trivial memory sink. |
| Only known keys with known value shapes accepted; everything else dropped **silently** | Rejecting loudly invites probing; dropping keeps the contract narrow without a schema round-trip. |
| Never echo a filesystem path in any response | Same rule the export payload already follows. |
| `cache-control: no-store` | Matches every other endpoint. |
| A write failure returns **200 with the in-memory merged state** | Onboarding degrades, never blocks. A read-only home directory must not turn a tour click into an error dialog. |

The method check applies to `/api/onboarding` only. Retrofitting method dispatch onto the
other five routes is a real improvement and a different change.

*Alternative considered.* Validating the patch with `zod` — already a workspace dependency via
`packages/schema`, so it is available. Not used: the patch is four keys with fixed shapes and
unknown keys are dropped anyway. Revisit if the endpoint grows.

### D3 — One endpoint taking a patch, not `POST /api/onboarded` taking a boolean

Issue #14's `{"onboarded": true}` cannot express "welcome dismissed, dashboard tour completed,
run tour not yet offered, two hints seen" — which is exactly the state the run tour and the
contextual hints require. One endpoint, shallow-merged small patches.

### D4 — Two short tours, and the tour never navigates

Issue #14 specifies one 7-step tour spanning nav → dashboard → sessions → run views. A 7-step
tour must force-navigate across routes (`#/dashboard` → `#/sessions` → `#/run/:id/…`), which
hijacks a user who arrived with an intention, and breaks on any run without insights. Instead:

- **Dashboard tour, 4 steps** — the savings split · where it went · a row is a session · the
  keyboard. Anchored popovers, not a full-screen dim: the stylebook's pillar is "Invisible UI",
  and dimming the whole screen for consecutive steps fights the product's own thesis.
- **Run tour, 3 steps**, offered *in place* the first time a run view opens, as a small
  non-modal prompt rather than an auto-starting overlay — nesting is delegation · the burn
  line · findings point at evidence.

Step 3 of the run tour is the activation gate, so its `Next` reads `Try it` and **performs**
the insight activation rather than describing it: the click is the aha moment, and a tour that
narrates it instead of doing it has missed the point.

`TimeView`'s wall-clock decomposition and `CostView`'s what-if panel are hints, not steps —
second-session material. The hints carry the long tail so both tours stay short.

**Anchors** are `data-tour="<key>"` attributes added at nine existing sites — attributes only,
no restructuring. **Anchor resolution must tolerate a missing node:** a step whose anchor is
absent (a run with no insights, a filtered-empty table) is skipped and the counter reflects
the reduced total. A tour that points at nothing is worse than no tour.

**A11y is a project standard, not a nicety.** Native `<dialog>` / focus-trapped popover,
`Esc`-closable, `role="dialog"` + `aria-modal` + focused close button in the shape
`HelpSheet.tsx` already uses. Animations `transform`/`opacity` only, behind `motion-safe:`;
under `prefers-reduced-motion` the tour runs with instant step transitions and stays fully
usable. The welcome dialog renders only **after** the onboarding fetch resolves — a dialog
that flashes and disappears is worse than none, and `LoadingScreen` already covers that window.

### D5 — `@clack/prompts` for the CLI wizard

**Adopt** in `packages/cli`. Arrow-key `select`, `text` with validation, first-class cancel via
`isCancel`. Hand-rolling a raw-mode selection loop over `node:readline` is roughly 120 lines of
terminal edge cases — arrow escape sequences, `Ctrl-C`, redraw, Windows — for a worse result.
~4 kB gzipped, which is irrelevant: this is an npm CLI, and it never reaches `packages/ui`.
**Zero network.** Brings `picocolors`, which honours `NO_COLOR`.

`node:readline/promises` **stays** for `export`'s existing y/N redaction consent. A single
confirm does not justify a second idiom there, and that prompt is already the right pattern.

*Alternatives rejected.* `@inquirer/prompts` — larger, with a plugin/rendering-engine surface
we do not need. `prompts` — thin but effectively unmaintained. `enquirer` — CJS-leaning, awkward
in an ESM-only repo. `chalk` — unnecessary given picocolors.

*Residual risk.* Clack draws its own gutter, glyphs and dim hint text, so §3's copy must read
correctly inside that frame **and** unstyled under `NO_COLOR`. CI must never reach it — already
guaranteed by the `isTTY` gate in D9.

### D6 — `@floating-ui/react` for placement; the controller stays ours (resolves O6)

**Adopt the positioning primitive; do not adopt a tour framework.**

The genuinely hard part of an anchored tour is placement: flip, shift, viewport collision,
scroll-into-view, and re-measure on resize — inside a virtualized waterfall
(`@tanstack/react-virtual`) where the anchor may not be mounted at all. That is precisely
floating-ui's job. The remaining ~150 lines — step index, keyboard handling, focus trap,
persistence — are ours regardless, because the state lives on the server (D1/D2).

~15–20 kB gzipped in the live bundle, which costs nothing over loopback. **Zero bytes in the
export bundle** (D7). Zero network.

*Alternatives considered.* **`driver.js`** is genuinely good — ~5 kB, zero deps, TypeScript,
MIT, and it would ship the tour fastest. Rejected on three counts: it owns the overlay DOM,
its own CSS variables and its own animation model, colliding with the token system and the
`transform`/`opacity`-only motion rule; step content is HTML strings, so React formatters and
`SeverityPill` cannot be reused inside steps; and it introduces a second dialog idiom beside
the hand-rolled `HelpSheet`/`CommandPalette`. *If this is ever revisited, verify the publisher
and the repo↔npm link first — its GitHub home appears to have moved organisations.*
**`react-joyride`** — heavier, historically fussy under React 18 concurrency. **`@reactour/tour`**,
**`shepherd.js`** — same "brings its own look" objection, larger. **Hand-rolling positioning
too** — viable, but re-implementing collision detection against a virtualized list is exactly
the risk worth paying 18 kB to delete.

The spotlight is one absolutely-positioned element with a large-spread `box-shadow`. It needs
no library at all.

*Residual risk.* One more dependency in the dashboard's graph, mitigated by D7's CI guard.

### D7 — Export exclusion is structural, and needs its own forbidden list

Onboarding code and both dependencies must be **absent** from `dist-export/index.html`, not
merely inert in it.

1. **Build-time dead-code elimination.** Gate every onboarding entry point behind a constant —
   `define: { __RUNRAY_ONBOARDING__: 'false' }` in `vite.export.config.ts` — so Rollup
   eliminates the whole subtree, imports included. A runtime `if (live)` is **not sufficient**:
   the module still gets bundled.
2. **Lazy in the live build too.** `React.lazy()` / dynamic `import()` keeps the tour out of the
   initial chunk and off a returning user's first-paint path.
3. **A separate export-only forbidden list in `bundle-guard.test.ts`.** This is a correction to
   the plan's §16.3, which says to add the markers to `FORBIDDEN`. That would fail the live
   bundle: `distBundles()` returns `dist/assets/*` *and* `dist-export/index.html`, and
   `FORBIDDEN` is asserted against every entry. `@floating-ui` and `data-tour` are **expected**
   in `dist`. So the guard grows a second list checked against `dist-export/index.html` only:

   | Marker | Why |
   |---|---|
   | `@floating-ui` | positioning library leaked into a shareable report |
   | `data-tour` | tour anchors/controller leaked into a shareable report |
   | `/api/onboarding` | live-mode endpoint string leaked into a `file://` artifact |

   That third marker is worth as much as the size guard: it proves an exported report cannot
   even *describe* a call to a local server it will never have.
4. **Assert the budget in the same test.** `dist-export/index.html` under 1.5 MB. It is at
   1.34 MB today; a silent breach should be found by CI, not by a user on Slack.

**The gate ships in the same commit as the first UI dependency, never after it.** A phase that
adds `@floating-ui/react` without the guard spends the export budget silently.

### D8 — "Where we looked" without touching adapter discovery

`NO_DATA_HINTS` becomes a function of the actual scan: every root checked, in scan order, with
a one-word verdict — `missing` (no such directory) · `empty` (exists, no sessions) ·
`unreadable` (permissions).

Root resolution currently lives inside each adapter's `defaultRoots()` and the CLI never sees
it. Rather than change the adapter interface, `discover.ts` gains a `resolveScanRoots(paths,
source)` — the same union `resolveWatchRoots` already computes, **without** the `existsSync`
filter, because a root that does not exist is precisely the thing the user needs told. Each
root is then stat-ed for its verdict, and `DiscoveryResult` returns `rootsScanned` alongside
`candidatesScanned` and `errors`.

**No adapter, normalizer, or cost-engine code changes, and no root is added or removed from the
scan** — hence no `trace-ingestion` delta and no golden movement. This change reports what is
already scanned; it does not alter what is scanned.

Delivery to the UI's `EmptyScreen` is via `/api/viewconfig`, which already exists and is
**live-only**. Roots are `~`-abbreviated in terminal output and **never** enter the export
payload — same rule that strips the pricing `path`.

This is the single highest-leverage change for the evaluator persona, whose exact failure mode
is "the script assumes a specific install path".

### D9 — The wizard is gated three ways, and exit codes are contract

```
Guard:  runs.length === 0
        && process.stdin.isTTY === true
        && process.stderr.isTTY === true
        && no explicit [path] argument
Else:   "where we looked" (D8) + exit 3 — today's shape, better content
```

The `isTTY` pair is the same test `export` already uses (`program.ts:345`). **An explicit wrong
`[path]` is a user error, not a discovery failure** — offering a wizard there would be
answering a question the user did not ask.

| Branch | Ends in | Exit |
|---|---|---|
| 1 · sample session | demo trace → server → browser | **0** |
| 2 · setup guides | printed, then re-ask | — |
| 3 · folder, runs found | re-scan → server → browser | **0** |
| 3 · folder, still empty | re-ask, max 3 attempts, then fall through | **3** |
| 4 · dashboard anyway | empty serve → server → browser (D14) | **0** |
| 5 · exit | "where we looked" + `Esc`/`Ctrl-C`/empty land here too | **3** |

**The wizard never converts "no data" into a silent success.** `list --json` and `diff --json`
feed scripts and the future CI gate; the non-TTY path must stay byte-identical, and that is a
regression test, not a hope.

All onboarding output is **stderr**. stdout stays a data channel — the first-run banner must
never appear in `list --json`.

New file `packages/cli/src/onboarding.ts` holds the prompt loop, the state reader/writer and
the guide text. `program.ts` gains call sites, not logic.

### D10 — Tours are server-side state; hints may live in `localStorage`

Deliberate asymmetry. Re-showing a one-line dismissible hint after a port change is a shrug;
re-showing a completed tour is an insult. Tours and `welcomeDismissedAt` go through
`/api/onboarding`; the six contextual hint keys may use `localStorage`. Documented trade-off,
not an oversight.

### D11 — `demo` gets the welcome dialog, in its own variant (resolves O1/O2)

`demo` is the front door for evaluators, so suppressing the welcome there would leave the
persona most likely to arrive first with the least framing. But the standard copy talks about
"your sessions", which would be a lie. So: the welcome renders on `demo` with the §4.1b variant
— *"A sample session, scrubbed and bundled"* — keeping the privacy line and both buttons.

Wizard option 1 likewise opens the browser on demo data, with the in-app demo banner visible.
Blurring "your data" and "sample data" is the one confusion this feature cannot afford, and a
visible banner is a cheaper guard than making a user with no data type a second command.

Activation is deliberately **not** claimed on demo data: the demo earns attention, it cannot
earn activation, because the insight is not about the user's money. Its success criterion is a
transition — the user runs `runray view` afterwards — which is what the bridge line
(printed once, suppressed when `demoSeenAt` is set) exists to prompt.

### D12 — The wizard prints config, never writes it (resolves O3)

After a successful custom path, print the exact `runray view <path>` invocation and the
`{ "dataRoots": ["<path>"] }` snippet. Writing a config file on the user's behalf is a side
effect they did not request, and this feature's entire credibility rests on the claim that it
does not do things behind your back. Costs one argument per run; worth it.

### D13 — At most two next-step hints, plus framing for conditions that are not failures

After a successful **first** `view`, print at most two hints, then never again
(`state.json.hintsShown`). Priority order, first two that apply: shortcuts (always) · `diff`
(≥ 2 runs) · `--watch` (a run under 10 minutes old) · `export --redact` (any insight fired).
Two is the cap. A wall of tips is the same failure as the wall of hints we are removing.

**Two framing lines print in addition and consume no slot.** The plan's §6.5 specifies only
the unpriced-model framing, but the finding it answers (F10) names *two* warnings —
`reportUnpricedCoverage` **and** `reportDiscoveryErrors` (`program.ts:131-132`). A first-run
user whose OpenCode database is locked, or whose import file was half-written, gets a bare
per-candidate parse error with nothing saying the failure was contained. Both are normal,
expected conditions; both read as a broken install at the exact moment trust in the numbers is
being formed. So the discovery-error case gets a framing line too, printed adjacent to the
existing error, stating that the failure was contained and how many sessions loaded normally.

New copy is required for it — added to `docs/12-ONBOARDING-COPY.md` as §3.10f, since that file
is the source of truth and strings are implemented verbatim from it.

### D14 — Serving an empty dashboard is opt-in, which is how `EmptyScreen` becomes reachable

**The plan contradicts itself on F8.** §4's fix column says "§6.2 (option 4 starts the server
anyway)"; §6.2's own prompt tree says option 4 prints and **exits 3**; §7.6 says "wizard option
4 (and a future `--serve-empty`) start the server with zero runs so the browser can explain
itself." A server that stays up and a process that exits 3 are mutually exclusive.

Resolved by separating the two ideas the plan conflated. The **exit branch keeps exiting 3** —
a user who chose to leave should not have a browser opened at them. Serving an empty dashboard
becomes an **explicit request**: a `--serve-empty` flag on `view`, plus a fifth wizard branch
that maps to the same code path. Exit 0, because the user asked for exactly what they got.

This preserves the rule that the wizard never converts an *unrequested* no-data result into a
success, while making `EmptyScreen` — which is already well written — reachable in normal use
rather than only after runs roll off mid-`--watch`. It also settles an inconsistency that would
otherwise have shipped inside this change's own specs: the visualizer requires an empty state
fed with checked roots, and without this decision the CLI had no way to produce that state.

`--serve-empty` is honoured on non-interactive invocations, unlike the wizard: it is an
instruction, not a recovery guess, so the `isTTY` gate does not apply to it. Scripts that do
not pass it see no behavior change at all.

## Risks / Trade-offs

**Onboarding state breaks `view`** → Every read and write is wrapped; malformed, unreadable and
read-only are all "absent". Explicit test: corrupt `state.json` → `view` still serves. This is
the one failure mode that would make the feature net-negative.

**Two dashboards on two ports write concurrently** → Atomic tmp+rename, and the merge is
shallow with last-write-wins per key. Losing "hint 3 dismissed" to a race is acceptable;
a truncated file is not, which is what atomicity buys.

**`@floating-ui/react` leaks into the export bundle** → D7's export-only marker list fails CI.
The 91 KB of headroom is the real budget, and this dependency is 15–20 kB — one careless import
away from consuming a fifth of it.

**Tour anchor recycled inside the virtualized waterfall** → A step whose anchor is unmounted
scrolls it into view, or is skipped and the counter total reduced. A popover pinned to a
recycled row is the specific bug to test for, not to reason about.

**Clack reached on a non-TTY path** → The `isTTY` pair gates it, and the non-TTY output is
asserted byte-identical. A wizard prompt appearing in CI would break the future CI gate, which
is a downstream change's foundation.

**Copy drifts from `docs/12-ONBOARDING-COPY.md`** → That file is the source of truth and
strings are implemented verbatim; a wording change goes there first. The doc's own review
checklist (no colour, 80 columns, no banned words, a real number or none) is the gate.

**The tour teaches the dashboard instead of shortening the path to a finding** → The stated
job of the dashboard tour is to reach "open a run"; its completion screen is a pointer at the
priciest session, not a celebration. Anything that does not shorten dashboard-opened →
evidence-highlighted is a hint, not a step.

**Trading velocity for visual control (D6)** → `driver.js` would ship faster. We accept a few
days and ~15 kB to keep the token system, the motion rule, and one dialog idiom. Reasonable
people differ; this is a taste call, not a correctness one, and either answer ships a good tour.

## Migration Plan

Six phases, each independently shippable and independently valuable. Phase 1 alone fixes
nothing user-visible; **phases 2–3 alone fix the worst finding**, and if the change is cut short
after phase 3 the product is strictly better than today.

| Phase | Work | Package |
|---|---|---|
| 1 | `state.json` reader/writer; `GET`/`POST /api/onboarding` | `cli` |
| 2 | `resolveScanRoots` + per-root verdicts; "where we looked" replaces `NO_DATA_HINTS` | `cli` |
| 3 | Wizard + `view` integration; `--serve-empty`; first-run banner; demo bridge; next-step hints and both framing lines — **adds `@clack/prompts`** | `cli` |
| 4 | Tour controller, store slice, welcome dialog, dashboard tour, `data-tour` anchors — **adds `@floating-ui/react` + the export-exclusion gate and guard markers, same commit** | `ui` |
| 5 | Run tour + contextual hints | `ui` |
| 6 | Export provenance strip | `ui` |

**Rollback.** Each phase reverts independently. Phases 1–2 are additive and invisible; phase 3
is the only one that changes an interactive code path, and its guard is a pure `isTTY` check —
reverting it restores today's behavior exactly. Phases 4–6 are UI-only and cannot affect the
CLI's exit codes or output.

**Definition of done, per `AGENTS.md`:** `pnpm lint && pnpm typecheck && pnpm test` green, no
schema drift, and **goldens unchanged** — this change touches no adapter output, so a moved
golden means the change is wrong, not the golden. Every UI task is `[UI → /frontend-design]`
per CLAUDE.md.

## Open Questions

**Q1 — OpenCode's Windows root (was O5, now reframed).** `opencode.ts:814-818` returns
`~/.local/share/opencode` unconditionally, with only an `OPENCODE_DATA_DIR` env override — there
is **no Windows branch at all**. On Windows this is almost certainly the wrong directory.

The plan's default answer was "list all candidates as checked", but listing a root we do not
actually scan would make the new output a lie, and the whole point of D8 is that the output is
true. So this change **reports exactly the roots that were scanned** — which on Windows makes
the gap visible for the first time — and fixing `defaultRoots()` is deferred. That fix changes
discovery behavior, needs a `trace-ingestion` delta and adapter fixtures, and belongs in its own
change. **Recommend filing it before this one ships**, since D8 turns a silent failure into a
legible one and users will report it.

**Q2 — Browser-level E2E.** The plan's test §13 asserts the browser half at component level
because there is no browser-automation harness in this repo (`project.md` lists Playwright as
planned, not present). Introducing Playwright is a larger decision than onboarding should make
on its own. Flagged, not smuggled in.

**Q3 — §3.7 wording.** The wizard's exit line reads `Nothing was written to disk.` — but the
wizard does write `state.json`. The line means *config and project files*. `docs/12` already
proposes `No configuration was written.` as the disambiguation. **Recommend taking it:** a
privacy-forward tool cannot afford a literally-false sentence in its privacy-adjacent copy.
