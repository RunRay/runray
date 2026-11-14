# codex fixtures

Codex session logs ("rollouts") for the `codex` adapter (change
`add-codex-adapter`). Codex writes one file per thread to
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`
(`~/.codex/sessions` when `CODEX_HOME` is unset; on Windows
`%USERPROFILE%\.codex\sessions`) and later compresses it in place to
`.jsonl.zst`. Each line is one record: `{timestamp, ordinal, type, payload}`.
Codex records no cost; RunRay computes it from tokens.

Every file here went through `pnpm scrub … --source codex`, carries the
`SCRUBBED` marker as its first line, and keeps its real file name: the name
holds only the start time and the thread id, both of which are also inside
the file. `scripts/codex-fixtures.test.ts` reads these files on every test run
and fails if any string in them is something other than lorem, an id, a
timestamp, a canonical path, a harness line, the blob placeholder or an
identifier under a structural key, or if an object key is anything but an
identifier or a canonical path. While a file here is new or changed against
git, the same test also searches it for the OS user name and the host name
of the machine it runs on, which is the machine that captured it.

## The set

| Variant | Files | What it is for |
|---|---|---|
| `simple` | 1 plain | One root thread, current format (CLI 0.155): 1 turn, 20 responses, 14 commands behind `pwsh.exe -Command`, 2 file changes, 1 MCP call, 17 extension items. No errors, no reviewer threads. |
| `zstd` | 1 compressed | The **same session as `simple`**, stored as `.jsonl.zst`. The two must normalise to the same run apart from the file name ("Same content, either form"). |
| `guardian` | 3 plain, in `YYYY/MM/DD` folders | A root thread (CLI 0.159: 2 turns, 73 responses, 69 commands of which 7 failed, 15 file changes, 3 MCP calls, one compaction) and its two approval-reviewer threads: one with 20 turns, and one with no turn at all, written a day later. The dated folders are how Codex lays sessions out, so this variant also covers discovery at depth. |
| `tool-errors` | 2 plain | Two root threads. The first (CLI 0.158): 17 failed commands, 1 failed file change, 3 failed scripts, a turn ended by an API error, one compaction. The second (CLI 0.159): a turn the person interrupted, 10 failed commands, 4 failed MCP calls, 3 failed scripts, two compactions, inline images. Their reviewer threads are left out on purpose. |
| `legacy` | 2 plain | The formats before code mode. The first (CLI 0.47, `originator: codex_vscode`): no usage records, only the running token event; 23 `shell` calls with an argv (`powershell.exe -Command`, one `bash -lc`), 7 patches sent as `["apply_patch", …]`, 2 non-zero exits read from the output's metadata. The second (CLI 0.147): 5 `shell_command` calls whose script is a bare string. |
| `compaction` | 1 plain | A reviewer thread **without its parent** (an orphan child, CLI 0.153) that starts with a compaction it inherited. 6 turns started, 7 completed: one completion is for a turn this file never started. |

About 18 MB together.

## What the compaction records showed

Design question: does a compaction request have its own usage record, or
must its tokens be read from somewhere else?

It has its own. Across the 250 rollouts the survey read, 114 `compacted`
records exist and 111 name a `compaction_response_id`. For 106 of those a
`token_usage_record` with that `response_id` sits directly before the
`compacted` record, with non-zero input and output, in the turn that was
running. A compaction is therefore one more response and becomes one more
`llm_call`; nothing special is needed.

The other 5 are the first record after `session_meta` in a reviewer thread:
history handed over by the parent, compacted there. The usage record is in the
parent's file, so counting `latest_token_usage_record` in the child would
count those tokens twice. The `compaction` fixture is one of these five; the
`guardian` and `tool-errors` roots hold four of the ordinary kind.

## Capturing a fixture

```sh
# 1. find the session (newest last)
ls ~/.codex/sessions/2026/10/13/

# 2. scrub it straight into place; the output name must stay rollout-*.jsonl[.zst]
pnpm scrub ~/.codex/sessions/2026/10/13/rollout-….jsonl.zst \
  -o fixtures/codex/<variant>/rollout-….jsonl

# 3. check it
pnpm vitest run scripts/codex-fixtures
```

- The output is plain or compressed by **its own** name, whatever the input
  was. Keep fixtures plain so a reviewer can read the diff; `zstd` is the one
  compressed file.
- A root and its reviewer threads are separate files, often in different date
  folders. A reviewer thread names its root in `session_meta.parent_thread_id`.
- Read what the script prints. `UNKNOWN keys` are fields this version of the
  script does not know: they were scrubbed with everything under them, and if
  the adapter needs one, it goes on `KNOWN_KEYS` in `scripts/scrub-codex.ts`.
  `GUARDED values` and `DROPPED` lines are explained in `scripts/README.md`.
- To keep an unscrubbed copy next to the fixture, put it under
  `fixtures/codex/<variant>/raw/`, which git ignores, and let the output path
  be derived. The copy is yours; nothing reads it.
- Read the scrubbed file before committing it. Then regenerate goldens with
  `pnpm goldens` in a commit of their own.

## Not covered yet

These shapes were not on the machine the set was captured from (Windows,
Codex Desktop and the VS Code extension). The parser skips what it does not
know, so none of them blocks anything; each is worth a fixture when someone
has one.

| Variant | How to get one |
|---|---|
| Codex CLI in a terminal | Run `codex` in a shell and finish one short task. `session_meta.originator` will be neither `Codex Desktop` nor `codex_vscode`. |
| macOS or Linux | Any session there. The command argv starts with `bash -lc` or `zsh -lc`, and paths are POSIX. |
| A rollout the 2026-10 migration never rewrote | A session from an install that was not upgraded past CLI 0.47, copied before upgrading. |
| Multi-agent subagents | A session where Codex spawned a worker thread: the child's `session_meta.source.subagent` has a key other than `other`. |
| A declined approval | Answer "no" to an approval prompt, then let the turn finish. |
| A thread forked or resumed by hand | `codex resume` or a fork from the app, then one more turn; the file may replay earlier history. |
