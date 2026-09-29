# demo — sample data for `runray demo`

`runs/<source>/<slug>.json` holds six normalized runs that `runray demo` serves
(and `prepack` copies into the published package as `assets/demo`).

They are built from the scrubbed goldens in `fixtures/normalized/`:

- The token counts, timings, costs and span trees are real. They come from
  actual Claude Code, OpenCode and OTLP sessions.
- The text is written by hand. The scrubber turns every string into lorem,
  which is right for tests and useless in a showcase. Each run has a
  storyline in `scripts/demo/stories.ts`: title, project, user prompts,
  subagent tasks, file paths, commands and error messages, chosen to match
  what the session's tools actually do.

| Run | Source | Story |
|---|---|---|
| `claude-code/invoices-table-redesign` | Claude Code, 2 days | Invoices table redesign checked in a live preview; screenshot timeouts, stale dev servers |
| `claude-code/orders-api-kysely-migration` | Claude Code, 19 subagents | Raw SQL → Kysely migration, one agent per module; TaskStop retry loop |
| `claude-code/docs-frontmatter-migration` | Claude Code | Frontmatter migration script; a 5-hour break expires the cache |
| `opencode/tzdate-dst-fix` | OpenCode export | DST bug in a date parser |
| `opencode/storefront-dark-mode` | OpenCode SQLite | Dark mode for checkout components, one subagent |
| `otlp/orders-api-precommit-review` | Claude Code OTel traces | Pre-commit review of a staged diff |

Regenerate after a golden or insight-engine change, and commit the result:

```sh
pnpm demo:build
```

The build puts every run through `priceRun → normalize → applyInsights` and
fails if a run id changes, a model is unpriced, a story is short of prompts,
files or error texts, or any scrubber lorem is left. Never edit `runs/` by
hand. After a rebuild, retake the README screenshots with
`pnpm docs:screenshots` (see `scripts/README.md`).

Not in the demo: `claude-code/duplicate-records` (a parser edge case),
`otlp/claude-traces-beta-1` (a 12-second probe), and the OpenCode
`storage` / `sqlite-1` goldens, which capture the same session as
`export-json`.
