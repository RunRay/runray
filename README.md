# RunRay

**Zero-config, local-first observability for AI coding agents.** Reads the session logs your agents already write to disk and turns them into actionable insights — no database, no collectors, no setup.

```bash
npx runray demo   # see it on a bundled sample session
npx runray view   # see your own sessions
```

> **Status: alpha, and installable today.** `0.1.0-alpha.1` is on npm — everything described below works. It is an alpha because it has been exercised by its authors and a handful of fixtures, not by a hundred real machines: agent log formats are undocumented and drift with every CLI release, so the honest expectation is that some session somewhere parses oddly. If one does, [open an issue](https://github.com/runray/runray/issues) with your `runray --version` and the source agent — that feedback is exactly what the alpha is for.

---

## What is this?

RunRay is a local-first CLI that reads session data your AI coding agents (Claude Code, OpenCode) **already store on disk**, normalizes it into one schema, and opens an instant dashboard: the full delegation tree, where the time went, where the money went — and what to change.

**Core hypothesis:** raw usage numbers are a solved problem (plenty of free tools aggregate them). What developers lack is *actionable insight* — "Bash failed 3× in a row and burned $0.09 in retries" beats "you used 138k tokens."

---

## What it does

- **Zero-config** — reads logs that already exist (`~/.claude/projects`, OpenCode's data dir). No env vars, no collector, no account. Pass a path to override auto-detection.
- **Format-agnostic adapters** — Claude Code JSONL (incl. subagent sidechains); OpenCode across both of its storage eras (legacy file storage *and* SQLite) plus `opencode export` JSON; OTLP/JSON import for custom or hook-instrumented agents.
- **Actionable insights, not just telemetry** — a rule engine flags retry loops, low cache hit-rate, context bloat, expensive subagents, and dead-end runs — each with evidence spans, an estimated wasted USD, and one concrete suggestion.
- **Timeline waterfall** — the execution tree with parallel vs sequential lanes, error marking, and the **Spend Spine**: a cumulative-cost gutter showing money accrete through the session.
- **Cost breakdown** — per-model, per-tool, cache-aware; explicit wasted-spend table.
- **Single-file export** — `runray export -o report.html --anonymize` produces a self-contained offline HTML report with redacted prompts and pseudonymized paths that you can safely share on Slack or GitHub PRs.
- **Private by design** — 100% local; zero runtime network calls (the only exception: explicit `pricing --refresh`); redaction and path pseudonymization happen in core before serialization; the browser UI generates no files and makes no outbound requests.

---

## Architecture

```
 ~/.claude/projects/**.jsonl ─┐
 opencode storage / .db ──────┼─▶ adapters ─▶ normalize ─▶ TraceFile ─▶ cost engine ─▶ insights
 OTLP JSON export ────────────┘                             (JSON)                        │
                                                     ┌────────────────┬───────────────────┤
                                                     ▼                ▼                   ▼
                                              local dashboard    report.html          --json
                                              (127.0.0.1)       (single file)        (stdout)
```

| Component | Description |
|-----------|-------------|
| **Adapters** (`packages/core`) | Pluggable per-source parsers (`detect()` / `parse()`). Golden-fixture contract tests absorb vendor format churn — OpenCode is mid-migration to SQLite as we write this. |
| **Schema** (`packages/schema`) | One versioned `TraceFile` JSON Schema — the contract between CLI and UI. UI never touches raw logs. |
| **Cost engine** (`packages/core`) | Offline pricing snapshot; cache read/write priced at their own rates; unknown models surfaced, never silently priced. |
| **Insights** (`packages/core`) | Five v0 rules with thresholds configurable via `runray.config.json`. |
| **CLI** (`packages/cli`) | `view · list · export · demo · pricing · diff`. Serves the embedded dashboard on 127.0.0.1 only. |
| **Visualizer** (`packages/ui`) | Vite + React + Tailwind; virtualized waterfall; ships as prebuilt static assets inside the npm package. |

---

## Usage

```bash
# Instant demo on a bundled, anonymized session — no agent data needed
npx runray demo

# Auto-detect and browse your sessions (Claude Code + OpenCode)
runray view

# A specific folder or file
runray view ./traces/session-2026-07-01.jsonl

# Machine-readable listing for scripts
runray list --json

# Sanitized shareable report (redacts prompt text & scrubs paths into pseudonyms)
runray export -o report.html --anonymize

# Minimal metadata-only export (prunes leaf spans, keeps containers, totals & findings)
runray export -o report.html --metadata-only

# Unredacted full trace (confirmation prompt required unless --yes)
runray export -o report.html --yes
```

---

## Dashboard views

### Timeline
Waterfall of the full execution tree: parent/child delegation with per-depth indenting, **parallel vs sequential** sibling spans on separate lanes, duration bars colored by span kind, error notches, expandable details (tokens, cost, prompt preview), and the Spend Spine cumulative-cost gutter — click a point to jump to that moment.

### Cost breakdown
Total session cost, cost stacked by model over time, a treemap by tool/agent subtree (cell intensity = spend), cache hit-rate, and a wasted-spend table linking every finding to its evidence spans.

### Insights strip
Findings ranked by severity with estimated waste — click to highlight the evidence in the waterfall.

---

## What ships in the alpha

Everything the PoC set out to build is in `0.1.0-alpha.1`:

- Claude Code JSONL adapter, including subagent sidechains
- OpenCode adapter across all three eras: file storage, SQLite, `opencode export` JSON
- OTLP/JSON import for anything else that can emit OpenTelemetry
- Normalization to the versioned schema; offline, cache-aware cost engine
- Insight rules flagging retry loops, cache-prefix breaks, context bloat, expensive subagents and dead-end runs
- Timeline waterfall, cost breakdown, sessions overview, span inspector
- `demo`, `list --json`, single-file `export`, `--redact`, and `diff` between two runs

**Deliberately absent, and staying that way:** databases, external collectors, SDKs, cloud deployment, accounts, alerting. Nothing here phones home.

**Next:** `runray ci` — a budget and cost-regression gate with a GitHub Action, so a pull request can fail on a spend regression the way it fails on a broken test. Cursor and other hook-instrumented agents keep no zero-config session logs on disk, so they arrive through the OTLP path rather than as native adapters.

---

## How is this different from ccusage?

ccusage and friends answer *"how much did I use this week?"* — aggregate usage reports. RunRay answers *"what happened inside this run, and what should I change?"* — per-run forensics with evidence-linked findings. Use both.

---

## Project structure

```
runray/
├── packages/
│   ├── schema/     # zod types → JSON Schema (the CLI↔UI contract)
│   ├── core/       # adapters, normalizer, cost engine, insights
│   ├── cli/        # commands + local server; embeds UI dist
│   └── ui/         # Vite React dashboard
├── fixtures/       # scrubbed sample logs per source × variant + golden outputs
├── openspec/       # spec-driven development artifacts
└── .github/        # CI: lint, typecheck, tests, schema validation, build
```

---

## License

MIT — see [LICENSE](LICENSE). The published package carries the same grant.
