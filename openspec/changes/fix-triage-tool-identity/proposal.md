# Proposal: fix-triage-tool-identity

## Why

The Errors tab groups a run's failures into clusters by error class and tool, and says for each failure whether the tool came back. For a shell call both read the harness tool name, `Bash`:

- A failing `pnpm test` and a failing `git push` of the same class are one cluster, "exit-nonzero × Bash".
- Recovery is "the next call of the same tool". After a failed `pnpm test`, a successful `ls` is the next Bash call, so the failure counts as recovered although the tests never ran again. A cluster that should read `unrecovered` or `looping` can read `recovered`, and the attention signal built on that outcome, which colours the session's error pill, stays quiet.

Since `add-tool-usage-breakdown` a shell span carries the program it ran (`runray.tool`, `runray.toolSub`, `runray.toolActivity`), resolved through `toolIdentity`. Triage does not read it.

## What Changes

- **Key** (`packages/core/src/triage/cluster.ts`): a classified shell call is "the same tool" as another when the harness tool, the registry tool, the subcommand and the activity all match. Recovery is the next such call in the same scope; a cluster is class × that identity. The activity is part of the key because `pnpm run test` and `pnpm run build` share the subcommand `run`: the script name tells them apart only in an unredacted trace, while the activity is closed vocabulary that survives redaction. The free-form script or program name is never part of the key, so redaction does not change which calls count as the same tool. (Redaction can still change a failure's class, because the failure text is gone; that fallback is older than this change and stays.) Programs outside the registry share one identity, `other command`, per activity.
- **Cluster data**: `ErrorCluster` gains an optional `program` (`key`, `label` such as `pnpm run` or `git push`, `sub`, `activity`). `tool` keeps the harness name, which the visualizer shows as a tag. `key` becomes `class|Bash|pnpm|run|test` for such a cluster; every other cluster keeps `class|tool`.
- **Unchanged**: a shell span without tool-usage attributes (a trace produced before commands were classified), MCP calls, built-in tools and model calls key as before. Two different harness shell tools (`Bash`, `PowerShell`) stay two tools.
- **Visualizer**: the Errors tab's cluster row, its failure ticks and the Inspector's "What this is" sentence name the program, with the harness tool as a tag. The activity is shown only where the label does not already say what the call did: after a `run`, `script` or `inline` subcommand and after `other command` (`pnpm run · test`, but `git push` and `tsc`).
- **Docs**: the triage paragraph in `docs/05-ARCHITECTURE.md` and the Errors introduction in `docs/08-FINDINGS.md`.

## Impact

- Affected specs: error-triage (MODIFIED "Error clusters, reaction cost and recovery"), visualizer (MODIFIED "Errors tab", "Inspector error sections"). Both requirements come from `add-profiler-depth`, which is not archived yet.
- Affected code: `packages/core/src/triage/cluster.ts` and its test, `packages/core/src/index.ts`, `packages/ui/src/lib/triage.ts`, `packages/ui/src/components/ErrorsView.tsx`, `packages/ui/src/components/ErrorTriageSections.tsx` and their tests.
- No schema change, no new dependency, goldens unchanged (triage is computed at view time, never stored).
- Behaviour change: a failed shell command followed only by other programs now shows as not recovered. Measured on 268 local Claude Code sessions (counts only, 2026-11-12): 1315 shell failures, 298 change recovery (230 from `ok` to not recovered, 44 the other way, because a later run of the same program succeeded), clusters go from 1376 to 1746, and 246 clusters change outcome. The error pill changes in none of them: the attention signal also requires that nothing succeeded after the failure, which this change does not touch. A redacted parse gives the same tool key and recovery for all 2681 failures.
- Depends on `add-tool-usage-breakdown` (RunRay/runray#79), which adds the attributes and `toolIdentity`.
- Not in scope: error classes and owners (`classifyError`); the retry-loop finding, which keys on the harness tool name for the same reason and is fixed separately.
