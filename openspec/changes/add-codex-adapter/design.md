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
{"type": "event_msg",     "payload": {"type": "task_started", turn_id, started_at, root_turn_id?, turn_attribution?}}
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

One span per child thread, not one per parent turn it worked in. A reviewer
thread lives as long as its parent and is consulted again and again: the 147
that ran have 1,765 turns between them, and 67 of the 119 that name their
parent's turns name more than one. All of a thread's turns sit under the one
span, which hangs on the turn that first consulted it (T10), so 80 of the 147
spans end after the turn they hang on. The tokens are in the right run and
under the right agent; what is approximate is which of the parent's turns a
later review is shown under.

*Rejected:* a `subagent` span per parent turn. It would put every review
under the turn that asked for it, and it would cut one conversation into
several: a `subagent` span is a context scope to the insight rules, which
follow the prompt from call to call inside it, and to `counts.subagents`,
which would count one reviewer several times.

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
process, one that failed before calling anything, a `wait` on a command
another call launched. One exception: a call that failed or was stopped
while every action of it went through is a span too, next to its actions,
or the failure the model was handed would show nowhere (T7). A response
carried at most one call in the current format; 35 legacy responses made
several, and each call is read the same way.

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
Codex ids are, so they are kept, not filtered back out. xAI is the only
other listed provider with `responses` entries (seven
`grok-4.20-multi-agent` ids), and they come in the same way. `gpt-6-astra`
is upstream as a `chat` entry and needs only the refresh.

A refresh also takes models away, which the survey before sign-off did not
look at. The list drops a model once its provider retires it: between
2026-08-18 and 2026-11-14 it dropped 76 of the snapshot's 249 ids. With a
plain refresh 45 of them would become unpriced (`claude-opus-4-1`,
`claude-sonnet-4-20250514`, `claude-3-7-sonnet-20250219`, `grok-4`,
`gemini-2.0-flash` among them) and 28 would be priced by the prefix rule as
the current model their id starts with (`mistral-large-2402`, published at
4 / 12, as today's `mistral-large` at 0.5 / 1.5). RunRay prices sessions
that are already on disk, so a retired model still has runs to price. The
build script therefore keeps every entry the list no longer has, at its last
rates, and names those ids in `RETIRED_MODELS` next to the table
(`keepRetiredModels`; signed off on 2026-11-14 when the refresh showed the
loss). A model the list still has always takes the list's rates.
`--drop-retired` builds the snapshot without them.
*Rejected:* the plain refresh, for the regression above. *Rejected:* a
marker on each entry: `PricingTable` is also the shape of the user's
`pricing.json` and of the `/api/pricing` payload, and a list beside the table
touches neither.
*Cost:* an entry the list removed because it was wrong stays too; nothing
tells the two apart. And the truncation check of `pricing --refresh`
compared a download with half the snapshot's length, which retired entries
would raise with every refresh until a complete list was refused. It now
compares with the number of models the list itself held at the snapshot
(`bundledListSize()`, 287 here). `pricing --refresh` does not keep retired
models: the user's file replaces the bundled table whole, as before.

This moves numbers outside Codex. `gpt-5.3-codex` is the model of four
OpenCode fixtures and both OpenCode demo runs (286 calls); their costs rise
by 40%, their goldens are regenerated in 5.1, and the demo runs are rebuilt
with `pnpm demo:build`. The refresh itself moves one more golden, which the
survey before sign-off missed: `claude-fable-5-1`, the model of the Claude
Code fixture `duplicate-records`, was priced by prefix as `claude-fable-5`
and now has an entry of its own with a cache-read rate of 0.25 where the
base model has 1, so that run's cost falls from $1.09 to $0.75. A fixture
model id that still resolves only by
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

**The zstd decoder stops at the first frame.** `zlib.createZstdDecompress()`
ends its output at the end of the first frame and drops the rest of the
input with no error (Node 24.14; a file of two frames decodes as the first
one). A zstd file may be several frames back to back, so the reader starts a
new decoder at the offset where the last one stopped (`bytesWritten` is the
input consumed) until nothing is left. Bytes after a frame that are not a
frame reject the read. All 250 surveyed files are one complete frame, so
this is a guard, not a measured case.

The same decoder reports no error for a frame that is cut short. A
compressed rollout that ends early reads as the lines before the cut, the
last one possibly incomplete, which the parser reports as an unparseable
line. That is what a plain rollout still being written gives, and it is
accepted for the same reason.

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
  usage record in the same turn. The span starts at the latest of the turn
  start, the previous tool output and the end of the response before it
  (107 responses follow another with no tool between them, compactions
  among them), and ends at the usage record. That includes time to first
  token, which is model time. The output of a call the response itself made
  is not such a tool output, though it is sometimes written before the
  response's usage (always in CLI 0.77 to 0.147): a response does not begin
  when its own tool has finished.
- The model is the one the latest `turn_context` of the record's turn
  names, else the last one named in the file: 2 usage records of 13,535
  have neither and are `unknown`. A `turn_context` can precede the
  `task_started` of the turn it names (39 files), so models are kept by
  turn id, not by position.
- `outputPreview` is the first assistant `output_text` of the response;
  `promptPreview` is set on the turn (T6), not repeated on each call.
- Provenance is the line a reader wants behind the span: the response's
  first assistant message, else its first tool call, else the usage record.
- No `response_id` repeats within or across the 250 files.
- Response items with no usage record before the turn ends (an aborted
  response) produce no `llm_call`; their tool spans hang from the turn.

**Legacy rollouts** (CLI 0.47 to 0.147 in the sample) have no usage records.
There one `llm_call` is emitted per `token_count` event whose
`info.total_token_usage` differs from the previous one, with tokens from
`info.last_token_usage` and a span id derived from the thread id and the
record's ordinal. 1,443 of 9,037 `token_count` events repeat the previous
total and are skipped; an event with `info: null` is skipped. When a file has
usage records, `token_count` events are ignored.

The legacy era writes its records in two orders. CLI 0.47 writes a
response's token event before the response's items, which it records in one
batch once the tool has run (`T R C O T R C O … T M`, all 106 turns of that
version). The later legacy releases (0.77, 0.135, 0.147) write it after them
(`R C T O … R M T`, 36 turns). No file mixes the two. The order shows at a
turn's first token event: if the model has written nothing in the turn yet
(no reasoning, message or call), the items that follow an event belong to
the response that event counted, and they fill in its preview and
provenance as they are read. Reading 0.47 the other way hangs each item
from the response after its own and drops the turn's last message.

An event before the thread's first turn is never a call. Five child threads
open with a `token_count` that carries the total and the last usage of their
parent. All five have usage records, so the event is ignored today; in a
child with none (its only turn aborted before a response) it would be read
as a legacy call and count the parent's tokens twice. It sets the baseline
the next event is compared with. No legacy rollout has an event there, so
the 13 legacy files reconcile as before.

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
turn, otherwise `ok`. `promptPreview` is the first text of the turn's user
messages that is not harness context. A user message is a list of text
parts, and the harness writes its context as parts of their own that open
with a tag (`<environment_context>`, `<turn_aborted>`,
`<guardian_tool_descriptions>`, `<recommended_plugins>`, the `<image>`
wrapper, nine names in the corpus). The names are several lowercase words
joined by `_` or `-`, which pasted HTML is not, so the shape of the name is
the test, not a list. One block shares its part with the prompt:
`<in-app-browser-context>` is followed by what the person typed in 110 of
110 cases, so the text after a leading block's closing tag counts as the
person's. Measured over the 639 turns of the 67 root threads: 627 get a
preview, and the 12 without one hold only a `<send_user_message_question_reply>`
block. Records outside any turn attach to the session span.

A turn of the approval reviewer's thread has no `promptPreview`. Its user
message is the review request, which the harness assembles from the parent's
transcript and opens with plain text, so the tag test lets it through: 1,764
of the 1,765 reviewer turns got a preview, and the previews are 4 fixed
texts. No person wrote any of them. The thread is known by its source
(T10), whether it is read as a child or, with its parent not scanned, as a
run of its own; a child of any other kind keeps its prompt, which there is
the task its parent gave it.

### T7 — Attributing actions to calls

A model-level call is any `response_item` whose type ends in `_call` and
that carries a `call_id` (`function_call`, `custom_tool_call`, 2
`tool_search_call`; a hosted tool's record has no `call_id`). It waits for
its output from its own record to the first `…_output` record with the same
`call_id`. Every call in the survey had one; 5 `exec` calls have more (30
further outputs in all), written later for a script they had left running,
and those are ignored. A call still waiting when the next turn starts stops
waiting there.

An `item_completed` action (13,669 in the survey) is attributed, in order:

1. to the call whose `call_id` equals the item's `id` (2,020 actions: MCP
   tools and extensions the model called directly, and the file changes of
   the legacy era);
2. else to the call that was waiting when the action **started**, by the
   record's `started_at_ms` against the times of the call's two records;
3. else, for an action started while no call was waiting (168) or one with
   no start time (none in the survey: the 31 without one all fall under
   rule 1), to the call waiting now;
4. else to the call of the same turn that got its output last;
5. else to the turn the action names, or to the session outside any turn.

Rule 2 goes by the start because the record is written when the action
ends, and a command can outlive the call that launched it: the script
returns `Script running with cell ID …`, and the command ends while a later
`wait`, `sleep` or the next `exec` is waiting, or just after one. Going by
the moment of the record, as an earlier draft of this section did, gave
1,061 of the 11,649 actions without an id to a call that came after them:
the tool span then started before the response it hung from, the call that
launched the command stayed behind as a wrapper span next to it, and the
`wait` that only watched disappeared. No action started or ended with two
calls waiting, so the call waiting at a given moment is one call. After
rule 2, 87 of 16,406 tool spans still start before their parent does.

Rule 4 covers the record written just after its call's output when there is
no start time to go by. 27 actions are written after their turn's end
record and name that turn. For both reasons, whether a call is left without
an action is decided when the file has been read, not when its output or
its turn's end is.

The action span's parent is the `llm_call` of the response that made the
attributed call (T4: the usage record, or in the legacy era the token event,
that closes the items the call was read among), or the call's turn when that
response has none, or the action's turn or the session in case 5. Its id is
the item id. Its times are `started_at_ms` / `completed_at_ms`; without a
start (31 actions) it is the end less the item's `duration` (`durationMs` for
a sleep), else the time of its call's record. An item type the adapter does
not know is no action and no span.

A call with no attributed action becomes a span named after the call
(`exec`, `wait`, `update_plan`, `request_user_input_async`, `view_image`, …)
from its record to its output; with no output in the file it is
`in_progress`. So does a call whose output says it failed or was stopped
when none of its actions failed: a script that ran its commands and then
threw (18 of the 120 failed scripts, and 1 of the 4 stopped calls). Its
actions stay spans; the call is one more, a sibling under the same
`llm_call`, and counts in `toolErrors`. A failed script with a failed
command is not repeated (24), and neither is a call whose action carries
the call's id. The outcome is read from the output:

| output | seen | outcome |
|---|---|---|
| `Script completed` / `Script running with cell ID N` / `Script terminated`, then `Wall time N seconds`, `Output:` | scripts and `wait` | `ok` |
| `Script failed`, same head | 120 | `error`, preview from the text after the head |
| JSON `{output, metadata: {exit_code, duration_seconds}}` | 981 legacy `shell` and `apply_patch` calls | `tool.exitCode`, `error` when non-zero |
| `Exit code: N`, `Wall time: N seconds`, `Output:` | 354 legacy `shell_command` and `apply_patch` calls | the same, from the head |
| plain text from `shell`, `shell_command` or `apply_patch` | 71 | `error`: the harness could not run it (arguments it could not parse, a patch it refused); a command that ran always reports an exit code |
| text starting `aborted by user` | 4 `exec` calls | `cancelled` with `statusReason: user-rejected`, as the other adapters mark a call the person declined |
| anything else | `update_plan`, `view_image`, … | `ok` |

Span names are the harness's own, so the tool-usage resolver finds them in
`HARNESS_TOOLS`: `exec_command` for a `CommandExecution`, `apply_patch` for a
`FileChange`, `view_image` for an `ImageView`, the MCP tool name for an
`McpToolCall` (with `tool.mcpServer` and kind `mcp_call`), `web.search` and
the other extension kinds verbatim. The legacy era has no command actions at
all (0 `CommandExecution` items against 1,081 `shell` / `shell_command`
calls), so there a command is its call: the span keeps the call's name, and
its exit code and duration come from the output. The duration matters there:
CLI 0.47 writes a call and its output in one batch, so in 381 of 686 `shell`
calls the two records are closer together than the command ran, and the span
is the output's time less the reported duration. A legacy `shell` call whose
argv starts with `apply_patch` (238 cases) is named `apply_patch` (T9);
25 `apply_patch` calls also have a `FileChange` item, which carries the
call's id and is attributed by rule 1.

`tool.isError` and `status: 'error'` follow the item's `status: "failed"`
(for an MCP call it agrees with `result.isError` in all 2,011);
`tool.exitCode` is `exit_code`; `tool.outputBytes` is the byte length of
what the model was shown: a command's `formatted_output` (`aggregated_output`
in the 961 items of the older shape that lack it), a call's output text, or
the `output` field inside the legacy JSON form. The preview of a failure goes
through `error-preview.ts` and is taken from the command's output, a file
change's stderr, the first text part of an MCP result, or the call's output
after its head; 112 of 1,481 failures have no text to preview. Such a span
has no `content` field in either mode. Under redaction a preview is null
exactly where there is one without it: the two parses of a file differ in
values, never in which fields exist, which is what lets the sanitized forms
of both be identical (the "Redaction parity" scenario) without a rule in
`sanitize.ts` that looks at a span's status.

**MCP calls and extensions.** An MCP action's size is the text parts of
`result.content`; an image part is not counted. An action that carries its
call's id (rule 1) is a tool the model called directly: an MCP tool (1,728
of 2,011), a `sleep`, an `imagegen`. The call's output record is then
exactly what the model was handed for it, so its text size replaces the
item's, and it names the failure when the item gives no text. The item is
always written before that output. Every one of the 2,011 MCP spans in the
survey has a server and a size, and all 148 failed ones a preview.
Extensions carry no size of their own: a web search's `results` are not
what the model read, and the 9 failed image generations give no reason
(`failure: null`). An `ImageView` is a `view_image` span with no file
identity, since Codex has no read tool to pair it with (T9). An extension
of a kind not seen is named by that kind. Arguments, results, queries,
prompts, saved paths and plugin ids are never stored.

The scrubbed fixtures cannot show the first of these paths. The scrubber
replaces every key inside an MCP `result`, `content` and `text` included,
so there the size and the failure text of a call come from its output
record, or are absent for a call made from a script (9 of 63). Tests on
inline records cover the real shape.

### T8 — Unwrapping the shell

A command is an argv. The wrapper is recognised by the basename of
`argv[0]` without `.exe`, lowercased:

| wrapper | script | dialect |
|---|---|---|
| `pwsh`, `powershell` | everything after `-Command` / `-c`, joined | `powershell` |
| `bash`, `zsh`, `sh`, `dash` | the one element after `-c` (`-lc`, `-ic`) | `posix` |
| `cmd` | everything after `/c` / `/k`, joined | guessed from the text, as hook commands are |
| anything else | the argv written back as one command line, each argument quoted where a POSIX shell needs it | `posix` |
| a string, not an argv | the string | `powershell` in a thread whose working directory is a Windows path, else guessed from the text |

The script follows the switch that hands the shell a command, read the way
that shell takes it: PowerShell and `cmd` join what follows into one
command line, a POSIX shell takes the next word and treats the rest as its
arguments. In every command surveyed that is the last element. A wrapper
with no such switch was given a script file (`bash build.sh --fast`), which
is what is left after its own options. An argv with no shell in front keeps
its arguments apart: joined with bare spaces, `git commit -m "wip; pnpm
build"` would read as two commands and be classified as a build.

The script is the `command` that target identity and tool usage are
computed from. `adapters/target.ts` gets a `codex` row (`exec_command`,
`shell`, `shell_command` as command tools; `apply_patch` as a file-write
tool). `adapters/usage.ts` cannot take a row: its table fixes one dialect
per tool name, and for Codex the dialect belongs to the call. The adapter
passes the dialect with the script to `shellScriptAttributes`, which calls
the classifier the way the hook path does; a guessed dialect also turns on
the hook path's reading of a quoted program path, since `cmd` may be what
runs the script. The command comes from the `CommandExecution` item, or,
for a call to a tool the harness table marks as a shell
(`shell`, `shell_command`, `exec_command`), from the call's `command` or
`cmd` argument. A command that cannot be read is still stamped as a
classified shell call of activity `other`, as an empty command is in the
other adapters.

Seen: `pwsh.exe -Command` 7,685, `pwsh.exe -NoProfile -Command` 547,
`cmd.exe /c` 175, and in the legacy era `powershell(.exe)` with
`-Command`, `-NoProfile -Command` or `-NoLogo -NoProfile -Command` 490 and
`bash -lc` 17. The script is always the last element. 336 legacy calls carry
the script as a bare string (`shell_command` 331, `shell` 5) with nothing
that names the shell. The guess the hook path makes (a backslash before a
name character means a Windows shell) is not enough for them: every one is
in a thread working in a Windows directory, where Codex runs such a string
in PowerShell, and 176 have no backslash to go by. Reading those as POSIX
changes the tool for 8. The thread's directory therefore decides first. An
argv with no shell in front was not seen apart from the 238 legacy
`["apply_patch", …]` calls (T9); its program keeps its path unless the path
holds a space or a backslash and would not read back as one word.

Measured on the 250 rollouts: of 9,488 command spans (8,407 actions, 1,081
legacy calls) 9,075 resolve to a tool of the registry and 413 are the
"other command" row, the 238 legacy patches among them; none is left
unclassified. The tools at the top are `Get-Content`, `git`, `node`, `rg`
and `npm`.

The harness table gets the Codex names it lacked. `shell_command` is a
shell tool. `web.search` is `web` and `request_user_input_async` is
`human`. `exec`, `wait`, `sleep`, `clock.sleep`, `write_stdin`, `imagegen`
and `image_gen.generation` are none of the kinds "Harness tool
classification" names and are listed as `other`, which is also what an
unlisted name gets. `js` and `js_reset` are not listed: they are tools of
an MCP server Codex ships and all 1,728 calls are recorded as MCP actions,
while the table is shared by every source, where a tool that happens to be
called `js` is not an MCP call.

`runray.targetKey` is the hash of the script's first token, as for every
shell tool. In PowerShell that token is often not a program: 1,717 of the
9,220 command spans start with a here-string (683, one key between them),
the call operator `&` (310) or an assignment. The retry-loop rule groups
failures by tool name and target key, so it will merge unrelated failed
scripts on Codex runs. The rule is shared by all sources and is being
re-keyed on the classified program in a change of its own
(RunRay/runray#80); the adapter does not diverge from the shared key in the
meantime.

### T9 — File changes

One span per `FileChange` item. `linesAdded` / `linesRemoved`, on success
only: for `update`, the `+` / `-` lines of `unified_diff`; for `add`, the
line count of `content`; for `delete`, the line count of `content` as
removed. A final line break ends the last line and does not start another
(every added file in the survey ends with one), so a file of ten lines
counts ten.

A diff's `---` / `+++` header lines are not changed lines. Codex writes
none: all 3,130 diffs open with a sized hunk header (`@@ -20,3 +20,4 @@`).
The count therefore goes by hunks, which is also what keeps a removed line
whose own text begins with `--` (an SQL comment) from being taken for a
header: only lines inside a hunk count, and a sized hunk ends when the
lines it announces have been read. A diff with no hunk header is counted
line by line with `+++` / `---` lines left out. On the 54 threads with file
changes the result equals a plain count of `+` and `-` lines.

`runray.targetKey` and `runray.targetKind: 'file-write'` are stamped only
when the item changes exactly one path (1,014 of 2,058 items; the mean is
2.2 paths); otherwise the span carries no target identity, as OpenCode's
`apply_patch` does. A failed change keeps the identity of the file it was
aimed at, as a failed `Edit` does in the other adapters, and has no line
counts. `duplicate-read` gains nothing either way: Codex has no read tool,
it reads through the shell.

**Legacy patches.** The legacy era has no `FileChange` item for 568 patch
calls, in three forms: the `apply_patch` tool with the patch as its input
(300), a `shell` call whose argv is `["apply_patch", <patch>]` (238), and a
shell script that starts with `apply_patch` and holds the patch in a
here-document (30). Each is a span named `apply_patch`, not a command: no
tool usage is stamped, and the line counts and the single-file identity come
from the patch text (`*** Add File:` / `*** Update File:` / `*** Delete
File:` headers, `+` and `-` body lines). A deleted file has no body in a
patch, so its lines are not counted. A path a patch gives relative to the
working directory is joined to the directory the call ran in (its
`workdir` argument where it has one, else the thread's `cwd`) and has its
`.` and `..` resolved before it is hashed, so the file has the key a
current rollout gives it. A path already from the root is hashed as
written. The outcome is the call's
(T7): 94 of the 568 failed. 25 more `apply_patch` calls do have a
`FileChange` item, which carries the call's id (T7 rule 1) and is the span.

### T10 — Child threads

A child thread's span: kind `subagent`, id the child's thread id,
`agent.sessionId` the same id, `agent.name` from the source (`guardian` for
`source.subagent.other == "guardian"`; the key under `source.subagent`
otherwise, or `source.subagent` itself where it is a bare word; `unknown`
when neither is present or it is not one short word), name
`subagent:<agent.name>`. The value under a key is never the name: `other`
holds free text. Status `error` if any of its turns errored, else `ok`. It
starts with the thread's first turn, not with its file, which is opened long
before the reviewer is first asked. The child's turns and calls are emitted
beneath it exactly as a root's are.

Parent: a turn of the parent thread, found from the child's first turn in
this order.

1. The turn named in `turn_attribution.parent_turn_id`.
2. The turn named in `root_turn_id`, when the parent is a root thread. The
   id is a turn of the root, so it says nothing about a parent that is itself
   a child.
3. When the first turn names neither: the one turn of the parent that was
   running as it began. A turn the parent's file never closed counts as
   over once the parent started its next one.

Releases differ in what they write. Of the 147 child threads with a turn, 22
carry both ids (they agree on all 318 turns), 97 only `root_turn_id`, and 28
neither; every one of the 249 turns of those 28 began while exactly one turn
of its parent was running. All 1,516 turns that name a parent turn start and
end inside it. With the three sources all 147 threads land on a turn.

When no turn is found the span hangs on the parent thread's own span (the
session span for a child of the root) and the run carries a warning naming
the child. That covers a named turn the parent does not have, a thread that
names none and began while no turn or several were running, and a parent
thread that is not in the run. A child that names a turn its parent lacks is
not placed by the clock: what it says is wrong, and that is worth a warning,
not a guess. A child file that cannot be read is a warning too, and the rest
of the run stands: a file the system cannot open, a compressed one on a
runtime without zstd, or one that is not a rollout. Any other error while
reading a child is a defect of the reader and fails the run, as it would in
the root's file; a warning would hide it behind missing tokens.

Ids are unique within a rollout and, in what was surveyed, across a parent
and its children (no turn, response, call or item id of a child is also its
parent's). A child's span whose id the run already holds takes the child's
thread id in front.

Session and subagent spans are extended to end no earlier than what is under
them, by the walk the Claude Code adapter uses (`adapters/span-time.ts`,
shared by the two). A subagent span is also moved back to start no later
than what is under it: it opens with the thread's first turn, and a file may
record a call before that turn (none of the 147 does). The session starts
with its file, since a start computed from a duration must not move it.
Turns are left as the rollout brackets them, so a reviewer's span can end
after the turn it hangs on (D2).

### T11 — What never leaves the parser

Under `redact`: `promptPreview`, `outputPreview` and error previews are
`null`, and `runray.target` is absent. In every mode, nothing is emitted from
`base_instructions`, `git.repository_url`, `git.commit_hash`,
`creator_user_id`, `creator_account_id`, `encrypted_content`, `rate_limits`,
`world_state`, `thread_settings_applied`, script or command text, patch
bodies, or outputs. `project.path` is `cwd` and `project.gitBranch` is
`git.branch`, as for Claude Code.

"Nothing is emitted from" is about what the adapter reads. A preview is the
start of what a person, the model or a failed tool wrote, and can hold
anything they wrote: a commit hash is in two open previews of the 67 runs
surveyed, printed by the model and by `git`. That is what redaction nulls.
Text the harness wrote is not a preview: its context blocks are skipped, and
the reviewer's request is never taken (T6).

A redacted parse writes `promptPreview: null` on every turn and
`outputPreview: null` on every model call, and an open parse writes a
preview only where there is text. The sanitizer therefore gives a Codex run
those two keys on those two kinds, as it does for the other sources, so that
both parses come out the same. A tool span needs no arm: it has content in
both parses or in neither (T7).

Four values of the harness's vocabulary reach fields that redaction keeps:
the reason of an interrupted turn and the code of an API error
(`statusReason`), the kind of an extension (the span's name) and the kind of
a child thread (`agent.name`). Each is taken only when it is one word:
letters, digits, `_`, `.` and `-`, at most 40 characters. Every value
surveyed is (`interrupted`, `usage_limit_exceeded`, `web.search`,
`guardian`, 982 values in all). A sentence in the same place is dropped
unread: the status stays, the reason does not, and an extension is named
`extension`.

A run warning's message is kept as written by redaction and by the
sanitizer, which replace only its `file`. So no message of this adapter
holds text from a rollout or a path: a child file that cannot be opened is
named by the system's error code (`ENOENT`), whose message would name the
path.

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

`scripts/scrub-fixture.ts --source codex`, with the rules in
`scripts/scrub-codex.ts`. The posture is default-scrub as for the other
sources, and stricter in one respect: it applies to keys as well as values.
A rollout stores arbitrary payloads as native JSON (MCP arguments and
results, tool schemas, the world state), so a key such as `name`, `id` or
`status` that is structure in Codex's own records is user data two levels
further down. Preserving by key name alone, as the generic walker does,
would keep it.

- **Two modes.** In Codex's own structure a key is kept only when it is on
  the list of known schema keys (207 names, from a key-path survey of the
  250 rollouts), and its string value is kept only when the key is on the
  preserve list and the value is identifier-shaped. In a payload Codex does
  not define (`result`, object `arguments`, `parsed_cmd`, `dynamic_tools`,
  the world state, compaction history, search results) every key and every
  string is lorem; numbers, booleans and the nesting survive.
- **Unknown keys are scrubbed and reported.** A key outside the known list
  is replaced by lorem with its whole subtree, and its name is printed to
  the person running the script. A new Codex field is a visible gap in the
  fixture, never an unreviewed value in git.
- **Paths as keys.** `FileChange.changes` is an object keyed by absolute
  path; those keys are canonicalised the way path values are.
- **Paths, strictly.** The shared `scrubPath` keeps whatever follows the
  last dot of a segment, so a dot-directory or a dotted name survives whole
  (`.codex` did, 51,142 times, in the first audit). Codex paths go through
  a variant that keeps an extension only after a non-empty stem and only
  when it is up to eight letters or digits. The shared function is left
  alone so the other sources re-scrub to the same bytes; fixing it there is
  a follow-up.
- **Diff shape.** In `unified_diff` and patch envelopes the marker lines
  (`*** … File:`, `@@`) and the first character of each change line keep
  their shape, a change line that reads as a `+++` / `---` header keeps
  reading as one, and `content` keeps its newline positions, so T9's line
  counts are the same before and after scrubbing.
- **Wrappers.** Behind a known wrapper the program name, the flags before
  the script and the drive are kept, the directories of `argv[0]` are lorem
  and the script is scrubbed. A flag is a dash and letters; a slash switch
  (`/c`) is one only behind `cmd`, since under every other shell `/word` is
  a path. A legacy `apply_patch` argv keeps its name and its patch keeps its
  shape. Any other argv is scrubbed element by element.
- **Call arguments.** A `function_call`'s JSON-encoded `arguments` is
  parsed, scrubbed and re-encoded: `command` as an argv or a script,
  `workdir` as a path, the parameter names of the built-in tools kept, any
  other parameter name lorem.
- **Output frames.** The lines the harness writes around an output
  (`Script completed`, `Script failed`, `Script error:`, `Script
  terminated`, `Script running with cell ID n`, `Wall time n seconds`,
  `Exit code: n`, `Output:`, and three more) are kept, since they carry the
  outcome the adapter reads; every other line is same-length lorem. A legacy
  output's `metadata.exit_code` and `duration_seconds` are kept.
- **Blobs.** `encrypted_content`, `base_instructions`, `image_url` and any
  long base64 string are replaced by a short fixed placeholder, not
  length-preserved lorem; they are megabytes the adapter never reads.
- **Identity.** `creator_account_id` and `creator_user_id` become anonymous
  stand-ins; `git.repository_url`, `commit_hash` and `branch` are replaced.
- **Compression.** A `.jsonl.zst` input is read compressed; the output is
  compressed when its own name ends in `.zst`. The marker record is the
  first line of the content either way.
- Preserved keys: the ids (`id`, `call_id`, `turn_id`, `root_turn_id`,
  `parent_turn_id`, `response_id`, `thread_id`, `parent_thread_id`,
  `session_id`, the window ids), `type`, `kind`, `role`, `phase`,
  `status`, `reason`, `codex_error_info`, `thread_source`,
  `turn_trigger`, tool `name`, `namespace`, MCP `server` and `tool`,
  `model`, `model_provider`, `timestamp`, `cli_version`, `originator`,
  and in `session_meta.source` the client name, the key under `subagent`
  and the value of `other`. Numbers are always kept.

Audited in memory against all 250 rollouts (121,445 records, 1,257 MB in,
465 MB out): no path segment, user or host name, repository value or
account id of a session found in its scrubbed output; ids, token counters,
statuses, exit codes, argv shapes, diff line counts and output frames equal
before and after; no unknown key and no guarded value. What survives as a
string is ids, timestamps and about 140 enum, tool, model and version values.

### T15 — Transcript slices

The slice behind a span is read from its provenance line with the rollout
reader, so a compressed file is read like a plain one (`transcript-codex.ts`,
called from `readTranscriptSlice` after the redaction refusal).

**One record is not always the answer.** An action (`item_completed`) holds
what was asked and what came of it. Two records do not, and the reader goes
on from the provenance line to the record that completes them:

- a call the model made (`function_call`, `custom_tool_call`): the first
  `*_output` record with the same call id. Only a line that contains the id
  is parsed. A call nothing answered is shown alone;
- a turn (`task_started`): the first user message of the turn with text of
  the person, read as the prompt preview reads it (T6), with the text of
  every part and not its first 200 characters. A turn that ends or is
  followed by another before such a message shows its own record.

*Rejected:* the record at the line and nothing else, as for Claude Code. A
command of the era before actions would show its arguments without its
output, and a turn would show a turn id.

**What is shown is chosen per record type, never a dump.** A
`session_meta` record also holds `creator_account_id`, `creator_user_id`,
the repository URL and a commit; a token event holds the account's rate
limits. T11 keeps these out of a run, and a slice is not a way around it: a
session shows ten named keys and its instructions, a usage record its
counts. A record of a type no span is read from (`turn_context`,
`world_state`, `compacted`) is `unavailable`: the file is not what it was
when the run was built.

**Binary data is named, not shown.** A message part that is not text, and
any segment that is one run of 512 or more base64 characters (bare or as a
data URL), reads `(not text)`. Measured on the surveyed sessions: the result
of every image generation is its image in base64, about a megabyte, which
filled the size cap with letters. An empty text reads `(empty)`.

**A rollout compressed since the build is `unavailable`**, with a reason
that says so. The compressed file has the same lines, but the run names the
plain one and a rebuilt view names the right one. Reasons carry an error
code, never the message: the message holds the path.

Measured: all 1,183 spans of the fixtures give an `ok` slice (5.1 s in all,
the slowest 17 ms). A sample of 714 spans over the surveyed sessions, one of
each kind and name per run, gives 714 `ok`, the slowest 1.1 s in a rollout
of several hundred megabytes: a slice reads its file from the start, as the
other sources do.

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
- **[Context compaction]** → Settled in task 1.4. Of 111 `compacted`
  records that name a `compaction_response_id`, 106 have a
  `token_usage_record` with that `response_id` directly before them, in the
  running turn: a compaction is one more response and one more `llm_call`.
  The other 5 open a reviewer thread with history the parent compacted;
  their usage record is in the parent's file, so
  `latest_token_usage_record` is never read (it would count those tokens
  twice). Both kinds are in the fixtures.
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
