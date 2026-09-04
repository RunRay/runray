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
- **Actionable insights, not just telemetry** — twelve rules flag retry loops, cache-prefix breaks, idle cache expiry, duplicate file reads, context bloat, wrong model tiers, expensive subagents, dead-end runs and more — each with evidence spans, an estimated USD figure, and one concrete suggestion. Every finding says whether that money is already **burned** or an **opportunity**, and how big it is in *that* run ([how findings are graded](https://github.com/apitome-app/runray/blob/main/docs/08-FINDINGS.md)).
- **Timeline waterfall** — the execution tree with parallel vs sequential lanes, error marking, and the **Spend Spine**: a cumulative-cost gutter showing money accrete through the session.
- **Cost breakdown** — per-model, per-tool, cache-aware; explicit wasted-spend table.
- **Single-file export** — `runray export -o report.html` produces one self-contained HTML you can drop into Slack or a PR.
- **Private by design** — 100% local; zero network calls at runtime (the only exception: explicit `pricing --refresh`); `--redact` strips prompt text while keeping structure and token counts.

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
| **Insights** (`packages/core`) | Twelve rules; severity graded by the engine from each finding's share of the run's cost; thresholds configurable via `runray.config.json`. |
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

# Self-contained shareable report (confirmation required unless --redact)
runray export -o report.html --redact
```

---

## Dashboard views

### Timeline
Waterfall of the full execution tree: parent/child delegation with per-depth indenting, **parallel vs sequential** sibling spans on separate lanes, duration bars colored by span kind, error notches, expandable details (tokens, cost, prompt preview), and the Spend Spine cumulative-cost gutter — click a point to jump to that moment.

### Cost breakdown
Total session cost, cost stacked by model over time, a treemap by tool/agent subtree (cell intensity = spend), cache hit-rate, and a wasted-spend table linking every finding to its evidence spans.

### Findings
Every finding answers two questions. **Is the money gone?** — *burned* findings (retry loops, cache breaks, duplicate reads, dead ends) add up to the run's **wasted** figure; *opportunity* findings (heavy fixed context, wrong model tier, low cache hit-rate) are savings you could still make and never inflate it. **How big is it here?** — severity is not a property of the rule: the engine grades each finding by its share of *that run's* cost (by default `warning` from 2% and $0.05, `critical` from 10% and $1), so the same $0.60 retry loop is a warning in a $0.65 run and a footnote in a $600 one.

The strip above the timeline lists findings ranked by amount; evidence rows in the waterfall carry a severity notch and a ⚠ chip, and the Inspector switches between an activity and the finding it belongs to. Every suggestion is addressed to you, not to the model, and the Inspector shows the rule's playbook for your tool under *How to fix*. Full rule list, formulas and threshold keys: [docs/08-FINDINGS.md](https://github.com/apitome-app/runray/blob/main/docs/08-FINDINGS.md).

Failed tool calls get the same treatment. The **Errors** tab of a session groups them by *who can act* — yours to fix (a missing binary, a shell the agent misread), tooling (a stuck browser pane, an MCP server), the agent's own slips, failed model calls, and the expected feedback of a test that did not pass yet — with the error text, whether the tool came back, what the reaction cost, and what you can do in your tool. The errors pill turns red only when a failure is yours to fix or the session never got past one; a run whose slips the agent fixed itself reads neutral.

The **Waste** tab keeps two figures apart — what a session *burned* (retries, cache re-writes, idle gaps: money already spent on nothing) and what a different setup could have saved, as upper bounds — names the one change that would have kept most of the burn, and places every burn on the session's clock over the context size it happened in. Findings are grouped by rule and graded as groups, so eighteen small cache breaks read as the 12% of the session they add up to, and thirteen re-reads worth cents take one line.

---

## What ships in the alpha

Everything the PoC set out to build is in `0.1.0-alpha.1`:

- Claude Code JSONL adapter, including subagent sidechains
- OpenCode adapter across all three eras: file storage, SQLite, `opencode export` JSON
- OTLP/JSON import for anything else that can emit OpenTelemetry
- Normalization to the versioned schema; offline, cache-aware cost engine
- Twelve insight rules (retry loops, cache-prefix breaks, idle cache expiry, duplicate reads, context bloat, fixed-context overhead, wrong model tier, expensive subagents, dead-end runs, scattered tool failures, oversized outputs, low cache hit-rate), each classed burned/opportunity and graded by its share of the run
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
