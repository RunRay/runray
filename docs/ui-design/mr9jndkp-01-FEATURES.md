# RunRay — Feature List

Scope legend: **MVP** = 30-day PoC · **v0.2** = post-validation iteration · **v1** = first monetizable release · **10★** = 2-year vision (from RunRay.md)

## MVP (30-Day PoC)

### Must have

| # | Feature | Notes |
|---|---------|-------|
| M1 | `runray view [path]` — auto-detect & open dashboard | Discovers `~/.claude/projects` and OpenCode data dir with no flags; `path` overrides. Opens local server on a free port. |
| M2 | Claude Code JSONL adapter | Parses per-message `usage` (input/output/cacheRead/cacheWrite), reconstructs span tree from `uuid`/`parentUuid`, maps `isSidechain` → subagent spans, tool_use/tool_result pairing. |
| M3 | OpenCode adapter | Handles both storage eras: legacy file storage (`storage/session|message|part`) and SQLite (`opencode.db`); also accepts `opencode export` JSON files. |
| M4 | Normalization to RunRay schema | Single `TraceFile` output; provenance (file/line) kept per span for drill-down. |
| M5 | Cost engine | Bundled offline pricing snapshot (LiteLLM-derived); per-model, per-token-class costing incl. cache read/write; `costSource: reported\|computed`. |
| M6 | Timeline Waterfall view | Virtualized span rows, nesting by delegation, color by span kind, duration bars, cost badges, collapse/expand subtrees, inspector panel. |
| M7 | Cost Breakdown view | Totals; stacked cost by model; treemap by tool/agent; explicit **wasted spend** callouts ("$X on failed Tool Y retries"). |
| M8 | Session list | All discovered runs: date, project, model mix, duration, tokens, cost, error badge. |
| M9 | Insights v0 (5 rules) | retry-loop, low-cache-hit-rate, context-bloat, expensive-subagent, dead-end-run. Each: severity, evidence spans, estimated waste USD, suggestion. |
| M10 | `runray export -o report.html` | Self-contained single-file HTML (inlined JS + data). Shareable in Slack/PRs. |
| M11 | Privacy defaults | 100% local, zero network calls (`--offline` implied; pricing refresh is opt-in); `--redact` strips prompt/output text, keeps structure + counts. |

### Should have (build if week 4 allows)

| # | Feature | Notes |
|---|---------|-------|
| S1 | `runray list` + `--json` output | Scripting/automation surface; feeds future CI. |
| S2 | Watch mode (`runray view --watch`) | Live-tail the active session; polling-based (fs watch) is enough. |
| S3 | Filters | By date range, project, model, min-cost. |

### Won't have in MVP (explicitly cut)

Databases (ClickHouse/InfluxDB), collectors, SDKs, cloud accounts, alerting/SLOs, team features, auth — all deferred per the PoC scope in RunRay.md.

## v0.2 (post-validation)

| # | Feature | Rationale |
|---|---------|-----------|
| V1 | **Run diff** (`runray diff <runA> <runB>`) | Compare two runs of the same task: cost delta, new/removed tool calls, depth changes. Direct foundation for CI regression gate. |
| V2 | Delegation graph view (@xyflow/react) | Agent A → Agent B topology; complements the waterfall. |
| V3 | More adapters | Codex (`~/.codex/sessions`), Gemini CLI, Amp — prioritized by beta-user demand. |
| V4 | Incremental index | Cache parsed results; re-scan only changed files (large-dir performance). |
| V5 | Insight rules v1 | Redundant skill reloads, oversized tool outputs feeding context, model-mix suggestions ("this subtree ran on Opus but never edited files"). |
| V6 | Insight: low-output-ratio | Oznaczenie sesji o wysokim koszcie, ale znikomych zmianach w kodzie (niski stosunek zmienionych linii do kosztu). |

## v1 (monetizable — CI/team path, from prior strategic analysis)

| # | Feature | Notes |
|---|---------|-------|
| C1 | `runray ci` | Exit-code gate: `--budget <usd>`, `--baseline <ref>`, `--fail-on-cost-regression <pct>`, `--fail-on <rule-id>`. Consumes normalized TraceFile from a headless agent run. |
| C2 | GitHub Action | Wraps agent runs in Actions; uploads report.html artifact; posts PR comment with cost diff vs baseline + top insights. |
| C3 | Behavior policies | Unauthorized tool / network egress / delegation-depth limits (shared policy engine). |
| C4 | Baseline store | Per-workflow historical baselines with run-to-run variance handling (statistical bands, not naive last-run compare). |
| C5 | Team dashboard (self-hosted) | Org token burn, per-repo/per-workflow trends. Paid tier boundary starts here. |

## 10★ horizon mapping (traceability to RunRay.md vision)

| Vision item | Seeded by |
|---|---|
| Universal Agent Support | Adapter architecture (M2/M3, V3) |
| Automated Root Cause Analysis | Insights engine (M9 → V5) — the "$2.50 in retries" example is literally rule `retry-loop` |
| Cost Attribution Engine + hard limits per run | Cost engine (M5) + provenance (M4) + `runray ci --budget` (C1) |
| Enterprise SaaS Dashboard | C5 self-hosted first; cloud later |
| Agent Drift Detection | Baseline store (C4) + run diff (V1) |
