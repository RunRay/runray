# Design: add-tool-usage-breakdown

The spec deltas state the *what*; this records the *why*, the rejected
alternatives and the evidence. Ids `D1`–`D6` are the decisions signed off by
the maintainer on 2026-11-11; `T1`–`T12` are technical decisions that follow
from them.

## Context

See `proposal.md` for the motivation. The constraints that shape the approach:

- **The command text never leaves the parser.** Under `ParseOptions.redact`
  prompt-derived text must not leave `packages/core` adapters, and a shell
  command is prompt-derived. Anything learned from the command has to be
  learned at parse time and stored as something that is not content.
- **The schema is frozen.** `Span.attributes` is the only open slot; the
  `runray.*` prefix is already reserved for adapter-emitted keys
  (`runray.targetKey`, `runray.targetKind`, `runray.target`,
  `runray.mcpDetection`).
- **Sanitized exports use a key allowlist** (`attribute-keys.ts`,
  `sanitize/identity.ts`) that fails closed, and a redaction-parity invariant
  that compares a redacted and an unredacted parse after sanitizing.
- **Fixtures are scrubbed to filler words.** Every committed `Bash` command is
  lorem ipsum, so goldens cannot exercise program resolution.
- **A tool span's duration is one number**: `tool_use` timestamp to
  `tool_result` timestamp in Claude Code transcripts, the part's own start and
  end in OpenCode. Nothing inside a compound command is timestamped.

Measurement behind the numbers quoted here: 2,743 Claude Code transcripts from
one Windows machine (TypeScript, Flutter and Rust projects), 161,261 tool
calls, 75,217 of them shell calls, parsed with a prototype of the
decomposition below. Only program names were counted.

## Goals / Non-Goals

**Goals:**

- Every shell call resolves to the program that did the work, its subcommand
  and an activity, for Bash, PowerShell and OpenCode's `bash`.
- Identity that is safe to share survives `--redact` and the sanitized
  profiles; identity that is session text does not.
- One resolver and one aggregation in core serve every consumer, so the Time
  view, a later dashboard card and a later CLI report cannot disagree.
- The Time view reports tool time per activity and per tool, and says plainly
  where a figure is shared, partial or unavailable.
- Traces produced before this change keep rendering, at today's fidelity.

**Non-Goals:**

- Dividing one call's duration between the tools it ran.
- Separating permission-prompt wait from execution for transcript sources.
- Changing `runray.targetKey`, `runray.target` or any insight rule's identity
  (D4).
- A user-editable registry or per-project tool definitions.
- Cross-run surfaces (dashboard "By tool", run filter, waterfall labels).
- Parsing the remote command of `ssh host <cmd>` or a container command of
  `docker exec <container> <cmd>`: those are arguments and stay unread.

## Decisions

### D1 — Closed-vocabulary identity survives redaction; free-form does not

A registry id (`docker`), a table subcommand (`compose up`), an activity, a
runner and a flag are values chosen from lists that ship in core. Emitting one
discloses that the session used a well-known tool, which is the same class of
fact as an MCP server name or a harness tool name, both of which survive
redaction today. A program name outside the registry, a package-manager script
name and a skill name are text typed in the session. In the measured sample
the hundred program names outside the registry included component file names,
worktree directory names and task output file names, so "it is only a program
name" does not hold for the open tail.

Rule: closed-vocabulary keys are emitted in every mode and are on the
sanitizer allowlist; `runray.toolName`, `runray.toolScript` and `runray.skill`
are emitted only with redaction off and are never on the allowlist. A skill
name is treated as free-form because the skill vocabulary is the user's own;
note that a *forked* skill already surfaces its name as the subagent span
name, which this change does not alter.

Alternative rejected: treat the whole identity like `runray.target` and drop
it under redaction. That leaves a shared report with one `Bash` row, which is
the problem this change exists to solve. Accepted cost: a redacted export
discloses the tool stack (for example that a session ran `terraform`).

### D2 — A call's duration goes to its primary tool; shared time is reported, not split

Three options: give the whole duration to one tool and mark the call as
shared; give the whole duration to every tool in the command; split evenly.
The second inflates sums (a `Σ` larger than the calls it sums). The third
manufactures precision the log does not contain. In the sample 10% of shell
calls, holding 29% of shell time, ran two or more heavy tools, so the
uncertainty is too large to hide and too common to ignore.

Rule (spec: "Time attribution"): the primary tool's `total` takes the
duration; if the call has also-ran tools the same duration counts in the
primary's `shared` portion and as `alsoRan` time on each also-ran tool, never
in an also-ran tool's total. Row totals therefore sum to the calls' summed
duration, and the reader sees how much of a row is certain.

### D3 — Waiting on the person is a fifth wall-clock segment

`AskUserQuestion` held 80 calls and 37 hours in the sample, 11% of what the
Time view calls tool execution. The segment is fed by spans whose activity is
`human` (T8). Precedence inside one elementary interval of the sweep: model,
then tool execution, then waiting, then gap (idle or coordination). A tool
that runs while a question is pending is execution; the person waiting is not
what the session was doing.

This changes the "Run time breakdown" requirement (four segments become five)
and lowers `tool execution` on existing runs that contain questions.

### D4 — The retry-loop identity is not touched here

`detectRetryClusters` groups failures by `(name, runray.targetKey)` and the
key is a hash of the first token, so 38% of Bash calls share the identity
`cd`. That is a defect in the rule's input. Fixing it means either changing
what `runray.targetKey` hashes or pointing the rule at the primary tool, and
both move findings and goldens. It is a separate change with its own golden
regeneration and its own review; this change leaves `target.ts` byte-identical
and asserts that in a scenario.

### D5 — Hook spans from Claude Code transcripts, with the limit stated

The transcript records hooks in three shapes: `attachment` records of type
`hook_non_blocking_error` and `hook_cancelled` (hook name, event, command,
`durationMs`, exit code, the triggering `toolUseID`), and `system` records of
subtype `stop_hook_summary` (hook count, commands, errors; no duration).
Successful `PreToolUse` and `PostToolUse` hooks leave nothing. The sample has
25,636 failed-hook records, which the product currently ignores.

A fourth shape exists and is deliberately not a span: `attachment` records of
type `hook_additional_context`, written when a successful hook hands text
back to the model. They carry no duration and no outcome, and only the
successful runs that returned text leave one, so counting them would put an
arbitrary sample of successes next to the complete set of failures.

Rule: emit what is recorded (T9) and label hook time as covering failed and
cancelled runs only. Rejected: emitting nothing until the source records
successes, because the failures alone are useful (a hook failing on most edits
is worth seeing) and the label keeps the figure honest.

### D6 — Table-driven tests now; a skeleton-preserving scrubber only after sign-off

Committed fixtures cannot exercise resolution (commands are filler). Coverage
in this change comes from table-driven unit tests over literal command
strings, and from adapter tests that build small transcripts inline in the
test file, which is how the existing adapter tests already work. Goldens still
change, because every shell span gains `runray.toolActivity: "other"`.

A fixture that proves the whole path needs `scripts/scrub-fixture.ts` to keep
a command's skeleton (registry program and table subcommand) while replacing
everything else. That touches both fixtures and privacy, which AGENTS.md
reserves for a human decision, so it is task group 7 and must not start
without an explicit go-ahead. The change is complete without it.

### T1 — One module, `packages/core/src/tools/`, exported browser-safe

`shell.ts` (decomposition), `registry.ts` (entries, subcommand tables,
runner list, harness-tool table), `classify.ts` (command to classification),
`identity.ts` (span to identity), `usage.ts` (run to rows), `index.ts`.
Exported as `@runray/core/tools` and registered in `browser-safe.test.ts`, so
the import graph may contain only relative modules. Adapters call
`classify`; the UI calls `identity` and `usage` and reads labels from the
registry. This mirrors `triage/` and `waste/`.

### T2 — Stamp only what cannot be recomputed from the normalized span

Anything derived from tool input is stamped at parse time, because the input
is gone afterwards: the shell classification, result flags, the skill name.
Anything derivable from fields the span already has is resolved at read time:
a harness tool's activity (from `span.name`), the MCP roll-up (from
`tool.mcpServer`), whether a call is a container (it is the parent of a
subagent span), the hook family (from `span.kind`).

Alternative rejected: stamp an identity on every tool span. It rewrites every
golden line, makes old traces unclassifiable even where the name is enough,
and puts the harness-tool table in two places. With T2 an old trace still
gets `Read` classified as `explore`; only its shell rows stay at `Bash`.

Consumers never read the attributes. `identity.ts` is the single reader
(spec: "Tool identity resolution").

### T3 — Attribute set

| Key | Value | Emitted | Allowlisted |
|---|---|---|---|
| `runray.toolActivity` | activity enum | every shell span and every hook span whose command, or whose commands alike, ran one tool; every mode | yes |
| `runray.tool` | registry id | when resolved, every mode | yes |
| `runray.toolSub` | table subcommand, or `run` / `script` / `inline` | when present, every mode | yes |
| `runray.toolVia` | runner id from the closed runner list | when unwrapped, every mode | yes |
| `runray.toolsAlso` | array of registry ids, order of appearance, max 8 | when non-empty, every mode | yes |
| `runray.toolFlags` | subset of `background`, `timeout`, `interrupted`, fixed order | when non-empty, every mode | yes |
| `runray.hookCount` | number | stop-hook summary spans | yes |
| `runray.toolName` | program name outside the registry | redaction off | no |
| `runray.toolScript` | script name or script file basename | redaction off | no |
| `runray.skill` | skill name | redaction off | no |

Absent means "does not apply"; no key is ever emitted with an empty value.
`runray.toolActivity` is the marker that classification ran: a shell span
without it comes from a trace produced before this change.

`runray.toolName` is emitted only when the token has the shape of a program
name (`^[a-z0-9][a-z0-9._+-]{1,39}$` after normalisation). This keeps
fragments of inline scripts and quoted text out of the local view.

### T4 — A hand-written scanner, not a shell grammar

A single left-to-right pass over at most 8,192 characters with a small state
(quote kind, substitution depth, pending heredoc delimiter). It recognises
separators and word boundaries and nothing else: no expansion, no globbing,
no evaluation. PowerShell differs only in its escape character, the call
operator and `$x = …` assignments, handled by a dialect flag chosen from the
harness tool name. The scan marks which words opened with a quote, because
removing the quotes loses the one thing that tells `$dir = "D:\work"` (a
value) from `$out = docker ps` (a command). PowerShell takes a quoted word
for a string wherever a command could stand and runs it only through the
call operator, so a quoted word is never a program there: not after `$x =`,
not as a list element on a line of its own, not as text sent down a pipe. A
hook command is the exception: its dialect is a guess from the text, cmd may
be what runs it, and cmd runs a quoted path, so hook commands are read
without the marks. The body of a heredoc is skipped inside a command
substitution too, which is where commit messages are passed.

Alternatives rejected: a shell parsing library adds a runtime dependency
(AGENTS.md requires a justification), covers POSIX only, and throws on the
malformed and truncated commands transcripts are full of. A regex split on
`&&` and `|` breaks on quoted separators and heredocs, which is where commit
messages and inline scripts live.

Properties tested rather than assumed: never throws (property test over
random strings, and every hand-off the registry defines repeated up to the
cap), linear time (a bench entry on a capped chain of runners, which is the
worst case; the 1 MB entry shows the cap), nested-shell recursion bounded at
depth 2 and a chain of hand-offs at four. A hand-off is a runner, a runner
subcommand, a module flag or a skipped workspace name; past the fourth, the
program that would hand off again names the call. Without that bound a
command repeating `uv run` overflowed the stack and one repeating
`pnpm exec` cost quadratic time.

Known and accepted gap: about 7% of shell time in the sample starts with a
variable or a substitution in the program position (`"$BIN/tool"`, `$(which
x)`). That is unresolvable without evaluation and is reported as unresolved.

### T5 — Registry content and maintenance

An entry is `{ id, label, activity, utility?, plumbing?, subs?,
valueOptions? }`, plus the fields that say how a program hands off (`runner`,
`runnerSubs`, `moduleFlag`, `shell`, `interpreter`); aliases live in one
table beside the entries. `subs` maps a subcommand (one or two words) to an
optional activity override. Package managers and task runners carry their own command
list; any other first word is a script (spec: "Package-manager scripts"),
whose activity comes from name patterns, read per colon-separated segment:
`test*`/`e2e*`/`spec*`/`unit*`/`integration*` to `test`,
`build*`/`compile*`/`bundle*`/`assemble*`/`dist*` to `build`, `lint*`/
`format*`/`fmt*`/`typecheck`/`type-check`/`check*`/`verify*`/`validate*`/
`prettier*`/`eslint*`/`tsc*` to `check`, `db*`/`migrat*`/`seed*`/`prisma*`/
`drizzle*` to `data`, `dev`/`start`/`serve`/`preview`/`watch` to `run`. A name that matches nothing takes the tool's own activity (`make all`
is a build), except under a package manager, whose own default
(dependencies) says nothing about its scripts: there it is `run`. Tools that
take several targets in one call (`make`, `gradle`, `mvn`, `turbo`,
`xcodebuild`) are named by their best-ranked target, so
`gradle clean assembleDebug` is the assemble.

A file run by path (`./scripts/deploy.sh`, `.\build.ps1`) resolves to the
pseudo-tool `script`; its file name is free-form (`runray.toolScript`).

A prototype registry of 353 names covered 96.6% of shell calls and 89.9% of
shell time in the sample. The shipped registry is seeded more widely than
that sample, which under-represents Python, Go, JVM, .NET and Apple
toolchains. A test snapshots the id list so that removing or renaming an id is
a visible, deliberate diff; adding entries is routine.

The harness-tool table lives in the same file and is keyed by exact tool name
across harness vocabularies (Claude Code names are PascalCase, OpenCode names
lowercase, so one table serves both and OTLP imports).

### T6 — Primary tool by expected-duration rank

"First heavy tool" attributes `git add -A && pnpm build` to `git`. The sample
gives mean call durations per activity that separate cleanly: build 63 s,
check 51 s, test 34 s, data 25 s, cloud 19 s, deps 18 s, devices 17 s, web
16 s, run 12 s, infra 9 s, vcs 6 s, explore 3.5 s. The rank is that order
down to `vcs`, then the harness-only activities, then `other`, `system` and
`explore`, with plumbing last; ties go to the earlier program. `other` sits
above the utilities on purpose: in `ls && acme-deploy --prod` the program
outside the registry is the work, not `ls`. It is a fixed array in core
(`ACTIVITY_RANK`), not a per-run statistic, so the result stays a pure
function of the command.

Candidates are the programs of every stage, not only pipeline heads, so a
heavy tool downstream of a pipe (`cat dump.sql | docker exec -i db psql`) is
found. Also-ran tools are the other distinct registry tools whose activity is
neither `explore` nor `system`; utilities are left out because `head`, `tail`
and `grep` trail 63% of commands and would turn every row into "shared".

The rank comes from one machine. It is a heuristic for picking one name where
the log gives no answer, and D2's shared marker is what keeps it honest.

### T7 — What "summed tool time" contains

`Σ` is the summed `durationMs` of closed `tool_call` and `mcp_call` spans,
minus containers (a tool span that is the parent of a subagent span), minus
spans with activity `human`. Hook spans are not in it: a tool hook's time is
already inside its tool span in transcript sources. Containers, hooks and
waiting are aggregated as three separate groups. Activity totals partition
`Σ`. Percentiles are nearest-rank, the method `time-breakdown.ts` already
uses.

`Σ` is not wall-clock: parallel calls overlap. The wall-clock strip keeps
using the interval sweep; the activity bar is labelled as summed.

A container's time in the agent group is the longer of the call and the
subagent span it contains. The call alone understates it: in 120 recent
sessions from the measured machine, 203 of 257 `Agent` calls returned in under
a tenth of their subagent's duration (agents launched in the background), and
the calls summed to 201 minutes against 2,061 minutes for their subagents.

### T8 — How a span becomes "waiting"

Activity `human` comes from the harness-tool table: Claude Code
`AskUserQuestion` and `ExitPlanMode`, OpenCode `question`. The sweep in
`lib/time-breakdown.ts` gains a third event counter beside llm and tool.
OTLP `claude_code.tool.blocked_on_user` spans, which would also split
permission wait from execution, map to kind `other` today and stay that way;
mapping them is a follow-up, because it changes how the OTLP adapter nests
tool phases.

### T9 — Hook span construction

- `hook_non_blocking_error`: kind `hook`, name = `hookName` (event and
  matcher, e.g. `PostToolUse:Edit`), status `error`, `endedAt` = record
  timestamp, `startedAt` = that minus `durationMs`,
  `statusReason: "exit <code>"` from the record's exit code, parent = the span
  whose id equals `toolUseID` when one exists, else the transcript's container
  span. The exit code does not go into `tool`: the data model keeps that
  object for tool and MCP calls and names `statusReason` as the place for an
  exit code, and readers such as the dashboard's "worst tool" note take a
  span with `tool.isError` for a failed tool call.
- `hook_cancelled`: the same with status `cancelled` and
  `statusReason: "timeout"` when the record says it timed out.
- `stop_hook_summary`: kind `hook`, name `Stop`, zero duration at the record
  timestamp, `runray.hookCount`, status `error` when the record lists hook
  errors, else `ok`.
- The hook command goes through `classify` and is then dropped. A command of
  `callback` (an SDK callback hook) carries no tool. The transcript does not
  say which shell ran the hook, so a command with a backslash before a name
  character is read in the PowerShell dialect: bash would swallow that
  backslash, and a POSIX reading would glue the directories of
  `C:\Users\…\format.mjs` into the script name. A summary of one command is
  classified in full; a summary of several names a tool only when every
  command ran the same one.
- The span name survives redaction, like a tool span's, so it is taken from
  the record only when it is shaped like `Event` or `Event:matcher`; otherwise
  it falls back to the bare event, and past that to `hook`. The matcher is
  kept only for an event that matches on names (tool events, subagent events,
  session and compaction events, notifications) and only when it has the
  shape of a tool name or an agent type: no dot and no slash, so a hook that
  matches on changed files cannot put a file name into a redacted report.
- Span ids derive from the record's `uuid`, so the duplicate-record rule
  ("first occurrence wins") already covers re-appended transcripts.
- A container starts no later than a hook it holds. The record is written
  when the hook ends, so a hook that ran as the session opened began before
  the transcript's first record.

Measured on 150 recent sessions from one machine: every `PreToolUse` and
`PostToolUse` hook span lies inside its tool span (7,899 of 7,899), which is
what T7 relies on; hook spans move a run's start earlier in 103 sessions
(median 1.6 s) and its end later in 124 (median 2.8 s), and the run grows by
more than 1% in 5 of them.

Totals and triage count only `tool_call` and `mcp_call`, so hook spans do not
move them, with one exception: `counts.maxDepth` is the depth of the deepest
span, and a hook under the deepest call is one level deeper. Three readers
looked at every span regardless of kind and now skip hooks. `dead-end-run`
takes the last non-session span as the run's terminal span: a trailing failed
hook would create a finding, and a trailing `Stop` span would hide one. The
reprice engine marks a subtree risky for a model swap when a span in it
errored, so one failed hook silenced `model-mismatch` for a whole session.
Triage counts cancelled spans as calls the person declined, which a hook
cancelled on a timeout is not. The three corrections also apply to OTLP runs,
which already carry `claude_code.hook` spans.

### T10 — OTLP

No stamping: an OTLP tool span has a name and no command, so it is classified
at read time by the harness-tool table. Incoming `runray.tool*` keys are
validated against their vocabularies in every mode (spec: "Reserved
tool-usage keys from OTLP are validated"), which is what lets the sanitizer
keep them by key without inspecting values.

### T11 — Aggregation lives in core

`usage.ts` returns the ranked rows, the three side groups, `Σ` and the
activity totals. It takes an optional set of activities that narrows the rows
and nothing else, so a filtered table recomputes its counts and percentiles
while shares keep the run-wide denominator. A set, not one activity, because
the bar's neutral part stands for several. Activity labels live beside the
vocabulary in core (`ACTIVITY_LABELS`) for the same reason the registry
labels do.

An identity separates what is closed vocabulary from what is session text:
`sub` is a table subcommand or an MCP tool name, `detail` is a script or
program name. Sub-rows are keyed by both, so the local view shows
`run build` beside `run test:e2e` and a redacted trace degrades to one `run`
sub-row without a second code path. Shell calls whose program is not a
registry tool share one row under a fixed key (`other-command`), with the
program names as its sub-rows; under redaction that is the single nameless
"other command" row the visualizer spec asks for. A row's id includes whether
its key is a registry id, because OpenCode names its shell tool `bash`, which
is also a registry tool.

A hook row is keyed by the hook's name, and the tool its command ran is the
identity's `sub`, so two hooks on one event stay apart as sub-rows
(`PostToolUse:Edit` → `prettier`, `node format.mjs`) and the classification
stamped at parse time is shown rather than only stored. A stop-hook summary
has no one command and no duration: its identity carries the number of hook
runs it stands for, and the aggregation counts it as an untimed call. A zero
would read as "took no time" and pull every percentile of the row down, so
`untimed` calls add nothing to the time figures, the way calls still in
progress add nothing. The view says above the hook rows what they cover, by
source: a Claude Code transcript records only failed and cancelled runs,
while an imported trace carries whatever its exporter wrote.

The UI's `toolDurationStats` is removed with its last caller;
`toolDurationStatsAcrossRuns` stays, because the dashboard "By tool" card
still keys by harness name until its own change.

### T12 — Activity colors

The bar colors at most six activities and folds the rest into one neutral
part, with unresolved time drawn as a pattern. Within a run a color belongs
to its activity: selecting a part narrows the table and repaints nothing.
From one run to the next the same activity can take another color, because
the six go to the run's six largest activities (next paragraph). The palette is derived from the project's tokens under
`/frontend-design` and must pass adjacent-pair separation for common color
vision deficiencies on both the ink and the paper surface; the legend carries
every value as text, so color is never the only carrier.

The six colors are handed to the six largest activities in the fixed activity
order, so what sits next to what in the bar is always a pair of palette
neighbours, and that is the pair the check covers. The shipped ramp runs sky,
olive, pink, orange, blue, amber, then the neutral. It was found by searching
hue orders and lightness per theme for the largest minimum neighbour distance:
24.5 OKLab ΔE on ink and 26.5 on paper across normal vision, protanopia and
deuteranopia, every part at 3:1 or better on the card ground
(`activity-palette.test.ts` holds the floor at 12). Brand violet is left out
because it is model wait in the strip above, and red because it means error.
The first palette, taken from the mock, failed the check (8.9 between two
neighbours under protanopia) and was replaced.

## Risks / Trade-offs

- **Misattribution inside shared commands** → the shared marker and the
  also-ran figure (D2); the limit is stated in the view (spec: "Limits of
  tool time are stated").
- **A redacted export discloses the tool stack** → accepted at sign-off (D1);
  documented in `docs/02-DATA-MODEL.md` next to the keys.
- **Registry gaps look like "unresolved"** → locally the out-of-registry name
  is visible in the "other command" row, which is how a gap gets noticed;
  the id snapshot test keeps additions cheap and removals deliberate.
- **A wrong id from unusual syntax** → the scanner reports unresolved rather
  than guessing whenever the program position holds an expansion; arguments
  are never candidates, so `echo docker` and `ssh host docker ps` resolve to
  `echo` and `ssh`.
- **Golden churn** → two dedicated regeneration commits (after stamping,
  after hooks), each reviewed as a diff that adds attributes or hook spans and
  changes nothing else.
- **Hook spans add rows to the waterfall** → they are a span kind the UI
  already styles; zero-duration `Stop` spans add no time; if noise shows up in
  review, hiding zero-duration hooks by default is a UI-only follow-up.
- **Time includes permission wait** → cannot be fixed from transcripts; stated
  in the view. Edit averages 4.2 s per call against 0.5 s for Read in the
  sample, which is the size of the effect.
- **Parse cost** → one bounded pass per shell span; `pnpm bench` gains an
  entry and must stay inside the existing budgets.

## Migration Plan

Additive. No schema version change, no stored-state migration.

1. Core module and tests land first; nothing calls it, goldens byte-identical.
2. Adapters stamp attributes; goldens regenerated in a dedicated commit.
3. The Time view switches to the new aggregation. Reports exported before
   step 2 render in the degraded state (spec: "Tool usage degraded states").
4. Hook spans land with their own golden regeneration.

Rollback is per step: the attributes are ignored by every consumer that does
not go through `identity.ts`, so reverting the UI step alone restores the old
table.

## Open Questions

- Whether OpenCode's `skill` tool records the skill name in a field the
  adapter can read. The capture is specified as "where the source records
  it", so the answer changes one table entry, not the spec.
- Whether newer Claude Code versions add a duration to `stop_hook_summary`
  entries. If they do, the `Stop` span gets a real duration with no spec
  change.
