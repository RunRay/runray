# Onboarding experience — CLI first run, dashboard tour, export provenance

## Why

A user who installs RunRay before running an agent hits a dead end: `view` prints a
static hint block and exits 3 — no demo offered, no way to point at a folder, no statement of
where we actually looked (`program.ts:60-66,141-146`). A user who *does* have data gets a
dashboard that renders run #1 and run #100 identically, opens with two large numbers whose
distinction is the entire product thesis and is explained nowhere, and never states the
privacy promise that is the strongest reason three of five personas adopt at all.

There is no signup and no telemetry, so the only activation gate that matters is narrow and
observable: **the user opens one finding on their own run and lands on its evidence spans**
(`activateInsight` → `ui.highlighted`). Everything in this change exists to shorten the path
to that moment, or to remove a dead end in front of it. Implements GitHub issue #14; the
behavior contract is `docs/11-ONBOARDING-PLAN.md` and every user-visible string is
`docs/12-ONBOARDING-COPY.md`.

## What Changes

**Per-user onboarding state (new seam).**
- `~/.config/runray/state.json` — XDG-aware, `%APPDATA%` on Windows, `0600`, atomic
  writes, unknown keys preserved. A malformed or unreadable file is treated as absent and is
  **never** fatal. No paths, no project names, no prompt text ever enter it.
- `GET /api/onboarding` returns the current block (`{}` when absent);
  `POST /api/onboarding` shallow-merges a ≤ 4 KB patch of known keys and returns the merged
  block. A write failure returns 200 with in-memory state — onboarding degrades, never blocks.
- Deliberately **not** `window.__RUNRAY_ONBOARDED__` injection (issue #14's proposal):
  that pattern is export-only, and live mode serves the UI as a byte-streaming static server.
  State must also survive the port shifting between 4173 and 4222, which `localStorage`
  cannot do.

**CLI first run (`packages/cli`).**
- Interactive no-data wizard, gated on `stdin.isTTY && stderr.isTTY` and the absence of an
  explicit `[path]` argument: open the sample session · show setup guides · point at a folder
  · open the dashboard anyway · exit. **Exit codes are unchanged** — a served dashboard is 0,
  everything else stays 3. Non-TTY output stays byte-stable for scripts and the future CI gate.
- `view --serve-empty` serves the dashboard with zero runs on explicit request, which is what
  finally makes the well-written `EmptyScreen` reachable in live mode. Opt-in only: an
  unrequested no-data `view` still starts no server and still exits 3.
- `NO_DATA_HINTS` becomes a function of the actual scan: every root checked, in scan order,
  each with a one-word verdict (`missing` / `empty` / `unreadable`).
- First-run banner (once per machine, stderr, suppressed under `--json` / non-TTY), a
  demo → own-data bridge line, and at most two next-step hints after the first successful
  `view`, then never again.
- First-run framing for the two warnings that describe normal conditions — unpriced models,
  and a per-candidate discovery failure that other runs survived — printed adjacent to the
  existing warning and consuming no hint slot, so neither reads as a broken install.
- New dependency `@clack/prompts` for the wizard; `node:readline/promises` stays for
  `export`'s existing consent prompt.

**Dashboard (`packages/ui`).**
- Welcome dialog — run count and date span from real data, the privacy line stated as
  mechanism, two buttons. Demo variant on `runray demo`.
- Dashboard tour, 4 anchored steps (savings split · where it went · a row is a session ·
  the keyboard). Run tour, 3 steps, **offered non-modally in place** rather than
  force-navigating. The tour never navigates for the user.
- One-shot contextual hints (`time-view`, `what-if`, `diff`, `limit-mode`, `coverage`,
  `redact`) carry the long tail so both tours stay short.
- `EmptyScreen` gains the checked-roots list over `/api/viewconfig`, and becomes reachable in
  normal use through the explicit empty-serve path above rather than only via a `--watch`
  roll-off.
- Export provenance strip when `live === false`: what the file is, when, by which version,
  redacted or not, read-only — with the "contains prompt text" variant visually distinct.
- New dependency `@floating-ui/react` for anchor placement only; the popover markup, tokens,
  motion and focus behavior stay hand-rolled against `HelpSheet`/`CommandPalette`.

**Build and test guards.**
- Onboarding is gated behind a build-time constant so Rollup dead-code-eliminates the whole
  subtree from `vite.export.config.ts`, and lazy-loaded in the live build.
- `bundle-guard.test.ts` gains `@floating-ui`, `data-tour` and `/api/onboarding` as forbidden
  markers, plus an explicit assertion that `dist-export/index.html` stays under 1.5 MB
  (1.34 MB today, ~91 KB of headroom). This ships **in the same commit as the first UI
  dependency**, never after it.

**Out of scope.** Accounts, e-mail sequences, product analytics (telemetry is forbidden —
§11 of the plan replaces it with timed observation of the 5-user beta cohort). Mobile
onboarding. Turning the exported report into an interactive tour. Introducing Playwright:
the browser half of the tour is asserted at component level, and adopting a browser harness
is a larger decision than onboarding should make on its own.

**Decisions taken** (plan §14): dashboard tour uses `@floating-ui/react` + our own controller,
not `driver.js` (O6). The wizard prints the `runray.config.json` snippet and never writes
it (O3). `demo` shows the welcome dialog with its own variant, and wizard option 1 serves demo
data with a visible in-app demo banner (O1/O2). `runray setup` stays a wizard branch, not
a command (O4). **Still open for design:** the Windows OpenCode root order — `%APPDATA%` vs
`%LOCALAPPDATA%` vs XDG-on-Windows (O5); all candidates are listed as "checked" either way, so
this affects scan order, not output shape.

## Capabilities

### New Capabilities
- `onboarding-state`: durable per-user onboarding state — the `state.json` file contract
  (location, permissions, atomicity, fault tolerance, privacy constraints) and its
  `GET`/`POST /api/onboarding` HTTP surface, including method/size/key validation and
  degrade-never-block semantics. This is the seam between Track A and Track B in the plan's
  §5, owned by neither the command surface nor the dashboard, and it needs a cross-track
  review per `openspec/project.md`.

  *(Deviation from plan §15, which folds this into the `cli` delta. Split out because a
  persistence-plus-HTTP contract with its own privacy and failure requirements does not
  belong inside a command-surface spec.)*

### Modified Capabilities
- `cli`: first-run banner; the interactive no-data wizard with **exit codes preserved**
  (0 / 1 / 3 unchanged) and its non-TTY guarantee; "where we looked" replacing the static
  no-data hints; setup guides; the demo → own-data bridge; capped next-step hints; and the
  requirement that discovery report its resolved roots with a per-root verdict.
- `visualizer`: welcome dialog with the privacy statement; the dashboard and run tours with
  their a11y contract (focus trap, `Esc`, keyboard navigation, `prefers-reduced-motion`,
  missing-anchor skip); one-shot contextual hints; the reachable empty state with checked
  roots; the export provenance strip; and the hard requirement that **`live === false`
  disables every onboarding surface and emits no onboarding code into the export bundle**.

No `trace-ingestion` or `cost-engine` delta: onboarding reads what discovery already produces
and adds nothing to the trace contract.

## Impact

**`packages/core`** — `discover.ts` returns the resolved root list alongside the existing
`candidatesScanned` / `errors`, with a per-root verdict. No adapter or normalizer change, so
**no golden may move; if a golden moves, the change is wrong.**

**`packages/cli`** — new `onboarding.ts` (prompt loop, guide text) and a state
reader/writer; `program.ts` gains call sites, not logic; `server.ts` gains the two endpoints
behind the existing loopback `Host` guard; `/api/viewconfig` gains the checked-roots list
(live only). New dependency: `@clack/prompts` (~4 kB, zero network, never reaches the
browser bundle).

**`packages/ui`** — new tour controller, welcome dialog, hint primitive, provenance strip,
zustand slice; `data-tour` attributes added at nine existing sites (attributes only, no
restructuring); `vite.export.config.ts` gains the dead-code-elimination constant;
`bundle-guard.test.ts` extended. New dependency: `@floating-ui/react` (~15–20 kB gzipped,
zero network, **live bundle only**). Every UI task is `[UI → /frontend-design]` per CLAUDE.md.

**Schema** — untouched. `TraceFile` gains no onboarding field: this is machine-local user
state, not trace data.

**Dependency posture** — `AGENTS.md` forbids new dependencies without justification; the
founder granted a scoped exception for this feature on 2026-08-10. Both adoptions are
justified in plan §16 and carried into `design.md`, which satisfies the PR-description
requirement. Every other hard rule still binds: no runtime network calls, loopback-only
server, redaction in core, export bundle purity.

**Not affected** — `pricing`, `export`, `diff` and `list --json` gain no interactive
behavior. `export`'s existing redaction consent prompt stays exactly as written.
