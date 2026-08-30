# AGENTS.md — instructions for coding agents working in this repo

You are implementing RunRay. Read before writing any code:
1. `openspec/project.md` — conventions and glossary (binding).
2. The active change under `openspec/changes/` — its `proposal.md`, `design.md`, and spec deltas are the requirements. Work from `tasks.md`, one task at a time, and tick tasks off as you complete them.
3. `docs/05-ARCHITECTURE.md` — module boundaries, CLI surface, performance budgets.
4. `docs/02-DATA-MODEL.md` + `schema/runray.schema.json` — the data contract.

## Hard rules (never violate; ask a human instead)

- **The schema is frozen.** Do not add, rename, or remove fields in `packages/schema` to make a task easier. Schema changes require a version bump, a human decision, and updates to `docs/02-DATA-MODEL.md` and all goldens.
- **Fixtures are sacred.** Never edit files under `fixtures/` by hand. New fixtures go through `scripts/scrub-fixture.ts` and must carry the `SCRUBBED` marker. Never commit real prompt text, real paths, or usernames. Goldens in `fixtures/normalized/` are regenerated only via the regen script, in a dedicated commit.
- **No runtime network calls.** The only permitted network operation in the product is explicit `pricing --refresh`. Do not add fetches, update checks, or telemetry. The local server binds 127.0.0.1 only.
- **Determinism.** Normalizer output must be stably ordered; if a change makes goldens flap, the change is wrong, not the goldens.
- **Privacy in core.** Redaction happens in `packages/core`, never as a UI-side filter.
- **No new dependencies without a note.** Adding a dependency requires a one-line justification in the PR description and a check that it doesn't pull in network access at runtime.

## Workflow

- One task from `tasks.md` per commit/PR; conventional commit messages; reference the task id (e.g. `feat(core): claude-code adapter tree reconstruction [2.2]`).
- Definition of done for any task: `pnpm lint && pnpm typecheck && pnpm test` green, goldens unchanged (or regenerated deliberately with justification), no schema drift (CI schema-diff clean).
- If a spec scenario and the code disagree, the spec wins; if the spec seems wrong, stop and flag it — do not silently reinterpret requirements.
- Keep Track boundaries: changes under `packages/ui` should not reach into parsers; changes under `packages/core` should not import from `ui`.

## When unsure

Prefer asking over assuming for: schema semantics, pricing edge cases, anything touching fixtures or privacy. Everything else: follow the specs and ship the task.
