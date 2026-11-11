# Proposal: add-tool-usage-breakdown

## Why

The Time view groups tool time by the harness tool name, so every program an
agent runs through a shell collapses into two rows, `Bash` and `PowerShell`.
Measured on 2,743 local Claude Code transcripts (161,261 tool calls), those two
rows hold 64% of all tool-span time. A session that spent twenty minutes in
`docker`, `vitest` and `pnpm build` reads as "Bash: 20 min".

The data needed to do better already passes through the parser and is thrown
away. Adapters stamp `runray.target` with the first whitespace token of the
command, no UI component reads it, and `--redact` deletes it. The first token
is also the wrong token: 90% of commands are compound (median four commands per
call), 38% start with `cd`, and under the first-token rule about 62% of shell
time lands on something that is not a program (`cd`, a loop keyword, `export`,
an unreadable token). `docker` shows up as the first token in 971 calls and as
the program doing the work in 1,778. A further 2,673 calls hide the real tool
behind a runner (`npx vitest`, `pnpm exec tsc`).

Other tool signals sit in the logs unused: the skill a `Skill` call invoked,
the hooks that ran around a tool, whether a command was sent to the
background, and the time an agent spent blocked on a question to the person,
which today counts as tool execution (11% of tool-span time in the sample).

## What Changes

- **Shell commands are decomposed in core.** A command string is split into
  pipelines and stages, setup words (`cd`, variable assignments, wrappers, loop
  keywords) are skipped, runners are unwrapped to the tool they launch, and one
  program is selected as the primary tool of the call. Bash, PowerShell and
  OpenCode's `bash` go through the same decomposition.
- **A closed tool registry** maps program names to a tool id, a display label
  and an activity. Per-tool subcommand tables turn `docker compose up`,
  `git diff` and `pnpm test` into identities. A name outside the registry never
  becomes an id.
- **An activity taxonomy** (test, build, check, run, explore, edit, vcs, deps,
  infra, cloud, data, web, system, devices, agent, human, integration, other)
  classifies every tool call, shell or not. Tool and activity are two separate
  axes: `pnpm` is one tool that builds, tests and installs.
- **New reserved span attributes** carry the result: `runray.tool`,
  `runray.toolSub`, `runray.toolActivity`, `runray.toolVia`, `runray.toolsAlso`,
  `runray.toolFlags`, and the unredacted-only `runray.toolName`,
  `runray.toolScript` and `runray.skill`. They live in the existing free-form
  `span.attributes` bag. **The schema is not touched.**
- **Closed-vocabulary identity survives redaction and the sanitized profiles.**
  Registry ids, table subcommands, the activity and the flags are kept under
  `--redact`, `sanitized` and `metadata-only` (where the span survives).
  Free-form names (a program outside the registry, a script name, a skill
  name) are emitted only when redaction is off, exactly like `runray.target`.
- **Command result flags**: a shell call sent to the background, timed out or
  interrupted is flagged, so a 300 ms "duration" of a dev server reads as a
  launch, not a run.
- **Claude Code hook spans**: the JSONL adapter emits `hook` spans from the
  hook records the transcript carries. Only failed and cancelled hook runs
  carry a duration; that limit is stated wherever hooks are shown.
- **One resolver and one aggregation in core**, exported browser-safe: every
  tool, MCP and hook span resolves to a family (shell, harness, MCP, skill,
  agent, hook), a tool, an optional subcommand and an activity; a per-run
  aggregation produces the rows the Time view renders. Spans from traces
  produced before this change resolve to their harness tool name, as today.
- **Time view**: a fifth wall-clock segment for time blocked on the person; a
  breakdown of tool time by activity; and a tool table that replaces "slowest
  tools", ranked by total time, expandable to subcommands, filterable by
  family, with time shared between several tools in one command shown
  separately from time a tool had to itself.

Out of scope: changing `runray.targetKey` or the retry-loop identity (the first
token still feeds it; a follow-up change owns that, because it moves insight
results and goldens); the dashboard "By tool" card, run filtering by tool and
waterfall labels; separating permission-prompt wait from execution in
transcript sources (the transcript does not record it); mapping OTLP
`blocked_on_user` spans; tracking slash commands and WebFetch hosts; splitting
one call's duration between the tools it ran (the log has no intermediate
timestamps).

## Capabilities

### New Capabilities

- `tool-usage`: the contract for identifying what a tool call ran and what
  kind of work it was. Owns shell command decomposition, the closed tool
  registry and its subcommand tables, the activity taxonomy, primary-tool
  selection, the privacy class of every identity value, the resolver that
  turns a span into a tool identity, and the per-run aggregation with its
  time-attribution rule. Lives in `packages/core`, browser-safe, consumed by
  the adapters at parse time and by the visualizer at render time.

### Modified Capabilities

- `trace-ingestion`: adapters stamp tool-usage attributes on shell tool spans,
  capture command result flags and the invoked skill, validate reserved
  tool-usage keys arriving through OTLP, and the Claude Code adapter emits
  hook spans. "Tool target identity capture" is unchanged.
- `trace-sanitization`: the attribute allowlist gains the closed-vocabulary
  tool-usage keys; the free-form ones stay off it.
- `visualizer`: "Run time breakdown" gains the fifth segment, the activity
  breakdown and the tool table described above, plus their degraded states.

No `cost-engine` delta: no cost math or insight rule reads the new attributes.

## Impact

**`packages/core`**: new `tools/` module (decomposition, registry,
classification, resolver, aggregation) with a browser-safe subpath export;
tool emit sites in the claude-code and opencode adapters; reserved-key
validation in the OTLP adapter; `attribute-keys.ts`. No new dependency.

**`packages/ui`**: the Time view and `lib/time-breakdown.ts`. Every UI task is
`[UI → /frontend-design]` per CLAUDE.md. No new dependency.

**`packages/cli`**: none beyond what flows through `buildTraceFile`.

**Schema**: untouched. The new keys are reserved `runray.*` attributes, the
same mechanism `runray.targetKey` uses.

**Goldens**: every golden containing a shell tool span or a hook record
changes. Regenerated through `pnpm goldens` in dedicated commits, one after
the adapters stamp attributes and one after hook spans land.

**Fixtures**: committed fixtures replace command text with filler words, so
they exercise only the "unresolved" path. Decomposition and classification are
covered by table-driven unit tests and by adapter tests that build transcripts
inline. A fixture that preserves a command's program and subcommand needs a
scrubber change, which is gated on human sign-off (design D6).

**Insights**: no rule reads the new attributes and no finding changes. Hook
spans are a new span kind in Claude Code runs, so the three readers that
looked at every span regardless of kind learn to skip them: `dead-end-run`
(the run's terminal span), the reprice engine's "errors" risk flag behind
`model-mismatch`, and triage's count of declined calls. A guard test asserts
that findings on the fixtures are unchanged (design T9).

**Run bounds and depth**: a run with hook records starts where its first
hook began and ends where its last one ended, typically a second or two
either way, and `counts.maxDepth` is one higher where a hook hangs off the
deepest call.

## Decisions taken at sign-off

1. Registry ids, table subcommands, activity and flags survive `--redact` and
   the sanitized profiles; free-form names do not (design D1).
2. A call's whole duration goes to its primary tool; time in calls that ran
   two or more heavy tools is reported as shared (design D2).
3. Time blocked on the person becomes a fifth wall-clock segment (design D3).
4. The retry-loop identity keeps using the first-token key in this change; its
   replacement is a separate change (design D4).
5. Hook spans come in this change, labelled as failed-runs-only for duration
   (design D5).
6. Table-driven tests now; a scrubber that keeps a command skeleton only after
   explicit sign-off (design D6).
