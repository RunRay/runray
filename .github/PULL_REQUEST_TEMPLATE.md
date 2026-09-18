<!-- The title becomes the squash commit message. Write it as a Conventional Commit: type(scope): what changed -->

## What and why

<!-- One paragraph. Link the issue or the openspec task id if there is one. -->

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] Changeset added (`pnpm changeset`), or the change is invisible to users of the `runray` package
- [ ] No hand edits under `fixtures/`; goldens regenerated only with `pnpm goldens`, in their own commit
- [ ] No schema field added, renamed or removed
- [ ] No new outbound network call at runtime
- [ ] New dependency, if any, has a one-line reason below
