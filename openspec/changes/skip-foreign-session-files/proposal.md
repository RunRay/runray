# Proposal: skip-foreign-session-files

## Why

Adapters pick candidates cheaply, by name and path, and never check that the content is theirs. When a file isn't, they don't refuse it: they emit a run anyway, dated `1970-01-01` (the `EPOCH` fallback), with no calls and $0. That breaks the project's "never guess silently" rule, which unknown-model pricing already follows.

- **Claude Code**: `detect()` takes every `*.jsonl` in a scanned folder. It already skips files that look like OTLP, but any other JSONL (another tool's export, a log someone dropped into a project folder) becomes a session. With no record timestamp, it gets the `EPOCH` start.
- **OpenCode, file storage**: a `storage/session/<project>/ses_*.json` that parses as JSON becomes a candidate with no check for the session's `id` or `time.created`, and falls back to `EPOCH`. Child sessions and `task` calls without timestamps also fall back to `EPOCH`, and because a run starts at its earliest span, one such child makes the whole run start in 1970.
- **OpenCode, export**: a document that passes the bounded text sniff and has an `info` object is parsed even when `info` isn't a session.
- **OTLP**: a run whose spans carry no start time gets the same `EPOCH` root.

## What Changes

- **One rule for every adapter** (`packages/cli/src/discover.ts`): a normalized run with no usable start (it would begin on 1970-01-01, including an empty run) is skipped with `no usable start time: the run would show as starting on 1970-01-01`. This one check covers OTLP and any future adapter. The adapter-specific checks below remain, because they give clearer reasons.
- **Claude Code**: `parse()` refuses a transcript with no `user`/`assistant` record or no record `timestamp`.
  - If the file carries Claude Code's own markers (`sessionId`, or `summary` / `file-history-snapshot` / `queue-operation` records), the adapter throws the new `NoSessionYet`, and discovery skips the file without a warning. This covers a live session whose first prompt isn't written yet, so `--watch` doesn't warn about it on every rebuild, and summary-only files.
  - Any other file gets `not a Claude Code session: no timestamped user or assistant records`.
  - A timestamped prompt with no reply is still a session.
- **OpenCode**: storage and export candidates whose session lacks `id` or a numeric `time.created` are refused. An export whose `info` has no `id` is now "not an opencode export document", and the filename fallback for its id is gone. A child session without `time.created` starts at the span it hangs under, with a run warning. A `task` call without `state.time` starts with its message.
- **CLI output**: skipped candidates still print `warning: skipped <file>: <reason>`. The trailer under them used to say the session "could not be read". It now says the entry was skipped (a locked `opencode.db` is one entry per session) and also names files that aren't sessions. The new wording is in `docs/12-ONBOARDING-COPY.md` §f and fits 80 columns.

## Impact

- Affected specs: trace-ingestion (ADDED "Files that are not sessions are skipped").
- Affected code:
  - `packages/core/src/adapter.ts` (`NoSessionYet`, exported from core)
  - `packages/core/src/adapters/claude-code.ts`
  - `packages/core/src/adapters/opencode.ts`
  - `packages/cli/src/discover.ts`
  - their tests
- Goldens are unchanged: no committed fixture relies on the `EPOCH` fallback. No schema change, no new dependency.
- Behavior change: a foreign file in a scanned folder now prints one `warning: skipped …` line per build instead of showing up as a 1970 session.
- Not in scope: when a folder holds only skipped files, it is still described as "empty". The root verdict is being reworked in a separate change to the `[path]` hints.
