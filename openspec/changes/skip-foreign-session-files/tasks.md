# Tasks: skip-foreign-session-files

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` byte-identical.

## 1. Refuse candidates that are not sessions

- [x] 1.1 `claude-code` `parse()`: throw when the main transcript has no `user`/`assistant` record or no record `timestamp`; drop the `EPOCH` fallback for the session start. Tests in `packages/core/src/adapters/claude-code.test.ts`: another tool's log, summary-only, user records without timestamp, non-JSON lines, plus an unanswered prompt that is kept.
- [x] 1.2 `opencode` `parse()`: throw for storage and export candidates whose session lacks `id` or a numeric `time.created`. Tests in `packages/core/src/adapters/opencode.test.ts`: two export lookalikes and one storage lookalike.
- [x] 1.3 Discovery-level test in `packages/cli/src/discover.test.ts` (a foreign `.jsonl` next to a real session: one run, no 1970 start, one skipped entry with the reason), and a `patch` changeset for `runray`.
