# RunRay — Onboarding Plan (CLI + Dashboard)

Status: **proposal, not yet a change.** Written 2026-08-10 against the implementation on
branch `14-featexperience-interactive-user-onboarding-visual-dashboard-tour`.
Implements GitHub issue **#14 — feat(experience): interactive user onboarding & visual
dashboard tour** (`p0-critical-poc`), with four deliberate deviations recorded in §10.

Copy lives in a separate file — this document specifies *behavior, structure and state*;
`docs/12-ONBOARDING-COPY.md` holds every user-visible string. Do not write strings here.

> Issue #14 was authored before the TraceLLM → RunRay rename (commit `388638b`).
> Everything below uses the current names: `runray`, `window.__RUNRAY_*__`,
> `~/.config/runray/`.

---

## 1. Scope

| In scope | Out of scope |
|---|---|
| First-run experience of `runray view` / `demo` / `list` in the terminal | Accounts, signup, login (there are none) |
| No-data recovery path (interactive wizard) | Onboarding e-mail sequences (no addresses, no network) |
| First-run welcome + guided tour in the dashboard | Product analytics / activation dashboards (telemetry is forbidden) |
| Contextual first-time hints for Timeline / Time View / insights / diff | Teaching agent usage itself (we explain RunRay, not Claude Code) |
| Privacy reassurance surface | Paid-tier upsell, team features (v1) |
| Local, per-user onboarding state + its HTTP surface | Changing the exported `report.html` into an interactive tour |
| A "what am I looking at" affordance for exported reports (Sam's path) | Mobile onboarding (dashboard is desktop-first per stylebook) |

---

## 2. What "activated" means here

There is no signup, so the funnel starts at *install* and the only thing that matters is
whether the tool changes a decision. Three gates, in order:

| Gate | Definition | Observable proof | Target |
|---|---|---|---|
| **A0 — Wow** | User understands what RunRay profiles, on *sample* data | Can name one execution bottleneck or wasteful pattern in the demo session unprompted | < 60 s from `npx runray demo` |
| **A1 — Activation** | User profiles **their own** run and identifies an actionable execution bottleneck | Lands on evidence spans for an insight, diagnoses latency in the Time tab, or reviews error triage in the Errors tab | < 3 min from install |
| **A2 — Habit** | User comes back to a second session, or acts on a finding | Second `runray view` on a later day, or a changed delegation/tool/cache pattern they attribute to us | within 7 days |

**The aha moment is A1.** Per `docs/03-PERSONAS.md`, every persona's "wow" test is the same shape:
*point at one bottleneck (latency, failure streak, delegation sprawl, or cost leak) and say "there it is."*
Not "saw a dashboard", not "read a token total" — a user who only reaches a total has not been activated.

**Corollary for the tour:** the tour's single job is to get the user to A1. It walks the user
through four concrete views: delegation trees, clock time, tool errors, and what-if repricing.

**Non-goal:** activating on demo data. `demo` earns attention; it cannot earn activation,
because the trace is not about the user's agent. The demo's success criterion is a
*transition* — the user runs `runray view` afterwards.

---

## 3. Constraints that shape every decision below

These are not preferences; they come from `AGENTS.md`, the specs, the code, and one recorded
founder decision (constraint 2).

1. **No telemetry, ever.** We cannot measure activation in-product. §11 replaces analytics
   with observation. Any proposal to "just count tour completions centrally" is rejected by
   `AGENTS.md` (no runtime network calls).
2. **New dependencies are allowed for this feature** — scoped exception, granted by the
   founder on 2026-08-10: *"for this feature it is ok to introduce a new library if this
   brings value or makes implementation easier or improves UX."* This overrides the default
   `AGENTS.md` posture for onboarding code only. The bar, the evaluated candidates, and the
   two recommended adoptions are in **§16**. Every other hard rule still binds: no runtime
   network calls, offline-only, bundle purity, and the export size budget (constraint 9).
3. **Non-TTY must stay machine-clean.** `runray list --json` and `diff --json` feed
   scripts (persona C) and the future CI gate. The wizard may only run when
   `process.stdin.isTTY && process.stderr.isTTY` — the same test `export` already uses
   (`program.ts:345`). Otherwise: today's hints on stderr and **exit code 3, unchanged.**
4. **The port is not stable.** The server takes `4173` and increments up to 50 times
   (`server.ts:14-16,258-275`). `localStorage` is origin-scoped *including port*, so any
   tour state kept in the browser re-appears whenever the port shifts. Durable state must
   live with the CLI (§8).
5. **Exported HTML must never onboard.** `export` produces a file opened from `file://`,
   often by someone else (persona D, Sam). There is no server, so no `/api/*`; and a tour
   aimed at "your sessions" is nonsense in a report about somebody else's. Detection is
   already free: `loadTraceFile()` returns `live: false` when `window.__RUNRAY_DATA__`
   is present (`lib/load.ts:44-47`). **`live === false` ⇒ tour and welcome permanently off.**
6. **No local filesystem paths in exports.** `export.ts` deliberately strips the pricing
   `path` before injection ("`path` is a local filesystem path and never enters a shareable
   file", `program.ts:418-419`). The no-data screen wants to show *which roots were
   checked* — those roots may be served over `/api/*` in live mode, and must be excluded
   from the export payload for the same reason.
7. **Accessibility is a project standard, not a nicety.** Tour UI must be a native
   `<dialog>`/focus-trapped popover, reachable and dismissible by keyboard, `Esc`-closable,
   with `aria-*` wiring in the shape `HelpSheet.tsx` already uses (`role="dialog"`,
   `aria-modal`, focused close button). Animations: `transform`/`opacity` only, behind
   `motion-safe:` (CLAUDE.md frontend guardrails, and `SavingsPanel.tsx:41` as precedent).
8. **The dashboard is dense on purpose.** The stylebook's pillar is "Invisible UI". A tour
   that dims the whole screen for seven consecutive steps fights the product's own thesis.
   Hence the split tour in §7.
9. **The export bundle is the scarce resource; the live bundle is nearly free.** The single-file
   template (`vite.export.config.ts` + `vite-plugin-singlefile`) is **1,406,294 bytes today**
   against the documented budget of **< 1.5 MB + data** (`05-ARCHITECTURE:122`) — about
   **91 KB of headroom** (163 KiB if the budget is read as binary). The dashboard bundle, by
   contrast, is served from `127.0.0.1` over loopback, so its size costs nothing measurable.
   Since onboarding **never runs in an export** (constraint 5), the governing rule is:
   *onboarding code and its dependencies must be excluded from the export build entirely* —
   see §16.3. This is what makes constraint 2's permission affordable.
10. **The UI has no component library.** `openspec/project.md` lists "shadcn/ui", but
    `packages/ui/package.json` has only `react`, `react-dom`, `zustand`,
    `@tanstack/react-virtual` and fonts. `HelpSheet` and `CommandPalette` are hand-rolled
    dialogs. So there is no Radix, and no `@floating-ui/*` already in the tree — a positioning
    primitive is a genuinely new dependency, and any tour library brings a *second*
    interaction idiom into an app that currently has exactly one. (Worth correcting
    `project.md` separately; it misdescribes the stack.)

---

## 4. Audit of today's first run

Findings are ordered by damage. Each is grounded in current code.

| # | Finding | Where | Impact | Fix |
|---|---|---|---|---|
| F1 | A user with no agent logs gets a wall of stderr text and **exit 3**. It is a dead end: no demo offered, no path to point at a custom directory, no browser opened. | `program.ts:60-66` (`NO_DATA_HINTS`), `program.ts:142-146` | **Critical.** This is the entire first impression for anyone who installs before running an agent — including every evaluator (persona E) who installs on a fresh laptop. | §6.2 wizard |
| F2 | The hint text names two paths but never says **where it actually looked or what it found**. On Windows / `winget` / non-XDG installs the real root differs from the printed guess, and the user cannot tell a wrong path from an empty one. | `program.ts:60-66` vs. real roots in `claude-code.ts:518`, `opencode.ts:817` | **High.** This is persona E's exact failure mode ("the script assumes a specific install path"). | §6.3 |
| F3 | Run #1 and run #100 render identically. `SavingsPanel` opens with two large numbers ("already burned" / "efficiency opportunities") whose distinction is the product's core idea and is explained nowhere in the UI. | `Overview.tsx:236`, `SavingsPanel.tsx:76,96` | **High.** Misreading these two numbers as one number is exactly the "it's another usage counter" bounce. | §7.2, §7.3 |
| F4 | The privacy promise — the strongest reason personas A/C/E adopt at all — appears in `readme.md` and **nowhere in the product**. A user cannot distinguish "sends nothing" from "sends something quietly". | grep: no privacy string in `packages/ui/src` | **High** for client-code users (C, E). | §7.2, §7.6 |
| F5 | `?` (help) and `⌘K` (palette) exist and are unadvertised: the only pointer is a `TopBar` button whose label is `aria-label`-only. `g t` / `g c`, `/`, `j`/`k` are discoverable only *inside* the help sheet you have to know to open. | `App.tsx:116-161`, `TopBar.tsx:67`, `HelpSheet.tsx:12-21` | **Medium.** Power surface, invisible. | §7.3 step 4 |
| F6 | `demo` ends with one line and no bridge. Nothing invites the user to run it on their own sessions — the single most important transition in the funnel (A0 → A1). | `program.ts:477-480` | **Medium-high.** Wasted momentum at the exact moment of peak interest. | §6.4 |
| F7 | `--watch`, `--redact`, `export`, `diff` are only in `--help`. A first-time user who would benefit right now never learns they exist. | `program.ts` option definitions | **Medium.** Depth stays undiscovered; `export` is Sam's whole path into the product. | §6.5 |
| F8 | `EmptyScreen` is well-written but nearly unreachable in live mode: `view` exits at `program.ts:142` before the server ever starts, so `runs.length === 0` in the browser only happens in an empty export or after runs roll off mid-`--watch`. | `StatusScreens.tsx:34-61` vs. `program.ts:141-146` | **Medium.** We wrote the recovery screen and then made it unreachable. | §6.2 (option 4 starts the server anyway) |
| F9 | An exported report has no self-description. Sam opens `report.html` from Slack with no statement of what it is, who generated it, when, or whether prompt text was redacted. | `export.ts` / `injectTraceData`, no provenance strip in UI | **Medium.** The artifact that must be self-explanatory is the one with no explanation. | §7.6 |
| F10 | Unpriced-model and discovery-error warnings hit stderr on first run (`reportUnpricedCoverage`, `reportDiscoveryErrors`) with no first-run framing, so a normal, expected condition reads as a broken install. | `discover.ts` via `program.ts:131-132` | **Low-medium.** Erodes trust in the numbers at the worst moment. | §6.5 note |

---

## 5. Architecture: three surfaces, one state

```
                       ┌──────────────────────────────────────────┐
  terminal             │  SURFACE A — CLI first run               │
  `runray view`  ──▶  banner · no-data wizard · demo bridge   │
                       │  next-step hints                         │
                       └──────────────┬───────────────────────────┘
                                      │ starts server, opens browser
                                      ▼
                       ┌──────────────────────────────────────────┐
  browser (live)       │  SURFACE B — dashboard first run         │
  127.0.0.1:41xx     ──▶  welcome dialog (privacy) · dashboard    │
                       │  tour (4) · run tour (3) · hints         │
                       └──────────────┬───────────────────────────┘
                                      │ GET/POST /api/onboarding
                                      ▼
                       ┌──────────────────────────────────────────┐
                       │  SURFACE C — state                       │
                       │  ~/.config/runray/state.json         │
                       │  (port-independent, per user, local)     │
                       └──────────────────────────────────────────┘

  file:// report.html  ─▶  no surfaces. Static provenance strip only (§7.6).
```

Ownership: Surface A is Track A (data/CLI), Surface B is Track B (experience), Surface C is
the seam and needs a cross-review per `openspec/project.md`.

---

## 6. Surface A — the CLI

### 6.1 First-run banner (`view`, `demo`, `list`)

Printed **once per machine**, gated on `state.json.firstSeenAt` being absent. Three lines
max, on **stderr** (stdout stays a data channel: `list --json` must not gain a banner).
Content: what RunRay read, where, and what it found. Copy: `12-ONBOARDING-COPY.md §3.1`.

Suppressed when: `--json`, non-TTY stderr, `NO_COLOR` (colour only — banner still prints),
or `state.json.firstSeenAt` already set.

### 6.2 The no-data wizard

Replaces the `runs.length === 0` dead end in `view` (F1). **Interactive TTY only.**

```
Guard:  runs.length === 0
        && process.stdin.isTTY === true
        && process.stderr.isTTY === true
        && no explicit [path] argument   ← a wrong explicit path is a user error,
                                           not a discovery failure: print §3.4 and exit 3
Else:   today's behavior — NO_DATA_HINTS (upgraded per §6.3) + exit 3
```

Prompt tree (one keypress or number + Enter; `Esc`/`Ctrl-C`/empty ⇒ option 4):

```
1) Open the demo session               → loadDemoTraceFile() → server → browser → exit 0
2) Show setup guides                   → print §3.5, then re-ask
3) Point at a folder                   → read path → re-scan
                                          ├─ runs found  → server → browser → exit 0
                                          └─ still empty → print §3.6, re-ask (max 3 tries)
4) Exit                                → print §3.7 + exit 3   ← exit code preserved
```

Rules:
- **Exit codes are contract** (`cli` spec: 0 success, 1 error, 3 no data). Option 1 and a
  successful option 3 end in a served dashboard ⇒ `0`. Options 2/4 and exhausted retries
  ⇒ `3`. The wizard never converts "no data" into a silent success.
- Option 3 does **not** persist the path. Writing `dataRoots` into a config file on the
  user's behalf is a side effect they did not ask for; instead print the exact
  `runray view <path>` invocation and the `runray.config.json` snippet (§3.8) so
  the user chooses. *(Open question O3 if a human wants auto-persist.)*
- Option 1 leaves a mark: `state.json.demoSeenAt`, used by §6.4's bridge line.
- New file: `packages/cli/src/onboarding.ts` — the prompt loop, the state reader/writer, and
  the guide text. `program.ts` gains a call, not logic.
- **Mechanism: `@clack/prompts`** (§16.1) — `select` for the menu, `text` for the path,
  `isCancel` for `Ctrl-C`, `note`/`outro` for the guides. Arrow-key selection replaces
  "type a number", which is the actual UX difference. `node:readline/promises` stays for
  `export`'s existing y/N consent — a single confirm does not justify a second idiom there.

### 6.3 "Where we looked" (F2)

`NO_DATA_HINTS` becomes a function of the actual scan, not a static string: list every root
that was checked, with a one-word verdict per root (`missing`, `empty`, `unreadable`), then
the next steps. `buildTraceFile` already returns `candidatesScanned` and `errors`
(`program.ts:131-137`) — this needs the *roots* alongside them, which means
`discover.ts` returning the resolved root list. Copy: `§3.4`.

This is the single highest-leverage change for persona E, and it also makes the difference
between "we looked in the wrong place" and "you have no sessions yet" legible for the
Windows/`winget`/`npm -g` matrix she has to support.

### 6.4 Demo → own-data bridge (F6)

After the demo server line, print one line that names the transition and nothing else
(`§3.9`). If `state.json.demoSeenAt` is already set, the demo is being re-run deliberately —
suppress it.

### 6.5 Next-step hints (F7, F10)

After a **successful first** `view`, print at most two hints, then never again
(`state.json.hintsShown`). Priority order, first two that apply:

| Condition | Hint |
|---|---|
| always | `?` in the dashboard for shortcuts (§3.10a) |
| ≥ 2 runs discovered | `runray diff <a> <b>` (§3.10b) |
| a run is < 10 min old | `--watch` (§3.10c) |
| any insight fired | mention the report artifact `export -o report.html --redact` (§3.10d) |
| unpriced models present | one-line framing of *why* the coverage warning is normal (§3.10e) — **prints in addition**, adjacent to the existing warning, and does not consume a hint slot |

Two is the cap. A wall of tips is the same failure as a wall of hints.

### 6.6 Commands untouched

`pricing`, `export`, `diff`, `list --json` gain no interactive behavior. `export`'s existing
redaction consent prompt is already the right pattern and stays as is.

---

## 7. Surface B — the dashboard

### 7.1 Gating

```ts
show = live === true                       // lib/load.ts: not an export
    && onboarding.welcomeDismissedAt == null
    && traceFile.runs.length > 0           // zero runs → EmptyScreen owns the screen
    && !prefersReducedMotion ? full tour : tour with instant step transitions
```

Render **after** the onboarding state fetch resolves, never before — a welcome dialog that
flashes and disappears is worse than none. The existing `LoadingScreen` already covers that
window (`App.tsx:169-173`).

### 7.2 Welcome dialog — one screen, three sentences, two buttons

Native `<dialog>`, focus-trapped, `Esc` = skip. Contains:
- what RunRay just read (run count, date span) — concrete, from `traceFile`;
- **the privacy line** (F4), stated as fact with the mechanism, not as a slogan;
- primary `Show me around` (starts the dashboard tour) / secondary `I'll explore myself`.

Both buttons `POST /api/onboarding` with `welcomeDismissedAt`; the secondary also marks
`tours.dashboard = "skipped"`. Copy: `§4.1`.

### 7.3 Dashboard tour — 4 steps

Anchored popovers (not full-screen dim), one per screen region, in reading order. Each:
title ≤ 60 chars, body ≤ 180 chars, `1 / 4` counter, `Back` / `Next` / `Skip tour`,
arrow-key and `Tab` navigable.

**Mechanism: `@floating-ui/react` for anchoring, our own step controller** (§16.2). The
popover markup, tokens, motion and focus behavior stay ours — the library only answers "where
does this box go, and does it flip". The spotlight is one absolutely-positioned element with a
large spread `box-shadow`; it needs no library at all.

| Step | Anchor | Teaches | Why it earns a step |
|---|---|---|---|
| 1 | `SavingsPanel` two figures | **burned** (already spent, unrecoverable) vs **opportunity** (changeable setup) | F3 — the core idea; misreading this is the bounce |
| 2 | `Overview` spend trend + `ToolRankCard` | where the money went across all runs, and that every element is a filter | turns the dashboard from a poster into an instrument |
| 3 | `SessionsTable` row | a row is a *run*; clicking it opens the forensic views | the only route to A1 |
| 4 | `TopBar` help button | `?` for shortcuts, `⌘K` for the palette | F5, and it ends the tour on a self-service note |

Completion writes `tours.dashboard = "completed"` and shows the completion line (`§4.3`) —
which is not a celebration, it is a pointer at the next action: open a run.

**The tour never navigates for the user.** Force-navigating a first-time user is how tours
become hostile; the run-level material is taught in situ instead:

### 7.4 Run tour — 4 steps across profiler views

First time a run view opens (`route.view` ∈ `timeline|cost|time|errors|waste` and
`tours.run` unset), offer a 4-step tour:

| Step | Anchor | Teaches |
|---|---|---|
| 1 | `Waterfall` rows | **Nesting & lanes**: nesting = subagent delegation; lanes = parallel tool execution |
| 2 | `Time` tab | **Where time went**: clock time split between model thinking and tool wait |
| 3 | `Errors` tab | **Normal errors vs bugs**: failures grouped by actor (agent exploring vs broken tools) |
| 4 | `InsightsStrip` / `WhatIf` | **Findings & What-If**: targeted findings and simulation of cheaper models |

Offered as a small non-modal prompt (`§4.4a`), not an auto-starting overlay: the user
arrived here with an intention, and hijacking it is hostile.

Step 4 is the activation gate. It performs the activation — selecting a finding to highlight
evidence or inviting a What-If repricing simulation.

### 7.5 Contextual first-time hints

One-shot, dismissible, at most one visible at a time, keyed in
`onboarding.hints[]`. These carry the long tail so the tours can stay short.

| Key | Trigger | Subject |
|---|---|---|
| `time-view` | first `#/run/:id/time` | wall-clock ≠ sum of spans; where the waiting was |
| `errors-view` | first `#/run/:id/errors` | error triage by actor; agent exploration vs bugs |
| `waste-view` | first `#/run/:id/waste` | burned spend vs potential savings under new settings |
| `what-if` | first `CostView` with `WhatIfPanel` visible | re-price the run against another model |
| `diff` | second run opened in a session | compare two runs of the same task |
| `limit-mode` | `limitWindow` configured and first dashboard | tokens / % of limit instead of USD (persona B) |
| `coverage` | first `CoverageNotices` render | unpriced models are surfaced, never silently priced |
| `redact` | first `export` opened from the UI, if any | `--redact` before sharing |

Hint state may live in `localStorage` (unlike the tours): re-showing a one-line dismissible
hint after a port change is a shrug; re-showing a tour is an insult. Documented trade-off,
not an oversight.

### 7.6 Two states that are not tours

- **Empty state (F8).** `EmptyScreen` stays as written, and becomes *reachable*: wizard
  option 4 (and a future `--serve-empty`) start the server with zero runs so the browser can
  explain itself. Extended with the checked-roots list from §6.3, delivered over
  `/api/viewconfig` (live only, **never** in exports — constraint 6).
- **Export provenance strip (F9).** When `live === false`, render a single static line at the
  top of the shell: what this file is, when it was generated, by which version, redacted or
  not, and that it is read-only. No dialog, no dismiss, no state. This is Sam's entire
  onboarding, and its job is to make him ask for the team version unprompted
  (internal validation checklist). Copy: `§4.6`.

### 7.7 First run checklist

A lightweight, collapsible, non-modal checklist docked in the UI for new users:
- Step 1: `[x] Found agent logs on disk` (Pre-completed at 25% progress).
- Step 2: `[ ] Check subagents and lanes in Timeline`.
- Step 3: `[ ] See where time went in Time view`.
- Step 4: `[ ] Check tool errors or test What-If repricing`.

Milestones update reactively upon user navigation. The checklist is permanently dismissible
at any point, persists in `state.json.onboarding.checklist`, and is excluded from exports.

---

## 8. Surface C — state, endpoints, security

### 8.1 File

`~/.config/runray/state.json`, honouring `$XDG_CONFIG_HOME`, and `%APPDATA%\runray\`
on Windows. Created lazily, `0600`, written atomically (tmp + rename) — two dashboards on
two ports may write concurrently.

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

Unknown keys are preserved on write; a malformed or unreadable file is treated as absent and
**never** fatal (an onboarding file must not be able to break `view`). No paths, no project
names, no prompt text ever enter this file — it is not sensitive, and it stays that way.

### 8.2 Endpoints

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/onboarding` | current onboarding block; `{}` when the file is absent |
| `POST` | `/api/onboarding` | shallow-merges a small JSON patch, returns the merged block |

Hardening, on top of the loopback `Host` guard already in `server.ts:169-172`:
reject any method but GET/POST (405); cap the body at 4 KB; accept only the known keys and
value shapes (drop the rest silently); never echo a filesystem path; `cache-control:
no-store` like every other endpoint. A write failure returns 200 with the in-memory state —
onboarding must degrade, never block.

### 8.3 Two deviations from issue #14's mechanism, and why

**(a) A fetched endpoint, not injected HTML.** Issue #14 proposes injecting
`window.__RUNRAY_ONBOARDED__` into `index.html` "following the existing pattern used for
`__RUNRAY_PRICING__`". That pattern does not exist on the live path: in `view`/`demo`,
pricing and view-config are **endpoints** (`server.ts:182-194`) that the UI fetches
(`lib/load.ts:64-89`); injection happens only in `export` (`program.ts:420-430`). `server.ts`
serves the UI with a plain static file server (`serveStatic`, `server.ts:121-140`) that reads
and streams bytes — injecting would mean parsing and patching HTML per request. So:
`GET /api/onboarding` matches the real live-mode pattern, needs no HTML rewriting, and is
symmetric with the POST. Exports need no flag at all, because `live === false` already
disables everything (constraint 5).

**(b) `POST /api/onboarding` with a patch, not `POST /api/onboarded` with a boolean.** One
boolean cannot express "welcome dismissed, dashboard tour done, run tour not offered yet,
two hints seen" — and §7.4/§7.5 need exactly that. One endpoint, small patches.

---

## 9. Anchor map

Tour steps need stable anchors. Add `data-tour="<key>"` at these existing sites — attributes
only, no restructuring:

| Key | File | Site | Used by |
|---|---|---|---|
| `savings` | `components/SavingsPanel.tsx` | `<section aria-label="Potential savings">` (`:39`) | dashboard 1 |
| `overview-trend` | `components/Overview.tsx` | spend-trend block | dashboard 2 |
| `tool-rank` | `components/ToolRankCard.tsx` | card root (`:34` region) | dashboard 2 |
| `sessions-table` | `components/SessionsTable.tsx` | first `<tbody>` row | dashboard 3 |
| `help-button` | `components/TopBar.tsx` | help button (`:67`) | dashboard 4 |
| `waterfall` | `components/Waterfall.tsx` | rows container | run 1 |
| `spend-spine` | `components/SpendSpine.tsx` | gutter root (`:30`) | run 2 |
| `insights-strip` | `components/InsightsStrip.tsx` | strip root (`:18`) | run 3 |
| `nav` | `components/SideNavBar.tsx` | `#/dashboard` / `#/sessions` links (`:28,:54`) | welcome (optional) |

Anchor resolution must tolerate a missing node — a step whose anchor is absent (a run with no
insights, a filtered-empty table) is **skipped**, and the counter reflects the reduced total.
An onboarding tour that points at nothing is worse than no tour.

---

## 10. Deliberate deviations from issue #14

| # | Issue #14 says | This plan does | Why |
|---|---|---|---|
| D1 | One tour, 7 steps, spanning nav → dashboard → sessions → run views | Two tours: 4 steps on the dashboard, 3 in a run view, triggered in place | A 7-step tour must force-navigate across routes (`#/dashboard` → `#/sessions` → `#/run/:id/…`), which hijacks the user and breaks on any run without insights. 3-5 steps per screen is the ceiling that survives contact. |
| D2 | Inject `window.__TRACELLM_ONBOARDED__` into `index.html` per the pricing pattern | `GET /api/onboarding`, no HTML rewriting | The cited pattern is export-only; live mode uses endpoints and a byte-streaming static server (§8.3a). |
| D3 | `POST /api/onboarded` writing `{"onboarded": true}` | `POST /api/onboarding` accepting a small patch | One boolean cannot carry per-tour and per-hint state (§8.3b). |
| D4 | Privacy promise as its own modal | Privacy line inside the single welcome dialog + one line in the export strip | Two modals before any data is a worse first impression than the thing they reassure about. Same message, no extra gate. |

Everything else in #14 — the CLI wizard, the option list, demo as the recommended branch,
`<dialog>` for a11y, `OnboardingTour.tsx`, store state, root-level integration — is adopted
as written.

---

## 11. Measuring this without telemetry

We cannot instrument activation, and we will not. What replaces it:

1. **Timed observation with the beta cohort.** One task, screen
   shared, stopwatch: install → first insight-evidence click. That number *is* A1, measured
   once per user, and it is the only trustworthy figure we will have.
2. **The scripted first-run walkthrough** in the beta protocol: no help from us for the
   first three minutes; every question the user asks aloud is a copy defect logged against
   `12-ONBOARDING-COPY.md`.
3. **Local, user-owned state.** `state.json` timestamps make time-to-activation
   *reconstructable by the user*, who may choose to paste it. Never collected, never
   requested automatically.
4. **Proxy signals we already get for free:** issues/questions containing "no sessions
   found" (F1/F2 regression alarm), unprompted requests for a team/CI version (the
   core validation metric — and Sam's whole reason to exist in §7.6), and the
   ratio of `demo` mentions to `view` mentions in beta feedback (the A0 → A1 bridge, §6.4).
5. **Targets, stated as observational goals, not dashboards:** 4 of 5 beta users reach A1
   unaided in under 3 minutes; 0 of 5 exit at F1's dead end; ≥ 1 asks for the team version
   unprompted.

There is no e-mail sequence, because there are no addresses and no network. Its function —
bringing a stalled user back — is served by the terminal instead: the next-step hints (§6.5)
fire on the *user's* next invocation, which is the only re-engagement channel a local-first
tool legitimately has.

---

## 12. Rollout

Six phases, each independently shippable and independently valuable. Phase 1 alone fixes the
worst finding; if the change is cut short after phase 3, the product is still strictly better
than today.

| Phase | Work | Package | Fixes | Ship gate |
|---|---|---|---|---|
| 1 | `state.json` reader/writer (XDG + `%APPDATA%`, atomic, fault-tolerant); `GET`/`POST /api/onboarding` | `cli` | infra | unit + server tests, malformed-file test |
| 2 | Discovery roots surfaced; `NO_DATA_HINTS` → "where we looked" | `cli`, `core` | F2, F10 | snapshot test per platform shape |
| 3 | `onboarding.ts` wizard + `view` integration; first-run banner; demo bridge; next-step hints — **adds `@clack/prompts`** (§16.1) | `cli` | F1, F6, F7, F8 | TTY and non-TTY tests; **exit codes unchanged** |
| 4 | `OnboardingTour.tsx`, store slice, welcome dialog, dashboard tour (4), `data-tour` anchors — **adds `@floating-ui/react`** (§16.2) + the export-exclusion build gate and guard markers (§16.3) | `ui` | F3, F4, F5 | store unit tests, a11y (focus trap, `Esc`, reduced motion), missing-anchor skip, **bundle-guard green** |
| 5 | Run tour (3) + contextual hints | `ui` | F3 depth | same, plus "never in export mode" test |
| 6 | Export provenance strip | `ui` | F9 | renders under `live === false`, contains no filesystem path |

The exclusion gate (§16.3) ships **in the same commit as the first UI dependency**, never
after it. A phase 4 that adds `@floating-ui/react` without the build gate silently spends the
export budget, and the next person to notice is a user opening a 1.4 MB report.

Definition of done, per `AGENTS.md`: `pnpm lint && pnpm typecheck && pnpm test` green,
goldens unchanged (this change touches no adapter output — **if a golden moves, the change is
wrong**), no schema drift. `TraceFile` gains **no** onboarding field: onboarding state is
machine-local user state, not trace data, and the schema is frozen.

Every UI task above is a `[UI → /frontend-design]` task per CLAUDE.md.

---

## 13. Test plan

**CLI**
- no data + TTY → wizard appears; each branch's exit code (1→0 on served, 2→3, 3 found→0,
  3 exhausted→3, 4→3).
- no data + **non-TTY** → byte-identical stderr hints and exit 3; `list --json` prints `[]`
  and nothing else. Regression guard for the CI gate.
- explicit wrong `[path]` → no wizard (user error, not discovery failure).
- banner prints once, never twice; never on stdout; absent under `--json`.
- unreadable / malformed / read-only `state.json` → `view` still works.
- `demo` bridge appears once, suppressed on re-run.

**UI**
- `live === false` (`window.__RUNRAY_DATA__` set) → no welcome, no tour, no fetch to
  `/api/onboarding`, provenance strip present.
- `GET /api/onboarding` 404/failure → onboarding silently off, dashboard unaffected.
- port change does not resurrect a completed tour (the whole reason for §8).
- keyboard-only pass: welcome → all 4 steps → completion, plus `Esc` at every step.
- `prefers-reduced-motion` → no transitions, tour still fully usable.
- missing anchor → step skipped, counter total reduced, tour completes.
- zero runs → `EmptyScreen`, never a tour.
- anchor inside the virtualized waterfall scrolled out of view → step scrolls it into view or
  is skipped; never a popover pinned to a recycled row.

**Bundles (§16.3)**
- `bundle-guard.test.ts` extended: `dist-export/index.html` contains no `@floating-ui`, no
  `data-tour`, no `/api/onboarding`.
- `dist-export/index.html` stays under 1.5 MB (1.34 MB today).
- the tour is a separate chunk in the live build, absent from the initial chunk.

**End-to-end.** There is **no browser-automation harness in this repo** — the existing
`*-e2e.test.ts` files in `packages/cli` drive the real CLI and local server under vitest, with
no browser. So:
- CLI-level e2e follows that pattern: first run in a temp `XDG_CONFIG_HOME` → wizard branch →
  server up → `GET /api/onboarding` reflects the written state → second run is silent.
- The browser half (welcome → tour → completion → reload → nothing re-appears) is asserted at
  component level with the store, **not** end-to-end, unless this change also introduces
  Playwright. Introducing it is a larger decision than onboarding should make on its own —
  flag it rather than smuggling a browser harness in as a sub-task.

---

## 14. Open questions for a human

| # | Question | Why it needs a decision | Default if unanswered |
|---|---|---|---|
| O1 | Does the welcome dialog appear on `demo` too, or only on `view`? | Demo is the front door for evaluators, but the welcome talks about "your sessions". | Yes, with demo-specific first line (§4.1b) |
| O2 | Is a *first* `runray view` allowed to open the browser on a wizard-selected demo, or should demo stay explicit? | Blurring "your data" and "sample data" is the one confusion we cannot afford. | Open it, with the demo banner visible in-app |
| O3 | Should wizard option 3 offer to persist the folder to `runray.config.json`? | Writing config on a user's behalf is a side effect; not writing it costs a step every run. | Do not persist; print the snippet |
| O4 | Does `runray setup` become a real command (standalone setup guide), or stay a wizard branch? | Adds CLI surface and therefore spec surface. | Wizard branch only |
| O5 | Windows OpenCode root: `%APPDATA%` vs `%LOCALAPPDATA%` vs XDG-on-Windows? | Persona E's exact failure mode; affects §6.3 output. | List all candidates as "checked" |
| O6 | Tour mechanism: `@floating-ui/react` + our controller, or `driver.js` outright? | ~15 kB and full token/motion control vs. a few days of velocity and a borrowed visual language (§16.2). Reasonable people differ. | floating-ui + our controller |

Per `AGENTS.md`, O3 and O5 touch discovery/privacy behavior — flag rather than assume.
O6 is a taste-and-velocity call, not a correctness one; either answer ships a good tour.

---

## 15. Promotion path to an openspec change

This document is planning material. To become work, it needs
`openspec/changes/add-onboarding-experience/` with:

- `proposal.md` — §2 (activation), §4 (audit), §12 (phases);
- `design.md` — §5, §7, §8, **§16** (state, endpoints and dependencies are the
  design-decision surface: D2/D3 and the two adoptions are ADR-shaped and belong here — the
  dependency justifications also satisfy `AGENTS.md`'s PR-description requirement);
- `specs/cli/spec.md` delta — first-run banner, wizard, exit-code preservation, non-TTY
  behavior, "where we looked" output;
- `specs/visualizer/spec.md` delta — welcome, both tours, hints, export-mode suppression,
  provenance strip, a11y requirements;
- `tasks.md` — §12's phases, one task per commit, UI tasks marked `[UI → /frontend-design]`.

No `trace-ingestion` or `cost-engine` delta: onboarding reads what discovery already
produces and adds nothing to the trace contract.

---

## 16. Dependency decisions

Constraint 2 grants a scoped exception to `AGENTS.md`'s no-new-dependency posture for
onboarding code. This section is the justification record that `AGENTS.md` still requires in
the PR description — one line per dependency, plus the check that it pulls in no runtime
network access.

### 16.0 The bar

A dependency earns its place here only if all five hold:

1. **It removes real work or real risk** — positioning maths, focus management, terminal
   raw-mode handling. Not "it's nicer".
2. **Zero network at runtime.** No telemetry, no update check, no font/CDN fetch. Verified by
   reading the package, not by trusting the readme.
3. **It cannot reach the export bundle** (constraint 9) — or it is small enough to fit the
   ~91 KB headroom, which nothing in this section attempts.
4. **It does not own our markup, tokens, or motion.** The design guardrails in CLAUDE.md are
   binding; a library that ships its own visual language would have to be fought, and fighting
   it costs more than the code it saved.
5. **ESM, TypeScript types, MIT-compatible, actively maintained, no native modules.**

### 16.1 CLI — adopt `@clack/prompts`

| | |
|---|---|
| **Verdict** | **Adopt** for `packages/cli` (phase 3) |
| **Justification** | Arrow-key `select`, `text` with validation, and first-class cancel (`isCancel`) for the no-data wizard. Hand-rolling a raw-mode selection loop over `node:readline` is ~120 lines of terminal edge cases (arrow escape sequences, `Ctrl-C`, redraw, Windows) for a worse result. |
| **Size** | ~4 kB gzipped; irrelevant regardless — this is an npm CLI, not a browser bundle, and it never reaches `packages/ui`. |
| **Network** | None. |
| **Alternatives rejected** | `@inquirer/prompts` — larger, plugin/rendering-engine surface we do not need. `prompts` — thin but effectively unmaintained. `enquirer` — CJS-leaning, awkward in an ESM-only repo. `chalk` — unnecessary; clack brings `picocolors`, which honours `NO_COLOR`. |
| **Residual risk** | Clack renders its own frame/glyphs, so §3's copy must read correctly inside it, and CI (non-TTY) must never reach it — already guaranteed by the `isTTY` gate in §6.2. |

### 16.2 UI tour — adopt `@floating-ui/react`, hand-roll the controller

| | |
|---|---|
| **Verdict** | **Adopt the positioning primitive; do not adopt a tour framework** (phases 4-5) |
| **Justification** | The genuinely hard part of an anchored tour is placement: flip, shift, collision with the viewport, scroll-into-view, and re-measure on resize — inside a virtualized waterfall (`@tanstack/react-virtual`) where the anchor may not be mounted. That is exactly floating-ui's job. The remaining ~150 lines (step index, keyboard, focus trap, persistence) are ours anyway, because the state lives on the server (§8). |
| **Size** | ~15-20 kB gzipped in the live bundle, which costs nothing over loopback (constraint 9). **Zero in the export bundle**, per §16.3. |
| **Network** | None. |
| **Also considered** | **`driver.js`** — genuinely good: ~5 kB gzipped, zero deps, TypeScript, MIT, and it would deliver the tour fastest. Rejected on three counts: it owns the overlay DOM, its own CSS variables and its own animation model (colliding with the token system and the `transform`/`opacity`-only motion rule); step content is HTML strings, so our React formatters and `SeverityPill` cannot be reused inside steps; and it introduces a second dialog idiom beside the hand-rolled `HelpSheet`/`CommandPalette` (constraint 10). Note also that its GitHub home appears to have moved orgs — **verify the publisher and the repo↔npm link before adding it** if this decision is revisited. **`react-joyride`** — heavier, historically fussy under React 18 concurrency. **`@reactour/tour`**, **`shepherd.js`** — same "brings its own look" objection, larger. **Hand-rolled positioning** — viable, but re-implementing collision detection against a virtualized list is precisely the risk worth paying 18 kB to delete. |
| **Residual risk** | One more dependency in the dashboard's dependency graph. Mitigated by §16.3's exclusion test: if it ever shows up in an export, CI fails. |

Recorded as **O6** in §14: this is a judgment call trading ~15 kB and full visual control
against a few days of velocity. A human may legitimately prefer `driver.js`.

### 16.3 The exclusion rule (this is the load-bearing part)

Onboarding code and both dependencies must be **absent from `dist-export/index.html`**, not
merely inert in it. Two builds already exist (`vite.config.ts`, `vite.export.config.ts`), so:

1. Gate every onboarding entry point behind a build-time constant — e.g.
   `define: { __RUNRAY_ONBOARDING__: 'false' }` in `vite.export.config.ts` — so Rollup
   dead-code-eliminates the whole subtree, imports included. A runtime `if (live)` is **not**
   sufficient: the module still gets bundled.
2. Load the tour through `React.lazy()` / dynamic `import()` in the live build too, so it
   stays out of the initial chunk and off the first-paint path of a returning user.
3. **Enforce it in `bundle-guard.test.ts`** — the mechanism is already there. Add markers to
   `FORBIDDEN` so an export containing them fails CI:

   | Marker | Why |
   |---|---|
   | `@floating-ui` | positioning lib leaked into a shareable report |
   | `data-tour` | tour anchors/controller leaked into a shareable report |
   | `/api/onboarding` | live-mode endpoint string leaked into a `file://` artifact |

   That third marker is worth as much as the size guard: it proves an exported report cannot
   even *describe* a call to a local server it will never have.
4. Keep the budget honest: assert `dist-export/index.html` stays under 1.5 MB in the same
   test. The template is at 1.34 MB today; a silent breach would be discovered by a user on
   Slack, not by us.

### 16.4 Not adopted

| Considered | Why not |
|---|---|
| `boxen` / `cli-boxes` for the CLI banner | The banner is three lines; a box is noise against the stylebook's density pillar, and clack's `note` already frames text if needed. |
| `ora` (spinners) | Clack ships one; discovery is fast enough that a spinner mostly flashes. |
| `conf` / `env-paths` for `state.json` | ~20 lines of `node:path` + `node:os` covers XDG and `%APPDATA%`, and we want exact control over atomic writes and fault tolerance (§8.1). A config library that throws on a malformed file is a liability here. |
| `zod` for the POST body | Already a workspace dependency via `packages/schema`, so it is available if wanted — but the patch is 4 keys with fixed shapes, and §8.2 drops unknown keys silently. Use it only if the endpoint grows. |
| Any analytics/tour-hosting SaaS (Userflow, Appcues, Intercom tours) | Categorically excluded: they are network calls and telemetry, which `AGENTS.md` forbids outright. The exception in constraint 2 covers libraries, not services. |

---

## References

- GitHub issue #14 — `feat(experience): interactive user onboarding & visual dashboard tour`
- `docs/03-PERSONAS.md` — testing lenses that define "wow" vs "meh" per persona
- `docs/12-ONBOARDING-COPY.md` — every string referenced as `§x.y` above
- `docs/05-ARCHITECTURE.md` §3 — CLI surface and exit codes
- `AGENTS.md` — no telemetry, privacy in core, frozen schema; its no-new-dependency rule is
  scoped-out for this feature by constraint 2, with the justification record in §16
- `packages/ui/src/bundle-guard.test.ts` — the enforcement point for §16.3
