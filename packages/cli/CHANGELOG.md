# runray

## 0.1.0-alpha.6

### Patch Changes

- 7235d48: In the timeline, span names no longer run into the tree's guide lines. A span that starts early in a long session draws as a hairline bar at the left edge, and its name used to begin inside the tree gutter, where delegation rails and concurrency brackets cut through it. Names now start to the right of that gutter. A failed span's ✕ sits in front of its red name instead of hanging off the thin bar.

## 0.1.0-alpha.5

### Minor Changes

- 1375bac: runray now needs Node.js 22 or newer; Node 20 reached end of life in April 2026. The optional SQLite reader behind OpenCode sessions moves to better-sqlite3 13, which ships its native binary for every platform inside the package, so installing runray no longer downloads that binary from GitHub. The trade-off is a larger install: about 27 MB unpacked for better-sqlite3, up from about 10 MB.

### Patch Changes

- 6c6d16c: See what each git branch cost. The dashboard ranks spend by branch in a new Top branches card, and clicking a branch filters every view to it. Each session shows the branch it started on, in its header and in the sessions table. `runray list --json` and the sessions CSV carry the branch too. Claude Code sessions record their branch already. OTLP imports now read it from OpenTelemetry's `vcs.ref.head.name` resource attribute (or `vcs.repository.ref.name`, or `git.branch`). OpenCode records no branch, so its sessions show none.
- 40d727f: In the paper (light) theme, cards and popovers no longer show a dark rim along their bottom and right edges. They now use the soft paper shadow they were designed with. Faint labels are easier to read in both themes, including on selected rows, active tabs and table heads: sort headers, captions, timestamps and the top bar's status line now meet WCAG AA contrast (4.5:1).
- 86fcd6d: Redacted, anonymized and path-scrubbed views and exports of OTLP imports no longer keep the `gen_ai.*` attributes that hold message content.
  
  OpenTelemetry GenAI instrumentations can put prompt and output messages, system instructions, tool definitions, and tool arguments and results in `gen_ai.*` span attributes (opt-in), and older ones write `gen_ai.prompt.N.content`. Until now `--redact`, `--anonymize`, `--metadata-only` and `--scrub-paths` kept every `gen_ai.*` attribute, so an export of such an import could include that text and the local paths in it.
  
  Now only metadata keys survive: provider, operation, model and numeric request parameters, response id, model and finish reasons, tool name, call id and type, conversation and agent ids, and token and cost counters. `--scrub-paths` alone still keeps prompt and output previews, but now drops these attributes. Keys under the reserved `runray.` and `tracepulse.` prefixes follow the same rule: only the metadata keys on the list survive (target key and kind, MCP detection, the 1-hour cache-write count), whoever wrote them, and anything else under those prefixes, such as a display label, is dropped.
  
  If you shared a redacted, anonymized or path-scrubbed export of an OTLP import with content attributes enabled, export it again with this version. Claude Code and OpenCode transcripts were not affected.
- 13d309f: The local viewer behind `runray view` and `runray demo` now refuses cross-site requests that change state. `POST /api/onboarding` only accepts a same-origin `application/json` request, so a web page open in your browser can no longer change which tours, hints and checklist steps you've seen. If you post to it by hand, send `Content-Type: application/json`. The state file is also written through a temporary file with a random name that is created exclusively.
- b60fde7: The Inspector has a wide mode: the toggle in its header, or the palette,
  widens it from 360px to up to 560px, and the choice persists. When the
  window has no room for it, the toggle says so. The prompt and output
  previews, the delegation reason and the raw span record each get a copy
  button that confirms the copy, or says on the button when the browser
  blocked it.
- a241c75: In the timeline, a subagent's work no longer blends into the main agent's.
  
  - Subagent bars have their own colour: chartreuse in the dark theme and umber in the light one. Before, they nearly matched the model-call bars in dark and the tool bars in light. The new colours stay distinct for colour-blind viewers too.
  - Every row inside a subagent carries a thin rail under that subagent's arrow, so nested subagents read as stacked rails.
  - A collapsed row shows the findings that sit wholly inside it: `⚠ 2 inside`, coloured by the worst one. Hover lists them, and so does the Inspector when the row is selected, for keyboard users. Clicking one opens it and expands the subtree onto it. Collapsing subagents no longer makes their findings disappear.
- 6276fcd: A file in a scanned folder that isn't a session no longer shows up as a session dated 1 January 1970 with no calls and $0. That covers another tool's `.jsonl` next to your Claude Code projects, an OpenCode-looking JSON file without a session id or start time, and any run with no usable start time. RunRay skips such a file, prints `warning: skipped <file>: <reason>`, and loads every other session as before. A Claude Code session that has just started and has no prompt yet is skipped without a warning. An OpenCode subagent session without timestamps now starts with the call that spawned it instead of pulling the whole run back to 1970.
- bdd755b: A `USD | tokens` switch beside %win picks the unit the headline figures lead with, and the choice persists. In token mode the dashboard, its rankings (ordered by tokens), the tool ranking, the run preview, tokens by day, the Explorer list, and a run's header, Cost view, tool leaderboard and subtree map lead with token counts. Waste, savings and what-if stay in dollars, and their headline figures read "at API prices", because most of those estimates are price differences with no token count behind them. %win now takes its percentages in the chosen unit, and its settings take a token budget.
  
  In dollar mode, the dashboard's headline and Avg Session card now lead with dollars, and the Resource Breakdown follows the switch instead of its own Tokens / Spend toggle. The savings panel no longer shows token figures estimated from cost shares, and the Wasted card says "no priced calls" instead of 0.0% when nothing is priced.
- d93d168: `runray pricing --refresh` now checks the downloaded price list before it replaces your prices.
  
  - It gives up after 30 seconds without data, 10 minutes in all, or 32 MiB, and says why a connection failed (DNS, refused, TLS) instead of just "fetch failed".
  - It refuses an HTML page, an empty list, or one with under half the usual models. If LiteLLM really dropped models, `--allow-short-list` accepts a shorter list.
  - It leaves out any model with a negative or absurd rate and prints `warning: left out <model>: <reason>`.
  - The new prices are written in one step. If anything fails, your previous prices stay exactly as they were and the command says nothing was written.
  
  A `pricing.json` that is empty or has invalid rates is now ignored with a warning, instead of leaving every call unpriced.

## 0.1.0-alpha.4

### Patch Changes

- 9bf2d61: `runray demo` now shows six sessions that read like real work, with no lorem ipsum. Titles, projects, prompts, subagent tasks, file names and error messages describe what each session actually does; token counts, timings and costs still come from real sessions. The demo no longer shows the "totals understated" banner, and a transcript request answers with a clear "not included in the demo" status.
- The dashboard has a first-run checklist in the bottom-left corner with four steps: found agent logs on disk, inspect subagents and lanes in Timeline, trace clock time in Time view, and review tool errors or try What-If repricing. Progress is saved with the rest of the onboarding state on this machine. The dashboard and run tours now cover the same profiler dimensions and keep their place when you move between steps.
- Reworded the CLI first-run banner, the "no sessions found" hints, the setup wizard and the dashboard messages in plainer language. Behavior is unchanged.

## 0.1.0-alpha.3

### Minor Changes

- 023b285: Two export profiles that keep the structure and drop the content:
  `sanitized` pseudonymizes paths and prunes leaf spans, `metadata-only`
  keeps counts and shapes alone. The dashboard reads the export's manifest
  and says what was removed, and a dialog in the dashboard writes the CLI
  command for the profile you pick.
- 91f00f5: Errors get a triage: what happened, who can act, what to do.
  
  - A failed tool's preview now starts where the failure is named: the last
    line that says `failed`, `error` or `exception` (never a "0 errors"
    line), else the first line after the shell wrapper's `Exit code N`. A
    batch tool's error is its failing step, not its successful log, and a
    shell error is the message, not the wrapper. The wrapper line becomes
    `tool.exitCode` in the Claude Code adapter.
  - A call the person declined ("The user doesn't want to proceed…",
    OpenCode's "The user rejected permission…" or "Tool execution aborted") is
    `cancelled` with `statusReason: user-rejected`, not an error: it no longer
    counts as a tool error and no longer feeds retry-loop,
    scattered-tool-failures or dead-end-run.
  - Every failure gets an error class and an owner (yours to fix, tooling,
    agent slip, model call, expected feedback), read from its text by
    `@runray/core/triage`, with a playbook per class per source. A run's
    failures group into clusters (class × tool) with the model call that
    reacted to each one, whether the tool came back, and the findings that
    cite them. docs/08 gains a generated "Errors, class by class" block.
  - A new **Errors** tab beside Overview, Timeline Explorer and Time: who
    can act first, then what happened, then what to do. Failures grouped by
    owner with the error text, each occurrence a jump to the timeline, the
    findings that cite them, and the playbook for the session's own source.
    Expected feedback (a test that did not pass yet) is collapsed and dimmed.
  - The errors pill in the sessions table and rail turns red only when a
    failure is yours to fix or the session never got past one; otherwise it
    reads neutral, and "· N yours to fix" says why when it is red.
  - The Inspector explains a failed span: what it is, who can act, whether
    the tool came back, what the reaction cost, and what you can do.
- 6bbd86f: Findings now tell the person running the agent what to do, and show them how.
  
  - Every rule's suggestion addresses the person, never the model: it names a
    lever they have (a command, a config key, an instructions file, a model
    switch), carries the finding's own numbers where they change the decision,
    and picks the lever by source: Claude Code, OpenCode, or a custom agent.
  - Each rule has a playbook (why it happens, what you can do in each tool, what
    is out of your hands). The Inspector shows it under *How to fix* for the
    session's own source; the findings guide carries the full set, generated
    from the same registry and checked for drift.
  - Failed tool calls keep the first 200 characters of their error text (never
    under `--redact`), so retry loops, dead ends and scattered failures say what
    went wrong instead of only how often. `PowerShell` is recognized as a shell
    tool for retry identity.
  - `context-bloat` measures the full context of the main session instead of the
    uncached slice, so cached sessions that grow are no longer invisible; the
    excess is priced at what each call actually paid per token and stated as an
    upper bound. `cache-prefix-break` says what survived the break (the front
    of the prompt, the history, or a compaction) and words the finding
    accordingly (`cachePrefixBreak.baseRetainedTokens`, `shrinkRatio`).
  - The dashboard's savings groups describe the rule, not one finding's
    sentence.
- cd7a5e1: A **Waste** tab per session: what bought nothing, and what one change would have kept.
  
  - `@runray/core/waste` (browser-safe): a run's findings grouped by rule
    and split by class, burned (the engine's capped waste-class total) apart
    from opportunities (upper bounds, never added to it). Each group is graded
    on its sum by the engine's own severity tiers, groups whose findings are
    all under five cents fold into one line, a cache break's shape and tokens
    are read from its two evidence calls, and every burned finding is placed
    on the session's clock next to the context size of each model call.
    `gradeSeverity` and the break shape move to pure modules shared with the
    rule engine.
  - The tab (`#/run/:id/waste`): the two figures, one sentence naming the
    largest burn and the lever for your tool, the leak rail (context curve,
    a bar per burn sized by amount, idle gaps, compactions, a ~200k guide;
    a bar opens the finding on the timeline), then the groups with their
    occurrences, shape split and playbook. The tab bar carries the burned
    amount.
  - The Overview keeps where the money went: totals, tool leaderboard,
    cost by model, agent subtrees. Its waste table and the what-if
    repricing panel move to the Waste tab. The findings strip shows the
    five largest findings and "+N more in Waste".
  - The Growing context row opens to how its estimate is counted (the
    baseline, the calls counted, the excess tokens and the rate, an upper
    bound against the session's opening context) and to what keeping the
    context under 100k, 200k or 400k tokens would have saved, by the same
    formula (`contextCapEstimates` in `@runray/core/waste`).

### Patch Changes

- d6b504a: The navigation rail collapses to icons and back: the chevron in its
  header, the `[` key, or the palette. Every destination keeps its name for
  assistive tech and a tooltip, and the choice persists like the theme.
- 4f67158: Claude Code sessions that the desktop app re-appended after a bridge (every
  record before the `bridge-session` marker written a second time) no longer
  count every tool call twice. The adapter keeps the first copy of each record,
  so tool calls, tool errors, code-change counts and the findings built on them
  match the session once; token totals and cost were already counted once per
  API call and are unchanged.
- 29e6a87: The "Cost by agent subtree" map names the delegates it cannot label. A
  subagent worth a percent of the run lays out as a sliver; the map keeps its
  honest proportions and a strip under it lists every such cell with its value,
  each a jump to the timeline.

## 0.1.0-alpha.2

### Patch Changes

- 087d079: Make better-sqlite3 an optional dependency. It is needed only to read the
  OpenCode SQLite store, so when it is absent — `--omit=optional`, a failed
  native build, an unsupported platform — that one source now degrades to an
  actionable "unavailable" message instead of an unhandled MODULE_NOT_FOUND,
  and Claude Code and OTLP keep working.
  
  Note: this does not remove the `prebuild-install` deprecation warning from a
  default `npx runray`; npm installs optional dependencies unless told not to.
- Report a broken better-sqlite3 install as one clear message. The module loads
  its native addon lazily inside the constructor, so a missing or ABI-mismatched
  binary sailed past the load check and surfaced later as a raw `bindings` dump
  naming whichever OpenCode database happened to be scanned first — with the
  wrong remedy attached. The addon is now probed at load time, so every failure
  mode arrives as a single actionable error and the other sources keep working.
- Fix nine Windows path defects found by an audit of the path surface, plus the
  follow-ups from auditing that audit:
  
  - A UTF-8 BOM no longer hides a file. PowerShell's `>`, `Out-File` and
    `Set-Content -Encoding utf8` all write one, and the cheap content sniff does
    not notice it, so an OTLP capture or an `opencode export` bundle matched,
    failed to parse, and vanished — leaving the directory reported as "empty".
    `runray.config.json` and the pricing override hard-failed the same way.
  - The onboarding wizard printed a config snippet built by string
    interpolation, so every Windows path produced either invalid JSON (`\G` is
    not a legal escape) or a silently corrupted one (`\t` became a tab).
    Following our own instructions broke every later command.
  - The port scan aborted `view` on a port inside a Windows reserved block
    (Hyper-V, WSL2 and Docker Desktop reserve ranges of ordinary high ports and
    binding one returns EACCES, not EADDRINUSE) instead of stepping past it.
    A privileged-port refusal on POSIX still reports "permission denied".
  - Serving a directory path threw EISDIR out of the request handler and killed
    the viewer, its watcher and every connected client. It now 404s.
  - A session started at a filesystem root got an empty project name, which
    collided with the dashboard's "all projects" entry and dropped the run out
    of the filter. This affected `/` on Linux too.
  - Paths under the home directory are abbreviated to `~` regardless of case, so
    a pasted lowercase root no longer leaks the username into shared output.
