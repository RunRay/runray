# CLAUDE.md

RunRay — zero-config, local-first observability & token audit for local coding agents (Claude Code, OpenCode; OTLP import for others). Planning is complete; implementation follows spec-driven development.

## Read first, in this order

@AGENTS.md

1. `openspec/project.md` — conventions and glossary (binding).
2. `openspec/changes/add-local-trace-viewer/` — the active change: `proposal.md`, `design.md`, spec deltas in `specs/`, and the task list in `tasks.md`. Work one task at a time.
3. `docs/05-ARCHITECTURE.md` — module boundaries, full CLI spec, insight-rule logic, performance budgets.
4. `docs/02-DATA-MODEL.md` + `schema/runray.schema.json` — the frozen v0.1 data contract.

## Current state

- `schema/runray.schema.json` is the committed contract. It is the generated output of the zod source and CI checks for drift.

## Commands (once scaffolded)

`pnpm lint && pnpm typecheck && pnpm test` must pass before any task is considered done. Bench: `pnpm bench` (informational).

## Repo map

- `docs/` — planning docs 00–06 (plan, features, data model, design stylebook, sample-log guide, architecture, roadmap)
- `openspec/` — specs and changes (active: add-local-trace-viewer; planned: add-run-diff, add-ci-gate)
- `schema/` — JSON Schema contract + `example-trace.json` reference
- `packages/{schema,core,cli,ui}` — monorepo workspaces (after task 1.1)
- `fixtures/` — scrubbed sample logs per source × variant + normalized goldens (after task 1.3)
- `scripts/` — `scrub-fixture.ts` and maintenance scripts

Language note: specs, code, commits, and comments are English.

## Frontend guardrails (gdy projektujemy UI)

- **Każde zadanie dotykające frontendu (komponenty, strony, layouty, style) wykonuj
  z użyciem skilla `/frontend-design`** — dotyczy też podzadań UI w większych
  change'ach (w tasks.md oznaczaj je `[UI → /frontend-design]`).
- Brak default Tailwind palette (nie używaj `indigo-500`, `blue-600` etc.). Pickup brand color i derive.
- Brak flat `shadow-md` — layered, color-tinted shadows
- Pary fontów: serif/display dla nagłówków + sans dla body
- Animacje tylko `transform` + `opacity`, nigdy `transition-all`
- Każdy interaktywny element: hover + focus-visible + active state
