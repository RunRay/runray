# Findings: what RunRay flags, and how it sizes it

A **finding** is one concrete thing RunRay noticed in a session that cost money it did not have to: a tool that failed three times in a row, a prompt cache that expired during a coffee break, a file read five times without changing. Every finding carries the same four things:

- the **rule** it came from (the kind of problem — the twelve rules are listed below),
- **evidence**: the exact spans in the timeline it is based on,
- an **estimate** in USD, where the data allows one,
- one **suggestion**: the one thing to change, addressed to you, not to the model (the playbook behind it is under *How to fix*).

Before you read the estimate, two questions decide how to treat it.

## Two questions every finding answers

### 1. Is the money gone? — the class

| class | meaning | where it shows up |
|---|---|---|
| **burned** | Spend that bought nothing: retries, cache re-writes, redundant reads, the tail after a fatal error. | Adds up to the run's **wasted** figure — the *Status / Waste* tile above the timeline and *already burned* on the dashboard. Capped at what the run actually cost. |
| **opportunity** | Spend that did buy something but could have been cheaper: a heavy fixed context, a model tier above the task, a cold cache. | Ranked and summed as *efficiency opportunities* on the dashboard. Never added to the wasted figure, so a hypothetical saving is never reported as a loss. |

The class is a property of the rule (see the table below): a retry loop is always burned money, a wrong model tier is always an opportunity.

### 2. How big is it here? — the severity

Severity is **not** a property of the rule. The engine grades every finding after all rules have run, from its estimate as a share of *that run's* total cost:

| severity | default rule | reads as |
|---|---|---|
| `critical` | at least **10 %** of the run's cost **and** at least **$1** | the biggest lever in this session |
| `warning` | at least **2 %** of the run's cost **and** at least **$0.05** | worth a look |
| `info` | everything else | noted, not urgent |

Two consequences worth knowing:

- **The same finding grades differently in different runs.** A $0.60 retry loop is a `warning` in a $0.65 session — it *was* the session — and `info` in a $600 one.
- **Unsized findings are `info`.** No estimate (for example a model missing from the price snapshot) or a run with no priced cost means the engine cannot size the finding, and it does not guess.

The absolute floors exist so that a few cents in a tiny session never read as critical. Shares and floors are configurable — see *Tuning thresholds*.

## The twelve rules

| rule | class | fires when | the estimate counts |
|---|---|---|---|
| `retry-loop` · Repeated failing tool calls | burned | the same tool call (same name and target) fails 3+ times in a row within one scope, tolerating up to 3 other calls in between | model calls in the same scope between the first and the last attempt — each retry re-bills the full context |
| `cache-prefix-break` · Cache prefix broken mid-session | burned | between two consecutive calls of the same model the cached prefix collapses (≥ 20k tokens read, then ≤ 20 % of that) and ≥ 10k tokens are written again | the re-written prefix at the cache-write premium over the cache-read rate; the finding says what survived — the front (tools or settings changed), the history (conversation written again), or a compaction |
| `idle-cache-expiry` · Cache expired while idle | burned | a pause longer than the live cache's TTL (5 min, or 60 min when the previous call wrote a 1-hour cache), followed by a ≥ 10k-token re-write | the re-written prefix at the cache-write premium |
| `duplicate-read` · Same file re-read unchanged | burned | the same file is read 3+ times with no write to it in between | the redundant reads' output (≈ bytes ÷ 4 tokens) at the input rate |
| `scattered-tool-failures` · Scattered tool failures | burned | 5+ isolated tool failures outside retry loops, making up ≥ 20 % of tool calls | the model calls that reacted to the failures |
| `dead-end-run` · Run ended in an error | burned | the session terminates on a failure | model calls after the last completed code change — nothing was produced after that point |
| `fixed-context-overhead` · Heavy fixed context | opportunity | the very first call already carries ≥ 20k tokens (tool definitions, project instructions) and the run has 5+ calls | the excess, written once and re-read on every later call |
| `model-mismatch` · Wrong model tier | opportunity | a cheaper same-family model would save ≥ $0.50 on calls that are not risky (few tool calls, modest context) | the risk-free repricing delta |
| `expensive-subagent` · Expensive subagent | opportunity | one delegated subtree costs > 50 % of the run and ≥ $0.25 | the subtree repriced one tier down; no cheaper tier means no figure |
| `context-bloat` · Growing context | opportunity | the last calls' context (input-class tokens, main session) is 2× the first calls' and above 50k tokens | the cumulative excess over the starting context, priced at what each call actually paid per token — cache reads where it was served from cache; an upper bound that assumes the work could have continued from a compacted context |
| `low-cache-hit` · Low cache hit-rate | opportunity | hit-rate below 40 % on a run costing more than $0.10 with 5+ calls | what a 60 % hit-rate would have saved |
| `oversized-output` · Oversized tool output | opportunity | tool outputs of 100 kB or more enter the context | ≈ bytes ÷ 4 tokens at the input rate — usefulness is unknowable, so never burned |

Estimates marked ≈ rely on the four-bytes-per-token heuristic and say so in the finding text.

## How to fix, rule by rule

Every finding's **suggestion** is one sentence addressed to you, the person running the agent, never to the model: it names a lever you have and carries the finding's own numbers where they change the decision. The playbook behind it is below, one per rule: why the finding happens, what you can do about it in Claude Code, in OpenCode or in a custom agent reporting over OTLP, and what is out of your hands. The Inspector shows the part for the session's own source under *How to fix*. Every command, key and file named here is checked against the tool's current documentation before it is added.

<!-- playbooks:start -->
<!-- Generated from RULE_META in packages/core/src/insights/meta.ts by `pnpm docs:playbooks`. Edit the registry, not this block. -->

### `retry-loop` · Repeated failing tool calls

The same tool failed several times in a row — every retry re-billed the full context.

**Why it happens**

- The agent does not know a fact about your environment: the shell version, a binary that is not installed, a sandbox that blocks the call.
- The file changed under the agent (a formatter on save, a concurrent edit), so an edit no longer finds its anchor text.
- An MCP server is down, slow, or rejects the arguments the agent sends.

**What you can do**

*Claude Code*

- Interrupt the loop (Esc) as soon as the same call fails twice; every further attempt re-bills the whole context.
- Write the missing fact into `CLAUDE.md`, for example `Shell is PowerShell 5.1: no && chaining`, so the next session starts with it.
- For a known-bad command pattern, a `PreToolUse` hook that exits with code 2 blocks the call before it is billed.
- For an MCP server that keeps failing, check it with `claude mcp list` and remove it with `claude mcp remove <name>` until it is fixed.

*OpenCode*

- Interrupt the loop as soon as the same call fails twice.
- Write the missing fact into `AGENTS.md` so the next session starts with it.
- For a failing MCP server, set `mcp.<name>.enabled: false` in `opencode.json` until it is fixed.

*Custom agent (OTLP)*

- Stop retrying the same call after two failures and surface the error to the person instead.
- Put the environment facts the agent keeps rediscovering into its system prompt.

**Out of your hands**

- The finding quotes the error text when the session was parsed without `--redact`; with redaction it names only the tool and the count.

### `low-cache-hit` · Low cache hit-rate

Most input tokens were paid at the full rate instead of being served from the prompt cache.

**Why it happens**

- The provider or model does not cache prompts, or caching is not enabled for the requests.
- The prefix changes on every call, so nothing can be served from cache.

**What you can do**

*Claude Code*

- Caching is automatic; check the same run for `cache-prefix-break` findings, which say what kept re-writing the prefix.
- Resume a session with `claude --continue` or `claude --resume` instead of pasting its history into a new one.

*OpenCode*

- Check that the provider you use supports prompt caching for the model; OpenCode adds no cache options of its own.

*Custom agent (OTLP)*

- Mark a stable prefix for caching in every request: system prompt, tool definitions, then the conversation, in that order.
- Keep anything that changes per call (timestamps, request ids) out of the cached prefix.

**Out of your hands**

- The estimate assumes a 60% hit-rate was reachable; a session whose prompts genuinely share nothing cannot get there.

### `context-bloat` · Growing context

The context grew steadily across the session, so every later call re-paid an ever-larger prefix; the estimate is an upper bound that assumes the work could have gone on from a compacted context.

**Why it happens**

- Large tool outputs stay in the conversation after they were used: a whole file, a long log, an unfiltered search.
- One session carries several unrelated tasks, so the context of the first is still paid for during the last.

**What you can do**

*Claude Code*

- Run `/compact` at a natural checkpoint and say what to keep, for example `/compact keep the failing test output`.
- Start the next task with `/clear` or a new session instead of continuing in the same context.
- Ask for smaller outputs: `Read` with `offset` and `limit`, `Grep` with a head limit, commands piped through a filter.

*OpenCode*

- Run `/compact` (alias `/summarize`) at a checkpoint; start a new task with `/new`.
- Set `compaction.prune: true` in `opencode.json` so old tool outputs are dropped automatically.

*Custom agent (OTLP)*

- Summarize or drop tool results once the step that needed them is done; keep only the conclusion in the history.

**Out of your hands**

- Auto-compaction is decided by the agent, not by RunRay; the finding shows where the context grew and which outputs were largest.

### `expensive-subagent` · Expensive subagent

One delegated subtree dominated the run's spend.

**Why it happens**

- A delegated task ran on the most capable model although it was mechanical: exploring files, running tests, formatting.
- The subagent was given a task so wide that it re-read most of the project.

**What you can do**

*Claude Code*

- Set `model: sonnet` or `model: haiku` in the agent's frontmatter under `.claude/agents/`; `inherit` follows the main conversation.
- Set `CLAUDE_CODE_SUBAGENT_MODEL` to change the default for every subagent in a session.
- Give the subagent a narrower task, or point it at the files it needs, so it does not explore the whole repository.

*OpenCode*

- Set `agent.<name>.model` in `opencode.json`, or `model:` in the agent's markdown frontmatter.
- Use `small_model` for lightweight work such as titles and summaries.

*Custom agent (OTLP)*

- Route delegated, low-risk work to a cheaper model and keep the strong model for planning and review.

**Out of your hands**

- The saving assumes the cheaper model uses the same tokens; a model that needs more attempts can cost more, and RunRay cannot predict that.

### `dead-end-run` · Run ended in an error

The session terminated on a failure — spend after the last productive step bought nothing.

**Why it happens**

- The last thing the agent did failed and nothing recovered from it: a command that errored, a session closed right after.
- In headless runs (`claude -p`, CI) an error at the end means the whole run produced nothing.

**What you can do**

*Claude Code*

- Resume with `claude --continue` and deal with the failing step first; everything up to the last completed change is intact.
- In CI, surface the failing step in the job log and rerun the job after fixing it, not the whole pipeline of prompts.

*OpenCode*

- Resume with `opencode -c` (or `--session <id>`) and deal with the failing step first.

*Custom agent (OTLP)*

- Return the error to the caller instead of ending the run silently, and make the failed step the first thing the next run sees.

**Out of your hands**

- An interactive session that simply ends after an error looks the same as a real dead end; the estimate counts only model calls after the last completed change.

### `model-mismatch` · Wrong model tier

These calls would cost less on a cheaper same-family model; risky subtrees are excluded from the estimate.

**Why it happens**

- The whole session ran on the top tier, including stretches with few tool calls and a modest context that a cheaper model handles.

**What you can do**

*Claude Code*

- Switch mid-session with `/model sonnet` (or `/model haiku`) for mechanical stretches, and back with `/model opus` for design and debugging.
- Start a session on a cheaper tier with `claude --model sonnet` when the task is known to be routine.

*OpenCode*

- Switch with `/models` in the TUI, or set `model` in `opencode.json`; `opencode run --model <provider/model>` for one-off runs.

*Custom agent (OTLP)*

- Route by task: a cheaper model for classification, extraction and formatting; the strong model where errors are costly.

**Out of your hands**

- RunRay marks subtrees with many tool calls, errors or a large context as risky and excludes them; the estimate covers only the rest.

### `cache-prefix-break` · Cache prefix broken mid-session

The cached prompt prefix was invalidated mid-session, so already-cached content was re-written at the premium rate.

**Why it happens**

- Something in the cached prefix changed between two calls: an MCP server connected or disconnected (its tools are part of the prefix), the model or a setting switched, an early turn was edited.
- The context was compacted: the new, shorter history is a different prefix and is written once more.
- Very large contexts get re-written with no visible change between the calls; in the sessions RunRay has seen this starts well above 180k tokens, and the cause sits on the platform side. The finding says which part survived: the front (tools or settings changed), the history (conversation written again), or a compaction.

**What you can do**

*Claude Code*

- Connect the MCP servers you need before the long part of the work; a server that joins mid-session re-writes the prefix.
- Keep sessions from growing past a few hundred thousand tokens: `/compact` at a checkpoint, or a new session per task.
- Avoid switching `/model` or settings in the middle of a large context; do it at a task boundary.

*OpenCode*

- Enable the MCP servers you need before starting; toggling `mcp.<name>.enabled` re-writes the prefix.
- `/compact` at a checkpoint and `/new` per task; `compaction.prune: true` keeps the history small.

*Custom agent (OTLP)*

- Order every request as system prompt, tools, history, and never change the earlier parts once the session runs.

**Out of your hands**

- RunRay sees the collapse and the re-write, not what changed; the shape (front, history, compaction) narrows the cause but does not prove it.

### `idle-cache-expiry` · Cache expired while idle

A long pause let the prompt cache expire — the next call re-wrote the whole prefix at the premium rate.

**Why it happens**

- The session was left alone longer than the cache lives (5 minutes on an API key, 1 hour on a subscription), then resumed.
- The next call wrote the whole context again at the write premium, and every later call re-reads all of it.

**What you can do**

*Claude Code*

- Before a long break, `/compact`: it reads the context from cache while that is still cheap, and the resumed session re-writes only the summary.
- Start the next day's task in a new session rather than `claude --continue` into a large context.
- On an API key, set `promptCacheTtl: "1h"` in settings (or `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`) so a coffee break does not expire the cache.

*OpenCode*

- Before a long break, `/compact` (alias `/summarize`); start the next task with `/new` instead of resuming a large session.
- There is no cache TTL setting in OpenCode; the provider's default applies.

*Custom agent (OTLP)*

- Use the 1-hour cache TTL for sessions that pause, and compact the history before an expected idle period.

**Out of your hands**

- The re-write on resume is unavoidable if you continue the same conversation; the choice is between compacting first, resuming as is, or starting fresh.

### `fixed-context-overhead` · Heavy fixed context

The session starts with a large fixed context (tool definitions, project instructions) that every later call re-reads.

**Why it happens**

- Everything the first call already carries is paid on every call: the system prompt, `CLAUDE.md` and imported files, skill and memory listings, MCP tool definitions, attachments.

**What you can do**

*Claude Code*

- Keep `CLAUDE.md` short (the docs recommend under 200 lines) and check what each `@import` pulls in.
- Disable MCP servers a project does not need: `disabledMcpServers` in settings, `claude mcp remove <name>`, or keep them project-scoped in `.mcp.json` instead of user-wide.
- Tool search defers MCP tool schemas by default, but a server with many tools still adds its name and descriptions to every call.

*OpenCode*

- Keep `AGENTS.md` and the files under `instructions` short.
- Set `mcp.<name>.enabled: false` for servers a project does not use, or restrict tools per agent with the `tools` map.

*Custom agent (OTLP)*

- Trim the system prompt and tool definitions; move rarely used tools behind a lookup step.

**Out of your hands**

- RunRay sees the footprint size, not its composition; the finding lists which MCP servers were actually called, the one fact the trace holds.

### `duplicate-read` · Same file re-read unchanged

The same file was read repeatedly with no edit in between; each redundant read re-enters the context as fresh input.

**Why it happens**

- The agent lost the file's content, usually after a compaction or a long stretch of other work, and read it again.

**What you can do**

*Claude Code*

- Nothing to configure; if the same file keeps coming back across sessions, make it shorter or split it so each read costs less.
- For a reference file the agent needs constantly, an `@import` in `CLAUDE.md` keeps it in the prefix once instead of re-reading it, at the price of a larger fixed context.

*OpenCode*

- Nothing to configure; keep files the agent needs repeatedly short.

*Custom agent (OTLP)*

- Cache tool results by file and content hash so an unchanged file is served from memory.

**Out of your hands**

- The estimate counts the re-entered bytes at the input rate; a read after a compaction is also the agent's only way to recover the content.

### `scattered-tool-failures` · Scattered tool failures

Many isolated tool failures forced extra model calls to react and recover.

**Why it happens**

- Many different calls failed once: wrong paths, missing tools, permission denials, flaky commands. Each failure costs a model call to react.

**What you can do**

*Claude Code*

- Start with the tool that failed most and put the fix into `CLAUDE.md`: the right path, the right command, the tools that are not available.
- If the failures are permission denials, add the calls to `permissions.allow` or `permissions.deny` in settings so the agent stops probing.

*OpenCode*

- Put the fixes into `AGENTS.md`; use the `permission` block per agent to deny calls that should never run.

*Custom agent (OTLP)*

- Log the error text with each failure and feed the recurring ones back into the system prompt.

**Out of your hands**

- The finding counts failures outside retry loops and quotes the most recent error of the dominant tool when parsed without `--redact`.

### `oversized-output` · Oversized tool output

Very large tool outputs entered the context; their usefulness is unknowable, so this never counts as burned waste.

**Why it happens**

- A tool returned far more than the agent needed: a whole file, an unfiltered directory listing, a full log, an MCP response with everything in it.

**What you can do**

*Claude Code*

- `Read` with `offset` and `limit`, `Grep` with a head limit, commands piped through `head` or a filter.
- `BASH_MAX_OUTPUT_LENGTH` caps command output (default 30,000 characters); MCP responses are capped separately.
- Put a rule in `CLAUDE.md` for the tool that produced it, for example `never print whole files; use Read with limit`.

*OpenCode*

- Keep outputs small at the source: filtered commands, targeted reads; `compaction.prune: true` drops old outputs later.

*Custom agent (OTLP)*

- Truncate or paginate tool results before they enter the context and keep the full result on disk for the agent to page through.

**Out of your hands**

- RunRay cannot tell how much of the output was needed, so this is an opportunity, never burned waste.
<!-- playbooks:end -->

## Errors, class by class

A failed call is not one thing. On real sessions a third of the "errors" are the agent's own check-and-fix loop (a test that did not pass yet), a third are the model's slips corrected within seconds, and under a tenth are something the person can act on. RunRay reads the failure text into an **error class** and an **owner** — who has a lever — and the Errors tab groups a session's failures by owner, most actionable first. Classification is a pure function of the text (`packages/core/src/triage`); under `--redact` it falls back to what the span shape still tells (an MCP call, a non-zero exit code) and says so. The pill in the sessions list turns red only when a group is yours to fix or the session never got past a failure (a tool that never came back, with nothing succeeding after it).

<!-- error-classes:start -->
<!-- Generated from ERROR_CLASS_META in packages/core/src/triage/meta.ts by `pnpm docs:playbooks`. Edit the registry, not this block. -->

### Yours to fix

*something in your environment or configuration; the agent cannot fix it alone.*

#### `model-limit` · Usage limit reached

The model call was refused because a plan or session limit was hit; the message names the reset time.

**Why it happens**

- A plan, session or model-specific usage limit was reached mid-session.

**What you can do**

*Claude Code*

- Wait for the reset the message names, or switch tiers with `/model` so the session can continue on a tier with its own budget.
- Resume where you were with `claude --continue`; the transcript is intact.

*OpenCode*

- Switch models with `/models` (or the `model` key in `opencode.json`); provider limits are per model.

*Custom agent (OTLP)*

- Surface provider limit responses to the person instead of retrying blindly.

**Out of your hands**

- RunRay reads the harness message; it cannot see the limit or how much of it is left.

#### `model-auth` · Not authenticated

The model call was refused because the session is not logged in or the credentials were rejected.

**Why it happens**

- The login expired or the API key was rejected.

**What you can do**

*Claude Code*

- Run `/login`, then resume with `claude --continue`.

*OpenCode*

- Re-authenticate the provider with `opencode auth login` and resume with `opencode -c`.

*Custom agent (OTLP)*

- Return the authentication failure to the caller.

**Out of your hands**

- Everything after the failure was lost time, not lost money.

#### `shell-syntax` · Shell syntax

The shell could not parse the command: a quoting mistake, a heredoc that never closed, an operator this shell does not have.

**Why it happens**

- The agent wrote for a different shell than the one it runs in (PowerShell 5.1 has no `&&`; Git Bash heredocs need care).

**What you can do**

*Claude Code*

- Put the shell fact into `CLAUDE.md`, for example `Shell is PowerShell 5.1: no && chaining` or `write multi-line scripts with the Write tool, not heredocs`.
- For a pattern you never want billed, a `PreToolUse` hook that exits with code 2 blocks the call before it runs.

*OpenCode*

- Put the shell fact into `AGENTS.md`; the `permission` block can deny a command pattern outright.

*Custom agent (OTLP)*

- State the shell and its limits in the system prompt.

**Out of your hands**

- The agent usually recovers on its own; the lever prevents the next session from paying again.

#### `missing-binary` · Missing program, module or permission

A command or module the agent relied on is not installed, not on PATH, or not permitted.

**Why it happens**

- The tool is not installed, not on PATH for this shell, or the file is not executable.

**What you can do**

*Claude Code*

- Install it, or write into `CLAUDE.md` that it is not available and what to use instead.
- For a tool that must never be tried, `permissions.deny` in settings stops the probing.

*OpenCode*

- Install it, or note in `AGENTS.md` what is not available.

*Custom agent (OTLP)*

- List the available tools in the system prompt.

**Out of your hands**

- RunRay cannot tell an uninstalled tool from a PATH problem.

#### `tool-unavailable` · Tool or configuration unavailable

The agent reached for a tool, skill or launch configuration that does not exist in this session.

**Why it happens**

- A skill or plugin is not installed, a tool is disabled in this context, or `.claude/launch.json` is missing.

**What you can do**

*Claude Code*

- Add the configuration the agent looked for: a `.claude/launch.json` entry for a preview server, or the skill/plugin it named.
- Check the MCP servers with `claude mcp list` if the missing tool belongs to one.

*OpenCode*

- Enable the tool in the `tools` map or the MCP server with `mcp.<name>.enabled` in `opencode.json`.

*Custom agent (OTLP)*

- Advertise only the tools that exist.

**Out of your hands**

- The message names what was missing; RunRay quotes it.

#### `port-in-use` · Port in use

A preview or dev server could not start because its port is taken.

**Why it happens**

- Another process, often a previous server, holds the port.

**What you can do**

*Claude Code*

- Stop the process the message names, or change the `port` in `.claude/launch.json`.

*OpenCode*

- Free the port or change it in the project config.

*Custom agent (OTLP)*

- Pick a free port before starting the server.

**Out of your hands**

- Nothing the agent can do without you.

#### `http-error` · HTTP or network error

A fetch failed: a 404, a refused connection, a DNS miss.

**Why it happens**

- A wrong URL, a service that is down, or no network.

**What you can do**

*Claude Code*

- Check the address or the service; if the agent must not fetch it, `permissions.deny` for `WebFetch` stops the attempts.

*OpenCode*

- Check the address or the service.

*Custom agent (OTLP)*

- Return the status code to the model.

**Out of your hands**

- RunRay sees the status, not the response.

### Tooling

*the Browser pane, a preview server or an MCP server; restart or reconfigure, not reprompt.*

#### `pane-timeout` · Browser pane timeout

A screenshot, click or navigation in the Browser or Preview pane timed out; the pane, not the page, is usually stuck.

**Why it happens**

- A stuck renderer, a modal dialog, or a page that never finished rendering.

**What you can do**

*Claude Code*

- Close the pane tab and open it again; a stuck renderer keeps timing out on every step.
- If the page is a dev server, read `preview_logs` before retrying.
- Interrupt (Esc) when the same step fails twice; each retry re-bills the context.

*OpenCode*

- Restart the browser tool or the MCP server behind it.

*Custom agent (OTLP)*

- Cap retries on timeouts and surface them.

**Out of your hands**

- The most common single error class on real sessions; a retry usually works, a restart always does.

#### `pane-navigation` · Navigation refused

The Browser pane refused to open the address: a `file://` page, a blocked origin, a server that is not up.

**Why it happens**

- The pane cannot open local files, the origin is not allowed, or nothing listens on the port yet.

**What you can do**

*Claude Code*

- Serve the file instead of opening it: an entry in `.claude/launch.json` lets the agent open it with `preview_start`.
- Tell the agent in `CLAUDE.md` to publish local HTML as an artifact rather than open it in the pane.

*OpenCode*

- Serve local files; check the origin allowlist of the browser tool.

*Custom agent (OTLP)*

- Validate the URL before navigating.

**Out of your hands**

- The refusal is a policy of the pane, not a bug in the page.

#### `mcp-error` · MCP server error

An MCP server returned an error RunRay does not recognize; the server, not the prompt, is the place to look.

**Why it happens**

- The server is down, misconfigured, or rejected the call.

**What you can do**

*Claude Code*

- Check the server with `claude mcp list`; remove it with `claude mcp remove <name>` until it is fixed.

*OpenCode*

- Set `mcp.<name>.enabled: false` in `opencode.json` until the server is fixed.

*Custom agent (OTLP)*

- Log the server response with the span.

**Out of your hands**

- Under `--redact` every MCP failure lands here.

### Agent slips

*the model's own mistake, usually corrected by the model; worth a note only when it repeats.*

#### `edit-anchor-miss` · Edit anchor not found

An edit could not find the text it meant to replace, so nothing was written.

**Why it happens**

- The model misremembered the file, or the file changed under it: a formatter on save, a concurrent edit, CRLF line endings.

**What you can do**

*Claude Code*

- Once is the model; several times on one file is the file changing under it. Pause format-on-save or the watcher while the agent works.
- Line-ending churn: a `.gitattributes` with `* text=auto` keeps the working copy stable.

*OpenCode*

- Pause format-on-save while the agent edits; keep line endings stable.

*Custom agent (OTLP)*

- Re-read before editing when the previous edit missed.

**Out of your hands**

- Nothing to configure; the agent corrects this itself.

#### `read-before-write` · Write before read

The harness refused a write because the agent had not read the file first.

**Why it happens**

- A safety check of the harness, doing its job.

**What you can do**

*Claude Code*

- Nothing to configure; the agent corrects this itself.

*OpenCode*

- Nothing to configure; the agent corrects this itself.

*Custom agent (OTLP)*

- Keep the read-before-write check; it is cheap.

**Out of your hands**

- The retry costs one model call.

#### `input-validation` · Invalid tool arguments

The tool rejected the arguments the model sent: a missing field, a wrong type, unparseable JSON.

**Why it happens**

- The model produced arguments the tool schema does not accept.

**What you can do**

*Claude Code*

- Nothing per event. If one tool keeps rejecting, a line in `CLAUDE.md` showing its correct call shape saves the retry.

*OpenCode*

- Nothing per event; a correct example in `AGENTS.md` if one tool keeps rejecting.

*Custom agent (OTLP)*

- Return the validation message verbatim; the model uses it.

**Out of your hands**

- Each rejection costs one model call to correct.

#### `tool-misuse` · Tool used out of order

The tool refused because a precondition was missing: no page open, no screenshot taken, a file too large for one read.

**Why it happens**

- The model skipped a step the tool requires.

**What you can do**

*Claude Code*

- Nothing to configure; the agent corrects this itself.

*OpenCode*

- Nothing to configure; the agent corrects this itself.

*Custom agent (OTLP)*

- Make the precondition part of the error message.

**Out of your hands**

- Each refusal costs one model call.

#### `path-not-found` · Path not found

A file or directory the agent named does not exist: a guessed name, a drifted working directory, a stale path.

**Why it happens**

- The model guessed a path, or the working directory drifted from an earlier `cd`.

**What you can do**

*Claude Code*

- Nothing per event. If the same path keeps failing across sessions, a short repo map in `CLAUDE.md` removes the guess.

*OpenCode*

- Nothing per event; a repo map in `AGENTS.md` if the same path keeps failing.

*Custom agent (OTLP)*

- Give the agent a file listing before it guesses.

**Out of your hands**

- Corrected on the next call in most sessions.

#### `script-error` · Agent script threw

A script the agent wrote raised an exception when it ran it.

**Why it happens**

- A bug in an ad-hoc script the model wrote to inspect data.

**What you can do**

*Claude Code*

- Nothing to configure; the agent corrects this itself.

*OpenCode*

- Nothing to configure; the agent corrects this itself.

*Custom agent (OTLP)*

- Return the stack trace; the model fixes its own script.

**Out of your hands**

- Each attempt costs one model call.

### Model calls

*the request to the model itself failed; not in the tool-error count.*

#### `model-server` · Provider error

The provider answered with a server-side error (500, 529, overloaded, timeout); the harness retried.

**Why it happens**

- A transient provider-side failure.

**What you can do**

*Claude Code*

- Nothing on your side: Claude Code retries. A run of them is worth a look at status.claude.com before retrying by hand.

*OpenCode*

- Nothing on your side beyond a retry; check the provider status page if it keeps happening.

*Custom agent (OTLP)*

- Retry with backoff and log the status code.

**Out of your hands**

- The retry re-bills the context; RunRay counts that in the next model call, not in this one.

#### `model-content` · Request rejected by the provider

The provider refused the request itself: a safeguard flag or an image it could not process.

**Why it happens**

- A safeguard flagged the message, or an image in the conversation could not be processed.

**What you can do**

*Claude Code*

- Rephrase or drop the flagged content; for an image, re-read the file another way or at a smaller size.

*OpenCode*

- Rephrase or drop the content the provider refused.

*Custom agent (OTLP)*

- Log the refusal reason and return it to the caller.

**Out of your hands**

- The provider does not say which part was flagged.

#### `model-error` · Model call failed

The model call failed for a reason RunRay does not recognize.

**Why it happens**

- An API error outside the recognized patterns.

**What you can do**

*Claude Code*

- Read the message in the Inspector; the transcript keeps it.

*OpenCode*

- Read the message in the Inspector.

*Custom agent (OTLP)*

- Record the error message on the span status.

**Out of your hands**

- Without the text (redacted sessions) the class is a guess.

### Expected feedback

*the agent ran a check and read the result; not a failure of the session and never counted as waste.*

#### `check-failed` · Check did not pass

A test, lint, type or build run reported failures; the agent asked for exactly this feedback.

**Why it happens**

- The fix-and-check loop; the exit code is the answer the agent wanted.

**What you can do**

*Claude Code*

- Nothing. This is the agent working.

*OpenCode*

- Nothing. This is the agent working.

*Custom agent (OTLP)*

- Nothing; do not count it as a failure of the run.

**Out of your hands**

- Never counted as waste; a long run of them is a hard task, not an error.

#### `exit-nonzero` · Command returned non-zero

A command exited with a non-zero code without naming a failure RunRay recognizes; usually a probe (grep with no match, a partial pipeline).

**Why it happens**

- A probe or a pipeline where a harmless step returned non-zero.

**What you can do**

*Claude Code*

- Nothing per event. Read the text if the same command keeps failing.

*OpenCode*

- Nothing per event.

*Custom agent (OTLP)*

- Record the exit code on the span.

**Out of your hands**

- Without the text RunRay cannot tell a probe from a real failure.

### Unclassified

*RunRay could not read a cause from the text.*

#### `unclassified` · Unclassified

The failure text did not match any known class.

**Why it happens**

- A message RunRay has no pattern for, or a redacted session.

**What you can do**

*Claude Code*

- Read the text in the Inspector.

*OpenCode*

- Read the text in the Inspector.

*Custom agent (OTLP)*

- Put the error message on the span status so it can be read.

**Out of your hands**

- Under `--redact` every non-MCP tool failure lands here.
<!-- error-classes:end -->

## Where findings appear

- **Dashboard → Potential savings.** Burned and opportunity totals side by side, then the top three rules by amount with their worst findings expandable in place. *Open in timeline* jumps to the evidence and lights it up.
- **Timeline → findings strip.** One pill per finding, ranked by amount, tinted by severity. Click one to highlight its evidence rows and open it in the Inspector.
- **Timeline → rows.** Every row that is evidence of a finding carries a severity-coloured notch in the left gutter and a ⚠ chip, with a count when several findings share the row. Hover for the list; click the chip to open the finding.
- **Inspector.** With an evidence row selected, switch between *Activity* (the span) and *Finding* (why it was flagged, what share of the run it represents, and *How to fix*: the rule's playbook for the session's own source). A row under several findings offers a chip per finding.
- **Errors tab.** A session's failed calls grouped by who can act — yours to fix, tooling, agent slips, model calls, expected feedback — with a summary (how many are yours to fix, how many recovered on the next call, what the reactions cost), the failures on the session's time axis, and one row per class × tool that opens to the error text, its occurrences (each a jump to the timeline), the findings that cite it, and the class playbook for your tool. Expected feedback starts collapsed; agent slips show a lever only when they repeat or never recover.
- **Inspector, failed span.** After *Output*: *What this is* (owner · class, what happened next, what the reaction cost) and *What you can do* for your tool, from the same registry as the tab. The errors pill in the sessions lists and the tab bar turns red only when a failure is yours to fix or the session never got past one.
- **CLI.** `runray export --json <file>` writes the normalized trace with every finding, its `severity`, `estimatedWasteUSD` and `spanIds`.

## Tuning thresholds

Detection gates and the severity tiers live under `insights.thresholds` in `runray.config.json`, looked up in the current directory and then in `~/.config/runray/`. Set only the keys you want to change. The defaults:

```json
{
  "insights": {
    "thresholds": {
      "severity": { "warningShare": 0.02, "warningFloorUSD": 0.05, "criticalShare": 0.1, "criticalFloorUSD": 1 },
      "retryLoop": { "minFailures": 3, "maxGapToolCalls": 3 },
      "lowCacheHit": { "maxHitRate": 0.4, "minCostUSD": 0.1, "minLlmCalls": 5, "targetHitRate": 0.6 },
      "contextBloat": { "multiplier": 2, "minMedianInputTokens": 50000, "topCulprits": 3 },
      "expensiveSubagent": { "minShareOfRunCost": 0.5, "minCostUSD": 0.25 },
      "modelMismatch": { "minSavingsUSD": 0.5, "riskToolCalls": 25, "riskContextTokens": 150000 },
      "cachePrefixBreak": { "minPrefixTokens": 20000, "collapseRatio": 0.2, "rewriteFloorTokens": 10000, "baseRetainedTokens": 5000, "shrinkRatio": 0.6 },
      "idleCacheExpiry": { "minIdleMinutes": 5, "rewriteFloorTokens": 10000 },
      "fixedContextOverhead": { "floorTokens": 20000, "minLlmCalls": 5 },
      "duplicateRead": { "minRepeats": 3 },
      "scatteredToolFailures": { "minFailures": 5, "minErrorShare": 0.2 },
      "oversizedOutput": { "minOutputBytes": 100000, "topOffenders": 5 }
    }
  }
}
```

Raising `severity.criticalShare` to `0.25`, for example, reserves `critical` for findings that eat a quarter of a session. Thresholds change what fires and how it is graded; the estimate formulas themselves are fixed.

## What the numbers do not claim

- **Wasted is capped at the run's cost.** Overlap between burned rules is only partly de-duplicated, so the cap keeps the headline honest.
- **Unpriced models have no dollar figure.** Their calls show tokens without USD, the totals are marked as understated, and their findings grade `info`. `runray pricing --refresh` fetches current prices — the only network call RunRay ever makes, and only when you ask for it.
- **Opportunities describe a counterfactual.** "Would have cost $X less on a cheaper model" assumes the cheaper model would have done the job; the risk flags exclude the subtrees where that is least likely. `context-bloat` is the widest of them: its estimate is the cost of carrying the grown context, an upper bound that assumes the work could have continued from a compacted context, so on long cached sessions it can dominate the opportunities total.
- **Findings are a pure function of the log.** Same session, same prices, same thresholds — the same findings, byte for byte.

Normative details live in [02-DATA-MODEL.md](02-DATA-MODEL.md) (the `Insight` record) and [05-ARCHITECTURE.md](05-ARCHITECTURE.md) §2.4 (rule formulas and registration order).
