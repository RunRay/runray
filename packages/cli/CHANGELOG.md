# runray

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
