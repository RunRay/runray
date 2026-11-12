# Tasks: fix-triage-tool-identity

Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green, no schema drift, goldens in `fixtures/normalized/` byte-identical.

## 1. Core

- [x] 1.1 `triageRun` keys recovery peers and clusters of a classified shell call on harness tool × registry tool × subcommand × activity, read through `toolIdentity`; `ErrorCluster.program` carries the program; unclassified shell calls and every other kind key as before. Tests in `packages/core/src/triage/cluster.test.ts`: a failed `pnpm test` not recovered by `ls` and recovered by `pnpm run test`; build kept apart from test; `pnpm test` and `git push` as two clusters; programs outside the registry in one cluster; a redacted and an unredacted stamp triaging equal; another harness shell tool kept apart; an unclassified Bash call unchanged.

## 2. Visualizer  [UI → /frontend-design]

- [x] 2.1 One helper in `packages/ui/src/lib/triage.ts` names a cluster's tool (program label, activity where the subcommand does not say it, MCP tool without its server prefix); the Errors tab's cluster row and failure ticks and the Inspector's "What this is" sentence use it, and the row tags the harness tool. Tests for the row and the Inspector sentence.

## 3. Docs and checks

- [x] 3.1 The triage paragraph in `docs/05-ARCHITECTURE.md` and the Errors introduction in `docs/08-FINDINGS.md` say what "the same tool" is for a shell call; a `patch` changeset for `runray`.
- [x] 3.2 Counts-only check on the local real sessions: how many shell failures change recovery and clusters, and that a redacted parse gives the same programs and recoveries as an unredacted one.
