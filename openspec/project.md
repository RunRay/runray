# Project: RunRay

Zero-config, local-first observability and token audit for local coding agents (Claude Code, OpenCode, custom agents via OTLP). Reads logs already on disk, normalizes them into one schema, and renders actionable insights — never just raw telemetry. 100% local; no telemetry of its own.

## Tech stack
- TypeScript, Node.js ≥ 20, ESM only. pnpm workspaces monorepo.
- Packages: `schema` (zod v4 → JSON Schema; ajv validates the generated contract), `core` (adapters, normalizer, cost engine, insights; `better-sqlite3` for OpenCode's SQLite era, plus browser-safe subpath exports the UI imports from), `cli` (commander + node:http + chokidar, embeds UI dist), `ui` (Vite 6 + React 18 + Tailwind v4 + zustand + @tanstack/react-virtual; `vite-plugin-singlefile` builds the export template).
- **No UI component library.** The dashboard has no shadcn/ui, no Radix, no headless-UI dependency: dialogs, popovers, the command palette and the help sheet are hand-rolled against the design tokens in `packages/ui/src/index.css`. Adding one is a deliberate decision, not a default — the tokens and the a11y patterns in `HelpSheet`/`CommandPalette` are the reference implementations to match.
- Tests: vitest — unit, golden-fixture, bundle-purity, and end-to-end smoke (`packages/cli/src/*-e2e.test.ts`, driven through the real CLI + local server, no browser automation). Lint/format: biome. Versioning: semver.
- Release: only the `cli` package is published, as `runray`; the other workspaces stay `private`. Its `prepack` builds the workspaces, embeds the UI dist and the demo goldens, copies the root README and LICENSE, and runs `scripts/bundle.mjs` (esbuild), which inlines the private workspace packages and leaves every npm dependency external. Versioning and the changelog run through **changesets**, currently in `alpha` pre-release mode — every user-visible change adds one (`pnpm changeset`). Publishing is `.github/workflows/release.yml`, triggered by hand with a `next`/`latest` dist-tag choice. Do not hand-edit versions and do not add a second versioning mechanism.
- Planned, not yet present: browser-level E2E (Playwright). Do not describe it as existing tooling.

## Conventions
- The normalized `TraceFile` schema (see `schema/runray.schema.json`) is the contract between CLI and UI; UI never reads raw agent logs.
- Every adapter change requires a fixture in `fixtures/<source>/<variant>` and a golden file in `fixtures/normalized/`. Fixtures must carry the `SCRUBBED` marker; real prompt text never enters git.
- Derived data (`totals`, `insights`) is always recomputed; source-reported cost is recorded via `costSource` but never trusted for rollups.
- No runtime network calls except explicit `runray pricing --refresh`. Local server binds 127.0.0.1 only.
- Determinism: normalizer output is stably sorted; goldens are byte-stable.
- Conventional commits; PRs cross-reviewed between Track A (data) and Track B (experience).

## Domain glossary
- **Run** — one agent session or headless execution.
- **Span** — one unit of work (llm_call, tool_call, subagent, mcp_call, hook) in the delegation tree.
- **Insight** — a rule-engine finding with evidence spans and estimated waste in USD.
- **Adapter** — a source plugin implementing `detect()`/`parse()` for one agent's on-disk format.

## Capability map (planned)
`trace-ingestion` · `cost-engine` · `insights` (folded into cost-engine spec for MVP) · `visualizer` · `cli` · `run-diff` (v0.2) · `ci-gate` (v1)
