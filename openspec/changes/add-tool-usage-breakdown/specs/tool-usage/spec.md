# Delta for tool-usage

## Purpose

Identifies which program or tool each tool call ran and what kind of work it
was, so tool time is reported per tool and per activity instead of per harness
tool name, without the command text ever leaving the parser.

## ADDED Requirements

### Requirement: Shell command decomposition
The system SHALL decompose a shell command string into pipelines (separated by
`&&`, `||`, `;`, a newline or a background `&`) and each pipeline into stages
(separated by `|`). Text inside quotes, command substitutions and heredoc
bodies SHALL never be split or read as a command. The same decomposition SHALL
apply to POSIX shells and to PowerShell.

#### Scenario: Compound command
- GIVEN the command `cd apps/web && pnpm test 2>&1 | tail -20`
- WHEN it is decomposed
- THEN it yields two pipelines, the second with the stages `pnpm` and `tail`

#### Scenario: Separator inside quotes
- GIVEN the command `git commit -m "fix; retry && done"`
- WHEN it is decomposed
- THEN it yields one pipeline with the single stage `git`

#### Scenario: Heredoc body is not a command
- GIVEN a command that writes a file through `cat <<'EOF' > notes.md` whose
  body contains the line `docker run --rm acme`
- WHEN it is decomposed
- THEN the only program found is `cat`

#### Scenario: PowerShell call operator
- GIVEN the PowerShell command
  `& "C:\tools\flutter\bin\flutter.bat" test; Get-Process`
- WHEN it is decomposed
- THEN it yields two pipelines whose programs are `flutter` and `get-process`

### Requirement: Program resolution within a stage
For each stage the system SHALL skip variable assignments, wrapper commands
and shell control keywords, then take the next word as the program and
normalise it to a lowercase basename without a Windows executable extension.
A program word whose last path segment contains an expansion SHALL be
unresolved.

#### Scenario: Assignment and wrappers are skipped
- GIVEN the stage `DATABASE_URL=x sudo timeout 30 docker ps`
- WHEN its program is resolved
- THEN the program is `docker`

#### Scenario: Loop keywords are skipped
- GIVEN the command `until curl -sf localhost:3000; do sleep 2; done`
- WHEN it is decomposed
- THEN the programs found are `curl` and `sleep`, and no keyword is reported
  as a program

#### Scenario: Windows path and extension
- GIVEN the stage `"C:\Program Files\Git\bin\git.exe" status`
- WHEN its program is resolved
- THEN the program is `git`

#### Scenario: Variable directory, literal name
- GIVEN the stage `$ANDROID_HOME/platform-tools/adb devices`
- WHEN its program is resolved
- THEN the program is `adb`

#### Scenario: Variable program is unresolved
- GIVEN the stage `"$BIN" --version`
- WHEN its program is resolved
- THEN the stage is unresolved and no program name is reported

### Requirement: Runner unwrapping
When a stage's program is a runner from the closed runner list (package
runners such as `npx`, `pnpm exec`, `uv run` and `python -m`, and nested
shells such as `bash -c`), the system SHALL resolve the tool the runner
launches and record the runner separately. Nested shell commands SHALL be
decomposed recursively to a bounded depth.

#### Scenario: Package runner
- GIVEN the stage `npx vitest run`
- WHEN it is resolved
- THEN the tool is `vitest` and the runner is `npx`

#### Scenario: Runner with workspace options
- GIVEN the stage `pnpm --filter web exec tsc --noEmit`
- WHEN it is resolved
- THEN the tool is `tsc` and the runner is `pnpm exec`

#### Scenario: Package name alias
- GIVEN the stage `npx @biomejs/biome check`
- WHEN it is resolved
- THEN the tool is `biome`

#### Scenario: Nested shell
- GIVEN the stage `bash -c "cd api && cargo test"`
- WHEN it is resolved
- THEN the inner command is decomposed and the tool is `cargo`

### Requirement: Closed tool registry
The system SHALL hold a closed registry mapping program names and aliases to a
tool id, a display label and a default activity. A tool id SHALL only ever be
a registry entry: a program name absent from the registry SHALL NOT produce a
tool id. Published ids SHALL be stable, and adding entries SHALL NOT change an
existing id.

#### Scenario: Known program
- GIVEN a stage whose program is `docker`
- WHEN it is classified
- THEN the tool id is `docker`

#### Scenario: Unknown program
- GIVEN a stage whose program is `acme-deploy`
- WHEN it is classified
- THEN no tool id is produced

#### Scenario: Alias
- GIVEN the stage `docker-compose up -d`
- WHEN it is classified
- THEN the tool id is `docker` and the subcommand is `compose up`

#### Scenario: Registry entries are complete
- GIVEN every entry in the registry
- WHEN the registry is validated
- THEN each has a non-empty label and an activity from the closed taxonomy,
  and no two entries share an id or an alias

### Requirement: Subcommand tables
For tools that have a subcommand table, the system SHALL report a subcommand
only when it matches the table, after skipping that tool's global options and
their values. A word that is not in the table SHALL NOT be reported.

#### Scenario: Global option with a value
- GIVEN the stage `git -C ../api diff --stat`
- WHEN it is classified
- THEN the tool is `git` and the subcommand is `diff`

#### Scenario: Two-word subcommand
- GIVEN the stage `docker compose -f dev.yml up -d`
- WHEN it is classified
- THEN the subcommand is `compose up`

#### Scenario: Word outside the table
- GIVEN the stage `git frobnicate ./secret-plan`
- WHEN it is classified
- THEN the tool is `git` and no subcommand is reported

### Requirement: Package-manager scripts
For package managers and task runners, a first word that is not one of the
tool's own commands SHALL be treated as a user-defined script: the subcommand
SHALL be `run`, and the script name SHALL be free-form identity text, used to
choose the activity and governed by the privacy rule for free-form values.

#### Scenario: Shorthand script
- GIVEN the stage `pnpm build`
- WHEN it is classified
- THEN the tool is `pnpm`, the subcommand is `run`, the script name is `build`
  and the activity is `build`

#### Scenario: Explicit run
- GIVEN the stage `npm run db:reset`
- WHEN it is classified
- THEN the subcommand is `run`, the script name is `db:reset` and the activity
  is `data`

#### Scenario: Own command
- GIVEN the stage `pnpm install --frozen-lockfile`
- WHEN it is classified
- THEN the subcommand is `install`, no script name is reported and the
  activity is `deps`

### Requirement: Activity taxonomy
Every tool call SHALL carry exactly one activity from the closed set
`explore`, `edit`, `run`, `check`, `build`, `test`, `vcs`, `deps`, `infra`,
`cloud`, `data`, `web`, `system`, `devices`, `agent`, `human`, `integration`,
`other`. A subcommand or script name SHALL override the tool's default
activity where the registry says so. A call that resolves to no registry tool
SHALL have activity `other`.

#### Scenario: Subcommand decides the activity
- GIVEN the stages `cargo test`, `cargo build` and `cargo clippy`
- WHEN each is classified
- THEN their activities are `test`, `build` and `check`

#### Scenario: Script name decides the activity
- GIVEN the stages `pnpm test:e2e`, `pnpm typecheck` and `pnpm dev`
- WHEN each is classified
- THEN their activities are `test`, `check` and `run`

#### Scenario: Unresolved call
- GIVEN a command whose only program is unresolved
- WHEN it is classified
- THEN the activity is `other`

### Requirement: Harness tool classification
The system SHALL classify harness tools by name, without reading their input:
file and search tools as `explore`, file-writing tools as `edit`, web tools as
`web`, delegation and planning tools as `agent`, and tools that block on the
person as `human`. MCP calls SHALL be `integration`. An unknown harness tool
name SHALL be `other`.

#### Scenario: Same activity across harnesses
- GIVEN a Claude Code `Read` call and an OpenCode `read` call
- WHEN each is classified
- THEN both have activity `explore`

#### Scenario: Blocking on the person
- GIVEN a Claude Code `AskUserQuestion` call and an OpenCode `question` call
- WHEN each is classified
- THEN both have activity `human`

#### Scenario: Unknown tool of a custom agent
- GIVEN an OTLP-imported tool span named `search_docs`
- WHEN it is classified
- THEN its activity is `other`

### Requirement: Primary tool selection
Among a command's programs the primary tool SHALL be the one whose activity
ranks highest in a fixed expected-duration order, ties going to the earlier
program; shell plumbing (`cd`, `export`, `echo`, `sleep` and the like) SHALL
rank last. Other distinct registry tools whose activity is neither `explore`
nor `system` SHALL be listed as also-ran tools, in order of appearance, at
most eight.

#### Scenario: Setup and output filter are not the tool
- GIVEN the command `cd web && pnpm test 2>&1 | tail -20`
- WHEN the primary tool is selected
- THEN it is `pnpm`, and there are no also-ran tools

#### Scenario: A slow activity outranks a quick one
- GIVEN the command `git add -A && pnpm build`
- WHEN the primary tool is selected
- THEN it is `pnpm`, and `git` is an also-ran tool

#### Scenario: Only utilities
- GIVEN the command `ls -la | grep config`
- WHEN the primary tool is selected
- THEN it is `ls`, and there are no also-ran tools

#### Scenario: Heavy tool downstream of a pipe
- GIVEN the command `cat dump.sql | docker exec -i db psql`
- WHEN the primary tool is selected
- THEN it is `docker`

#### Scenario: Only plumbing
- GIVEN the command `cd packages/ui`
- WHEN the primary tool is selected
- THEN it is `cd`, with activity `system`

### Requirement: Decomposition is total and bounded
Decomposition and classification SHALL be a pure, deterministic function of
the command text. It SHALL never throw on any input, SHALL read at most the
first 8,192 characters of a command, and SHALL run in time linear in the input
length. Identical commands SHALL produce identical results across spans, runs
and adapters.

#### Scenario: Malformed input
- GIVEN a command with an unterminated quote, stray operators and control
  characters
- WHEN it is decomposed
- THEN a result is returned without an error

#### Scenario: Oversized command
- GIVEN a command of one million characters
- WHEN it is decomposed
- THEN only its first 8,192 characters are read and the call completes

#### Scenario: Same command, same result
- GIVEN the same command text in a Claude Code `Bash` call and an OpenCode
  `bash` call
- WHEN both are classified
- THEN the results are identical

### Requirement: Privacy class of identity values
Every tool-identity value SHALL belong to one of two classes. Closed-vocabulary
values (tool id, table subcommand, activity, runner, flags) come from fixed
lists in core and SHALL be emitted in every redaction mode. Free-form values
(a program name outside the registry, a script name, a skill name) are session
text and SHALL be emitted only when redaction is off. No argument, path or
option value of a command SHALL ever be emitted.

#### Scenario: Parity of the closed class
- GIVEN the same command classified with redaction on and with redaction off
- WHEN the results are compared
- THEN every closed-vocabulary value is identical in both, and free-form
  values are present only without redaction

#### Scenario: Arguments never leak
- GIVEN the command `docker exec acme-db psql -U alice -c "select 1"`
- WHEN it is classified in either mode
- THEN the result contains none of `acme-db`, `alice` or the query text

#### Scenario: Program outside the registry under redaction
- GIVEN the command `acme-deploy --prod` classified with redaction on
- WHEN the result is read
- THEN it carries activity `other`, no tool id and no name

### Requirement: Tool identity resolution
The system SHALL resolve every tool, MCP and hook span to one identity through
a single function: a family (`shell`, `harness`, `mcp`, `skill`, `agent`,
`hook`), a tool key and label, an optional subcommand, an activity and flags.
Consumers SHALL use this resolution and SHALL NOT read tool-usage attributes
directly. A span without tool-usage attributes SHALL resolve to its harness
tool name.

#### Scenario: Shell span with identity
- GIVEN a shell tool span stamped with tool `docker` and subcommand `exec`
- WHEN it is resolved
- THEN the family is `shell`, the tool is `docker` and the subcommand is
  `exec`

#### Scenario: MCP span
- GIVEN an `mcp_call` span of server `playwright` and tool `browser_click`
- WHEN it is resolved
- THEN the family is `mcp`, the tool key is the server and the subcommand is
  the tool name

#### Scenario: Call that spawned a subagent
- GIVEN a tool span that is the parent of a subagent span of type `Explore`
- WHEN it is resolved
- THEN the family is `agent`, the tool key is `Explore` and the identity is
  marked as a container

#### Scenario: Trace produced before this change
- GIVEN a `Bash` span that carries no tool-usage attributes
- WHEN it is resolved
- THEN the family is `shell` and the tool key and label are `Bash`

### Requirement: Tool usage aggregation
The system SHALL aggregate a run's resolved spans into one row per tool, each
with its call count, error count, total time, shared time, also-ran time, and
nearest-rank p50, p95 and maximum duration, plus one sub-row per subcommand.
Rows SHALL be ordered by total time descending, then by key, so the output is
deterministic. Spans still in progress SHALL contribute a call and no time.

#### Scenario: One row per tool, sub-rows per subcommand
- GIVEN a run with four `docker exec` calls and one `docker ps` call
- WHEN the run is aggregated
- THEN there is one `docker` row with five calls and two sub-rows

#### Scenario: Deterministic order
- GIVEN two tools with identical total time
- WHEN the run is aggregated twice
- THEN both aggregations list them in the same order, by key

#### Scenario: Call in progress
- GIVEN a shell call with no result yet
- WHEN the run is aggregated
- THEN the call is counted and adds no time to any figure

### Requirement: Time attribution
A call's whole duration SHALL be attributed to its primary tool. A call with
at least one also-ran tool is shared: its duration SHALL count in the primary
tool's shared time and, separately, as also-ran time on each also-ran tool,
and SHALL NOT be added to an also-ran tool's total. The sum of row totals
SHALL equal the summed duration of the aggregated calls.

#### Scenario: A tool on its own
- GIVEN a 40-second call whose only tool is `vitest`
- WHEN the run is aggregated
- THEN `vitest` has total time 40 seconds and shared time zero

#### Scenario: Two tools in one call
- GIVEN a 60-second call `git add -A && pnpm build`
- WHEN the run is aggregated
- THEN `pnpm` has total time 60 seconds, all of it shared, and `git` has
  total time zero and also-ran time 60 seconds

#### Scenario: Totals are not inflated
- GIVEN any run
- WHEN the row totals are summed
- THEN the sum equals the summed duration of the aggregated calls

### Requirement: Containers, hooks and waiting stay out of tool time
Summed tool time SHALL exclude tool spans that contain a subagent, hook spans
and spans whose activity is `human`; each of the three SHALL be aggregated in
its own group. Activity totals SHALL partition summed tool time exactly.

#### Scenario: A delegation is not double-counted
- GIVEN an `Agent` call lasting three minutes whose subagent ran two minutes
  of tool calls
- WHEN the run is aggregated
- THEN the three minutes appear only in the agent group, and the subagent's
  tool calls count toward summed tool time once

#### Scenario: Waiting is not tool time
- GIVEN an `AskUserQuestion` call answered after ten minutes
- WHEN the run is aggregated
- THEN the ten minutes are absent from summed tool time and present in the
  waiting group

#### Scenario: Activities partition the sum
- GIVEN any run
- WHEN the activity totals are summed
- THEN the sum equals summed tool time
