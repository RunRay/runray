# Contributing to RunRay

Thanks for looking under the hood. This page covers how to get a change
merged. The design and the rules that bind every change live in
[AGENTS.md](AGENTS.md), [openspec/project.md](openspec/project.md) and
[docs/05-ARCHITECTURE.md](docs/05-ARCHITECTURE.md); read those before
touching parsers, the schema or the cost engine.

## Setup

Node 22 and pnpm. The pnpm version is pinned in `package.json`, so
`corepack enable` picks the right one.

```bash
pnpm install
pnpm build
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm build` runs first because the CLI tests serve the built UI. The full
run takes a few minutes; `pnpm test -- packages/core` narrows it while you
iterate.

## Before you open a pull request

- For anything larger than a bug fix, open an issue first and say what you
  plan to change. The active spec under `openspec/changes/` is the source of
  requirements; if the spec and the code disagree, the spec wins.
- Branch from `develop` and open the pull request against `develop`, which
  is the default branch. `main` holds the released code and only takes
  releases and hotfixes from maintainers (see below). One change per pull
  request. Contributors outside the RunRay organization work in a fork.
- Add a changeset (`pnpm changeset`) for anything a user of the `runray`
  package would notice. Internal refactors and docs need none.
- Commit messages follow Conventional Commits, in English:
  `fix(core): match model ids across version separators`.
- `pnpm lint && pnpm typecheck && pnpm test` is green on your machine.

## Rules that cannot bend

These come from AGENTS.md and CI enforces most of them.

- **The schema is frozen.** `schema/runray.schema.json` is generated from
  `packages/schema` and CI fails on drift. A field change needs a version
  bump and a maintainer decision, not a pull request that edits the schema
  to make a test pass.
- **Fixtures are sacred.** Never edit files under `fixtures/` by hand. New
  sample logs go through `pnpm scrub` and must carry the `SCRUBBED` marker.
  Goldens under `fixtures/normalized/` are regenerated only with
  `pnpm goldens`, in their own commit, with a reason in the message.
- **No network at runtime.** The only permitted network call is
  `runray pricing --refresh`. The view server binds 127.0.0.1. Tests assert
  this, so a stray fetch fails the build.
- **Redaction lives in core.** Anything that strips prompts, paths or names
  happens in `packages/core`, never as a filter in the UI.
- **Deterministic output.** The normalizer must produce byte-stable output.
  If your change makes goldens flap, the change is wrong, not the goldens.
- **Dependencies need a reason.** A new dependency gets one line in the pull
  request saying why, and a check that it makes no network calls at runtime.

## Review and merge

Every pull request needs CI green and one approving review from a
maintainer (see `.github/CODEOWNERS`). Pull requests into `develop` are
squash-merged, so the pull request title becomes the commit message; write
it as a Conventional Commit. Workflows on pull requests from forks wait for
a maintainer to approve the run.

## Branches

| Branch | Holds | Takes changes from |
|---|---|---|
| `develop` | the next release | `feature/*`, `fix/*`, `chore/*`, `docs/*` and Dependabot, squash-merged; `main` after a hotfix, merge commit |
| `main` | the published version | `develop` (a release) or `hotfix/*`, merge commit only |

A required check (`pr-source`) rejects a pull request into `main` from any
other branch or from a fork. `main` takes merge commits rather than
squashes so it keeps sharing history with `develop`; a squash would make
every following release re-apply old commits.

## Releases

Maintainers publish to npm from the `Release` workflow on `main`. Nothing
you need to do; the changeset you added ends up in the release notes.

For maintainers:

1. On a branch from `develop`, run `pnpm changeset version` and open a
   pull request into `develop` (`chore(release): version X`).
2. Open a pull request from `develop` into `main` titled
   `release: X` and merge it with a merge commit.
3. Run the `Release` workflow on `main`.

## Hotfixes

For a bug in the published version that cannot wait for the next release:

1. Branch `hotfix/<what>` from `main`. Fix, add a changeset, run
   `pnpm changeset version`.
2. Open a pull request into `main`, merge it with a merge commit, run the
   `Release` workflow.
3. Open a pull request from `main` into `develop` and merge it with a merge
   commit, so the fix is not lost in the next release.

## Security issues

Please do not report them in a public issue. See [SECURITY.md](SECURITY.md).
