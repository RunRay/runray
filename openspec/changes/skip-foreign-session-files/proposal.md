# Proposal: skip-foreign-session-files

## Why

Adapters pick candidates cheaply, by name and path, and never check that the content is theirs. When a file isn't, they don't refuse it: they emit a run anyway, dated `1970-01-01` (the `EPOCH` fallback), with no calls and $0. That breaks the project's "never guess silently" rule, which unknown-model pricing already follows.

- **Claude Code**: `detect()` takes every `*.jsonl` in a scanned folder. Since #1-era fixes it skips files that look like OTLP, but any other JSONL (another tool's export, a log someone dropped into a project folder) becomes a session. With no record timestamp, it gets the `EPOCH` start.
- **OpenCode, file storage**: a `storage/session/<project>/ses_*.json` that parses as JSON becomes a candidate with no check for the session's `id` or `time.created`, and falls back to `EPOCH`.
- **OpenCode, export**: a document that passes the bounded text sniff and has an `info` object is parsed even when `info` isn't a session.

The SQLite era isn't affected: the `session` table's schema guarantees both fields.

## What Changes

- `claude-code` `parse()` throws `not a Claude Code session: no timestamped user or assistant records` when the main transcript has no `user`/`assistant` record or no record `timestamp`. A session with a timestamped prompt and no reply yet (crashed, interrupted) is still a session.
- `opencode` `parse()` throws `not an opencode session: no id or time.created` for storage and export candidates whose session lacks either field.
- Discovery already catches a throwing `parse()`: the candidate is skipped, the other runs load, and the CLI prints `warning: skipped <file>: <reason>` on stderr. So no CLI change is needed.

## Impact

- Affected specs: trace-ingestion (ADDED "Files that are not sessions are skipped").
- Affected code: `packages/core/src/adapters/claude-code.ts`, `packages/core/src/adapters/opencode.ts`, and their tests. Plus one discovery-level test in `packages/cli/src/discover.test.ts`.
- Goldens are unchanged: no committed fixture relies on the `EPOCH` fallback. No schema change, no new dependency.
- Behavior change: a foreign file in a scanned folder now prints one `warning: skipped …` line per run instead of showing up as a 1970 session.
