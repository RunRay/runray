# Proposal: add-local-trace-viewer

## Why
Debugging agentic sessions is opaque: developers can't see the delegation chain, where tokens burn, or which failures cost money. Existing free tools (ccusage, AgentsView) aggregate usage but stop at raw telemetry. The core hypothesis to validate: **actionable insights beat raw telemetry** — with 5 beta users in 30 days.

## What Changes
- New CLI `runray` with commands: `view`, `list`, `export`, `demo`, `pricing`.
- New capability **trace-ingestion**: adapters for Claude Code JSONL and OpenCode (file storage, SQLite, export JSON), plus best-effort OTLP JSON import; normalization to the versioned `TraceFile` schema.
- New capability **cost-engine**: offline pricing snapshot, per-span USD costing incl. cache classes, and an insights rule engine (5 rules) producing evidence-linked findings.
- New capability **visualizer**: local React dashboard (sessions list, timeline waterfall with Spend Spine, cost breakdown, inspector) served on 127.0.0.1 and exportable as a self-contained HTML file.

## Impact
- Affected specs: trace-ingestion (new), cost-engine (new), visualizer (new), cli (new).
- Affected code: entire greenfield monorepo (`packages/schema`, `core`, `cli`, `ui`), `fixtures/`, CI workflows.
- Out of scope (explicit): databases/collectors/SDKs, cloud/auth, alerting, team features, `diff` (v0.2), `ci` gate (v1).
