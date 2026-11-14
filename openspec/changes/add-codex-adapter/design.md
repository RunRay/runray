# Design: add-codex-adapter

The spec deltas state the *what*; this records the *why*, the rejected
alternatives and the evidence. Ids `D1`–`D6` are the decisions signed off by
the maintainer on 2026-11-14; `T1`–`T14` are technical decisions that follow
from them.

## Context

See `proposal.md` for the motivation. The constraints that shape the approach:

- **The adapter contract** (`packages/core/src/adapter.ts`): `detect()` is a
  cheap scan, `parse()` turns one candidate into raw spans, redaction happens
  in `parse()`, and everything after it (pricing, normalization, insights) is
  source-agnostic.
- **The schema is frozen at 0.1.0.** `source.tool` and `source.format` are
  closed enums without a Codex value.
- **Command text never leaves the parser**, and target identity and tool
  usage are computed from it at parse time (`adapters/target.ts`,
  `adapters/usage.ts`).
- **Fixtures are scrubbed real logs.** Nothing may be hand-written, so a
  variant with no real sample cannot have a fixture.
- **No new dependency without a note**, and no network at runtime.

Evidence: 250 rollout files under `~/.codex/sessions` on one Windows machine,
written by Codex Desktop and the VS Code extension between 2025-10 and
2026-10 (CLI versions 0.47 to 0.162): 67 root threads and 183 child threads,
121,445 records, 13,535 usage records, 12,661 tool calls. Every figure in
this document is over all 250 files unless it says "sample", which means the
229 files under 3 MB (64,707 records) that the first pass read. Only record
types, key sets, counters and closed-vocabulary values were read.

13 files are in the legacy shape (no usage records), 201 in the current one,
and 36 are child threads with no turn.

What a rollout looks like:

```
{"timestamp": "...Z", "ordinal": 0, "type": "session_meta", "payload": {id, cwd, git, model_provider, parent_thread_id?, thread_source?, ...}}
{"type": "event_msg",     "payload": {"type": "task_started", turn_id, started_at, turn_attribution?}}
{"type": "turn_context",  "payload": {turn_id, model, effort, cwd, ...}}
{"type": "response_item", "payload": {"type": "message" | "reasoning" | "function_call" | "custom_tool_call" | "..._output", call_id?, ...}}
{"type": "token_usage_record", "payload": {response_id, turn_id, usage, turn_token_usage, thread_token_usage}}
{"type": "event_msg",     "payload": {"type": "item_completed", item: {type: "CommandExecution" | "FileChange" | "McpToolCall" | ...}, started_at_ms?, completed_at_ms}}
{"type": "event_msg",     "payload": {"type": "token_count", info: {last_token_usage, total_token_usage}}}
{"type": "event_msg",     "payload": {"type": "task_complete" | "turn_aborted", turn_id, duration_ms, error? | reason?}}
```

`timestamp` is ISO-8601 with milliseconds on every record. Within a file
timestamps never go back and `ordinal` increases strictly, in all 121,445
records, so file order is the order of events.

## Goals / Non-Goals

**Goals:**

- A Codex session discovered with no configuration renders with the same
  views, cost math and insights as a Claude Code one.
- Token totals of a run equal what Codex itself counted for the thread.
- The Time & Tools tab names the programs a Codex session ran.
- Unknown record types and unverified variants degrade to a warning or to
  nothing, never to a crash or a wrong number.

**Non-Goals:**

- Reading Codex's SQLite files, its logs database or its global state.
- Session titles (T13).
- A span per reasoning item, per message or per context compaction.
- Multi-file target identity for one patch.
- Any insight rule built for Codex alone.
- Splitting the time of one `exec` call between the model-written script and
  the commands it ran beyond what the harness records give.
- `runray.toolFlags` (background, timeout, interrupted) for Codex commands.
  A yielded script is visible in the call's output text, but no field was
  found that states it; reading it from prose is left for a fixture-backed
  follow-up.

## Decisions

### D1 — Schema 0.2.0 with two enum values

`SourceToolSchema` gains `codex`, `SourceFormatSchema` gains `codex-jsonl`,
`SCHEMA_VERSION` becomes `0.2.0`. `docs/02-DATA-MODEL.md` already rules that
an addition after the freeze takes a minor bump.

*Rejected:* reporting Codex runs as `source.tool: 'unknown'`. The source
filter, the playbooks, the per-source suggestions and the cost note all key
on the tool, and `SourceAdapter.id` excludes `unknown` by type.

*Rejected:* one format value per compression (`codex-jsonl-zst`). Compression
is a property of the file, visible in `source.files`; the record format is
the same.

No runtime code validates `schemaVersion` on read (`TraceFileSchema` is used
to generate the JSON Schema and to type the writers), so there is nothing to
make tolerant. Tests pinning `'0.1.0'` and the example trace move with it.

### D2 — Reviewer threads nest as subagents

A rollout whose `session_meta` carries `parent_thread_id` is a child thread.
On the surveyed machine every child is an approval-reviewer thread
(`thread_source: "guardian_review"`, `source: {subagent: {other:
"guardian"}}`, model `codex-auto-review`); all 183 had their parent on disk,
a parent had at most 16 children, and 36 children had no turn at all.

A child becomes one `subagent` span in the parent's run, with its own turns
and calls beneath it. This is what the OpenCode adapter does with child
sessions, and it puts the reviewer's tokens in the run that caused them.

*Rejected:* listing children as runs (183 of 250 rows would be reviews).
*Rejected:* dropping them (their usage is real and nothing else reports it).

A child with no turn is dropped silently: it is the reviewer started and
never consulted, the same class as a transcript with no prompt yet.

### D3 — Turn spans

`task_started` and `task_complete` / `turn_aborted` bracket a turn and carry
`turn_id`, a start time and `duration_ms`. The schema has had `kind: 'turn'`
since 0.1.0 and the OTLP adapter emits it, so the waterfall, the cost
breakdown and the sanitizer already handle it.

*Rejected:* flattening calls under the session as the Claude Code adapter
does. Codex is the only native source that records why a turn stopped
(`interrupted`, `usage_limit_exceeded`, `server_overloaded`), and a child
thread's link to its parent is a turn id (T9).

Cost: runs are one level deeper, so `counts.maxDepth` is one higher than an
equivalent Claude Code run. Rules that walk ancestors already look through
`turn` spans; T12 audits the ones that read `parentId` directly.

### D4 — Tool spans are harness actions

Current Codex gives the model one tool, `exec`, whose input is a script
(`text(await tools.exec_command({...}))`, `tools.apply_patch`,
`tools.write_stdin`, `tools.web__run`, MCP tools). What ran is recorded as
`event_msg / item_completed`:

| item type | count | carries |
|---|---|---|
| `CommandExecution` | 8,407 | argv, `exit_code`, `status`, `duration`, output |
| `FileChange` | 2,058 | per-path `add` / `update` / `delete` with content or diff, `status` |
| `McpToolCall` | 2,011 | `server`, `tool`, `duration`, `result.isError` |
| `Extension` | 771 | `kind`: `web.search`, `clock.sleep`, `image_gen.generation` |
| `ImageView` | 422 | a path |

Each of these is a tool span. The model-level call is a span only when no
action is attributed to it under T7: a script that polled a background
process, one that failed before calling anything, a `wait` that timed out.
A response carried at most one call in the whole corpus.

*Rejected:* a span per model-level call. Every command would be named `exec`.
*Rejected:* both levels as parent and child tool spans. `counts.toolCalls`
and tool time would count the same work twice.

### D5 — zstd through `node:zlib`, feature-detected

`zlib.createZstdDecompress()` exists from Node 22.15.0 and 23.8.0 and is still
labelled experimental in the Node documentation. The package declares
`node >= 22`. The reader checks for the function; when it is missing, a
compressed candidate fails with one error that names the Node version, the
same shape as `SqliteUnavailableError`, and discovery reports it as a skipped
entry. Plain `.jsonl` rollouts are unaffected.

*Rejected:* a zstd package from npm. It is a new dependency for a capability
the runtime has, and a native one would repeat the install problems that made
`better-sqlite3` optional.
*Rejected:* raising `engines` to `>=22.15`. It would block installs for
people who never touch Codex.

### D6 — Refresh the snapshot, keep Codex ids, never alias

The bundled snapshot is dated 2026-08-18 and has no entry for the newest
Codex model on the surveyed machine. It is refreshed with
`scripts/build-pricing-snapshot.ts` in this change.

The refresh alone is not enough. The snapshot holds no id containing
`codex`, because `convertLitellmPricing` keeps only entries whose `mode` is
`chat`, and the upstream list files every OpenAI Codex-family model as
`mode: "responses"`. A Codex id therefore prices through the prefix rule as
whatever shorter id it starts with. Read from the upstream list on
2026-11-14 (per million tokens, input / output):

| id | published | prices today as | effect |
|---|---|---|---|
| `gpt-5-codex` | 1.25 / 10 | `gpt-5` 1.25 / 10 | none |
| `gpt-5.1-codex`, `-codex-max` | 1.25 / 10 | `gpt-5.1` 1.25 / 10 | none |
| `gpt-5.1-codex-mini` | 0.25 / 2 | `gpt-5.1` 1.25 / 10 | five times too high |
| `gpt-5.2-codex` | 1.75 / 14 | `gpt-5.2` 1.75 / 14 | none |
| `gpt-5.3-codex` | 1.75 / 14 | `gpt-5` 1.25 / 10 (no `gpt-5.3` upstream) | 29% too low |

The converter keeps `responses` entries as well as `chat` ones, for the
providers it already lists, so each id resolves to its own entry (signed off
on 2026-11-14). The mode is the filter, so the same change brings in the 18
other OpenAI `responses` ids: the `-pro` models (`gpt-5-pro`, `gpt-5.2-pro`,
`gpt-5.4-pro`, `gpt-5.5-pro`, `o1-pro`, `o3-pro`) and the deep-research
ones. Those are mispriced by the same prefix rule today, far more than the
Codex ids are, so they are kept, not filtered back out. `gpt-6-astra` is
upstream as a `chat` entry and needs only the refresh.

This moves numbers outside Codex. `gpt-5.3-codex` is the model of four
OpenCode fixtures and both OpenCode demo runs (286 calls); their costs rise
by 40%, their goldens are regenerated in 5.1, and the demo runs are rebuilt
with `pnpm demo:build`. A fixture model id that still resolves only by
prefix fails the test in 5.1 unless it is on a short documented list with
the reason. `codex-auto-review` is
not a published model; it stays `costSource: 'unknown'`, counted by the
existing coverage warning. Mapping it to another model's price would be a
guess, which the cost engine does not make.

### T1 — Rollouts are the only input

`state_*.sqlite` and `thread_history_*.sqlite` are projections: the latter
keeps `next_rollout_byte_offset` per thread, and the former still lists
`.jsonl` paths for files that are `.jsonl.zst` on disk. Their names carry a
schema counter that changes between releases. The adapter reads none of them,
so it needs no SQLite binding and cannot lock a live Codex.

### T2 — Discovery

- Default root: `$CODEX_HOME/sessions`, else `~/.codex/sessions`. Not
  `~/.codex`: that directory holds databases written every few seconds, and
  zero-config watch would rebuild continuously.
- A candidate file is named `rollout-*.jsonl` or `rollout-*.jsonl.zst`, at
  any depth under a root (`YYYY/MM/DD/`).
- `detect()` reads the first record of each file to learn `id` and
  `parent_thread_id`. This is the same bounded sniff the other adapters do
  (Claude Code reads 1 KB for OTLP, OpenCode reads a session file for
  `parentID`). Measured: 337 ms for 250 compressed files, the largest first
  record 49 KB.
- Children are attached to the candidate of their root thread (following
  parent links, so a child of a child lands in the same run). A child whose
  parent is not among the scanned files becomes a candidate of its own.
- A thread present as both `.jsonl` and `.jsonl.zst` is one candidate, and
  the plain file wins: it is the one a live session appends to.
- `runRef` is the root file path. Candidates are sorted by `runRef`.

The session id in the filename matched `session_meta.id` in 250 of 250 files,
but the id is taken from the record, not the name.

### T3 — Reading

One streaming line reader in core (`createReadStream`, optional zstd
decompression, a splitter on LF) serves `detect()`, `parse()` and the
transcript slice. An unparseable line is a run warning with its line number;
a byte-order mark on line one is stripped; a record type the adapter does
not know is skipped silently.

**Not `node:readline`.** It also ends a line at U+2028 and U+2029, which
JSON allows unescaped inside a string. One record in the corpus (a tool
output) holds a raw U+2028; read through `readline` it arrives as two
fragments, neither of which parses, and the record is lost. The reader
splits on the LF byte and nothing else, and decodes UTF-8 across chunk
boundaries. The Claude Code adapter and `transcript.ts` read through
`readline` and have the same defect (22 records in 12 of 2,787 local
transcripts); fixing them is a separate change.

Measured: the largest file is 157 MB compressed, 257 MB of text, 6,537
lines with a longest line of 9.7 MB, read and `JSON.parse`d in 2.2 s. All
250 files take 57 s, nearly all of it in the 21 root threads over 3 MB. That
is the cost of one full build until the persistent run index lands
(`add-persistent-index`); task 5.5 records it against the budgets.

### T4 — One llm_call per response

`token_usage_record` is written once per API response, after the response's
items and before any tool runs (`custom_tool_call → token_usage_record →
item_completed → custom_tool_call_output` is the dominant sequence). It
carries `response_id`, `turn_id` and three counters; `usage` is the
response's own.

- Span id: `response_id`. Model: the turn's `turn_context.model`. Provider:
  `session_meta.model_provider`, else `unknown`.
- Tokens come from `usage` only. `thread_token_usage` is not differenced: in
  7 of 181 threads it starts from a total inherited from the parent thread.
  In the other 174 the sum of `usage` equals the final thread total, which is
  the check task 8.1 runs.
- The span belongs to the turn its usage record names in `turn_id`, or to
  the latest started turn when that id names no turn in the file (T6).
- The response's items are the `response_item` records since the previous
  usage record in the same turn. The span starts at the later of the turn
  start and the previous tool output, and ends at the usage record. That
  includes time to first token, which is model time.
- `outputPreview` is the first assistant `output_text` of the response;
  `promptPreview` is set on the turn (T6), not repeated on each call.
- Response items with no usage record before the turn ends (an aborted
  response) produce no `llm_call`; their tool spans hang from the turn.

**Legacy rollouts** (CLI 0.47 to 0.147 in the sample) have no usage records.
There one `llm_call` is emitted per `token_count` event whose
`info.total_token_usage` differs from the previous one, with tokens from
`info.last_token_usage` and a span id derived from the thread id and the
record's ordinal. 1,443 of 9,037 `token_count` events repeat the previous
total and are skipped; an event with `info: null` is skipped. When a file has
usage records, `token_count` events are ignored.

### T5 — Token conversion

```
cacheRead  = cached_input_tokens
cacheWrite = cache_write_input_tokens                  (0 in every record seen)
input      = max(0, input_tokens − cacheRead − cacheWrite)
reasoning  = reasoning_output_tokens
output     = max(0, output_tokens − reasoning)
```

The five parts sum to Codex's `total_tokens`. The engine bills reasoning at
the output rate, so cost is the same as billing `output_tokens` whole.
`reasoning` is omitted when zero, as in the OpenCode adapter.

### T6 — Turns

A `turn` span has the id `turn_id`, starts at `task_started`, ends at the
`task_complete` or `turn_aborted` **with the same id**, and takes its
duration from the two record timestamps. Turns are matched by id, not by
position: five child threads carry a `task_complete` for a turn id that was
never started in the file, between the start and the completion of the real
turn. A completion or abort for an id with no `task_started` is ignored. No
turn id is started twice. Status: `cancelled` with `statusReason` from `reason` when
aborted, `error` with `statusReason` from `error.codex_error_info` when the
completion carries an error, `in_progress` when the file ends inside the
turn, otherwise `ok`. `promptPreview` is the first user message of the turn
that is not harness context; messages whose text starts with a tag the
harness writes (`<environment_context>`, `<turn_aborted>`, …) are skipped.
Records outside any turn attach to the session span.

### T7 — Attributing actions to calls

A model-level call is open from its `function_call` / `custom_tool_call`
record to the `…_output` record with the same `call_id` (all 5,567 calls had
one). An `item_completed` action is attributed, in order:

1. to the call whose `call_id` equals the item's `id` (2,020 actions: MCP
   calls, extensions, and the file changes of the legacy era);
2. else to the single open call (10,233 actions; no action ever arrived with
   two calls open);
3. else to the call that closed most recently in the same turn (1,416
   actions);
4. else to the turn, or to the session for the 18 actions outside any turn.

Rule 3 is not an edge case. An action's record is often written just after
its call's output: 983 of the 1,416 land within two records of that output,
and all but two are in the same turn. 353 of them follow an `exec` call
that had no action yet, so hanging them from the turn would also leave that
call as a wrapper span beside its own command, which D4 rules out. Whether a
call is left without an action is therefore decided when its turn ends, not
when its output is read.

The action span's parent is the `llm_call` of the response that made the
attributed call, or the turn in case 4. Its id is the item id, its times are
`started_at_ms` / `completed_at_ms` where present and the record timestamp
minus the item's `duration` otherwise. A call with no attributed action
becomes a span named after the call (`exec`, `wait`, `sleep`, `update_plan`,
`request_user_input_async`, …), `error` when its output says the script
failed.

Span names are the harness's own, so the tool-usage resolver finds them in
`HARNESS_TOOLS`: `exec_command` for a `CommandExecution`, `apply_patch` for a
`FileChange`, the MCP tool name for an `McpToolCall` (with `tool.mcpServer`
and kind `mcp_call`), `web.search` and the other extension kinds verbatim.
The legacy era has no command actions at all (0 `CommandExecution` items
against 1,081 `shell` / `shell_command` calls), so there a command is its
call: the span keeps the call's name, and its exit code and duration come
from the output's metadata. A legacy `shell` call whose argv starts with
`apply_patch` (238 cases) is named `apply_patch`; 25 of them also have a
`FileChange` item, which carries the call's id and is attributed by rule 1.

`tool.isError` and `status: 'error'` follow the item's `status: "failed"`;
`tool.exitCode` is `exit_code` (or `metadata.exit_code` in a legacy output);
`tool.outputBytes` is the byte length of what the model was shown
(`formatted_output`, or the output record's text in the legacy era). The
error preview of a failed action goes through `error-preview.ts`.

### T8 — Unwrapping the shell

A command is an argv. The wrapper is recognised by the basename of
`argv[0]` without `.exe`, lowercased:

| wrapper | script | dialect |
|---|---|---|
| `pwsh`, `powershell` | last element | `powershell` |
| `bash`, `zsh`, `sh`, `dash` | last element | `posix` |
| `cmd` | last element | guessed from the text, as hook commands are |
| anything else | the argv joined with spaces | `posix` |
| a string, not an argv | the string | guessed from the text |

The script is the `command` that target identity and tool usage are
computed from. `adapters/target.ts` gets a `codex` row (`exec_command`,
`shell`, `shell_command` as command tools; `apply_patch` as a file-write
tool). `adapters/usage.ts` cannot take a row: its table fixes one dialect
per tool name, and for Codex the dialect belongs to the call. The adapter
passes the dialect with the script, through an optional parameter of
`toolUsageSpanAttributes` or by calling the classifier the way the hook path
does.

Seen: `pwsh.exe -Command` 7,685, `pwsh.exe -NoProfile -Command` 547,
`cmd.exe /c` 175, and in the legacy era `powershell(.exe)` with
`-Command`, `-NoProfile -Command` or `-NoLogo -NoProfile -Command` 490 and
`bash -lc` 17. The script is always the last element. 336 legacy calls carry
the script as a bare string (`shell_command` 331, `shell` 5) with nothing
that names the shell; the same guess the hook path makes (a backslash before
a name character means a Windows shell) picks the dialect.

### T9 — File changes

One span per `FileChange` item. `linesAdded` / `linesRemoved`, on success
only: for `update`, lines of `unified_diff` starting with `+` / `-` that are
not `+++` / `---` headers; for `add`, the line count of `content`; for
`delete`, the line count of `content` as removed. `runray.targetKey` and
`runray.targetKind: 'file-write'` are stamped only when the item changes
exactly one path (the mean is 2.2 paths per item); otherwise the span carries
no target identity, as OpenCode's `apply_patch` does. `duplicate-read` gains
nothing either way: Codex has no read tool, it reads through the shell.

### T10 — Child threads

A child thread's span: kind `subagent`, id the child's thread id,
`agent.sessionId` the same id, `agent.name` from the source (`guardian` for
`source.subagent.other == "guardian"`; the key under `source.subagent`
otherwise; `unknown` when neither is present), name `subagent:<agent.name>`.
Parent: the parent run's `turn` whose id equals the child's first
`turn_attribution.parent_turn_id`; when no such turn exists, the session span
with a run warning. Status `error` if any of its turns errored, else `ok`.
The child's turns and calls are emitted beneath it exactly as a root's are.
Containers are extended to cover their children, as in the Claude Code
adapter.

### T11 — What never leaves the parser

Under `redact`: `promptPreview`, `outputPreview` and error previews are
`null`, and `runray.target` is absent. In every mode, nothing is emitted from
`base_instructions`, `git.repository_url`, `git.commit_hash`,
`creator_user_id`, `creator_account_id`, `encrypted_content`, `rate_limits`,
`world_state`, `thread_settings_applied`, script or command text, patch
bodies, or outputs. `project.path` is `cwd` and `project.gitBranch` is
`git.branch`, as for Claude Code.

### T12 — Source-specific text, not source-specific logic

`instructionsFile` returns `AGENTS.md` for Codex. The four other switches in
`insights/rules.ts` and `PLAYBOOK_SOURCES` get a Codex arm with levers that
exist in Codex. `cache-prefix-break` and `idle-cache-expiry` require a cache
write on the second call; Codex records none, so both are silent on Codex
runs. That is stated in the spec and left alone: detecting a break from a
read collapse alone is a different rule with different thresholds, and it
belongs in its own change.

Three checks ride along in the task that adds the Codex arms: that
`fixed-context-overhead` gives a finite estimate on a run with no cache-write
tokens (OpenAI entries in the snapshot carry the input rate as their write
rate, so the "written once" leg prices as plain input); that `expensive-subagent` reads sensibly when the subagent is the
reviewer; and that no rule reading `parentId` directly assumes an
`llm_call`'s parent is the session or a subagent.

### T13 — No title in this change

A rollout carries no title. Codex keeps thread names in
`~/.codex/session_index.jsonl`, outside the sessions root. Reading it would
make every candidate depend on a file that changes whenever any thread is
renamed, so every run would look modified to `--since` and to the watch. The
run has no `title`; the UI already has a fallback for that.

### T14 — Scrubbing Codex fixtures

`scripts/scrub-fixture.ts --source codex`, default-scrub as for the others,
with these Codex rules:

- **Paths as keys.** `FileChange.changes` is an object keyed by absolute
  path. The scrubber canonicalises those keys the way it canonicalises path
  values; the default leaves keys alone.
- **Diff shape.** In `unified_diff`, patch envelopes and `content`, the first
  character of each line and the `*** … File:` / `@@` marker lines keep their
  shape, so T9's line counts are the same before and after scrubbing.
- **Wrappers.** `argv[0]` and the flags before the script are structural and
  kept; the script is scrubbed.
- **Blobs.** `encrypted_content` and `base_instructions` are replaced by a
  short fixed placeholder, not length-preserved lorem; they are megabytes of
  text the adapter never reads.
- **Compression.** A `.jsonl.zst` input is decompressed, scrubbed and written
  back compressed; the marker record is the first line either way.
- Preserved keys beyond the existing list: `ordinal`, `call_id`, `turn_id`,
  `root_turn_id`, `parent_turn_id`, `response_id`, `thread_id`,
  `parent_thread_id`, `thread_source`, `model`, `model_provider`,
  `cli_version`, `originator`, `status`, `exit_code`, `phase`, `role`,
  `namespace`, item and record `type`, tool `name`, MCP `server` and `tool`.

## Risks / Trade-offs

- **[One machine, one OS, two clients]** → The parser is tolerant by
  construction (unknown records skipped, every field optional), each
  unverified variant below is listed in `fixtures/codex/README.md` with how
  to capture it, and none blocks the change.
  - Codex CLI in a terminal (`originator` other than Desktop / VS Code).
  - macOS and Linux argv (`bash -lc` seen 17 times, legacy era only).
  - Rollouts never touched by the 2026-10 migration, which rewrote old files
    into the current record shapes on the surveyed machine.
  - Multi-agent subagents: `thread_spawn_edges` was empty. T10 handles any
    `parent_thread_id`, with `agent.name` falling back to the source key.
  - A call the person declined: no sample. Until one exists it surfaces as
    whatever status the item carries, not as `cancelled`.
  - A thread forked or resumed by hand, which may replay history.
- **[A full build reads everything]** → 57 s for the surveyed machine's 250
  rollouts, against a few seconds for its other sources. `--since` and
  `--source` cut it today; the persistent index removes it. The number is
  measured in 5.5 and stated in the docs, not hidden.
- **[`--since` over-includes]** → Compression rewrote old files, so their
  mtime is the migration date. The filter can let an old session through; it
  cannot drop a recent one. Documented, not fixed.
- **[zstd is experimental in Node]** → It is read-only use of a stable
  format behind feature detection; a removal would surface as the D5 error,
  not as wrong data.
- **[Context compaction]** → 26 of 33 `compacted` records directly follow a
  usage record, which suggests the compaction request is counted like any
  response. Confirmed or refuted on the compaction fixture (task 1.4); if
  refuted, its usage is read from `latest_token_usage_record`.
- **[Reviewer cost is invisible]** → `codex-auto-review` is unpriced, so a
  run's dollar total excludes it while its tokens are shown. The coverage
  warning names the model.
- **[Tiered pricing]** → The engine has no long-context price tier. Existing
  limitation, shared with OpenCode runs on the same models.

## Migration Plan

Additive. A TraceFile written before the change differs from one written
after only in `schemaVersion` and, for Codex users, in having Codex runs.
Rollback is reverting the adapter registration; the enum values can stay.
The persistent run index (planned in `add-persistent-index`) keys its cache
on the schema version and will rebuild once.

## Open Questions

- Whether `session_index.jsonl` can supply titles without the freshness
  problem in T13 (for example by excluding it from the candidate's mtime).
- Whether Codex archives rollouts to a second directory on some platforms.
  None exists on the surveyed machine; a second default root is one line if
  it does.
