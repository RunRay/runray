# RunRay — Onboarding Copy

Companion to `docs/11-ONBOARDING-PLAN.md`. That document owns behavior and state; this one
owns **every user-visible string** in the onboarding path. Section numbers here are the
`§x.y` references used there.

Status: **draft for review.** Nothing here is implemented yet. Strings are final-intent, not
placeholders — implement them verbatim, and change them here first if they need to change.

---

## 1. Voice

The dashboard's existing copy already sets the register (`StatusScreens.tsx`: *"direct copy,
next step, no apology"*). Extended for onboarding:

| Rule | Do | Don't |
|---|---|---|
| State the fact, then the next action | "No agent sessions found. Checked: …" | "Oops! We couldn't find anything 😔" |
| Second person, present tense, indicative | "Open a row for the forensics." | "You can open a row if you'd like to see…" |
| Numbers are evidence — always concrete | "14 sessions from 3 projects" | "lots of sessions" |
| Commands in mono, exactly as typed | `runray view <path>` | "run the view command" |
| Never apologise for correct behavior | "Unpriced models are listed, never guessed." | "Sorry, we couldn't price…" |
| Explain the *why* once, never twice | (one clause) | a paragraph of reassurance |
| Sentence case everywhere, including buttons | "Show me around" | "Show Me Around" |
| Direct punctuation, no em-dashes | "Burned from retries and dead ends." | "gone — retries and dead ends" |

**Banned:** exclamation marks · emoji · "Oops" · "Sorry" · "Simply" / "Just" · "easy" ·
"Welcome aboard" · "Let's get started" · "powerful" · "AI-powered" · "seamless" ·
"revolutionary" · any praise of the product inside the product.

**Length budget:** tour step title ≤ 60 chars · tour body ≤ 180 chars · hint ≤ 120 chars ·
CLI line ≤ 80 chars.

---

## 2. Lexicon

Fix these once; inconsistency here reads as two products.

| Concept | User-facing word | Notes |
|---|---|---|
| One agent execution | **session** in prose, **run** in ids/CLI args | Glossary defines Run as one agent session; users recognise "session", scripts take run ids. `runray diff <runA> <runB>`, "14 sessions". |
| Money already lost | **burned** | Never "wasted" in the UI — "wasted" blames the user; "burned" describes the event. Retries, cache breaks, dead ends. |
| Money a change would save | **opportunity** / "would have saved" | Always conditional. Never "you could save" as a promise. |
| Cumulative-cost gutter | **burn line** (Spend Spine internally) | `HelpSheet` already ships "Burn line as data" — match it. |
| Parallel span rows | **lanes** | Say once that lanes mean genuinely parallel, not layout. |
| Findings | **findings** in prose, **insights** as the feature name | "12 rules", "a finding with evidence". |
| Prompt-stripping | **redacted** | Never "anonymised" (we do not anonymise, we strip). |
| Local-only | **stays on this machine** | Concrete mechanism, never the word "secure". |
| The bundled sample | **sample session** | Never "fake" or "dummy" data — it is scrubbed real structure. |

---

## 3. CLI copy

All onboarding output goes to **stderr**. stdout stays a data channel. Colour only when
`process.stderr.isTTY && !process.env.NO_COLOR`; every string below must read correctly with
zero colour.

**Rendering note.** The wizard is built with `@clack/prompts` (plan §16.1), which draws its
own left-hand gutter, symbols and dim hint text. Consequences for the copy:
- Option **labels** carry the verb; option **hints** (dim, after the label) carry the
  qualifier. Do not write a label that only makes sense with its hint.
- Clack owns the question glyph and the cancel line — do not write "?" prefixes or
  "Press Ctrl-C to quit".
- Everything below must still read correctly unstyled: `picocolors` honours `NO_COLOR`, and
  the non-interactive path (§3.4) never goes through clack at all.

### §3.1 First-run banner

Printed once per machine (`state.json.firstSeenAt` absent), before the result line.

```
RunRay 0.1.0. Local agent profiler, first run. Nothing leaves this machine.
Read 14 session(s) from 2 location(s). Pricing: bundled snapshot 2026-07-01.
```

Rules: real counts, never rounded. Version from `cliVersion()`. Second line omitted when the
run has no data (§3.4 covers that case instead).

### §3.2 Success line (existing, unchanged)

```
RunRay viewing 14 run(s) at http://127.0.0.1:4173/
```

Kept verbatim — it is already correct, and scripts may match it.

### §3.3 Wizard prompt

Shown when discovery finds nothing on an interactive terminal (plan §6.2). A clack `select`,
so the user arrows and hits Enter — there are no numbers to type.

**Intro:**
```
RunRay: no agent sessions found in the standard locations.
```

**Question:**
```
What would you like to do?
```

**Options** — `label` then `hint`:

| label | hint |
|---|---|
| `Open the sample session` | `recommended, nothing to install` |
| `Show setup guides` | `Claude Code · OpenCode · OTLP` |
| `Point at a folder` | `logs live somewhere else` |
| `Open the dashboard anyway` | `empty, but it explains itself` |
| `Exit` | `show me where you looked` |

Selection is pre-set to the first option — the recommended path should need one keypress.

**Path question** (option 3), a clack `text`:
```
Message:      Folder or session file
Placeholder:  ~/projects/my-app/.agent-logs
```
Validation, on empty input: `Enter a path, or press Escape to go back.`

**Cancel** (`Ctrl-C` / `Escape` at the select) — clack's own cancel line, then §3.4 and
exit 3. Do not add a farewell of our own.

Invalid input has no copy: a `select` cannot produce one, which is most of the reason to use
one.

### §3.4 "Where we looked" (replaces `NO_DATA_HINTS`)

Printed non-interactively, and after wizard option 4. Verdict per root is one word:
`empty` (exists, no sessions) · `missing` (no such directory) · `unreadable` (permissions).

```
No agent sessions found.

Checked:
  ~/.claude/projects                                    missing
  ~/.local/share/opencode                               missing

RunRay reads logs coding agents already write. There is nothing to set
up. Two ways forward:

  Run any agent session once, then:   runray view
  Logs live somewhere else:           runray view <path>

No agent sessions on this machine? Try the sample session:  runray demo
```

Notes for the implementer:
- Paths are printed `~`-abbreviated. Terminal output may show local paths; **exported HTML
  may not** (plan constraint 6).
- One line per root actually checked, in scan order. If `--source` narrowed the scan, add:
  `(scan limited to --source claude)` under the list.
- `unreadable` roots get one extra line after the list:
  `One location could not be read. Check permissions, or pass the folder directly.`

### §3.5 Setup guides (wizard option 2)

```
Claude Code
  Nothing to configure. Any session writes JSONL under ~/.claude/projects.
  Run:  claude "explain this repo"     then:  runray view

OpenCode
  Nothing to configure. Sessions land in ~/.local/share/opencode. RunRay reads
  both the legacy file storage and the newer SQLite store.
  Installed somewhere non-standard? runray view <that folder>

Other agents (Cursor, custom pipelines)
  No on-disk session logs to read. Export OTLP/JSON with an OTel Collector
  file exporter, then:  runray view <that file>

All three are read locally. RunRay makes no network calls.
```

### §3.6 Custom path found nothing (wizard option 3)

```
Nothing readable in <path>.

Expected one of: Claude Code JSONL, an OpenCode store, or OTLP/JSON.
Try the parent folder, or a single session file directly.
```

After the third attempt, stop asking and fall through to §3.4 + exit 3.

### §3.7 Wizard exit (option 4)

Prints §3.4, then:

```
No configuration was written.
```

That last line matters: the user just declined a wizard, and the one thing they want to know
is whether it left anything behind. (It leaves `state.json`; the line refers to *config and
project files*.)

### §3.8 Config snippet (after a successful custom path)

```
To run this again:  runray view <path>

To make this the default, add to runray.config.json:

  { "dataRoots": ["<path>"] }
```

Printed, never written. Writing config on the user's behalf is a side effect they did not
request (plan O3). Both lines are required: the `cli` spec's custom-path requirement asks for
the equivalent invocation *and* the snippet, because a user who does not want a config file
still needs the one command that repeats what just worked.

### §3.9 Demo → own data bridge

After the demo server line, once (`state.json.demoSeenAt` absent):

```
This is a scrubbed sample session, not your data.
When you've run an agent on this machine:  runray view
```

### §3.10 Next-step hints

At most two, after the first successful `view` (plan §6.5). Each is one line plus its
command, indented.

**a. Shortcuts** — always eligible, first priority:
```
In the dashboard: ? for shortcuts, ⌘K (Ctrl-K) for the command palette.
```

**b. Diff** — when ≥ 2 sessions were discovered:
```
Same task twice? Compare them:  runray diff <runA> <runB>
```

**c. Watch** — when a session is less than 10 minutes old:
```
Session still running? Live-tail it:  runray view --watch
```

**d. Export** — when at least one finding fired:
```
Share a finding without sharing prompts:
  runray export -o report.html --redact
```

**e. Coverage framing** — prints next to the existing unpriced-model warning and does
**not** consume a hint slot:
```
Unpriced models are listed, never guessed — their spans show tokens without
a dollar figure. Refresh prices with:  runray pricing --refresh
```

**f. Contained-failure framing** — prints next to the existing per-candidate discovery
errors and does **not** consume a hint slot. One session failing to parse is expected — a
locked OpenCode database, a half-written import — and on a first run it reads as a broken
install unless we say otherwise:
```
The session(s) above could not be read; the other N loaded normally. A locked
database or a partly written file is skipped, never guessed at.
```
`N` is the real count of runs that did load. Singular/plural per the actual numbers; no
apology (§1) — this is correct behavior being described, not a failure being excused.

---

## 4. Dashboard copy

### §4.1 Welcome dialog

Never rendered in an exported report (plan constraint 5).

**Title** (display face):
```
14 sessions were already on this machine.
```
Count from `traceFile.runs.length`. Singular form: `One session was already on this machine.`

**Body:**
```
RunRay read the logs Claude Code and OpenCode already wrote.
Inspect execution time, stalled tools, and subagent branches.
It requires no collector or account.
```

**Privacy line** (own block, quieter type, the mechanism *is* the reassurance):
```
Everything stays local. No network calls or telemetry; this dashboard runs
on 127.0.0.1 for this browser only.
```

**Buttons:**
```
[ Show me around ]    [ I'll explore myself ]
```

Dialog `aria-label`: `Welcome to RunRay`. `Esc` behaves as the secondary button.

#### §4.1b Demo variant

On `runray demo`, replace title and body; keep the privacy line and buttons:

```
Title:  A sample session, scrubbed and bundled.
Body:   Real structure, no real prompts or paths. Everything below works the
        same on your own sessions when you run "runray view".
```

### §4.2 Dashboard tour — 4 steps

Chrome for every step: `Back` · `Next` · `Skip tour`, and the counter as `1 / 4`.
Final step's `Next` reads `Done`.

**Step 1 — anchor `savings`**
```
Title:  Two numbers, not one
Body:   The left number is spend burned on retries and broken caches. The
        right number shows what cleaner runs would have saved. You can still
        fix the right number.
```

**Step 2 — anchor `overview-trend`, then `tool-rank`**
```
Title:  Where it went
Body:   Charts show daily spend by model, followed by the tools and MCP servers
        behind it. Click any item to filter every view to that slice.
```

**Step 3 — anchor `sessions-table`**
```
Title:  One row is one session
Body:   Open any row to see the delegation tree, slow tool calls, and
        tool errors.
```

**Step 4 — anchor `help-button`**
```
Title:  The rest is keyboard
Body:   Press ? to view keyboard shortcuts. Press ⌘K to open the command
        palette and jump to a session or switch views.
```

### §4.3 Tour completion

Not a celebration, but a pointer at the next action (the plan's A1 gate):

```
The overview is complete. Traces and evidence live inside individual sessions.

[ Open latest session → ]
```

The button navigates to the newest visible run's timeline. If runs are available,
it opens session inspection.

### §4.4 Run tour — 4 steps

#### §4.4a The offer (non-modal, first run view opened)

```
First time in a session view? Take a 30-second tour of this view.

[ Show me ]   [ No thanks ]
```

`No thanks` sets `tours.run = "skipped"` and never asks again.

#### Steps

**Step 1 — anchor `waterfall`**
```
Title:  Nesting is delegation
Body:   Indentation shows who called whom. Rows in separate lanes ran
        at the same time, not one after another.
```

**Step 2 — anchor `time-tab`**
```
Title:  Where the time went
Body:   The Time tab splits clock time between the model thinking and the
        agent waiting on tools.
```

**Step 3 — anchor `errors-tab`**
```
Title:  Normal errors versus real bugs
Body:   The Errors tab separates normal exploration from tool crashes. A failed
        check usually means the agent is exploring. A broken tool is yours to fix.
```

**Step 4 — anchor `insights-strip`**
```
Title:  Findings point at evidence
Body:   Click a finding to highlight the spans that caused it in the
        waterfall. Or open What-If to test cheaper models on this exact run.
```

Step 4's `Next` reads `Try it` and activates the first finding or opens What-If.

### §4.8 First run checklist

Docked in the corner, collapsible, non-modal:

```
Title:  First run checklist (25%)
Items:
  [x] Found agent logs on disk
  [ ] Inspect subagents and lanes in Timeline
  [ ] Trace clock time in Time view
  [ ] Review tool errors or test What-If repricing
```

### §4.5 Contextual hints

One line, one dismiss (`✕`, `aria-label="Dismiss hint"`), never more than one on screen.

| Key | Copy |
|---|---|
| `time-view` | `Clock time, not the sum of spans. Shows where the session was stuck waiting.` |
| `errors-view` | `Grouped by who can fix it. Most failed commands are the agent exploring; broken tools are real bugs.` |
| `waste-view` | `Burned spend is already gone to retries. Opportunities show what cleaner settings would have saved.` |
| `what-if` | `Re-price this session against another model. Calculations stay on this machine.` |
| `diff` | `Two runs of the same task? Compare them with: runray diff <runA> <runB>` |
| `limit-mode` | `Shows token usage and percentage of your weekly limit instead of dollars.` |
| `coverage` | `Unpriced models show token counts without dollar figures. Costs are never guessed.` |
| `redact` | `Exporting? Use --redact to keep structure and counts while dropping prompt text.` |

`limit-mode` exists for persona B, who is on a flat subscription and for whom a dollar
figure is the wrong unit entirely (`03-PERSONAS.md §B`). It must never say "cost".

### §4.6 Export provenance strip

Rendered when `live === false`. Static, no dismiss, one line, no filesystem paths ever.

```
Exported RunRay report · 3 sessions · generated 2026-08-10 by runray 0.1.0 · read-only
```

Append exactly one of:
```
· prompt text redacted
· contains prompt text
```

The second variant is a warning about the file the reader is holding, and must be visually
distinct (warning hue), not decorative. A reader who does not know a report carries prompts
cannot handle it correctly.

Below the strip, one quieter line — this is persona D's entire onboarding:
```
Generated locally from agent session logs. Nothing in this file was uploaded anywhere.
```

### §4.7 Empty state (extends the existing `EmptyScreen`)

Keep the current heading and two-step instruction verbatim — it is already right. Add, below
the existing hint, when the CLI supplied checked roots:

```
Looked in:
  ~/.claude/projects           missing
  ~/.local/share/opencode      missing
```

Live mode only. Never in exports (plan constraint 6).

---

## 5. Review checklist

Before any onboarding string ships:

- [ ] Reads correctly with no colour, no emoji, in an 80-column terminal.
- [ ] CLI: reads correctly inside clack's gutter, and unstyled under `NO_COLOR`. Labels stand
      alone without their hints.
- [ ] Contains a number that came from real data, or no number at all — never a placeholder.
- [ ] Names the next action, as a command or a button.
- [ ] Zero banned words (§1). Zero exclamation marks.
- [ ] Uses §2's word for the concept, not a synonym.
- [ ] No apology for correct behavior (unpriced models, no data, redaction refusal).
- [ ] No filesystem path in anything that can reach an exported file.
- [ ] Every dialog string has an `aria-label`; every dismiss has an accessible name.
- [ ] A persona could act on it: which of the five, and what do they do next?

---

## 6. Language

English, per `openspec/project.md` (specs, code, comments and product copy are English; only
the founder decision docs 00/05/06 are Polish). No localisation in scope for v0.1 — but every
string above is a constant with no interpolated grammar beyond counts, so extraction stays
cheap if that changes.

---

## References

- `docs/11-ONBOARDING-PLAN.md` — behavior, state, phases; the `§x.y` refs point here.
  §16 covers the libraries that render this copy (`@clack/prompts`, `@floating-ui/react`)
- `docs/03-PERSONAS.md` — who each string is for
- `packages/ui/src/components/StatusScreens.tsx` — the voice this extends
- `packages/ui/src/components/HelpSheet.tsx` — shipped terminology ("Burn line as data")
